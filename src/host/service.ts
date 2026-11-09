/**
 * Host-side service layer: provider discovery, session scanning, and the real
 * import run against DSH's own persistence.
 */
import { open, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import type { ImportOptions, ImportRecord, ImportResult, ParsedSession, ProviderDescriptor } from '../shared/types.ts'
import {
  importSession,
  sessionTitleEvent,
  type DshEvent,
  type PersistencePort,
  type ProjectionCachePort,
  type SessionHeaderLike,
} from './importer.ts'
import { cleanTitleText, parseClaudeJsonl } from './parsers/claude-jsonl.ts'
import { adaptFileLinks } from './file-links.ts'
import { ImportStateStore, recordKey } from './state.ts'
import { attachSessionToWorkspace, detachSessionFromWorkspaces, type AttachOutcome } from './workspaces.ts'

/**
 * Workspace membership port. DSH's live registry keeps the sidebar in sync, so
 * imports attach through it; the file writer below is only a fallback for hosts
 * that predate the service.
 */
export interface WorkspacePort {
  attach(sessionId: string, cwd: string | undefined): Promise<AttachOutcome>
  detach(sessionId: string): Promise<boolean>
}

/** Expand a `~`-prefixed path against the current user's home. */
export function expandHome(path: string): string {
  return path.startsWith('~') ? join(homedir(), path.slice(1)) : path
}

/** Roots declared for the current platform. */
export function rootsFor(provider: ProviderDescriptor): string[] {
  const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const roots = provider.assets.sessions?.roots[platform] ?? []
  return roots.map(expandHome)
}

export interface ScannedSession {
  /** Human-readable title hint from the source transcript. */
  title?: string
  providerId: string
  sourcePath: string
  sourceSessionId: string
  directory: string
  bytes: number
  mtimeMs: number
  /** Import state, from the idempotency ledger. */
  status: 'new' | 'imported' | 'grown' | 'failed'
  dshSessionId?: string
  /** Source workspace (cwd), used to group the picker like the source tool does. */
  cwd?: string
  /** Project-directory creation time; the picker orders workspaces by it. */
  createdAtMs?: number
}

/**
 * List candidate transcripts. Metadata only — no parsing, so the panel opens
 * instantly even with hundreds of files.
 */
export async function scanProvider(
  provider: ProviderDescriptor,
  records: Record<string, ImportRecord> = {},
): Promise<ScannedSession[]> {
  const glob = provider.assets.sessions?.layout.sessionGlob ?? '*/*.jsonl'
  const depth = glob.split('/').length - 1
  const out: ScannedSession[] = []

  for (const root of rootsFor(provider)) {
    let dirs: string[]
    try {
      const entries = await readdir(root, { withFileTypes: true })
      dirs = entries.filter(entry => entry.isDirectory()).map(entry => join(root, entry.name))
    } catch {
      continue
    }
    for (const dir of dirs) {
      if (depth > 1) continue
      let createdAtMs = 0
      try {
        createdAtMs = (await stat(dir)).birthtimeMs
      } catch {
        createdAtMs = 0
      }
      let files: string[]
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl')).map(entry => join(dir, entry.name))
      } catch {
        continue
      }
      for (const file of files) {
        try {
          const info = await stat(file)
          const snapshot = { bytes: info.size, mtimeMs: info.mtimeMs }
          const sessionId = basename(file, '.jsonl')
          const record = records[recordKey(provider.id, sessionId)]
          const status: ScannedSession['status'] =
            record === undefined
              ? 'new'
              : record.status === 'failed'
                ? 'failed'
                : record.fingerprint.bytes === snapshot.bytes && record.fingerprint.mtimeMs === snapshot.mtimeMs
                  ? 'imported'
                  : 'grown'
          const hint = await readSessionHint(file)
          out.push({
            providerId: provider.id,
            sourcePath: file,
            sourceSessionId: sessionId,
            directory: dir,
            bytes: info.size,
            mtimeMs: info.mtimeMs,
            ...(createdAtMs === 0 ? {} : { createdAtMs }),
            status,
            ...(hint.title === undefined ? {} : { title: hint.title }),
            ...(hint.cwd === undefined ? {} : { cwd: hint.cwd }),
            ...(record === undefined ? {} : { dshSessionId: record.dshSessionId }),
          })
        } catch {
          // ignore unreadable entries
        }
      }
    }
  }

  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * Cheap picker metadata: the source tool's own title (or first human message)
 * plus the workspace cwd, so the panel can group sessions by project the way
 * the source tool's sidebar does. Only the head of the file is read, so a
 * 60 MB transcript does not slow the list down.
 */
export async function readSessionHint(file: string): Promise<{ title?: string; cwd?: string }> {
  const HEAD_BYTES = 512 * 1024
  let text = ''
  try {
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(HEAD_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
      text = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return {}
  }

  let title: string | undefined
  let cwd: string | undefined
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (cwd === undefined) {
      if (record['type'] === 'workspace-directories') {
        const dirs = record['directories']
        if (Array.isArray(dirs) && typeof dirs[0] === 'string') cwd = dirs[0]
      }
      if (cwd === undefined && typeof record['cwd'] === 'string') cwd = record['cwd']
    }
    if (title === undefined) {
      for (const field of ['aiTitle', 'customTitle', 'title']) {
        const value = record[field]
        if (typeof value === 'string' && value.trim() !== '') {
          title = value.trim().slice(0, 80)
          break
        }
      }
    }
    if (title === undefined && record['type'] === 'user') {
      const message = record['message'] as { content?: unknown } | undefined
      const content = message?.content
      let raw: string | undefined
      if (typeof content === 'string') raw = content
      else if (Array.isArray(content)) {
        const first = content.find(block => (block as { type?: string })?.type === 'text') as { text?: string } | undefined
        if (typeof first?.text === 'string') raw = first.text
      }
      if (raw !== undefined) title = cleanTitleText(raw)
    }
    if (title !== undefined && cwd !== undefined) break
  }
  return { ...(title === undefined ? {} : { title }), ...(cwd === undefined ? {} : { cwd }) }
}

/**
 * Ledger entries whose DSH session log no longer exists are stale: the user
 * deleted the session itself, so the source must become importable again.
 * Deleting a *workspace* keeps session logs, so those entries stay.
 */
export async function loadLiveRecords(): Promise<Record<string, ImportRecord>> {
  const store = new ImportStateStore(join(dshHome(), 'session-import', 'state.json'))
  const records = await store.load()
  const sessionsRoot = join(dshHome(), 'sessions')
  const alive = new Set<string>()
  try {
    for (const project of await readdir(sessionsRoot, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      for (const entry of await readdir(join(sessionsRoot, project.name), { withFileTypes: true })) {
        if (entry.isDirectory()) alive.add(entry.name)
      }
    }
  } catch {
    return records
  }
  let changed = false
  for (const record of Object.values(records)) {
    if (alive.has(record.dshSessionId)) continue
    await store.remove(record.providerId, record.sourceSessionId)
    changed = true
  }
  return changed ? store.load() : records
}

export interface RetractResult {
  providerId: string
  sourceSessionId: string
  dshSessionId: string
  removedPaths: string[]
  /** The session was resident in the running host and had to be torn down first. */
  evicted: boolean
}

/**
 * Host-side lifecycle hooks for a resident Session.
 *
 * A Session that was ever opened stays in `ctx.sessions`/`ctx.agents` for the
 * life of the process. Deleting its log behind that resident instance leaves a
 * ghost row in `session/list`, so retraction must first tear the instance down.
 */
export interface RetractRuntime {
  /** `running`, `idle`, or another lifecycle state; undefined when cold. */
  liveStatus(sessionId: string): string | undefined
  /** Stop the agent and unregister both the agent and its session. */
  evict(sessionId: string): Promise<void>
}

/**
 * Delete an imported session and its bookkeeping.
 *
 * DSH exposes no delete API, so this removes the session directory. Safety is
 * deliberate: only ids this plugin created (`import-` prefix) may be removed,
 * and only when the ledger has a record for them. A resident Session is torn
 * down through {@link RetractRuntime} first; deletion failures are surfaced
 * instead of silently dropping the ledger entry.
 */
export async function retractImport(
  providerId: string,
  sourceSessionId: string,
  workspace?: WorkspacePort,
  runtime?: RetractRuntime,
): Promise<RetractResult> {
  const store = new ImportStateStore(join(dshHome(), 'session-import', 'state.json'))
  const record = (await store.load())[recordKey(providerId, sourceSessionId)]
  if (record === undefined) throw new Error('没有导入记录，无法撤回')
  if (!record.dshSessionId.startsWith('import-')) {
    throw new Error(`拒绝删除非本插件创建的会话：${record.dshSessionId}`)
  }

  const status = runtime?.liveStatus(record.dshSessionId)
  if (status === 'running') throw new Error('该会话正在生成回复，请等本轮结束后再撤回')
  if (status !== undefined) {
    if (runtime === undefined) throw new Error('该会话正在 DSH 中运行，请重启 DSH 后再撤回')
    await runtime.evict(record.dshSessionId)
  }

  const removedPaths: string[] = []
  const sessionsRoot = join(dshHome(), 'sessions')
  let projectDirs: string[] = []
  try {
    projectDirs = (await readdir(sessionsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => join(sessionsRoot, entry.name))
  } catch {
    projectDirs = []
  }

  for (const projectDir of projectDirs) {
    const candidate = join(projectDir, record.dshSessionId)
    let info
    try {
      info = await stat(candidate)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new Error(`无法检查会话文件：${cause instanceof Error ? cause.message : String(cause)}`)
    }
    if (!info.isDirectory()) continue
    try {
      await rm(candidate, { recursive: true, force: true })
    } catch (cause) {
      throw new Error(`删除会话文件失败：${cause instanceof Error ? cause.message : String(cause)}`)
    }
    removedPaths.push(candidate)
  }

  await (workspace === undefined
    ? detachSessionFromWorkspaces(dshHome(), record.dshSessionId)
    : workspace.detach(record.dshSessionId))
  await store.remove(providerId, sourceSessionId)
  return {
    providerId,
    sourceSessionId,
    dshSessionId: record.dshSessionId,
    removedPaths,
    evicted: status !== undefined,
  }
}

/**
 * Existing imports written before titles were logged show up as 「未命名」.
 * Append a deterministic `session/title` from the source title when missing,
 * then checkpoint the projection cache so the cold sidebar list can show the
 * title without the user opening the session first.
 */
export async function backfillTitles(
  persistence: PersistencePort,
  projections?: ProjectionCachePort,
): Promise<{ titled: number; warmed: number; scanned: number }> {
  const store = new ImportStateStore(join(dshHome(), 'session-import', 'state.json'))
  const records = await store.load()
  let titled = 0
  let warmed = 0
  let scanned = 0
  for (const record of Object.values(records)) {
    scanned += 1
    try {
      const header = (await persistence.stat?.(record.dshSessionId))?.header
      const handle = await persistence.open(record.dshSessionId, 'write')
      let events: readonly DshEvent[] | undefined
      try {
        const page = await handle.read()
        events = page.events
        if (!events.some(event => event.type === 'session/title')) {
          const hint = await readSessionHint(record.sourcePath)
          const titleEvent = sessionTitleEvent(hint.title, events)
          if (titleEvent !== undefined) {
            await handle.append([titleEvent])
            await handle.flush()
            events = [...events, titleEvent]
            titled += 1
          }
        }
      } finally {
        await handle.close()
      }
      if (projections !== undefined && header !== undefined && events !== undefined) {
        const ok = await warmProjectionCache(persistence, projections, record.dshSessionId, { header, events })
        if (ok) warmed += 1
      }
    } catch {
      // session is live/busy or its log disappeared; leave it for the next start
    }
  }
  return { titled, warmed, scanned }
}

const TITLE_PROJECTION_KEYS = ['title']
const CACHE_SETTLE_ATTEMPTS = 20
const CACHE_SETTLE_MS = 25

/**
 * Fold one stored log into DSH's persistent projection cache. The cold session
 * list serves a row's title only from this cache, so without a checkpoint an
 * imported session reads as 「未命名」 until someone opens it.
 *
 * The write-back is fire-and-forget in the cache service; poll the zero-I/O
 * face briefly so a list refresh issued right after import already sees it.
 */
export async function warmProjectionCache(
  persistence: PersistencePort,
  projections: ProjectionCachePort,
  sessionId: string,
  seed?: { header: SessionHeaderLike; events: readonly DshEvent[] },
): Promise<boolean> {
  try {
    const header = seed?.header ?? (await persistence.stat?.(sessionId))?.header
    if (header === undefined || header.isSeeded) return false
    let events = seed?.events
    if (events === undefined) {
      const handle = await persistence.open(sessionId, 'read')
      try {
        events = (await handle.read()).events
      } finally {
        await handle.close()
      }
    }
    projections.coldSnapshot(header, 0, events)
    if (!events.some(event => event.type === 'session/title')) return true
    if (projections.cachedSnapshot === undefined) return true
    for (let attempt = 0; attempt < CACHE_SETTLE_ATTEMPTS; attempt += 1) {
      const cached = projections.cachedSnapshot(header, TITLE_PROJECTION_KEYS)
      if (typeof cached?.values['title'] === 'string' && cached.values['title'] !== '') return true
      await new Promise(resolve => setTimeout(resolve, CACHE_SETTLE_MS))
    }
    console.warn('[dsh-session-import] 投影缓存未及时落盘：' + sessionId)
    return true
  } catch (cause) {
    console.warn('[dsh-session-import] 投影缓存预热失败：' + sessionId, cause)
    return false
  }
}

/** DSH-side home, used for the idempotency ledger. */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export interface ImportRequest {
  providerId: string
  sourcePath: string
  options: ImportOptions
  /** Provider rules for local file links; absent means leave source text as-is. */
  provider?: ProviderDescriptor
}

/**
 * Run one real import. `persistence` is DSH's own service, so the resulting
 * session is a first-class session: it appears in the sidebar and can be
 * resumed.
 */
export async function runImport(
  persistence: PersistencePort,
  request: ImportRequest,
  workspace?: WorkspacePort,
  projections?: ProjectionCachePort,
): Promise<ImportResult> {
  const parsed = await parseClaudeJsonl(request.sourcePath, {
    providerId: request.providerId,
  })
  const adapted = adaptFileLinks(parsed.events, request.provider?.fileLinks?.assistant, parsed.cwd)
  const session: ParsedSession =
    adapted.links === 0 ? parsed : { ...parsed, events: adapted.events }
  if (adapted.links > 0) {
    console.info(
      `[dsh-session-import] 文件链接: ${adapted.links} 处 -> ${adapted.files} 个文件（${session.sourceSessionId}）`,
    )
  }
  const state = new ImportStateStore(join(dshHome(), 'session-import', 'state.json'))
  const result = await importSession({ persistence, state }, session, request.options)

  if (result.status === 'imported' || result.status === 'appended') {
    if (projections !== undefined) {
      await warmProjectionCache(persistence, projections, result.dshSessionId)
    }

    // A session file on disk is not enough: the sidebar groups by the workspace
    // registry, so an unattached session shows up under 「未分组」.
    const cwd = session.cwd
    const outcome =
      workspace === undefined
        ? await attachSessionToWorkspace(dshHome(), result.dshSessionId, cwd)
        : await workspace.attach(result.dshSessionId, cwd)
    console.info('[dsh-session-import] 工作区挂载: ' + (outcome.attached ? outcome.workspacePath : outcome.reason))
    return outcome.attached ? { ...result, workspacePath: outcome.workspacePath } : result
  }
  return result
}
