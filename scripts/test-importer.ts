/**
 * Importer self-test with an in-memory persistence port.
 *
 * Verifies the contract DSH enforces: create-once, contiguous seq, and a
 * read-back that matches what was written. Also proves idempotency: a second
 * import of an unchanged source is skipped.
 *
 *   node scripts/test-importer.ts <path-to-session.jsonl>
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { importSession, type PersistencePort } from '../src/host/importer.ts'
import { parseClaudeJsonl } from '../src/host/parsers/claude-jsonl.ts'
import { ImportStateStore } from '../src/host/state.ts'
import { DEFAULT_IMPORT_OPTIONS } from '../src/shared/types.ts'
import type { DshEvent } from '../src/host/mapper.ts'

const target = process.argv[2]
if (!target) {
  console.error('usage: node scripts/test-importer.ts <path-to-session.jsonl>')
  process.exit(2)
}

interface StoredSession {
  header: { id: string; cwd?: string }
  events: DshEvent[]
}

class FakePersistence implements PersistencePort {
  readonly sessions = new Map<string, StoredSession>()

  async create(header: {
    version: number
    id: string
    createdAt: number
    cwd?: string
    isSeeded: boolean
    delegationDepth: number
  }): Promise<void> {
    if (this.sessions.has(header.id)) throw new Error(`create: 会话已存在 ${header.id}`)
    if (header.version !== 4) throw new Error(`create: 版本必须是 4，收到 ${header.version}`)
    if (header.isSeeded !== false) throw new Error('create: 导入会话的 isSeeded 必须是 false')
    this.sessions.set(header.id, { header: { id: header.id, ...(header.cwd === undefined ? {} : { cwd: header.cwd }) }, events: [] })
  }

  async append(id: string, events: readonly DshEvent[]): Promise<void> {
    const session = this.sessions.get(id)
    if (session === undefined) throw new Error(`append: 会话不存在 ${id}`)
    events.forEach((event, index) => {
      const expected = session.events.length + index
      if (event.seq !== expected) throw new Error(`append: seq 不连续，期望 ${expected}，收到 ${event.seq}`)
    })
    session.events.push(...events)
  }

  async inspect(id: string): Promise<{ events: readonly { type: string; seq: number }[] }> {
    const session = this.sessions.get(id)
    if (session === undefined) throw new Error(`inspect: 会话不存在 ${id}`)
    return { events: session.events.map(event => ({ type: event.type, seq: event.seq })) }
  }
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-import-test-'))
const state = new ImportStateStore(join(dir, 'state.json'))
const persistence = new FakePersistence()

const parsed = await parseClaudeJsonl(target, { providerId: 'qoder' })
const deps = { persistence, state, now: () => Date.now() }

const first = await importSession(deps, parsed, DEFAULT_IMPORT_OPTIONS)
console.log('first  ', first.status, `turns=${first.turns}`, `events=${first.events}`, `repaired=${first.repaired}`, `truncated=${first.truncated}`)

const stored = first.dshSessionId === undefined ? undefined : persistence.sessions.get(first.dshSessionId)
console.log('stored ', stored === undefined ? 'MISSING' : `events=${stored.events.length} cwd=${stored.header.cwd ?? '(none)'}`)

const second = await importSession(deps, parsed, DEFAULT_IMPORT_OPTIONS)
console.log('second ', second.status, second.message ?? '')

const problems: string[] = []
if (first.status !== 'imported') problems.push(`首次导入应为 imported，实际 ${first.status}`)
if (stored === undefined) problems.push('没有落盘会话')
if (stored !== undefined && stored.events.length !== first.events) problems.push('写入条数与返回值不一致')
if (second.status !== 'skipped') problems.push(`重复导入应为 skipped，实际 ${second.status}`)
if (persistence.sessions.size !== 1) problems.push(`会话数应为 1，实际 ${persistence.sessions.size}`)

await rm(dir, { recursive: true, force: true })

if (problems.length === 0) {
  console.log('✅ 导入管线自检通过（幂等 + seq 连续 + 回读一致）')
} else {
  console.log(`❌ 自检失败（${problems.length} 项）：`)
  for (const problem of problems) console.log(`   - ${problem}`)
  process.exit(1)
}
