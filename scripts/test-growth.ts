/**
 * Growth test: import a fixture, append a second turn to the source, import
 * again, and assert the second run appended only the new events.
 *
 *   node scripts/test-growth.ts
 */
import { mkdtemp, appendFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { importSession, prefixHashOf, type PersistencePort, type SessionHandle } from '../src/host/importer.ts'
import { parseClaudeJsonl } from '../src/host/parsers/claude-jsonl.ts'
import { sourceContentUnchanged } from '../src/host/service.ts'
import { ImportStateStore } from '../src/host/state.ts'
import { DEFAULT_IMPORT_OPTIONS, type ImportRecord } from '../src/shared/types.ts'
import type { DshEvent } from '../src/host/mapper.ts'

const SESSION = 'fixture-growth'
const TIME = '2026-11-04T00:00:00.000Z'

function user(uuid: string, parent: string | null, text: string): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    parentUuid: parent,
    sessionId: SESSION,
    timestamp: TIME,
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
}

function assistant(uuid: string, parent: string | null, text: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    parentUuid: parent,
    sessionId: SESSION,
    timestamp: TIME,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })
}

function leaf(uuid: string): string {
  return JSON.stringify({ type: 'active-leaf', sessionId: SESSION, leafUuid: uuid, explicit: true, timestamp: TIME })
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

const dir = await mkdtemp(join(tmpdir(), 'dsh-growth-'))
const source = join(dir, 'fixture.jsonl')
await writeFile(source, [user('u1', null, '第一轮'), assistant('a1', 'u1', '收到一'), leaf('a1')].join('\n') + '\n', 'utf8')

const persistence = new Fake()
const deps = { persistence, state: new ImportStateStore(join(dir, 'state.json')) }

const first = await importSession(deps, await parseClaudeJsonl(source, { providerId: 'qoder' }), DEFAULT_IMPORT_OPTIONS)
console.log('first ', first.status, `turns=${first.turns} events=${first.events}`)

await appendFile(source, [user('u2', 'a1', '第二轮'), assistant('a2', 'u2', '收到二'), leaf('a2')].join('\n') + '\n', 'utf8')

const second = await importSession(deps, await parseClaudeJsonl(source, { providerId: 'qoder' }), DEFAULT_IMPORT_OPTIONS)
console.log('second', second.status, `events=${second.events}`, second.message ?? '')

const total = second.dshSessionId === undefined ? 0 : (persistence.sessions.get(second.dshSessionId)?.events.length ?? 0)
console.log('total ', total, 'events on disk')

const problems: string[] = []
if (first.status !== 'imported') problems.push(`首次应为 imported，实际 ${first.status}`)
if (second.status !== 'imported') problems.push(`增量应为 imported，实际 ${second.status}`)
if (second.events <= 0) problems.push('增量应写入新事件')
if (total !== 0 && total <= (first.events ?? 0)) problems.push('追加后总事件数没有增长')

const record = {
  providerId: 'qoder',
  sourceSessionId: SESSION,
  sourcePath: source,
  fingerprint: { bytes: 100, mtimeMs: 1, headHash: 'head' },
  dshSessionId: 'dsh',
  importedTurns: 1,
  importedEventCount: 1,
  prefixHash: 'prefix',
  importedAt: 1000,
  lastImportAt: 1000,
  status: 'ok',
} satisfies ImportRecord
const changedSnapshot = { bytes: 120, mtimeMs: 2 }
if (!sourceContentUnchanged(record, changedSnapshot, 'head', 500)) {
  problems.push('旧账本在仅改元数据时不应标记有新增')
}
if (sourceContentUnchanged(record, changedSnapshot, 'head', 1500)) {
  problems.push('旧账本在新增真实消息后应标记有新增')
}
if (!sourceContentUnchanged({ ...record, lastMessageAt: 500 }, changedSnapshot, 'head', 500)) {
  problems.push('记录最后消息时间一致时不应标记有新增')
}
if (sourceContentUnchanged({ ...record, lastMessageAt: 500 }, changedSnapshot, 'head', 600)) {
  problems.push('记录最后消息时间落后时应标记有新增')
}

await rm(dir, { recursive: true, force: true })

if (problems.length === 0) {
  console.log(`✅ 增量追平通过（追加 ${second.events} 条，累计 ${total} 条）`)
} else {
  console.log(`❌ 增量测试失败：`)
  for (const problem of problems) console.log(`   - ${problem}`)
  process.exit(1)
}
