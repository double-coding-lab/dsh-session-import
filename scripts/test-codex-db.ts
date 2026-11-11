/**
 * Codex Desktop database family: projects group the picker, finished turns
 * only, wrappers stripped, images carried, appends stay stable, and a ledger
 * that still points at a rollout is rebuilt from the database.
 *
 *   node scripts/test-codex-db.ts
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { importSession, type PersistencePort, type SessionHandle } from '../src/host/importer.ts'
import { parseCodexDb, scanCodexDb } from '../src/host/parsers/codex-db.ts'
import { ImportStateStore } from '../src/host/state.ts'
import { runImport, scanProvider } from '../src/host/service.ts'
import { DEFAULT_IMPORT_OPTIONS, type ProviderDescriptor } from '../src/shared/types.ts'
import type { DshEvent } from '../src/host/mapper.ts'

const dir = await mkdtemp(join(tmpdir(), 'dsh-codex-db-'))
const root = join(dir, 'codex')
const dshHome = join(dir, 'dsh-home')
process.env.DSH_HOME = dshHome
await mkdir(root, { recursive: true })
await mkdir(join(dshHome, 'session-import'), { recursive: true })

const PROJECT_ROOT = 'E:\\workproject\\demo-project'
const tA = 'thread-a'
const tB = 'thread-b'

const state = new DatabaseSync(join(root, 'state_5.sqlite'))
state.exec(`
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    title TEXT,
    first_user_message TEXT,
    cwd TEXT,
    rollout_path TEXT,
    archived INTEGER DEFAULT 0,
    thread_source TEXT,
    source TEXT,
    model TEXT,
    model_provider TEXT,
    name TEXT,
    created_at_ms INTEGER,
    updated_at_ms INTEGER
  );
`)
const insertThread = state.prepare(
  `INSERT INTO threads (id, title, first_user_message, cwd, rollout_path, archived,
                        thread_source, source, model, model_provider, name, created_at_ms, updated_at_ms)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
)
insertThread.run(tA, 'A 标题', '第一问', '\\\\?\\E:\\workproject\\demo-project\\src', null, 0, null, 'vscode', 'gpt-test', 'test', null, 1_700_000_000_000, 1_700_000_030_000)
insertThread.run(tB, '', 'B 问', 'E:\\workproject\\demo-project\\packages\\b', null, 0, null, 'cli', null, 'test', null, 1_700_000_000_100, 1_700_000_020_000)
insertThread.run('thread-chat', '聊天线程', '聊天问', 'D:\Temp\codex-chat', null, 0, null, 'cli', null, 'test', null, 1_700_000_000_200, 1_700_000_018_000)
insertThread.run('thread-noise', 'Generate slide 99 for this codex-ppt deck', 'Generate slide 99 for this codex-ppt deck', PROJECT_ROOT, null, 0, null, 'exec', null, 'test', null, 1_700_000_000_300, 1_700_000_019_000)
insertThread.run('thread-json-sub', '内部子任务', '内部子任务', PROJECT_ROOT, null, 0, null, '{"subagent":{"thread_spawn":{}}}', null, 'test', null, 1_700_000_000_400, 1_700_000_019_500)
insertThread.run('thread-sub', '子代理', '内部', PROJECT_ROOT, null, 0, 'subagent', null, null, null, null, 1_700_000_000_000, 1_700_000_030_000)
insertThread.run('thread-empty', '', '', PROJECT_ROOT, null, 0, null, null, null, null, null, 1_700_000_000_000, 1_700_000_030_000)
insertThread.run('thread-archived', '归档', '旧会话', PROJECT_ROOT, null, 1, null, null, null, null, null, 1_600_000_000_000, 1_600_000_030_000)
state.close()

const history = new DatabaseSync(join(root, 'thread_history_1.sqlite'))
history.exec(`
  CREATE TABLE thread_turns (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    rollout_ordinal INTEGER NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (thread_id, turn_id)
  );
  CREATE TABLE thread_items (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    rollout_ordinal INTEGER NOT NULL,
    created_at_ms INTEGER,
    item_json TEXT NOT NULL,
    item_type TEXT NOT NULL DEFAULT '',
    updated_at_ordinal INTEGER NOT NULL DEFAULT 0,
    started_at_ms INTEGER,
    completed_at_ms INTEGER,
    PRIMARY KEY (thread_id, turn_id, item_id)
  );
`)
const insertTurn = history.prepare(
  'INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status) VALUES (?, ?, ?, ?)',
)
const insertItem = history.prepare(
  `INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms,
                             item_json, item_type, started_at_ms, completed_at_ms)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
)
let ordinal = 0
function item(
  threadId: string,
  turnId: string,
  id: string,
  type: string,
  payload: Record<string, unknown>,
  created: number,
  completed?: number,
): void {
  ordinal += 1
  insertItem.run(
    threadId,
    turnId,
    id,
    ordinal,
    created,
    JSON.stringify({ type, id, ...payload }),
    type,
    created,
    completed ?? null,
  )
}

insertTurn.run(tA, 'turn-a1', 1, 'completed')
item(tA, 'turn-a1', 'a-u1', 'userMessage', {
  content: [{
    type: 'text',
    text: '\n# Context from my IDE setup:\n\n## Active file: src/a.ts\n\n## My request for Codex:\n第一问\n',
    text_elements: [],
  }],
}, 1_700_000_001_000)
item(tA, 'turn-a1', 'a-r1', 'reasoning', { summary: ['想一想'], content: [] }, 1_700_000_002_000)
item(tA, 'turn-a1', 'a-m1', 'agentMessage', { text: '回答一', phase: 'commentary' }, 1_700_000_003_000, 1_700_000_003_500)
item(tA, 'turn-a1', 'a-c1', 'commandExecution', {
  command: 'echo hi', cwd: PROJECT_ROOT, status: 'completed', aggregatedOutput: 'hi', exitCode: 0,
}, 1_700_000_004_000, 1_700_000_005_000)
insertItem.run(tA, 'turn-a1', 'a-img1', ordinal + 1, 1_700_000_005_500, JSON.stringify({
  type: 'userMessage',
  id: 'a-img1',
  content: [
    { type: 'text', text: '看这个\n## My request:\n图片里是什么？', text_elements: [] },
    { type: 'localImage', path: 'D:\\Temp\\shot.png' },
  ],
}), 'userMessage', 1_700_000_005_500, null)
ordinal += 1
item(tA, 'turn-a1', 'a-f1', 'fileChange', {
  changes: [{ path: 'E:\\workproject\\demo-project\\a.py', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+new' }],
  status: 'completed',
}, 1_700_000_006_000, 1_700_000_006_500)
item(tA, 'turn-a1', 'a-p1', 'mcpToolCall', {
  server: 'github', tool: 'get_file_contents', status: 'completed',
  arguments: { repo: 'demo' }, result: { content: [{ type: 'text', text: 'mcp-ok' }] },
}, 1_700_000_007_000, 1_700_000_007_500)
item(tA, 'turn-a1', 'a-m2', 'agentMessage', { text: '完成', phase: 'final' }, 1_700_000_008_000, 1_700_000_009_000)
insertTurn.run(tA, 'turn-a2', 2, 'completed')
item(tA, 'turn-a2', 'a-u2', 'userMessage', { content: [{ type: 'text', text: '第二问', text_elements: [] }] }, 1_700_000_010_000)
item(tA, 'turn-a2', 'a-m3', 'agentMessage', { text: '回答二', phase: 'final' }, 1_700_000_011_000, 1_700_000_012_000)
insertTurn.run(tA, 'turn-a3', 3, 'inProgress')
item(tA, 'turn-a3', 'a-u3', 'userMessage', { content: [{ type: 'text', text: '进行中', text_elements: [] }] }, 1_700_000_013_000)
item(tA, 'turn-a3', 'a-m4', 'agentMessage', { text: '半截回答', phase: 'commentary' }, 1_700_000_014_000)

insertTurn.run('thread-noise', 'turn-n1', 1, 'completed')
item('thread-noise', 'turn-n1', 'n-u1', 'userMessage', { content: [{ type: 'text', text: 'Generate slide 99 for this codex-ppt deck', text_elements: [] }] }, 1_700_000_001_000)
item('thread-noise', 'turn-n1', 'n-m1', 'agentMessage', { text: '生成中', phase: 'final' }, 1_700_000_002_000, 1_700_000_003_000)
insertTurn.run('thread-json-sub', 'turn-j1', 1, 'completed')
item('thread-json-sub', 'turn-j1', 'j-u1', 'userMessage', { content: [{ type: 'text', text: '内部子任务', text_elements: [] }] }, 1_700_000_001_000)
item('thread-json-sub', 'turn-j1', 'j-m1', 'agentMessage', { text: '内部回答', phase: 'final' }, 1_700_000_002_000, 1_700_000_003_000)

insertTurn.run('thread-chat', 'turn-c1', 1, 'completed')
item('thread-chat', 'turn-c1', 'c-u1', 'userMessage', { content: [{ type: 'text', text: '聊天问', text_elements: [] }] }, 1_700_000_006_000)
item('thread-chat', 'turn-c1', 'c-m1', 'agentMessage', { text: '聊天答', phase: 'final' }, 1_700_000_007_000, 1_700_000_008_000)

insertTurn.run(tB, 'turn-b1', 1, 'completed')
item(tB, 'turn-b1', 'b-u1', 'userMessage', { content: [{ type: 'text', text: 'B 问', text_elements: [] }] }, 1_700_000_002_000)
item(tB, 'turn-b1', 'b-m1', 'agentMessage', { text: 'B 答', phase: 'final' }, 1_700_000_003_000, 1_700_000_004_000)
history.close()

await writeFile(join(root, '.codex-global-state.json'), JSON.stringify({
  'local-projects': {
    'project-demo': {
      id: 'project-demo',
      name: '演示项目',
      rootPaths: [PROJECT_ROOT],
      createdAt: 1_600_000_000_000,
    },
  },
  'thread-project-assignments': {
    [tA]: { projectKind: 'local', projectId: 'project-demo' },
  },
}), 'utf8')

const provider: ProviderDescriptor = {
  schemaVersion: 1,
  id: 'codex-db-test',
  name: 'Codex DB Test',
  family: 'codex-db',
  assets: {
    sessions: {
      roots: { win32: [root], darwin: [root], linux: [root] },
      layout: {
        sessionGlob: 'state_5.sqlite',
        database: {
          state: 'state_5.sqlite',
          history: 'thread_history_1.sqlite',
          globalState: '.codex-global-state.json',
        },
      },
      title: { fields: ['name', 'title'], fromFirstUserMessage: true },
      ignore: { titlePrefixes: ['Generate slide '] },
    },
  },
  capabilities: { resume: true, images: true, subagents: false, reasoning: true },
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
  delete(id: string): void {
    this.sessions.delete(id)
  }
}

const problems: string[] = []
const check = (condition: boolean, message: string): void => {
  if (!condition) problems.push(message)
}

const options = {
  providerId: provider.id,
  root,
  database: {
    state: 'state_5.sqlite',
    history: 'thread_history_1.sqlite',
    globalState: '.codex-global-state.json',
  },
  titleFields: ['name', 'title'],
  fromFirstUserMessage: true,
}

const scanned = await scanProvider(provider)
check(scanned.length === 3, `扫描应只包含 3 个用户线程，实际 ${scanned.length}`)
const rowA = scanned.find(row => row.sourceSessionId === tA)
const rowB = scanned.find(row => row.sourceSessionId === tB)
const rowChat = scanned.find(row => row.sourceSessionId === 'thread-chat')
check(rowA !== undefined && rowB !== undefined && rowChat !== undefined, '扫描缺少线程 A/B/聊天')
check(rowA?.status === 'new', `线程 A 首次扫描应为 new，实际 ${String(rowA?.status)}`)
check(rowA?.title === 'A 标题', `线程 A 标题应优先取 name/title，实际 ${String(rowA?.title)}`)
check(rowA?.cwd === PROJECT_ROOT, `线程 A 应归到项目根目录，实际 ${String(rowA?.cwd)}`)
check(rowB?.cwd === PROJECT_ROOT, `线程 B 应按 cwd 前缀归到项目根目录，实际 ${String(rowB?.cwd)}`)
check(rowB?.title === 'B 问', `线程 B 标题应回落到首条用户消息，实际 ${String(rowB?.title)}`)
check(rowA?.workspaceName === '演示项目' && rowB?.workspaceName === '演示项目', '扫描行应携带项目名称')
check(rowA?.workspaceKey === rowB?.workspaceKey, '同一项目的线程应共享工作区标识')
check(rowChat?.workspaceKey === 'codex-chats' && rowChat?.workspaceEphemeral === true, '未归属项目的线程应进入最近任务分组')
check(rowChat?.workspaceName === '聊天', '未归属项目的线程应归入聊天分组')
check(rowA?.bytes === 10, `线程 A 只应统计已完成回合的 10 条 items，实际 ${String(rowA?.bytes)}`)

const parsed = await parseCodexDb(tA, options)
const users = parsed.events.filter(event => event.kind === 'user')
check(users.length === 3, `线程 A 应有 3 条用户消息，实际 ${users.length}`)
check(users[0]?.text === '第一问', `IDE 包装应被剥离，实际 ${JSON.stringify(users[0]?.text)}`)
check(users[1]?.text === '图片里是什么？', `文件包装应被剥离，实际 ${JSON.stringify(users[1]?.text)}`)
check((users[1]?.images?.length ?? 0) === 1, '用户图片未带到事件')
check(!parsed.events.some(event => event.kind === 'assistant' && event.text === '半截回答'), '进行中的回合不应导入')
const calls = parsed.events.filter(event => event.kind === 'tool-call')
const results = parsed.events.filter(event => event.kind === 'tool-result')
check(calls.length === 3 && results.length === 3, `工具调用应各 3 条，实际 ${calls.length}/${results.length}`)
check(parsed.fingerprint?.bytes === 10, `解析指纹应基于已完成 items，实际 ${String(parsed.fingerprint?.bytes)}`)

const persistence = new Fake()
const first = await runImport(persistence, {
  providerId: provider.id,
  sourcePath: rowA?.sourcePath ?? '',
  sourceSessionId: tA,
  options: DEFAULT_IMPORT_OPTIONS,
  provider,
})
const firstStored = first.dshSessionId === undefined ? undefined : persistence.sessions.get(first.dshSessionId)
const firstText = JSON.stringify(firstStored?.events ?? [])
check(first.status === 'imported', `首次导入失败：${first.status} ${first.message ?? ''}`)
check(firstText.includes('第一问') && firstText.includes('回答一') && firstText.includes('mcp-ok'), '首次导入缺少正文或工具结果')
check(!firstText.includes('半截回答'), '首次导入混入了进行中的回合')

const store = new ImportStateStore(join(dshHome, 'session-import', 'state.json'))
let records = await store.load()
check(records[`${provider.id}:${tA}`]?.sourcePath.includes('#thread=') === true, '账本应记录数据库伪路径')
const afterImport = await scanProvider(provider, records)
check(afterImport.find(row => row.sourceSessionId === tA)?.status === 'imported', '导入后扫描应为 imported')

// A new finished turn appends; an in-progress turn stays invisible until done.
const reopen = new DatabaseSync(join(root, 'thread_history_1.sqlite'))
reopen.prepare('INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status) VALUES (?, ?, ?, ?)')
  .run(tA, 'turn-a4', 4, 'completed')
let seq = 100
reopen.prepare(
  `INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms,
                             item_json, item_type, started_at_ms, completed_at_ms)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(tA, 'turn-a4', 'a-u4', seq, 1_700_000_020_000, JSON.stringify({
  type: 'userMessage', id: 'a-u4', content: [{ type: 'text', text: '第三问', text_elements: [] }],
}), 'userMessage', 1_700_000_020_000, null)
seq += 1
reopen.prepare(
  `INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms,
                             item_json, item_type, started_at_ms, completed_at_ms)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(tA, 'turn-a4', 'a-m5', seq, 1_700_000_021_000, JSON.stringify({
  type: 'agentMessage', id: 'a-m5', text: '回答三', phase: 'final',
}), 'agentMessage', 1_700_000_021_000, 1_700_000_022_000)
reopen.close()
const meta = new DatabaseSync(join(root, 'state_5.sqlite'))
meta.prepare('UPDATE threads SET updated_at_ms = ? WHERE id = ?').run(1_700_000_022_000, tA)
meta.close()

records = await store.load()
const grown = await scanProvider(provider, records)
check(grown.find(row => row.sourceSessionId === tA)?.status === 'grown', '新增回合后扫描应为 grown')
const second = await runImport(persistence, {
  providerId: provider.id,
  sourcePath: rowA?.sourcePath ?? '',
  sourceSessionId: tA,
  options: DEFAULT_IMPORT_OPTIONS,
  provider,
})
const secondStored = second.dshSessionId === undefined ? undefined : persistence.sessions.get(second.dshSessionId)
const secondText = JSON.stringify(secondStored?.events ?? [])
check(second.status === 'imported' && second.events > 0, `增量追加失败：${second.status} events=${second.events}`)
check(secondText.includes('回答三'), '增量日志缺少第三问的回答')
check((secondText.match(/回答一/g) ?? []).length === 1, '增量不应重复旧内容')

// A ledger left on an old rollout path is recognized and rebuilt in place.
records = await store.load()
const record = records[`${provider.id}:${tA}`]!
await store.upsert({ ...record, sourcePath: 'D:\\old\\rollout-thread-a.jsonl' })
records = await store.load()
const migrated = await scanProvider(provider, records)
const migratedRow = migrated.find(row => row.sourceSessionId === tA)
check(migratedRow?.sourceChanged === true && migratedRow?.status === 'grown', '旧 rollout 账本应标记为 sourceChanged')
const repaired = await parseCodexDb(tA, options)
const rebuilt = await importSession(
  { persistence, state: store, deleteSession: async id => persistence.delete(id) },
  repaired,
  DEFAULT_IMPORT_OPTIONS,
)
const rebuiltStored = rebuilt.dshSessionId === undefined ? undefined : persistence.sessions.get(rebuilt.dshSessionId)
const rebuiltText = JSON.stringify(rebuiltStored?.events ?? [])
check(rebuilt.status === 'imported' && rebuilt.rebuilt === true, `源迁移应重建，实际 ${rebuilt.status} ${String(rebuilt.rebuilt)}`)
check(rebuilt.dshSessionId === first.dshSessionId, '重建应保持同一个 DSH 会话 ID')
check((rebuiltText.match(/回答一/g) ?? []).length === 1, '重建不应重复旧内容')
check(rebuiltText.includes('回答三'), '重建缺少最新回合')

await rm(dir, { recursive: true, force: true })

if (problems.length === 0) {
  console.log('✅ Codex 数据库导入通过（项目归组、包装剥离、仅已完成回合、图片、增量、旧账本重建）')
} else {
  console.log('❌ Codex 数据库导入失败：')
  for (const problem of problems) console.log(`   - ${problem}`)
  process.exit(1)
}
