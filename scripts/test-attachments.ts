/**
 * User file-attachment self-test.
 *
 * Qoder lists files under `附件引用：`, Claude Code quotes them as `@"…"`,
 * and Codex Desktop puts them in `# Files mentioned by the user`. All three
 * must become native `@path` references in the message text, so DSH renders
 * the same clickable chips a composer pick produces; missing files stay as
 * readable source text.
 *
 *   node scripts/test-attachments.ts
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { importSession, type PersistencePort, type SessionHandle } from '../src/host/importer.ts'
import type { DshEvent } from '../src/host/mapper.ts'
import { createFileResolver } from '../src/host/service.ts'
import { parseClaudeJsonl } from '../src/host/parsers/claude-jsonl.ts'
import { parseCodexDb } from '../src/host/parsers/codex-db.ts'
import { ImportStateStore } from '../src/host/state.ts'
import { DEFAULT_IMPORT_OPTIONS } from '../src/shared/types.ts'

const dir = await mkdtemp(join(tmpdir(), 'dsh-attachments-'))
const file = join(dir, '方案模板.docx')
const spaced = join(dir, '附件 1，方案模板.docx')
const image = join(dir, '截图.png')
const skill = join(dir, 'skills', 'presentations', 'SKILL.md')
await writeFile(file, 'docx-bytes')
await writeFile(spaced, 'docx-bytes')
await writeFile(image, 'png-bytes')
await mkdir(join(dir, 'skills', 'presentations'), { recursive: true })
await writeFile(skill, '# presentations')

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

class FakePersistence implements PersistencePort {
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

const problems: string[] = []
const check = (condition: boolean, message: string): void => {
  if (!condition) problems.push(message)
}
const userEvent = (events: readonly { kind: string }[]) =>
  events.find(event => event.kind === 'user') as
    | { kind: 'user'; text: string; files?: { localPath: string }[] }
    | undefined

// Qoder: text attachment list.
const qoderPath = join(dir, 'qoder.jsonl')
await writeFile(qoderPath, `${JSON.stringify({
  type: 'user',
  uuid: 'qoder-user',
  timestamp: '2026-11-11T00:00:00.000Z',
  sessionId: 'qoder-session',
  cwd: dir,
  message: {
    role: 'user',
    content: [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'cG5nLWJ5dGVz' },
      },
      {
        type: 'text',
        text: `帮我看下这个文件\n\n附件引用：\n- 文件：${file}\n- 文件：${image}`,
      },
    ],
  },
})}\n`)
const qoder = await parseClaudeJsonl(qoderPath, { providerId: 'qoder' })
const qoderUser = userEvent(qoder.events)
check(qoderUser?.text.includes('帮我看下这个文件') === true, 'Qoder 用户正文丢失')
check(qoderUser?.files?.length === 1 && qoderUser.files[0]?.localPath === file, 'Qoder 非图片附件未进入 files')
check(qoderUser?.files?.some(entry => entry.localPath === image) !== true, 'Qoder 图片路径不应重复进入 files')

// Claude Code: quoted @file mention.
const claudePath = join(dir, 'claude.jsonl')
await writeFile(claudePath, `${JSON.stringify({
  type: 'user',
  uuid: 'claude-user',
  timestamp: '2026-11-11T00:00:01.000Z',
  sessionId: 'claude-session',
  cwd: dir,
  message: {
    role: 'user',
    content: `@"${file}"\n你看一下这个文件`,
  },
})}\n`)
const claude = await parseClaudeJsonl(claudePath, { providerId: 'claude-code' })
const claudeUser = userEvent(claude.events)
check(claudeUser?.files?.length === 1 && claudeUser.files[0]?.localPath === file, 'Claude @ 文件未进入 files')
check(claudeUser?.text.includes('你看一下这个文件') === true, 'Claude 用户正文丢失')

// Codex Desktop: files-mentioned wrapper.
const codexRoot = join(dir, 'codex')
await mkdir(codexRoot, { recursive: true })
const state = new DatabaseSync(join(codexRoot, 'state_5.sqlite'))
state.exec(`
  CREATE TABLE threads (
    id TEXT PRIMARY KEY, title TEXT, first_user_message TEXT, cwd TEXT,
    archived INTEGER DEFAULT 0, thread_source TEXT, source TEXT, model TEXT,
    model_provider TEXT, name TEXT, created_at_ms INTEGER, updated_at_ms INTEGER
  );
`)
state.prepare(
  `INSERT INTO threads (id, title, first_user_message, cwd, archived, thread_source,
                        source, model, model_provider, name, created_at_ms, updated_at_ms)
   VALUES (?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, ?, ?, ?)`,
).run('thread-files', '附件线程', '看下这个文件', dir, '附件线程', 1_700_000_000_000, 1_700_000_010_000)
state.prepare(
  `INSERT INTO threads (id, title, first_user_message, cwd, archived, thread_source,
                        source, model, model_provider, name, created_at_ms, updated_at_ms)
   VALUES (?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, ?, ?, ?)`,
).run('thread-links', '链接线程', '7-12页，请优化', dir, '链接线程', 1_700_000_000_000, 1_700_000_020_000)
state.close()

const history = new DatabaseSync(join(codexRoot, 'thread_history_1.sqlite'))
history.exec(`
  CREATE TABLE thread_turns (
    thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL,
    status TEXT NOT NULL, PRIMARY KEY (thread_id, turn_id)
  );
  CREATE TABLE thread_items (
    thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
    rollout_ordinal INTEGER NOT NULL, created_at_ms INTEGER, item_json TEXT NOT NULL,
    item_type TEXT NOT NULL DEFAULT '', updated_at_ordinal INTEGER NOT NULL DEFAULT 0,
    started_at_ms INTEGER, completed_at_ms INTEGER,
    PRIMARY KEY (thread_id, turn_id, item_id)
  );
`)
history.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?)').run('thread-files', 'turn-1', 1, 'completed')
history.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?)').run('thread-links', 'turn-1', 1, 'completed')
history.prepare(
  `INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms,
                             item_json, item_type, started_at_ms, completed_at_ms)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  'thread-files',
  'turn-1',
  'item-1',
  1,
  1_700_000_005_000,
  JSON.stringify({
    type: 'userMessage',
    id: 'item-1',
    content: [{
      type: 'text',
      text: `\n# Files mentioned by the user:\n\n## 方案模板.docx: ${file}\n\n## My request for Codex:\n看下这个文件\n`,
    }],
  }),
  'userMessage',
  1_700_000_005_000,
  null,
)
history.prepare(
  `INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms,
                             item_json, item_type, started_at_ms, completed_at_ms)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  'thread-links',
  'turn-1',
  'item-1',
  1,
  1_700_000_015_000,
  JSON.stringify({
    type: 'userMessage',
    id: 'item-1',
    content: [{
      type: 'text',
      text: `[方案模板.docx](方案模板.docx)   7-12页，没有按照PPT里面的内容来进行对应的讲解，请优化\n\n[$presentations:Presentations](skills/presentations/SKILL.md)\n`,
    }],
  }),
  'userMessage',
  1_700_000_015_000,
  null,
)
history.close()

const codex = await parseCodexDb('thread-files', {
  providerId: 'codex',
  root: codexRoot,
  database: { state: 'state_5.sqlite', history: 'thread_history_1.sqlite' },
  titleFields: ['name', 'title'],
  fromFirstUserMessage: true,
})
const codexUser = userEvent(codex.events)
check(codexUser?.text === '看下这个文件', `Codex 包装未剥离：${JSON.stringify(codexUser?.text)}`)
check(codexUser?.files?.length === 1 && codexUser.files[0]?.localPath === file, 'Codex files-mentioned 未进入 files')

// Codex composer: file chips are markdown links relative to the thread cwd.
const codexLinks = await parseCodexDb('thread-links', {
  providerId: 'codex',
  root: codexRoot,
  database: { state: 'state_5.sqlite', history: 'thread_history_1.sqlite' },
  titleFields: ['name', 'title'],
  fromFirstUserMessage: true,
})
const linksUser = userEvent(codexLinks.events) as
  | { kind: 'user'; text: string; files?: { localPath: string; mention?: string }[] }
  | undefined
check(linksUser?.files?.length === 1 && linksUser.files[0]?.localPath === file, 'Codex 相对链接文件未进入 files')
check(linksUser?.files?.[0]?.mention === '[方案模板.docx](方案模板.docx)', 'Codex 链接缺少待清理 mention')
check(linksUser?.files?.some(entry => entry.localPath === skill) !== true, 'Codex 技能链接不应作为附件')
check(linksUser?.text.includes('$presentations') !== true, `Codex 技能链接应移出正文：${JSON.stringify(linksUser?.text)}`)

// Import: user text carries native @ references; nothing becomes a file block.
const persistence = new FakePersistence()
const store = new ImportStateStore(join(dir, 'state.json'))
const qoderImport = await importSession({
  persistence,
  state: store,
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
  files: {
    async resolve(files) {
      return files.map(entry => ({ localPath: entry.localPath }))
    },
  },
}, qoder, DEFAULT_IMPORT_OPTIONS)
const qoderStored = qoderImport.dshSessionId === undefined
  ? undefined
  : persistence.sessions.get(qoderImport.dshSessionId)
const qoderMessage = qoderStored?.events.find(event => event.type === 'user/message')
const qoderContent = qoderMessage?.data['content'] as Array<Record<string, unknown>> | undefined
check(qoderContent?.some(block => block['type'] === 'file') !== true, '导入后不应再生成 file block')
check(
  qoderContent?.map(block => block['type']).join(',') === 'image,text',
  `图片与正文顺序错误：${JSON.stringify(qoderContent?.map(block => block['type']))}`,
)
const qoderText = qoderContent?.find(block => block['type'] === 'text')?.['text'] as string | undefined
check(
  qoderText === '帮我看下这个文件\n@方案模板.docx',
  `Qoder 附件未转成 @ 引用：${JSON.stringify(qoderText)}`,
)

const claudeImport = await importSession({ persistence, state: store, files: {
  async resolve(files) {
    return files.map(entry => ({ localPath: entry.localPath }))
  },
} }, claude, DEFAULT_IMPORT_OPTIONS)
const claudeStored = claudeImport.dshSessionId === undefined
  ? undefined
  : persistence.sessions.get(claudeImport.dshSessionId)
const claudeMessage = claudeStored?.events.find(event => event.type === 'user/message')
const claudeContent = claudeMessage?.data['content'] as Array<Record<string, unknown>> | undefined
check(claudeContent?.some(block => block['type'] === 'file') !== true, 'Claude 导入后不应再生成 file block')
const claudeText = claudeContent?.find(block => block['type'] === 'text')?.['text'] as string | undefined
check(
  claudeText === '你看一下这个文件\n@方案模板.docx',
  `Claude @ 文件未转成原生引用：${JSON.stringify(claudeText)}`,
)

const codexLinksImport = await importSession({ persistence, state: store, files: {
  async resolve(files) {
    return files.map(entry => ({
      localPath: entry.localPath,
      ...(entry.mention === undefined ? {} : { mention: entry.mention }),
    }))
  },
} }, codexLinks, DEFAULT_IMPORT_OPTIONS)
const linksStored = codexLinksImport.dshSessionId === undefined
  ? undefined
  : persistence.sessions.get(codexLinksImport.dshSessionId)
const linksMessage = linksStored?.events.find(event => event.type === 'user/message')
const linksContent = linksMessage?.data['content'] as Array<Record<string, unknown>> | undefined
check(linksContent?.some(block => block['type'] === 'file') !== true, 'Codex 链接导入后不应再生成 file block')
const linksText = linksContent?.find(block => block['type'] === 'text')?.['text'] as string | undefined
check(linksText?.startsWith('@方案模板.docx') === true, `Codex 链接未原位替换为 @ 引用：${JSON.stringify(linksText)}`)
check(linksText?.includes('[方案模板.docx]') !== true, `Codex 文件链接未清理：${JSON.stringify(linksText)}`)
check(linksText?.includes('7-12页') === true, `Codex 正文被误删：${JSON.stringify(linksText)}`)
check(linksText?.includes('$presentations') !== true, `Codex 技能链接应移出正文：${JSON.stringify(linksText)}`)

// A file name with spaces keeps the quoted `@"path"` grammar the rule expects.
const spacedPath = join(dir, 'spaced.jsonl')
await writeFile(spacedPath, `${JSON.stringify({
  type: 'user',
  uuid: 'spaced-user',
  timestamp: '2026-11-11T00:00:03.000Z',
  sessionId: 'spaced-session',
  cwd: dir,
  message: { role: 'user', content: `@"${spaced}"\n看看这个` },
})}\n`)
const spacedParsed = await parseClaudeJsonl(spacedPath, { providerId: 'claude-code' })
const spacedImport = await importSession({ persistence, state: store, files: {
  async resolve(files) {
    return files.map(entry => ({ localPath: entry.localPath }))
  },
} }, spacedParsed, DEFAULT_IMPORT_OPTIONS)
const spacedStored = spacedImport.dshSessionId === undefined
  ? undefined
  : persistence.sessions.get(spacedImport.dshSessionId)
const spacedMessage = spacedStored?.events.find(event => event.type === 'user/message')
const spacedContent = spacedMessage?.data['content'] as Array<Record<string, unknown>> | undefined
const spacedText = spacedContent?.find(block => block['type'] === 'text')?.['text'] as string | undefined
check(
  spacedText === '看看这个\n@"附件 1，方案模板.docx"',
  `带空格文件名应使用引号引用：${JSON.stringify(spacedText)}`,
)

// A missing file cannot become a reference; its original mention stays.
const missingPath = join(dir, '不存在.docx')
const missingPathJsonl = join(dir, 'missing.jsonl')
await writeFile(missingPathJsonl, `${JSON.stringify({
  type: 'user',
  uuid: 'missing-user',
  timestamp: '2026-11-11T00:00:02.000Z',
  sessionId: 'missing-session',
  cwd: dir,
  message: { role: 'user', content: `@"${missingPath}"\n还在吗` },
})}\n`)
const missing = await parseClaudeJsonl(missingPathJsonl, { providerId: 'claude-code' })
const missingImport = await importSession({
  persistence,
  state: store,
  files: { async resolve() { return [] } },
}, missing, DEFAULT_IMPORT_OPTIONS)
const missingStored = missingImport.dshSessionId === undefined
  ? undefined
  : persistence.sessions.get(missingImport.dshSessionId)
const missingMessage = missingStored?.events.find(event => event.type === 'user/message')
const missingContent = missingMessage?.data['content'] as Array<Record<string, unknown>> | undefined
const missingText = missingContent?.find(block => block['type'] === 'text')?.['text'] as string | undefined
check(missingContent?.some(block => block['type'] === 'file') !== true, '缺失文件不应生成 file block')
check(missingText?.includes(`@"${missingPath}"`) === true, '缺失文件的原引用应保留')

// Host resolver keeps existing files only and never copies bytes.
const resolved = await createFileResolver().resolve([
  { localPath: file },
  { localPath: missingPath },
])
check(resolved.length === 1 && resolved[0]?.localPath === file, '文件 resolver 应跳过缺失文件')

await rm(dir, { recursive: true, force: true })

if (problems.length === 0) {
  console.log('✅ 用户文件附件通过（Qoder/Claude/Codex、@ 引用、文本清理、缺失文件回退）')
} else {
  console.log('❌ 用户文件附件失败：')
  for (const problem of problems) console.log(`   - ${problem}`)
  process.exit(1)
}
