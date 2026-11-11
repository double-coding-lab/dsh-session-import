/**
 * Rewind-branch test: import a transcript, then import a forked transcript that
 * copied the leading turns and continued elsewhere. The second import must
 * rebuild the DSH session from the fork (dropping the abandoned branch), keep
 * the same ledger identity, and refuse an unrelated replacement.
 *
 *   node scripts/test-rebuild.ts
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { importSession, type PersistencePort, type SessionHandle } from '../src/host/importer.ts'
import { parseClaudeJsonl } from '../src/host/parsers/claude-jsonl.ts'
import { ImportStateStore } from '../src/host/state.ts'
import { DEFAULT_IMPORT_OPTIONS } from '../src/shared/types.ts'
import type { DshEvent } from '../src/host/mapper.ts'

const OLD = 'fixture-rebuild-old'
const FORK = 'fixture-rebuild-fork'
const UNRELATED = 'fixture-rebuild-unrelated'

function user(session: string, uuid: string, parent: string | null, text: string, time: string): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    parentUuid: parent,
    sessionId: session,
    timestamp: time,
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
}

function assistant(session: string, uuid: string, parent: string | null, text: string, time: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    parentUuid: parent,
    sessionId: session,
    timestamp: time,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })
}

function leaf(session: string, uuid: string): string {
  return JSON.stringify({ type: 'active-leaf', sessionId: session, leafUuid: uuid, explicit: true })
}

interface StoredSession {
  events: DshEvent[]
}

class Handle implements SessionHandle {
  readonly #session: StoredSession
  constructor(session: StoredSession) {
    this.#session = session
  }
  async append(events: readonly DshEvent[]): Promise<void> {
    events.forEach((event, index) => {
      const expected = this.#session.events.length + index
      if (event.seq !== expected) throw new Error(`seq 不连续：期望 ${expected}，收到 ${event.seq}`)
    })
    this.#session.events.push(...events)
  }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
  async read(): Promise<{ events: readonly DshEvent[] }> {
    return { events: this.#session.events }
  }
}

class Fake implements PersistencePort {
  readonly sessions = new Map<string, StoredSession>()
  async create(header: { id: string }): Promise<SessionHandle> {
    const session: StoredSession = { events: [] }
    this.sessions.set(header.id, session)
    return new Handle(session)
  }
  async open(id: string): Promise<SessionHandle> {
    const session = this.sessions.get(id)
    if (session === undefined) throw new Error(`open: 会话不存在 ${id}`)
    return new Handle(session)
  }
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-rebuild-'))
const oldPath = join(dir, 'old.jsonl')
const forkPath = join(dir, 'fork.jsonl')
const unrelatedPath = join(dir, 'unrelated.jsonl')

const hello = [
  user(OLD, 'u1', null, '你好', '2026-11-04T00:00:00.000Z'),
  assistant(OLD, 'a1', 'u1', '你好，我是助手', '2026-11-04T00:00:01.000Z'),
]
await writeFile(oldPath, [
  ...hello,
  user(OLD, 'u2', 'a1', '图片问题', '2026-11-04T00:00:02.000Z'),
  assistant(OLD, 'a2', 'u2', 'API Error: 400', '2026-11-04T00:00:03.000Z'),
  leaf(OLD, 'a2'),
].join('\n') + '\n', 'utf8')
await writeFile(forkPath, [
  user(FORK, 'u1', null, '你好', '2026-11-04T00:00:00.000Z'),
  assistant(FORK, 'a1', 'u1', '你好，我是助手', '2026-11-04T00:00:01.000Z'),
  user(FORK, 'u3', 'a1', '图片问题', '2026-11-04T00:01:00.000Z'),
  assistant(FORK, 'a3', 'u3', '这是 Docker 镜像界面', '2026-11-04T00:01:01.000Z'),
  leaf(FORK, 'a3'),
].join('\n') + '\n', 'utf8')
await writeFile(unrelatedPath, [
  user(UNRELATED, 'z1', null, '另一个会话', '2026-11-04T02:00:00.000Z'),
  assistant(UNRELATED, 'z2', 'z1', '无关回复', '2026-11-04T02:00:01.000Z'),
  leaf(UNRELATED, 'z2'),
].join('\n') + '\n', 'utf8')

const persistence = new Fake()
let deletions = 0
const deps = {
  persistence,
  state: new ImportStateStore(join(dir, 'state.json')),
  deleteSession: async (sessionId: string) => {
    deletions += 1
    if (!persistence.sessions.delete(sessionId)) throw new Error(`缺少会话 ${sessionId}`)
  },
}

const first = await importSession(deps, await parseClaudeJsonl(oldPath, { providerId: 'claude-code' }), DEFAULT_IMPORT_OPTIONS)
const firstId = first.dshSessionId

// runImport forwards the row's logical id; simulate that override here.
const forkParsed = await parseClaudeJsonl(forkPath, { providerId: 'claude-code' })
const second = await importSession(deps, { ...forkParsed, sourceSessionId: OLD }, DEFAULT_IMPORT_OPTIONS)
const stored = second.dshSessionId === undefined ? undefined : persistence.sessions.get(second.dshSessionId)
const storedText = JSON.stringify(stored?.events ?? [])

const records = await deps.state.load()
const record = records[`claude-code:${OLD}`]

const unrelatedParsed = await parseClaudeJsonl(unrelatedPath, { providerId: 'claude-code' })
const third = await importSession(deps, { ...unrelatedParsed, sourceSessionId: OLD }, DEFAULT_IMPORT_OPTIONS)
const afterThird = third.dshSessionId === undefined ? undefined : persistence.sessions.get(third.dshSessionId)

const problems: string[] = []
if (first.status !== 'imported') problems.push(`首次应为 imported，实际 ${first.status}`)
if (second.status !== 'imported' || second.rebuilt !== true) problems.push(`分叉应重建成功，实际 ${second.status} rebuilt=${String(second.rebuilt)}`)
if (deletions !== 1) problems.push(`重建应删除一次旧日志，实际 ${deletions}`)
if (second.dshSessionId !== firstId) problems.push('重建必须沿用原 DSH 会话 ID')
if (!storedText.includes('Docker 镜像界面')) problems.push('重建后的日志缺少最新分支内容')
if (storedText.includes('API Error: 400')) problems.push('重建后的日志仍保留被 rewind 的旧回合')
if (record === undefined || record.sourcePath !== forkPath) problems.push('账本应指向最新分支路径')
if (record?.lineageId !== 'u1') problems.push(`账本应记录血缘 ID，实际 ${String(record?.lineageId)}`)
const storedMapped = (stored?.events ?? []).filter(event => event.type !== 'session/title')
if (record?.importedEventCount !== storedMapped.length) problems.push(`账本事件数应与重建日志一致（${String(record?.importedEventCount)} vs ${storedMapped.length}）`)
if (Object.keys(records).length !== 1) problems.push(`账本不应出现额外记录：${Object.keys(records).join(', ')}`)
if (third.status !== 'failed') problems.push(`无关转录必须拒绝重建，实际 ${third.status}`)
if (deletions !== 1) problems.push('无关转录不得删除已有会话')
if (!JSON.stringify(afterThird?.events ?? []).includes('Docker 镜像界面')) problems.push('拒绝重建时不得破坏现有日志')

await rm(dir, { recursive: true, force: true })

if (problems.length === 0) {
  console.log(`✅ rewind 分支重建通过（沿用 ${firstId}，丢弃旧分支，拒绝无关替换）`)
} else {
  console.log('❌ rewind 分支重建失败：')
  for (const problem of problems) console.log(`   - ${problem}`)
  process.exit(1)
}
