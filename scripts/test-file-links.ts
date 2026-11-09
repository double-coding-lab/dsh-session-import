/**
 * Provider file-link adaptation self-test.
 *
 * Runs the Qoder provider rules over `fixtures/file-links.jsonl`, then checks
 * both halves of the native contract: assistant links become inline code and
 * the same paths ride on `deliverables/presented` for the turn.
 *
 *   node scripts/test-file-links.ts
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adaptFileLinks } from '../src/host/file-links.ts'
import { importSession, type PersistencePort, type SessionHandle } from '../src/host/importer.ts'
import { mapToDshEvents, type DshEvent } from '../src/host/mapper.ts'
import { parseClaudeJsonl } from '../src/host/parsers/claude-jsonl.ts'
import { ImportStateStore } from '../src/host/state.ts'
import { DEFAULT_IMPORT_OPTIONS, type FileLinkRule, type ProviderDescriptor, type SourceEvent } from '../src/shared/types.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const fixture = join(root, 'fixtures', 'file-links.jsonl')
const provider = JSON.parse(
  await readFile(join(root, 'providers', 'qoder', 'provider.json'), 'utf8'),
) as ProviderDescriptor

/** Same platform conversion the adapter applies to a `file:` URL. */
const urlPath = (path: string): string => resolve(fileURLToPath(new URL(`file:///${path}`)))

interface StoredSession {
  header: { id: string; cwd?: string }
  events: DshEvent[]
}

class FakeHandle implements SessionHandle {
  readonly #session: StoredSession

  constructor(session: StoredSession) {
    this.#session = session
  }

  async append(events: readonly DshEvent[]): Promise<void> {
    events.forEach((event, index) => {
      const expected = this.#session.events.length + index
      if (event.seq !== expected) throw new Error(`append: seq 不连续，期望 ${expected}，收到 ${event.seq}`)
    })
    this.#session.events.push(...events)
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {}

  async read(): Promise<{ events: readonly DshEvent[] }> {
    return { events: this.#session.events }
  }
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
  }): Promise<SessionHandle> {
    if (this.sessions.has(header.id)) throw new Error(`create: 会话已存在 ${header.id}`)
    const session: StoredSession = {
      header: { id: header.id, ...(header.cwd === undefined ? {} : { cwd: header.cwd }) },
      events: [],
    }
    this.sessions.set(header.id, session)
    return new FakeHandle(session)
  }

  async open(id: string, _access?: 'read' | 'write'): Promise<SessionHandle> {
    const session = this.sessions.get(id)
    if (session === undefined) throw new Error(`open: 会话不存在 ${id}`)
    return new FakeHandle(session)
  }
}

const parsed = await parseClaudeJsonl(fixture, { providerId: 'qoder' })
const adapted = adaptFileLinks(parsed.events, provider.fileLinks?.assistant, parsed.cwd)
const assistant = adapted.events.find(event => event.kind === 'assistant')

const problems: string[] = []
const text = assistant?.kind === 'assistant' ? assistant.text : ''
const files = assistant?.kind === 'assistant' ? (assistant.files ?? []) : []

const uniqueChip = '`说明.md`'
const collisionChipA = `\`${urlPath('E:/demo/project/reports/周报.md')}\``
const collisionChipB = `\`${urlPath('E:/demo/archive/周报.md')}\``

if (adapted.links !== 3) problems.push(`应识别 3 处文件链接，实际 ${adapted.links}`)
if (adapted.files !== 3) problems.push(`应归并 3 个文件，实际 ${adapted.files}`)
if (!text.includes(uniqueChip)) problems.push(`唯一文件名应使用文件名作为 chip：缺少 ${uniqueChip}`)
if (!text.includes(collisionChipA) || !text.includes(collisionChipB)) problems.push('同名文件应退化为完整路径，避免解析歧义')
if (
  text.includes('file:///E:/demo/project/reports/周报.md') ||
  text.includes('file:///E:/demo/project/docs/说明.md') ||
  text.includes('file:///E:/demo/archive/周报.md')
) {
  problems.push('可识别的 file:// 链接未全部改写')
}
if (!text.includes('[示例](file:///E:/demo/project/example.md)')) problems.push('代码块内的示例链接不应改写')
if (!text.includes('`[行内](file:///E:/demo/project/inline.md)`')) problems.push('行内代码里的示例链接不应改写')
if (!files.some(file => file.path === urlPath('E:/demo/project/docs/说明.md') && file.description === '查看说明')) {
  problems.push('链接标签应作为 presented 文件描述保留')
}

const synthetic: SourceEvent[] = [
  {
    kind: 'assistant',
    time: 0,
    text:
      'A [abs](E:\\demo\\报告(1).md "标题") ' +
      'B [rel](docs/b.md) ' +
      'C [enc](<file:///E:/demo/a%20b.md#L10>) ' +
      'D [dup](file:///E:/demo/a%20b.md)',
  },
]
const flexibleRules: FileLinkRule[] = [
  { syntax: 'markdown-link', accept: ['absolute-path', 'relative-path', 'file-url'] },
]
const flexible = adaptFileLinks(synthetic, flexibleRules, 'E:\\demo\\project')
const flexibleText = flexible.events[0]?.kind === 'assistant' ? flexible.events[0].text : ''
if (flexible.links !== 4) problems.push(`通用规则应识别 4 处链接，实际 ${flexible.links}`)
if (flexible.files !== 3) problems.push(`重复文件应归并，期望 3 个，实际 ${flexible.files}`)
if (flexibleText.includes('file:///') || flexibleText.includes('(docs/b.md)')) problems.push('通用规则的链接未全部改写')
if (!flexibleText.includes('`报告(1).md`') || !flexibleText.includes('`a b.md`')) {
  problems.push('绝对路径、百分号编码与带括号路径未正确改写')
}

const mapped = mapToDshEvents(adapted.events, DEFAULT_IMPORT_OPTIONS)
const presented = mapped.events.filter(event => event.type === 'deliverables/presented')
if (presented.length !== 1) problems.push(`应产生 1 条 deliverables/presented，实际 ${presented.length}`)
const presentedFiles = Array.isArray(presented[0]?.data.files) ? presented[0].data.files : []
if (presentedFiles.length !== 3) problems.push(`presented 应包含 3 个文件，实际 ${presentedFiles.length}`)
if (presented[0]?.data.turn !== 1) problems.push('presented 事件应归属于第 1 轮')
if (typeof presented[0]?.data.callId !== 'string' || !presented[0].data.callId.startsWith('imp-present-')) {
  problems.push('presented 事件缺少稳定的 callId')
}
const assistantMessage = mapped.events.find(
  event => event.type === 'assistant/message' && JSON.stringify(event.data).includes('说明.md'),
)
if (assistantMessage === undefined) problems.push('mapper 输出里找不到包含文件 chip 的 assistant/message')

const dir = await mkdtemp(join(tmpdir(), 'dsh-file-links-test-'))
const state = new ImportStateStore(join(dir, 'state.json'))
const persistence = new FakePersistence()
const result = await importSession(
  { persistence, state, now: () => Date.now() },
  { ...parsed, events: adapted.events },
  DEFAULT_IMPORT_OPTIONS,
)
if (result.status !== 'imported') problems.push(`导入应为 imported，实际 ${result.status}`)
const stored = result.dshSessionId === undefined ? undefined : persistence.sessions.get(result.dshSessionId)
if (stored === undefined) problems.push('导入后没有落盘会话')
if (stored !== undefined && stored.events.filter(event => event.type === 'deliverables/presented').length !== 1) {
  problems.push('回读日志里缺少 deliverables/presented')
}
await rm(dir, { recursive: true, force: true })

if (problems.length === 0) {
  console.log('✅ 文件链接自检通过（provider 规则 + 原生 presented + 回读一致）')
} else {
  console.log(`❌ 文件链接自检失败（${problems.length} 项）：`)
  for (const problem of problems) console.log(`   - ${problem}`)
  process.exit(1)
}
