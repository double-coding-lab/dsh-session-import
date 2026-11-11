/**
 * WorkBuddy provider self-test.
 *
 * Covers the append-only transcript grammar: `<user_query>` extraction,
 * injected context and compaction summaries, image blobs, tool calls, and the
 * `resend-fork-notice` range that must drop an edited-away branch.
 *
 *   node scripts/test-workbuddy.ts
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { importSession, type PersistencePort, type SessionHandle } from '../src/host/importer.ts'
import type { DshEvent } from '../src/host/mapper.ts'
import { parseWorkbuddyJsonl } from '../src/host/parsers/workbuddy-jsonl.ts'
import { loadWorkBuddyMeta } from '../src/host/parsers/workbuddy-meta.ts'
import { readSessionHint, workspaceFieldsFor } from '../src/host/service.ts'
import { ImportStateStore } from '../src/host/state.ts'
import { DEFAULT_IMPORT_OPTIONS, type ProviderDescriptor } from '../src/shared/types.ts'

const dir = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-'))
const workspace = join(dir, 'workbuddy-space')
const projects = join(dir, '.workbuddy', 'projects', 'e-workbuddy-space')
const transcript = join(projects, 'wb-session.jsonl')
const docx = join(workspace, '方案 模板.docx')
const screenshot = join(dir, '.workbuddy', 'blobs', 'ab', 'shot.png')
await mkdir(projects, { recursive: true })
await mkdir(workspace, { recursive: true })
await mkdir(join(dir, '.workbuddy', 'blobs', 'ab'), { recursive: true })
await writeFile(docx, 'docx-bytes')
await writeFile(screenshot, 'png-bytes')

const context = '<system-reminder data-role="user-context">\n<user_info>\nWorkspace Folder: ' + workspace + '\n</user_info>\n</system-reminder>'
const record = (value: Record<string, unknown>): void => {
  // Keep the helper synchronous-friendly: records are written in one batch.
  pending.push(value)
}
const pending: Record<string, unknown>[] = []
const user = (id: string, time: number, query: string, extra: unknown[] = []): void => {
  record({ id, timestamp: time, type: 'message', role: 'user', sessionId: 'wb-session', cwd: workspace, content: [{ type: 'input_text', text: `${context}\n<user_query>${query}</user_query>` }, ...extra] })
}

user('m1', 1_700_000_001_000, `@"${docx}" 看下这个方案`)
record({ timestamp: 1_700_000_001_100, type: 'ai-title', aiTitle: 'WorkBuddy 测试会话', sessionId: 'wb-session', cwd: workspace })
record({ id: 'r1', parentId: 'm1', timestamp: 1_700_000_002_000, type: 'reasoning', rawContent: [{ type: 'reasoning_text', text: '先读方案文件' }], providerData: { model: 'deepseek-v4-flash' } })
record({ id: 'a1', parentId: 'r1', timestamp: 1_700_000_003_000, type: 'message', role: 'assistant', status: 'completed', sessionId: 'wb-session', cwd: workspace, providerData: { model: 'deepseek-v4-flash' }, content: [{ type: 'output_text', text: '收到，我先读文件。' }] })
record({ id: 'fc1', parentId: 'a1', timestamp: 1_700_000_004_000, type: 'function_call', callId: 'call-1', name: 'Read', arguments: JSON.stringify({ file_path: docx }), sessionId: 'wb-session', cwd: workspace })
record({ id: 'fr1', parentId: 'fc1', timestamp: 1_700_000_005_000, type: 'function_call_result', callId: 'call-1', name: 'Read', status: 'completed', output: [{ type: 'input_text', text: '方案正文' }], sessionId: 'wb-session', cwd: workspace })
record({ id: 'm2', parentId: 'fr1', timestamp: 1_700_000_006_000, type: 'message', role: 'user', sessionId: 'wb-session', cwd: workspace, content: [{ type: 'input_text', text: '<system-reminder data-role="error-recovery">Network error occurred, please continue</system-reminder>' }] })
record({ id: 'm3', parentId: 'm2', timestamp: 1_700_000_007_000, type: 'message', role: 'user', sessionId: 'wb-session', cwd: workspace, content: [{ type: 'input_text', text: '<cb_summary>\nSummary of the conversation so far:\nThe conversation is between an AI agent and a user.' }] })
user('m4', 1_700_000_008_000, '继续优化')
user('u-old', 1_700_000_009_000, '旧问题')
record({ id: 'a-old', parentId: 'u-old', timestamp: 1_700_000_009_500, type: 'message', role: 'assistant', status: 'incomplete', sessionId: 'wb-session', cwd: workspace, content: [{ type: 'output_text', text: 'Interrupted by user' }] })
record({ id: 'notice-1', parentId: 'a-old', timestamp: 1_700_000_009_800, type: 'resend-fork-notice', editedUserItemId: 'u-old', sessionId: 'wb-session', cwd: workspace })
user('u-new', 1_700_000_010_000, '新问题')
record({ id: 'a-new', parentId: 'u-new', timestamp: 1_700_000_011_000, type: 'message', role: 'assistant', status: 'completed', sessionId: 'wb-session', cwd: workspace, providerData: { model: 'deepseek-v4-flash' }, content: [{ type: 'output_text', text: '新回答' }] })
record({ id: 'u-img', parentId: 'a-new', timestamp: 1_700_000_012_000, type: 'message', role: 'user', sessionId: 'wb-session', cwd: workspace, content: [{ type: 'image_blob_ref', blob_path: screenshot, mime: 'image/png', size: 9 }, { type: 'input_text', text: `${context}\n<user_query>看截图</user_query>` }] })
record({ id: 'snap-1', parentId: 'u-img', timestamp: 1_700_000_013_000, type: 'file-history-snapshot', sessionId: 'wb-session', cwd: workspace })
await writeFile(transcript, pending.map(line => JSON.stringify(line)).join('\n') + '\n')

const problems: string[] = []
const check = (condition: boolean, message: string): void => {
  if (!condition) problems.push(message)
}

const parsed = await parseWorkbuddyJsonl(transcript, { providerId: 'workbuddy' })
const users = parsed.events.filter(event => event.kind === 'user')
const userTexts = users.map(event => event.kind === 'user' ? event.text : '')
check(parsed.sourceSessionId === 'wb-session', `会话 ID 错误：${parsed.sourceSessionId}`)
check(parsed.cwd === workspace, `cwd 错误：${parsed.cwd}`)
check(parsed.title === 'WorkBuddy 测试会话', `标题错误：${parsed.title}`)
check(
  userTexts.length === 4 && userTexts[0]?.includes('看下这个方案') === true
    && userTexts[1] === '继续优化' && userTexts[2] === '新问题' && userTexts[3] === '看截图',
  `用户消息错误：${JSON.stringify(userTexts)}`,
)
check(userTexts.some(text => text.includes('旧问题') || text.includes('Interrupted')) !== true, '编辑前的旧分支应丢弃')
check(parsed.events.some(event => event.kind === 'user' && event.text.includes('system-reminder')) !== true, '系统包装应剥离')
check(users[0]?.kind === 'user' && users[0].files?.[0]?.localPath === docx, '用户文件提及未识别')
check(users[3]?.kind === 'user' && users[3].images?.[0]?.localPath === screenshot, 'image_blob_ref 未识别')
check(parsed.events.some(event => event.kind === 'reasoning' && event.text === '先读方案文件'), 'reasoning 未映射')
const call = parsed.events.find(event => event.kind === 'tool-call')
check(call?.kind === 'tool-call' && call.name === 'Read' && call.args.includes('file_path'), '工具调用未映射')
const result = parsed.events.find(event => event.kind === 'tool-result')
check(result?.kind === 'tool-result' && result.callId === 'call-1' && result.text === '方案正文', '工具结果未映射')
check(parsed.stats.injectedUserMessages >= 2, `注入消息未统计：${parsed.stats.injectedUserMessages}`)

const hint = await readSessionHint(transcript)
check(hint.title === 'WorkBuddy 测试会话', `扫描标题与解析不一致：${hint.title}`)
check(hint.cwd === workspace, `扫描 cwd 错误：${hint.cwd}`)
check(hint.lineageId === 'wb-session', `扫描 lineage 错误：${hint.lineageId}`)
check(hint.lastMessageAt === 1_700_000_012_000, `扫描最后消息时间错误：${hint.lastMessageAt}`)

const provider = JSON.parse(
  await readFile(new URL('../providers/workbuddy/provider.json', import.meta.url), 'utf8'),
) as ProviderDescriptor
check(provider.assets.sessions?.metadata?.database === '~/.workbuddy/workbuddy.db', 'WorkBuddy 应声明元数据数据库')

const projectMeta = {
  id: 'wb-project',
  cwd: 'E:/workbuddy-space/2026-10-13-14-18-44',
  isPlayground: true,
  projectId: 'p_test',
}
const projectFields = workspaceFieldsFor(provider, projectMeta, projectMeta.cwd, new Map([['p_test', '测试']]))
check(projectFields.workspaceKey === 'workbuddy-project:p_test', '云端项目应按 project_id 归组')
check(projectFields.workspaceName === '测试', '项目别名应覆盖默认标签')
check(projectFields.cwd === undefined, '云端项目会话不应挂到临时目录')

const playgroundMeta = { id: 'wb-play', cwd: 'E:/workbuddy-space/2026-10-16-17-15-01', isPlayground: true }
check(workspaceFieldsFor(provider, playgroundMeta, playgroundMeta.cwd).cwd === undefined, 'playground 会话应进入最近任务')

const datedMeta = { id: 'wb-dated', cwd: 'C:\\Users\\Administrator\\WorkBuddy\\2026-06-24-16-50-25', isPlayground: false }
check(
  workspaceFieldsFor(provider, datedMeta, datedMeta.cwd).cwd === datedMeta.cwd,
  '真实日期空间应保留为工作区',
)

const namedMeta = { id: 'wb-named', cwd: 'C:\\Users\\Administrator\\WorkBuddy\\Claw', isPlayground: false }
check(workspaceFieldsFor(provider, namedMeta, namedMeta.cwd).cwd === namedMeta.cwd, '具名空间应保留')

const dbPath = join(dir, 'workbuddy.db')
const { DatabaseSync } = await import('node:sqlite')
const metaDb = new DatabaseSync(dbPath)
try {
  metaDb.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, title TEXT, custom_title TEXT, cwd TEXT,
    is_playground INTEGER NOT NULL DEFAULT 0, project_id TEXT, deleted_at INTEGER
  )`)
  metaDb.prepare('INSERT INTO sessions (id, title, custom_title, cwd, is_playground) VALUES (?, ?, ?, ?, ?)')
    .run('wb-session', null, '雷达巡检', 'E:\\项目文档\\开发1组\\项目\\2026\\雷达监测', 0)
  metaDb.prepare('INSERT INTO sessions (id, title, cwd, is_playground, project_id) VALUES (?, ?, ?, ?, ?)')
    .run('wb-project', '调研美化 HTML 的 skill', 'E:/workbuddy-space/2026-10-14-10-32-53', 1, 'p_test')
  metaDb.exec(`CREATE TABLE automation_runs (
    thread_id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, runs_json TEXT
  )`)
  metaDb.prepare('INSERT INTO automation_runs (thread_id, automation_id, runs_json) VALUES (?, ?, ?)')
    .run('run-1', 'automation-1', JSON.stringify([{ conversationId: 'wb-session' }]))
} finally {
  metaDb.close()
}
const meta = await loadWorkBuddyMeta(dbPath)
check(meta.get('wb-session')?.customTitle === '雷达巡检', '自定义标题应优先于 id 兜底')
check(meta.get('wb-project')?.projectId === 'p_test', '项目归属应从元数据读取')
check(meta.get('wb-session')?.backgroundGroupId === 'automation-1', '自动化运行应映射到 backgroundGroupId')

interface StoredSession {
  events: DshEvent[]
}

class FakePersistence implements PersistencePort {
  readonly sessions = new Map<string, StoredSession>()

  async create(header: { id: string }): Promise<SessionHandle> {
    const session: StoredSession = { events: [] }
    this.sessions.set(header.id, session)
    return {
      append: async events => { session.events.push(...events) },
      flush: async () => {},
      close: async () => {},
      read: async () => ({ events: session.events }),
    }
  }

  async open(id: string): Promise<SessionHandle> {
    const session = this.sessions.get(id)
    if (session === undefined) throw new Error(`open: 会话不存在 ${id}`)
    return {
      append: async events => { session.events.push(...events) },
      flush: async () => {},
      close: async () => {},
      read: async () => ({ events: session.events }),
    }
  }
}

const persistence = new FakePersistence()
const imported = await importSession({
  persistence,
  state: new ImportStateStore(join(dir, 'state.json')),
  files: {
    async resolve(files) {
      return files.map(file => ({ localPath: file.localPath }))
    },
  },
  images: {
    async resolve(images) {
      return images.map((_, index) => ({
        attachmentId: `img-${index + 1}`,
        mediaType: 'image/png',
        width: 1,
        height: 1,
        bytes: 9,
      }))
    },
  },
}, parsed, DEFAULT_IMPORT_OPTIONS)
check(imported.status === 'imported', `导入失败：${imported.message ?? imported.status}`)
const stored = imported.dshSessionId === undefined ? undefined : persistence.sessions.get(imported.dshSessionId)
check(stored?.events.some(event => event.type === 'session/title') === true, '导入后缺少标题事件')
const firstUser = stored?.events.find(event => event.type === 'user/message')
const content = firstUser?.data['content'] as Array<Record<string, unknown>> | undefined
check(content?.some(block => block['type'] === 'file') !== true, '用户文件不应再生成 file block')
check(content?.some(block => typeof block['text'] === 'string' && block['text'].includes('@"方案 模板.docx"')) === true, '导入后文件引用应使用引号 @ 路径')
const lastUser = [...(stored?.events ?? [])].reverse().find(event => event.type === 'user/message')
const lastContent = lastUser?.data['content'] as Array<Record<string, unknown>> | undefined
check(lastContent?.some(block => block['type'] === 'image') === true, '导入后缺少图片块')

await rm(dir, { recursive: true, force: true })

if (problems.length === 0) {
  console.log('✅ WorkBuddy 导入通过（user_query、摘要/包装过滤、图片、工具、编辑分支、扫描提示）')
} else {
  console.log('❌ WorkBuddy 导入失败：')
  for (const problem of problems) console.log(`   - ${problem}`)
  process.exit(1)
}
