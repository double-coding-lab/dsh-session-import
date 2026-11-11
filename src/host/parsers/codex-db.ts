/**
 * `codex-db` family parser.
 *
 * Codex Desktop no longer keeps one plain rollouts file per conversation:
 * newer builds compress them (`*.jsonl.zst`) and write several per thread,
 * while the app itself reads `state_5.sqlite` (threads + projects) and
 * `thread_history_1.sqlite` (ordered items). The databases are therefore the
 * only complete source: every project shown in the Codex sidebar exists as a
 * row here, including threads that never produced an uncompressed rollout.
 *
 * Threads are read from `threads`, grouped with the desktop project state, and
 * only items of finished turns are imported. A running turn is skipped until
 * it completes, which also keeps the mapped event prefix stable for appends.
 */
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  ImportRecord,
  ParseStats,
  ParsedSession,
  SessionIgnoreRule,
  SourceEvent,
  SourceImage,
} from '../../shared/types.ts'
import { recordKey } from '../state.ts'
import { cleanTitleText } from './claude-jsonl.ts'

export interface CodexDbConfig {
  state: string
  history: string
  globalState?: string
}

export interface CodexDbOptions {
  providerId: string
  root: string
  database: CodexDbConfig
  titleFields?: string[]
  fromFirstUserMessage?: boolean
  ignore?: { titlePrefixes?: string[]; sessions?: SessionIgnoreRule[] }
}

/** Picker row; structurally the host's `ScannedSession` for this family. */
export interface CodexDbScanRow {
  title?: string
  providerId: string
  sourcePath: string
  sourceSessionId: string
  directory: string
  bytes: number
  mtimeMs: number
  status: 'new' | 'imported' | 'grown' | 'failed'
  dshSessionId?: string
  cwd?: string
  createdAtMs?: number
  sourceChanged?: boolean
  workspaceKey?: string
  workspaceName?: string
  workspaceEphemeral?: boolean
}

interface ThreadRow {
  id: string
  title: string | null
  first_user_message: string | null
  cwd: string | null
  archived: number | null
  thread_source: string | null
  source: string | null
  model: string | null
  model_provider: string | null
  name: string | null
  created_at_ms: number | null
  updated_at_ms: number | null
}

interface ItemRow {
  turn_id: string
  item_id: string
  rollout_ordinal: number
  created_at_ms: number | null
  started_at_ms: number | null
  completed_at_ms: number | null
  item_type: string
  item_json: string
}

interface ProjectInfo {
  id: string
  name: string
  roots: string[]
  createdAt: number
}

interface ThreadCount {
  items: number
  users: number
}

interface WorkspaceInfo {
  key: string
  name?: string
  cwd?: string
  createdAt: number
}

type Sqlite = import('node:sqlite').DatabaseSync

/** Drop the Win32 extended-length prefix; the rest of DSH compares plain paths. */
export function plainPath(value: string): string {
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`
  if (value.startsWith('\\\\?\\')) return value.slice(4)
  return value
}

function comparablePath(value: string): string {
  const path = plainPath(value).replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path
}

function isUnder(cwd: string, root: string): boolean {
  const target = comparablePath(cwd)
  const base = comparablePath(root)
  return target === base || target.startsWith(`${base}/`)
}

async function openDb(file: string): Promise<Sqlite> {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true })
  // Codex keeps writing while the picker scans; wait out a transient writer
  // instead of failing the whole provider with SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 2000')
  return db
}

/** The app bumps `state_N` / `thread_history_N`; follow the newest one. */
async function resolveDbFile(root: string, configured: string, prefix: string): Promise<string> {
  try {
    const pattern = new RegExp(`^${prefix}_(\\d+)\\.sqlite$`)
    const candidates = (await readdir(root))
      .map(name => ({ name, match: pattern.exec(name) }))
      .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
      .sort((left, right) => Number(right.match[1]) - Number(left.match[1]))
    const newest = candidates[0]
    if (newest !== undefined) return join(root, newest.name)
  } catch {
    // Fall through to the configured name so the caller reports a usable path.
  }
  return join(root, configured)
}

interface CodexLayout {
  stateFile: string
  historyFile: string
  projects: Map<string, ProjectInfo>
  assignments: Map<string, string>
}

async function readProjects(root: string, config: CodexDbConfig): Promise<{
  projects: Map<string, ProjectInfo>
  assignments: Map<string, string>
}> {
  const projects = new Map<string, ProjectInfo>()
  const assignments = new Map<string, string>()
  if (config.globalState === undefined) return { projects, assignments }
  let state: Record<string, unknown>
  try {
    state = JSON.parse(await readFile(join(root, config.globalState), 'utf8')) as Record<string, unknown>
  } catch {
    return { projects, assignments }
  }
  const rawProjects = state['local-projects']
  if (rawProjects !== null && typeof rawProjects === 'object') {
    for (const raw of Object.values(rawProjects as Record<string, unknown>)) {
      if (raw === null || typeof raw !== 'object') continue
      const project = raw as { id?: unknown; name?: unknown; rootPaths?: unknown; createdAt?: unknown }
      if (typeof project.id !== 'string' || typeof project.name !== 'string') continue
      const roots = Array.isArray(project.rootPaths)
        ? project.rootPaths.filter((path): path is string => typeof path === 'string' && path !== '')
        : []
      projects.set(project.id, {
        id: project.id,
        name: project.name,
        roots,
        createdAt: typeof project.createdAt === 'number' ? project.createdAt : 0,
      })
    }
  }
  const rawAssignments = state['thread-project-assignments']
  if (rawAssignments !== null && typeof rawAssignments === 'object') {
    for (const [threadId, raw] of Object.entries(rawAssignments as Record<string, unknown>)) {
      if (raw === null || typeof raw !== 'object') continue
      const assignment = raw as { projectKind?: unknown; projectId?: unknown }
      if (assignment.projectKind === 'remote') continue
      if (typeof assignment.projectId === 'string') assignments.set(threadId, assignment.projectId)
    }
  }
  return { projects, assignments }
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

async function loadLayout(options: CodexDbOptions): Promise<CodexLayout> {
  const stateFile = await resolveDbFile(options.root, options.database.state, 'state')
  const historyFile = await resolveDbFile(options.root, options.database.history, 'thread_history')
  const { projects, assignments } = await readProjects(options.root, options.database)
  return { stateFile, historyFile, projects, assignments }
}

/** Longest project root containing the thread cwd. */
function projectForCwd(
  cwd: string,
  projects: Map<string, ProjectInfo>,
): { project: ProjectInfo; root: string } | undefined {
  let best: { project: ProjectInfo; root: string } | undefined
  for (const project of projects.values()) {
    for (const root of project.roots) {
      if (!isUnder(cwd, root)) continue
      if (best === undefined || root.length > best.root.length) best = { project, root }
    }
  }
  return best
}

function workspaceFor(
  thread: ThreadRow,
  layout: CodexLayout,
): { workspace: WorkspaceInfo; cwd?: string; ephemeral?: boolean } {
  const cwd = thread.cwd === null ? undefined : plainPath(thread.cwd)
  const assigned = layout.assignments.get(thread.id)
  const project = assigned === undefined ? undefined : layout.projects.get(assigned)
  if (project !== undefined) {
    const root = cwd === undefined
      ? project.roots[0]
      : projectForCwd(cwd, new Map([[project.id, project]]))?.root ?? project.roots[0]
    return {
      workspace: {
        key: `codex-project:${project.id}`,
        name: project.name,
        ...(root === undefined ? {} : { cwd: plainPath(root) }),
        createdAt: project.createdAt,
      },
      ...(root === undefined && cwd === undefined ? {} : { cwd: plainPath(root ?? cwd ?? '') }),
    }
  }
  const inferred = cwd === undefined ? undefined : projectForCwd(cwd, layout.projects)
  if (inferred !== undefined) {
    return {
      workspace: {
        key: `codex-project:${inferred.project.id}`,
        name: inferred.project.name,
        cwd: plainPath(inferred.root),
        createdAt: inferred.project.createdAt,
      },
      cwd: plainPath(inferred.root),
    }
  }
  const createdAt = thread.created_at_ms ?? 0
  // The Codex sidebar keeps projectless chats out of the project list. Mirror
  // that: one "chats" group, still imported into each thread's own cwd.
  return {
    workspace: {
      key: 'codex-chats',
      name: '聊天',
      ...(cwd === undefined ? {} : { cwd }),
      createdAt,
    },
    ...(cwd === undefined ? {} : { cwd }),
    ephemeral: true,
  }
}

function titleOf(thread: ThreadRow, options: CodexDbOptions): string | undefined {
  const fields = options.titleFields !== undefined && options.titleFields.length > 0
    ? options.titleFields
    : ['name', 'title']
  let raw: string | undefined
  for (const field of fields) {
    const value = (thread as unknown as Record<string, unknown>)[field]
    if (typeof value === 'string' && value.trim() !== '') {
      raw = value
      break
    }
  }
  if (raw === undefined && options.fromFirstUserMessage !== false) {
    raw = thread.first_user_message ?? undefined
  }
  if (raw === undefined || raw.trim() === '') return undefined
  const cleaned = cleanTitleText(raw)
  return cleaned ?? raw.trim().slice(0, 80)
}

/** Source path is opaque: the host must never stat it. */
function sourcePathOf(layout: CodexLayout, threadId: string): string {
  return `${layout.stateFile}#thread=${threadId}`
}

function fingerprintOf(threadId: string, itemCount: number, updatedAt: number): {
  bytes: number
  mtimeMs: number
  headHash: string
} {
  return {
    bytes: itemCount,
    mtimeMs: updatedAt,
    headHash: createHash('sha256').update(`codex-db:${threadId}`).digest('hex').slice(0, 16),
  }
}

function sameSourcePath(left: string, right: string): boolean {
  return left.replace(/\\/g, '/').toLowerCase() === right.replace(/\\/g, '/').toLowerCase()
}

function isIgnored(
  title: string | undefined,
  cwd: string | undefined,
  ignore: CodexDbOptions['ignore'],
): boolean {
  if (ignore === undefined) return false
  if (ignore.titlePrefixes?.some(prefix => title?.startsWith(prefix) === true) === true) return true
  return ignore.sessions?.some(rule => {
    if (rule.cwdContains === undefined && rule.title === undefined) return false
    const cwdHit = rule.cwdContains === undefined
      || cwd?.toLowerCase().includes(rule.cwdContains.toLowerCase()) === true
    const titleHit = rule.title === undefined || title === rule.title
    return cwdHit && titleHit
  }) === true
}

/**
 * List every user-visible Codex thread with finished turns. Item counts of
 * finished turns double as the source fingerprint: metadata-only rewrites
 * change `updated_at_ms` but not the mapped content.
 */
export async function scanCodexDb(
  options: CodexDbOptions,
  records: Record<string, ImportRecord> = {},
): Promise<CodexDbScanRow[]> {
  const layout = await loadLayout(options)
  if (!(await exists(layout.stateFile)) || !(await exists(layout.historyFile))) return []
  const meta = await openDb(layout.stateFile)
  const history = await openDb(layout.historyFile)
  try {
    const threads = meta.prepare(
      `SELECT id, title, first_user_message, cwd, archived, thread_source, source,
              model, model_provider, name, created_at_ms, updated_at_ms
       FROM threads`,
    ).all() as unknown as ThreadRow[]
    const counts = new Map<string, ThreadCount>()
    const rows = history.prepare(
      `SELECT i.thread_id AS id,
              COUNT(*) AS items,
              SUM(CASE WHEN i.item_type = 'userMessage' THEN 1 ELSE 0 END) AS users
       FROM thread_items i
       JOIN thread_turns t
         ON t.thread_id = i.thread_id AND t.turn_id = i.turn_id
       WHERE t.status <> 'inProgress'
       GROUP BY i.thread_id`,
    ).all() as unknown as Array<{ id: string; items: number; users: number }>
    for (const row of rows) counts.set(row.id, { items: Number(row.items), users: Number(row.users) })

    const scanned: CodexDbScanRow[] = []
    for (const thread of threads) {
      const record = records[recordKey(options.providerId, thread.id)]
      // Archived threads and threads without finished turns stay hidden unless
      // this plugin already imported one: its retract entry must survive.
      if (thread.archived === 1 && record === undefined) continue
      // Internal subagent threads (including older rows whose source is a JSON
      // spawn marker but whose thread_source was never backfilled) are not in
      // the Codex sidebar and must not enter the picker.
      if (thread.thread_source !== null && thread.thread_source !== 'user') continue
      if (thread.source?.trimStart().startsWith('{') === true) continue
      const count = counts.get(thread.id)
      if ((count === undefined || count.users === 0) && record === undefined) continue
      const { workspace, cwd, ephemeral } = workspaceFor(thread, layout)
      const title = titleOf(thread, options)
      if (isIgnored(title, cwd, options.ignore) && record === undefined) continue
      const updatedAt = thread.updated_at_ms ?? thread.created_at_ms ?? 0
      const sourcePath = sourcePathOf(layout, thread.id)
      const itemCount = count?.items ?? 0
      const fingerprint = fingerprintOf(thread.id, itemCount, updatedAt)
      let status: CodexDbScanRow['status'] = 'new'
      let sourceChanged = false
      if (record !== undefined) {
        if (record.status === 'failed') {
          status = 'failed'
        } else if (count === undefined) {
          status = 'imported'
        } else if (!sameSourcePath(record.sourcePath, sourcePath)) {
          // The ledger points at an old rollout file; the database is now the
          // authoritative source and the import will rebuild from it.
          status = 'grown'
          sourceChanged = true
        } else {
          const unchanged = record.fingerprint.bytes === fingerprint.bytes
            && (record.fingerprint.mtimeMs === fingerprint.mtimeMs
              || record.fingerprint.headHash === fingerprint.headHash)
          status = unchanged ? 'imported' : 'grown'
        }
      }
      scanned.push({
        providerId: options.providerId,
        sourcePath,
        sourceSessionId: thread.id,
        directory: options.root,
        bytes: itemCount,
        mtimeMs: updatedAt,
        status,
        ...(title === undefined ? {} : { title }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(workspace.createdAt === 0 ? {} : { createdAtMs: workspace.createdAt }),
        ...(workspace.name === undefined ? {} : { workspaceName: workspace.name }),
        workspaceKey: workspace.key,
        ...(ephemeral === true ? { workspaceEphemeral: true } : {}),
        ...(record === undefined ? {} : { dshSessionId: record.dshSessionId }),
        ...(sourceChanged ? { sourceChanged: true } : {}),
      })
    }
    return scanned.sort((left, right) => right.mtimeMs - left.mtimeMs)
  } finally {
    meta.close()
    history.close()
  }
}

/** Context Codex wraps around the actual request before storing the item. */
const REQUEST_MARKERS = ['## My request for Codex:', '## My request:']
const IDE_CONTEXT_PREFIX = '# Context from my IDE setup'
const SYNTHETIC_USER_PREFIXES = [
  '<environment_context',
  '<user_instructions',
  '<INSTRUCTIONS',
  '<app-context',
  '<send_user_message_question',
  '<turn_aborted',
]

/** Strip the IDE wrapper; return undefined for machine-only user items. */
function userTextOf(raw: string, stats: ParseStats): string | undefined {
  let text = raw
  let marker = -1
  let markerLength = 0
  for (const candidate of REQUEST_MARKERS) {
    const index = text.lastIndexOf(candidate)
    if (index > marker) {
      marker = index
      markerLength = candidate.length
    }
  }
  if (marker >= 0) text = text.slice(marker + markerLength)
  else if (text.trimStart().startsWith(IDE_CONTEXT_PREFIX)) {
    stats.injectedUserMessages += 1
    return undefined
  }
  text = text.trim()
  if (SYNTHETIC_USER_PREFIXES.some(prefix => text.startsWith(prefix))) {
    stats.injectedUserMessages += 1
    return undefined
  }
  return text
}

function reasoningText(item: Record<string, unknown>): string {
  const parts: string[] = []
  for (const key of ['summary', 'content']) {
    const blocks = item[key]
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      const text = typeof block === 'string'
        ? block
        : block !== null && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
          ? (block as { text: string }).text
          : undefined
      if (text !== undefined && text.trim() !== '' && !parts.includes(text)) parts.push(text)
    }
  }
  return parts.join('\n\n')
}

function blockText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const type = (block as { type?: unknown }).type
    if (type !== 'text' && type !== 'input_text' && type !== 'output_text') continue
    const text = (block as { text?: unknown }).text
    if (typeof text === 'string' && text !== '') parts.push(text)
  }
  return parts.join('\n\n')
}

function mcpResultText(result: unknown): string {
  if (result === null || result === undefined) return ''
  if (typeof result === 'string') return result
  if (typeof result === 'object') {
    const content = (result as { content?: unknown }).content
    if (Array.isArray(content)) {
      const parts = content.map(part => {
        if (part === null || typeof part !== 'object') return ''
        const text = (part as { text?: unknown }).text
        if (typeof text === 'string') return text
        const resource = (part as { resource?: unknown }).resource
        if (resource !== null && typeof resource === 'object') {
          const resourceText = (resource as { text?: unknown }).text
          if (typeof resourceText === 'string') return resourceText
        }
        return ''
      }).filter(part => part !== '')
      if (parts.length > 0) return parts.join('\n\n')
    }
  }
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

function toolResultText(item: Record<string, unknown>): string {
  if (typeof item['aggregatedOutput'] === 'string') return item['aggregatedOutput']
  if (typeof item['error'] === 'string') return item['error']
  return ''
}

function changeResultText(item: Record<string, unknown>): string {
  const changes = Array.isArray(item['changes']) ? item['changes'] : []
  const parts: string[] = []
  for (const change of changes) {
    if (change === null || typeof change !== 'object') continue
    const path = (change as { path?: unknown }).path
    const diff = (change as { diff?: unknown }).diff
    const kind = (change as { kind?: unknown }).kind
    const label = kind !== null && typeof kind === 'object'
      ? typeof (kind as { type?: unknown }).type === 'string' ? (kind as { type: string }).type : 'update'
      : 'update'
    parts.push([
      typeof path === 'string' ? `${label}: ${path}` : label,
      typeof diff === 'string' ? diff : '',
    ].filter(part => part !== '').join('\n'))
  }
  return parts.join('\n\n')
}

function contentItemsText(item: Record<string, unknown>): string {
  const items = Array.isArray(item['contentItems']) ? item['contentItems'] : []
  return items.map(entry => {
    if (entry === null || typeof entry !== 'object') return ''
    const text = (entry as { text?: unknown }).text
    return typeof text === 'string' ? text : ''
  }).filter(text => text !== '').join('\n\n')
}

function finiteTime(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

/**
 * Parse one thread. Only finished turns are read, so a running Codex turn
 * never becomes a half-imported DSH turn that a later append cannot extend.
 */
export async function parseCodexDb(
  threadId: string,
  options: CodexDbOptions,
): Promise<ParsedSession> {
  if (threadId === '') throw new Error('Codex 会话 ID 为空')
  const layout = await loadLayout(options)
  const meta = await openDb(layout.stateFile)
  let thread: ThreadRow | undefined
  let rows: ItemRow[] = []
  try {
    thread = meta.prepare(
      `SELECT id, title, first_user_message, cwd, archived, thread_source, source,
              model, model_provider, name, created_at_ms, updated_at_ms
       FROM threads WHERE id = ?`,
    ).get(threadId) as unknown as ThreadRow | undefined
    if (thread === undefined) throw new Error(`Codex 数据库中没有会话 ${threadId}`)
    const history = await openDb(layout.historyFile)
    try {
      rows = history.prepare(
        `SELECT i.turn_id, i.item_id, i.rollout_ordinal, i.created_at_ms,
                i.started_at_ms, i.completed_at_ms, i.item_type, i.item_json
         FROM thread_items i
         JOIN thread_turns t
           ON t.thread_id = i.thread_id AND t.turn_id = i.turn_id
         WHERE i.thread_id = ? AND t.status <> 'inProgress'
         ORDER BY i.rollout_ordinal ASC`,
      ).all(threadId) as unknown as ItemRow[]
    } finally {
      history.close()
    }
  } finally {
    meta.close()
  }

  const stats: ParseStats = {
    lines: rows.length,
    badLines: 0,
    records: rows.length,
    mainlineRecords: rows.length,
    sidechainRecords: 0,
    compactBoundaries: 0,
    injectedUserMessages: 0,
    ignoredTypes: {},
    blocks: {},
  }
  const { workspace, cwd } = workspaceFor(thread, layout)
  const title = titleOf(thread, options)
  const model = thread.model ?? thread.model_provider ?? undefined
  const events: SourceEvent[] = []
  let startedAt: number | undefined
  let endedAt: number | undefined
  const push = (event: SourceEvent): void => {
    if (startedAt === undefined) startedAt = event.time
    endedAt = event.time
    events.push(event)
  }
  const ignored = (type: string): void => {
    stats.ignoredTypes[type] = (stats.ignoredTypes[type] ?? 0) + 1
  }

  for (const row of rows) {
    let item: Record<string, unknown>
    try {
      item = JSON.parse(row.item_json) as Record<string, unknown>
    } catch {
      stats.badLines += 1
      continue
    }
    const type = row.item_type === '' ? String(item['type'] ?? '') : row.item_type
    const created = finiteTime(row.created_at_ms, row.started_at_ms, row.completed_at_ms)
    const started = finiteTime(row.started_at_ms, row.created_at_ms, row.completed_at_ms)
    const completed = finiteTime(row.completed_at_ms, row.created_at_ms, row.started_at_ms)
    const time = created ?? started ?? completed
    if (time === undefined) {
      stats.badLines += 1
      continue
    }
    const callId = typeof item['id'] === 'string' ? item['id'] : row.item_id

    if (type === 'userMessage') {
      const content = item['content']
      const images: SourceImage[] = []
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block === null || typeof block !== 'object') continue
          const blockType = (block as { type?: unknown }).type
          stats.blocks[String(blockType ?? 'unknown')] = (stats.blocks[String(blockType ?? 'unknown')] ?? 0) + 1
          if (blockType === 'localImage') {
            const path = (block as { path?: unknown }).path
            if (typeof path === 'string' && path !== '') images.push({ localPath: plainPath(path) })
          } else if (blockType === 'image' || blockType === 'inputImage') {
            const url = (block as { url?: unknown }).url
            if (typeof url === 'string' && url !== '') images.push({ url })
          }
        }
      }
      const text = userTextOf(blockText(content), stats)
      if (text === undefined || (text === '' && images.length === 0)) continue
      push({ kind: 'turn-boundary', time })
      push({
        kind: 'user',
        time,
        text,
        ...(images.length === 0 ? {} : { images }),
      })
      continue
    }
    if (type === 'agentMessage') {
      const text = typeof item['text'] === 'string' ? item['text'] : ''
      if (text.trim() === '') {
        ignored(type)
        continue
      }
      push({ kind: 'assistant', time: completed ?? time, text, ...(model === undefined ? {} : { model }) })
      continue
    }
    if (type === 'reasoning') {
      const text = reasoningText(item)
      if (text === '') {
        ignored('reasoning:encrypted')
        continue
      }
      push({ kind: 'reasoning', time: started ?? time, text })
      continue
    }
    if (type === 'plan') {
      const text = typeof item['text'] === 'string' ? item['text'] : ''
      if (text.trim() === '') {
        ignored(type)
        continue
      }
      // The plan is model-authored content the Codex UI shows as a document.
      push({ kind: 'assistant', time: completed ?? time, text, ...(model === undefined ? {} : { model }) })
      continue
    }
    if (type === 'commandExecution') {
      const command = typeof item['command'] === 'string' ? item['command'] : ''
      const workdir = typeof item['cwd'] === 'string' ? plainPath(item['cwd']) : cwd
      push({
        kind: 'tool-call',
        time: started ?? time,
        callId,
        name: 'exec',
        args: JSON.stringify({ command, ...(workdir === undefined ? {} : { cwd: workdir }) }),
      })
      const output = toolResultText(item)
      const status = typeof item['status'] === 'string' ? item['status'] : ''
      const exitCode = typeof item['exitCode'] === 'number' ? item['exitCode'] : undefined
      push({
        kind: 'tool-result',
        time: completed ?? time,
        callId,
        text: output,
        ...(status !== '' && status !== 'completed' || (exitCode !== undefined && exitCode !== 0)
          ? { isError: true }
          : {}),
      })
      continue
    }
    if (type === 'fileChange') {
      const changes = Array.isArray(item['changes']) ? item['changes'] : []
      push({
        kind: 'tool-call',
        time: started ?? time,
        callId,
        name: 'apply_patch',
        args: JSON.stringify({
          changes: changes.map(change => {
            if (change === null || typeof change !== 'object') return {}
            const path = (change as { path?: unknown }).path
            const kind = (change as { kind?: unknown }).kind
            return {
              ...(typeof path === 'string' ? { path } : {}),
              ...(kind !== null && typeof kind === 'object' && typeof (kind as { type?: unknown }).type === 'string'
                ? { kind: (kind as { type: string }).type }
                : {}),
            }
          }),
        }),
      })
      push({
        kind: 'tool-result',
        time: completed ?? time,
        callId,
        text: changeResultText(item),
        ...(item['status'] !== undefined && item['status'] !== 'completed' ? { isError: true } : {}),
      })
      continue
    }
    if (type === 'mcpToolCall') {
      const server = typeof item['server'] === 'string' ? item['server'] : 'mcp'
      const tool = typeof item['tool'] === 'string' ? item['tool'] : 'call'
      const args = item['arguments']
      push({
        kind: 'tool-call',
        time: started ?? time,
        callId,
        name: `${server}/${tool}`,
        args: (() => {
          try {
            return JSON.stringify(args ?? {})
          } catch {
            return String(args)
          }
        })(),
      })
      push({
        kind: 'tool-result',
        time: completed ?? time,
        callId,
        text: mcpResultText(item['result']) || mcpResultText(item['error']),
        ...(item['status'] !== undefined && item['status'] !== 'completed' ? { isError: true } : {}),
      })
      continue
    }
    if (type === 'webSearch') {
      const query = typeof item['query'] === 'string' ? item['query'] : ''
      push({
        kind: 'tool-call',
        time: started ?? time,
        callId,
        name: 'web_search',
        args: JSON.stringify({ query }),
      })
      const results = item['results']
      const text = results === null || results === undefined
        ? (query === '' ? '搜索完成' : `搜索完成：${query}`)
        : (() => {
            try {
              return JSON.stringify(results)
            } catch {
              return String(results)
            }
          })()
      push({ kind: 'tool-result', time: completed ?? time, callId, text })
      continue
    }
    if (type === 'dynamicToolCall') {
      const namespace = typeof item['namespace'] === 'string' ? item['namespace'] : ''
      const tool = typeof item['tool'] === 'string' ? item['tool'] : 'call'
      const args = item['arguments']
      push({
        kind: 'tool-call',
        time: started ?? time,
        callId,
        name: namespace === '' ? tool : `${namespace}/${tool}`,
        args: (() => {
          try {
            return JSON.stringify(args ?? {})
          } catch {
            return String(args)
          }
        })(),
      })
      push({
        kind: 'tool-result',
        time: completed ?? time,
        callId,
        text: contentItemsText(item),
        ...(item['status'] !== undefined && item['status'] !== 'completed' ? { isError: true } : {}),
      })
      continue
    }
    if (type === 'contextCompaction') {
      stats.compactBoundaries += 1
      continue
    }
    // imageView/imageGeneration/subAgentActivity/sleep/collabAgentToolCall and
    // unknown item types carry no user-visible conversation text.
    ignored(type)
  }

  if (events.length === 0) {
    throw new Error(`Codex 会话 ${threadId} 没有可导入的已完成回合`)
  }

  const updatedAt = thread.updated_at_ms ?? thread.created_at_ms ?? endedAt ?? Date.now()
  return {
    sourceSessionId: threadId,
    providerId: options.providerId,
    sourcePath: sourcePathOf(layout, threadId),
    fingerprint: fingerprintOf(threadId, rows.length, updatedAt),
    ...(workspace.cwd === undefined ? {} : { cwd: workspace.cwd }),
    ...(title === undefined ? {} : { title }),
    startedAt: thread.created_at_ms ?? startedAt,
    endedAt,
    lineageId: threadId,
    events,
    stats,
  }
}

/** Provider-level config fallback for hosts that pass a family without assets. */
export const DEFAULT_CODEX_DB: CodexDbConfig = {
  state: 'state_5.sqlite',
  history: 'thread_history_1.sqlite',
  globalState: '.codex-global-state.json',
}
