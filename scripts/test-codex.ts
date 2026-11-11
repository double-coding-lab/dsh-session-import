/**
 * Codex family test: rollout segments of one session compose into one import;
 * injected context is skipped; a later resume segment appends only its new turns.
 *
 *   node scripts/test-codex.ts
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { importSession, type PersistencePort, type SessionHandle } from '../src/host/importer.ts'
import { parseCodexJsonl } from '../src/host/parsers/codex-jsonl.ts'
import { ImportStateStore } from '../src/host/state.ts'
import { scanProvider } from '../src/host/service.ts'
import { DEFAULT_IMPORT_OPTIONS, type ProviderDescriptor } from '../src/shared/types.ts'
import type { DshEvent } from '../src/host/mapper.ts'

const SESSION = 'codex-fixture'
const dir = await mkdtemp(join(tmpdir(), 'dsh-codex-'))
process.env.DSH_HOME = join(dir, 'dsh-home')
await mkdir(join(process.env.DSH_HOME, 'session-import'), { recursive: true })

const day = join(dir, 'sessions', '2026', '11', '11')
await mkdir(day, { recursive: true })

function line(timestamp: string, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, ordinal: 0, type, payload })
}

function meta(timestamp: string): string {
  return line(timestamp, 'session_meta', {
    session_id: SESSION,
    timestamp,
    cwd: 'D:\\Temp\\codex-ws',
  })
}

function message(timestamp: string, role: string, text: string): string {
  return line(timestamp, 'response_item', {
    type: 'message',
    role,
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
  })
}

function toolCall(timestamp: string, callId: string, input: string): string {
  return line(timestamp, 'response_item', { type: 'custom_tool_call', call_id: callId, name: 'exec', input })
}

function toolResult(timestamp: string, callId: string, text: string): string {
  return line(timestamp, 'response_item', {
    type: 'custom_tool_call_output',
    call_id: callId,
    output: [{ type: 'input_text', text }],
  })
}

function reasoning(timestamp: string, text: string): string {
  return line(timestamp, 'response_item', {
    type: 'reasoning',
    summary: [],
    content: [{ type: 'reasoning_text', text }],
  })
}

const segmentA = join(day, 'rollout-2026-11-11T01-00-00-codex-fixture-a.jsonl')
const segmentB = join(day, 'rollout-2026-11-11T01-05-00-codex-fixture-a.jsonl')
const segmentC = join(day, 'rollout-2026-11-11T01-10-00-codex-fixture-a.jsonl')

await writeFile(segmentA, [
  meta('2026-11-11T01:00:00.000Z'),
  message('2026-11-11T01:00:00.500Z', 'developer', '<app-context>desktop rules</app-context>'),
  message('2026-11-11T01:00:01.000Z', 'user', '<environment_context><cwd>D:\\Temp\\codex-ws</cwd></environment_context>'),
  message('2026-11-11T01:00:02.000Z', 'user', '# AGENTS.md instructions for D:\\Temp\\codex-ws\n<INSTRUCTIONS>rules'),
  message('2026-11-11T01:00:03.000Z', 'user', '第一问'),
  message('2026-11-11T01:00:04.000Z', 'assistant', '回答一'),
  reasoning('2026-11-11T01:00:04.500Z', '想一想'),
  toolCall('2026-11-11T01:00:05.000Z', 'call-1', 'echo hi'),
  toolResult('2026-11-11T01:00:06.000Z', 'call-1', 'hi'),
  line('2026-11-11T01:00:07.000Z', 'event_msg', { type: 'token_count' }),
].join('\n') + '\n', 'utf8')

await writeFile(segmentB, [
  meta('2026-11-11T01:05:00.000Z'),
  message('2026-11-11T01:05:01.000Z', 'user', '继续'),
  message('2026-11-11T01:05:02.000Z', 'assistant', '回答二'),
].join('\n') + '\n', 'utf8')

const provider: ProviderDescriptor = {
  schemaVersion: 1,
  id: 'codex-fixture',
  name: 'Codex Fixture',
  family: 'codex-jsonl',
  assets: {
    sessions: {
      roots: { win32: [join(dir, 'sessions')], darwin: [join(dir, 'sessions')], linux: [join(dir, 'sessions')] },
      layout: {
        sessionGlob: '*/*/*/rollout-*.jsonl',
        sessionGlobs: ['*/*/*/rollout-*.jsonl'],
      },
      title: { fields: [], fromFirstUserMessage: true },
      lineage: { mode: 'segments' },
    },
  },
  capabilities: { resume: true, images: false, subagents: false, reasoning: true },
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

const parsed = await parseCodexJsonl([segmentA, segmentB], { providerId: 'codex-fixture' })
const users = parsed.events.filter(event => event.kind === 'user').map(event => event.text)
const assistants = parsed.events.filter(event => event.kind === 'assistant').map(event => event.text)
const kinds = parsed.events.reduce<Record<string, number>>((counts, event) => {
  counts[event.kind] = (counts[event.kind] ?? 0) + 1
  return counts
}, {})

const problems: string[] = []
if (parsed.sourceSessionId !== SESSION) problems.push(`会话 ID 应来自 session_meta，实际 ${parsed.sourceSessionId}`)
if (parsed.title !== '第一问') problems.push(`标题应为第一问，实际 ${String(parsed.title)}`)
if (parsed.segmentPaths?.length !== 2) problems.push(`应合并 2 个 rollout，实际 ${String(parsed.segmentPaths?.length)}`)
if (users.join('|') !== '第一问|继续') problems.push(`用户消息应跳过注入上下文，实际 ${JSON.stringify(users)}`)
if (assistants.join('|') !== '回答一|回答二') problems.push(`助手消息异常：${JSON.stringify(assistants)}`)
if ((kinds['tool-call'] ?? 0) !== 1 || (kinds['tool-result'] ?? 0) !== 1) problems.push(`工具调用未配对：${JSON.stringify(kinds)}`)
if ((kinds['reasoning'] ?? 0) !== 1) problems.push(`reasoning 未映射：${JSON.stringify(kinds)}`)
if (parsed.stats.injectedUserMessages < 2) problems.push('注入上下文未计数')

const initial = await scanProvider(provider)
if (initial.length !== 1) problems.push(`扫描应合并为一行，实际 ${initial.length}`)
else {
  if (initial[0]?.sourcePaths?.length !== 2) problems.push('扫描行应携带两个 rollout 路径')
  if (initial[0]?.title !== '第一问') problems.push(`扫描标题应为第一问，实际 ${String(initial[0]?.title)}`)
  if (initial[0]?.status !== 'new') problems.push(`首次扫描应为 new，实际 ${initial[0]?.status}`)
}

const persistence = new Fake()
const deps = { persistence, state: new ImportStateStore(join(dir, 'state.json')) }
const first = await importSession(deps, parsed, DEFAULT_IMPORT_OPTIONS)
const firstStored = first.dshSessionId === undefined ? undefined : persistence.sessions.get(first.dshSessionId)
const firstCount = firstStored?.events.length ?? 0
const firstText = JSON.stringify(firstStored?.events ?? [])
if (first.status !== 'imported') problems.push(`首次导入失败：${first.status} ${first.message ?? ''}`)
if (!firstText.includes('回答一') || !firstText.includes('回答二')) problems.push('首次导入缺少两段内容')
if (firstText.includes('AGENTS.md') || firstText.includes('environment_context')) problems.push('注入上下文进入了日志')
if (!firstText.includes('tool/result')) problems.push('工具结果未写入')

const record = (await deps.state.load())[`codex-fixture:${SESSION}`]
if (record?.sourcePaths?.length !== 2) problems.push('账本应记录两个 rollout 路径')

const afterImport = await scanProvider(provider, await deps.state.load())
if (afterImport[0]?.status !== 'imported') problems.push(`导入后扫描应为 imported，实际 ${afterImport[0]?.status}`)

await writeFile(segmentC, [
  meta('2026-11-11T01:10:00.000Z'),
  message('2026-11-11T01:10:01.000Z', 'user', '第三问'),
  message('2026-11-11T01:10:02.000Z', 'assistant', '回答三'),
].join('\n') + '\n', 'utf8')

const grown = await scanProvider(provider, await deps.state.load())
if (grown[0]?.status !== 'grown') problems.push(`新增 rollout 后应显示 grown，实际 ${grown[0]?.status}`)
if (grown[0]?.sourcePaths?.length !== 3) problems.push('新增 rollout 后应携带三个路径')

const grownParsed = await parseCodexJsonl(grown[0]?.sourcePaths ?? [], { providerId: 'codex-fixture' })
const second = await importSession(deps, grownParsed, DEFAULT_IMPORT_OPTIONS)
const secondStored = second.dshSessionId === undefined ? undefined : persistence.sessions.get(second.dshSessionId)
const secondText = JSON.stringify(secondStored?.events ?? [])
const answerOneCount = (secondText.match(/回答一/g) ?? []).length
if (second.status !== 'imported' || second.events <= 0) problems.push(`增量追加失败：${second.status} events=${second.events}`)
if (!secondText.includes('回答三')) problems.push('增量日志缺少第三段内容')
if (answerOneCount !== 1) problems.push(`增量不应重复旧内容，回答一出现 ${answerOneCount} 次`)
if ((secondStored?.events.length ?? 0) <= firstCount) problems.push('追加后总事件数未增长')

const third = await importSession(deps, grownParsed, DEFAULT_IMPORT_OPTIONS)
if (third.status !== 'skipped') problems.push(`重复导入应 skipped，实际 ${third.status}`)

await rm(dir, { recursive: true, force: true })

if (problems.length === 0) {
  console.log('✅ Codex 分段导入通过（合并 3 个 rollout、跳过注入上下文、增量只追加新回合）')
} else {
  console.log('❌ Codex 分段导入失败：')
  for (const problem of problems) console.log(`   - ${problem}`)
  process.exit(1)
}
