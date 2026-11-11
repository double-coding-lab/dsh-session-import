/**
 * Host-side service layer: provider discovery, session scanning, and the real
 * import run against DSH's own persistence.
 */
import { createHash } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import type {
  DshImageRef,
  ImportOptions,
  ImportRecord,
  ImportResult,
  ParsedSession,
  ProviderDescriptor,
  SourceImage,
} from '../shared/types.ts'
import {
  importSession,
  sessionTitleEvent,
  type DshEvent,
  type FileResolverPort,
  type ImageResolverPort,
  type PersistencePort,
  type ProjectionCachePort,
  type ResolvedFileAttachment,
  type SessionHeaderLike,
} from './importer.ts'
import { cleanTitleText, parseClaudeJsonl } from './parsers/claude-jsonl.ts'
import { DEFAULT_CODEX_DB, parseCodexDb, scanCodexDb } from './parsers/codex-db.ts'
import { parseCodexJsonl } from './parsers/codex-jsonl.ts'
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

/** Bounded fan-out for per-file hint reads; keeps the picker warm-up short. */
const SCAN_CONCURRENCY = 16

/**
 * Per-file hint cache. A transcript's title/cwd only changes when the file
 * changes, so a stat match reuses the previous read; a cold scan after a DSH
 * restart then costs one stat per file instead of reading every head again.
 */
interface HintCacheEntry {
  bytes: number
  mtimeMs: number
  title?: string
  cwd?: string
  /** Same first-line hash the import ledger fingerprints. */
  headHash?: string
  /** First human-turn UUID shared by rewind branches. */
  lineageId?: string
  /** Newest user/assistant message time, used to pick the active branch. */
  lastMessageAt?: number
  /** Source tool's logical session id (Codex rollout session_meta). */
  sessionId?: string
  /** Start time of this rollout segment (Codex resume ordering). */
  segmentStartAt?: number
}

interface HintCache {
  version: 5
  entries: Record<string, HintCacheEntry>
}

let hintCache: HintCache | undefined
let hintCacheWrite: Promise<unknown> = Promise.resolve()

function hintCacheFile(): string {
  return join(dshHome(), 'session-import', 'scan-cache.json')
}

async function loadHintCache(): Promise<HintCache> {
  if (hintCache !== undefined) return hintCache
  try {
    const raw = JSON.parse(await readFile(hintCacheFile(), 'utf8')) as Partial<HintCache>
    if (raw.version === 5 && raw.entries !== null && typeof raw.entries === 'object') {
      hintCache = raw as HintCache
      return hintCache
    }
  } catch {
    // First run or an unreadable cache: start empty.
  }
  hintCache = { version: 5, entries: {} }
  return hintCache
}

function persistHintCache(): void {
  const snapshot = hintCache
  if (snapshot === undefined) return
  hintCacheWrite = hintCacheWrite.then(async () => {
    try {
      await mkdir(join(dshHome(), 'session-import'), { recursive: true })
      const file = hintCacheFile()
      const temp = `${file}.tmp-${process.pid}-${Date.now()}`
      await writeFile(temp, JSON.stringify(snapshot), 'utf8')
      await rename(temp, file)
    } catch (cause) {
      console.warn('[dsh-session-import] 扫描缓存写入失败', cause)
    }
  })
}

async function forEachConcurrent<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      await task(items[index])
    }
  })
  await Promise.all(workers)
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
  /** The active source branch differs from the imported one; re-import rebuilds. */
  branchChanged?: boolean
  /** The ledger points at another source form (e.g. old rollout, now DB). */
  sourceChanged?: boolean
  /** Ordered rollout files composing this row (segment lineage only). */
  sourcePaths?: string[]
  /** Source-tool project grouping (Codex Desktop projects). */
  workspaceKey?: string
  workspaceName?: string
  /** A projectless conversation, grouped like the source tool's "chats". */
  workspaceEphemeral?: boolean
}

/** Compare source paths the way Windows does (case-insensitive, either slash). */
function normalizeSourcePath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase()
}

function sameSourcePath(left: string, right: string): boolean {
  return normalizeSourcePath(left) === normalizeSourcePath(right)
}

function sameSourcePathList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => sameSourcePath(value, right[index] ?? ''))
}

/** One scanned transcript; lineage fields are scan-internal. */
interface PendingScan extends ScannedSession {
  lineageId?: string
  lastMessageAt?: number
  headHash?: string
  segmentStartAt?: number
  record?: ImportRecord
}

/**
 * List candidate transcripts. Metadata only — no parsing, so the panel opens
 * instantly even with hundreds of files.
 */
export async function scanProvider(
  provider: ProviderDescriptor,
  records: Record<string, ImportRecord> = {},
): Promise<ScannedSession[]> {
  const sessionsAsset = provider.assets.sessions
  if (provider.family === 'codex-db') {
    return scanCodexDb({
      providerId: provider.id,
      root: rootsFor(provider)[0] ?? expandHome('~/.codex'),
      database: sessionsAsset?.layout.database ?? DEFAULT_CODEX_DB,
      ...(sessionsAsset?.title?.fields === undefined ? {} : { titleFields: sessionsAsset.title.fields }),
      ...(sessionsAsset?.title?.fromFirstUserMessage === undefined
        ? {}
        : { fromFirstUserMessage: sessionsAsset.title.fromFirstUserMessage }),
      ...(sessionsAsset?.ignore === undefined ? {} : { ignore: sessionsAsset.ignore }),
    }, records)
  }
  const layout = provider.assets.sessions?.layout
  const globs = layout?.sessionGlobs !== undefined && layout.sessionGlobs.length > 0
    ? [...new Set([layout.sessionGlob, ...layout.sessionGlobs])]
    : [layout?.sessionGlob ?? '*/*.jsonl']
  const entries: PendingScan[] = []
  const roots = rootsFor(provider)
  // A rebuilt rewind branch keeps the ledger identity of the branch that was
  // first imported, so the active file is bound by its recorded path too.
  const recordsByPath = new Map<string, ImportRecord>()
  for (const record of Object.values(records)) {
    if (record.providerId !== provider.id) continue
    recordsByPath.set(normalizeSourcePath(record.sourcePath), record)
  }
  const cache = await loadHintCache()
  const seen = new Set<string>()
  let cacheDirty = false
  let enumerationComplete = true

  const tasks: Array<{ file: string; dir: string; createdAtMs: number }> = []
  const taskPaths = new Set<string>()
  const addDirectoryFiles = async (dir: string, createdAtMs: number): Promise<void> => {
    try {
      const dirEntries = await readdir(dir, { withFileTypes: true })
      for (const entry of dirEntries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        const file = join(dir, entry.name)
        if (taskPaths.has(file)) continue
        taskPaths.add(file)
        tasks.push({ file, dir, createdAtMs })
      }
    } catch {
      enumerationComplete = false
    }
  }
  const walk = async (dir: string, remaining: number): Promise<void> => {
    if (remaining <= 0) {
      let createdAtMs = 0
      try {
        createdAtMs = (await stat(dir)).birthtimeMs
      } catch {
        createdAtMs = 0
      }
      await addDirectoryFiles(dir, createdAtMs)
      return
    }
    let subdirs: string[]
    try {
      const dirEntries = await readdir(dir, { withFileTypes: true })
      subdirs = dirEntries.filter(entry => entry.isDirectory()).map(entry => join(dir, entry.name))
    } catch {
      enumerationComplete = false
      return
    }
    for (const sub of subdirs) await walk(sub, remaining - 1)
  }
  for (const root of roots) {
    for (const glob of globs) {
      const depth = Math.min(8, Math.max(0, glob.split('/').length - 1))
      await walk(root, depth)
    }
  }

  // A rebuilt rewind branch keeps the ledger identity of the branch that was
  // first imported; when its recorded path is present it owns the record, and
  // the abandoned branch carrying the same session id must not claim it.
  const scannedPaths = new Set(tasks.map(task => normalizeSourcePath(task.file)))
  const recordedPaths = new Set<string>()
  for (const record of recordsByPath.values()) {
    for (const key of record.sourcePaths ?? [record.sourcePath]) {
      const normalized = normalizeSourcePath(key)
      if (scannedPaths.has(normalized)) recordedPaths.add(normalized)
    }
  }
  const lineageMode = provider.assets.sessions?.lineage?.mode ?? 'branch'

  await forEachConcurrent(tasks, SCAN_CONCURRENCY, async ({ file, dir, createdAtMs }) => {
        try {
          const info = await stat(file)
          const snapshot = { bytes: info.size, mtimeMs: info.mtimeMs }
          const fileSessionId = basename(file, '.jsonl')
          seen.add(file)
          const cached = cache.entries[file]
          let hint: {
            title?: string
            cwd?: string
            headHash?: string
            lineageId?: string
            lastMessageAt?: number
            sessionId?: string
            segmentStartAt?: number
          }
          if (cached !== undefined && cached.bytes === snapshot.bytes && cached.mtimeMs === snapshot.mtimeMs) {
            hint = {
              ...(cached.title === undefined ? {} : { title: cached.title }),
              ...(cached.cwd === undefined ? {} : { cwd: cached.cwd }),
              ...(cached.headHash === undefined ? {} : { headHash: cached.headHash }),
              ...(cached.lineageId === undefined ? {} : { lineageId: cached.lineageId }),
              ...(cached.lastMessageAt === undefined ? {} : { lastMessageAt: cached.lastMessageAt }),
              ...(cached.sessionId === undefined ? {} : { sessionId: cached.sessionId }),
              ...(cached.segmentStartAt === undefined ? {} : { segmentStartAt: cached.segmentStartAt }),
            }
          } else {
            hint = await readSessionHint(file)
            cache.entries[file] = { bytes: snapshot.bytes, mtimeMs: snapshot.mtimeMs, ...hint }
            cacheDirty = true
          }
          const sessionId = hint.sessionId ?? fileSessionId
          const pathRecord = recordsByPath.get(normalizeSourcePath(file))
          const idRecord = records[recordKey(provider.id, sessionId)]
          const record = pathRecord
            ?? (idRecord !== undefined
              && (lineageMode === 'segments' || !recordedPaths.has(normalizeSourcePath(idRecord.sourcePath)))
              ? idRecord
              : undefined)
          // Source tools rewrite metadata records (titles, last-prompt) in place,
          // so an mtime-only change is not "grown" when bytes and the transcript
          // head still match the imported fingerprint.
          const contentUnchanged = record !== undefined
            && record.fingerprint.bytes === snapshot.bytes
            && (record.fingerprint.mtimeMs === snapshot.mtimeMs
              || (hint.headHash !== undefined && record.fingerprint.headHash === hint.headHash))
          const status: ScannedSession['status'] =
            record === undefined
              ? 'new'
              : record.status === 'failed'
                ? 'failed'
                : contentUnchanged
                  ? 'imported'
                  : 'grown'
          const ignore = provider.assets.sessions?.ignore
          const ignored = ignore?.titlePrefixes?.some(
            prefix => hint.title?.startsWith(prefix) === true,
          ) === true || ignore?.sessions?.some(rule => {
            if (rule.cwdContains === undefined && rule.title === undefined) return false
            const cwdHit = rule.cwdContains === undefined
              || hint.cwd?.toLowerCase().includes(rule.cwdContains.toLowerCase()) === true
            const titleHit = rule.title === undefined || hint.title === rule.title
            return cwdHit && titleHit
          }) === true
          // Keep already-imported records visible so their retract entry survives.
          if (ignored && record === undefined) return
          entries.push({
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
            ...(hint.lineageId === undefined ? {} : { lineageId: hint.lineageId }),
            ...(hint.lastMessageAt === undefined ? {} : { lastMessageAt: hint.lastMessageAt }),
            ...(hint.headHash === undefined ? {} : { headHash: hint.headHash }),
            ...(hint.segmentStartAt === undefined ? {} : { segmentStartAt: hint.segmentStartAt }),
            ...(record === undefined ? {} : { record }),
          })
        } catch {
          // ignore unreadable entries
        }
  })

  if (enumerationComplete) {
    for (const key of Object.keys(cache.entries)) {
      if (seen.has(key)) continue
      if (!roots.some(root => key.startsWith(root))) continue
      delete cache.entries[key]
      cacheDirty = true
    }
  }
  if (cacheDirty) persistHintCache()

  // Claude Code rewinds fork the conversation into a new transcript that copies
  // the leading turns. The source tool shows only the active branch, so the
  // picker does too: one row per lineage, pointing at the newest branch while
  // staying bound to the ledger record of the branch that was imported.
  const groups = new Map<string, PendingScan[]>()
  const rows: PendingScan[] = []
  for (const entry of entries) {
    if (entry.lineageId === undefined) {
      rows.push(entry)
      continue
    }
    const key = `${entry.providerId}\u0000${entry.lineageId}`
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [entry])
    else list.push(entry)
  }
  for (const group of groups.values()) {
    if (lineageMode === 'segments') {
      // Codex resumes append new rollout files: every file is a part of the
      // same conversation, ordered by its own start time. Compose them all.
      const ordered = [...group].sort(
        (a, b) => (a.segmentStartAt ?? a.mtimeMs) - (b.segmentStartAt ?? b.mtimeMs),
      )
      const active = ordered[ordered.length - 1]!
      const sourcePaths = ordered.map(entry => entry.sourcePath)
      const record = ordered.find(entry => entry.record !== undefined)?.record
      const unchanged = record !== undefined
        && record.sourcePaths !== undefined
        && sameSourcePathList(record.sourcePaths, sourcePaths)
        && record.fingerprint.bytes === active.bytes
        && (record.fingerprint.mtimeMs === active.mtimeMs
          || (active.headHash !== undefined && record.fingerprint.headHash === active.headHash))
      const continuationTitles = new Set(['继续', 'jixu', 'continue', '继续。'])
      const title = ordered
        .map(entry => entry.title)
        .find(value => value !== undefined && !continuationTitles.has(value.trim().toLowerCase()))
        ?? active.title
      rows.push({
        ...active,
        ...(title === undefined ? {} : { title }),
        sourceSessionId: record?.sourceSessionId ?? active.sourceSessionId,
        ...(record === undefined ? {} : { dshSessionId: record.dshSessionId }),
        sourcePaths,
        status: record === undefined
          ? 'new'
          : record.status === 'failed'
            ? 'failed'
            : unchanged
              ? 'imported'
              : 'grown',
      })
      continue
    }
    if (group.length === 1) {
      rows.push(group[0]!)
      continue
    }
    const ordered = [...group].sort(
      (a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0) || b.mtimeMs - a.mtimeMs,
    )
    const active = ordered[0]!
    const imported = group.filter(entry => entry.record !== undefined)
    // Never hide imported rows: without one active record per lineage the
    // grouping would strand a retract entry, so keep the raw rows.
    if (imported.length === 0) {
      rows.push(active)
      continue
    }
    if (imported.length > 1) {
      rows.push(...group)
      continue
    }
    const record = imported[0]!.record!
    // The logical id stays on the branch that owns the ledger record; the path
    // is what moves when a rewind forks the conversation.
    const branchChanged = !sameSourcePath(record.sourcePath, active.sourcePath)
    rows.push({
      ...active,
      sourceSessionId: record.sourceSessionId,
      dshSessionId: record.dshSessionId,
      status: branchChanged ? 'grown' : active.status,
      ...(branchChanged ? { branchChanged: true } : {}),
    })
  }

  return rows
    .map(({ lineageId: _lineageId, lastMessageAt: _lastMessageAt, headHash: _headHash, segmentStartAt: _segmentStartAt, record: _record, ...row }) => row)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * Cheap picker metadata: the source tool's own title (or first human message)
 * plus the workspace cwd, so the panel can group sessions by project the way
 * the source tool's sidebar does. Head plus a small tail is read — Claude Code
 * writes its `ai-title` and sometimes the first prompt at the end of a long
 * transcript — while a 60 MB log still does not slow the list down.
 */
/** First text block of a Claude/Qoder/Codex message content payload. */
function firstTextBlock(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const type = (block as { type?: unknown }).type
    if (type !== 'text' && type !== 'input_text' && type !== 'output_text') continue
    const text = (block as { text?: unknown }).text
    if (typeof text === 'string' && text !== '') return text
  }
  return undefined
}

export async function readSessionHint(file: string): Promise<{
  title?: string
  cwd?: string
  headHash?: string
  lineageId?: string
  lastMessageAt?: number
  sessionId?: string
  segmentStartAt?: number
}> {
  const HEAD_BYTES = 256 * 1024
  const TAIL_BYTES = 64 * 1024
  let text = ''
  try {
    const handle = await open(file, 'r')
    try {
      const info = await handle.stat()
      const head = Buffer.alloc(Math.min(HEAD_BYTES, info.size))
      const { bytesRead } = await handle.read(head, 0, head.length, 0)
      text = head.subarray(0, bytesRead).toString('utf8')
      if (info.size > HEAD_BYTES) {
        const tailStart = Math.max(HEAD_BYTES, info.size - TAIL_BYTES)
        const tail = Buffer.alloc(info.size - tailStart)
        const tailRead = await handle.read(tail, 0, tail.length, tailStart)
        text += '\n' + tail.subarray(0, tailRead.bytesRead).toString('utf8')
      }
    } finally {
      await handle.close()
    }
  } catch {
    return {}
  }

  // Same first-line hash as `fingerprintSource`, so an mtime-only rewrite can be
  // recognized without reading the whole transcript.
  const firstLine = (text.split('\n', 1)[0] ?? '').replace(/\r$/, '')
  const headHash = createHash('sha256').update(firstLine.slice(0, 4096)).digest('hex').slice(0, 16)

  // The import parser prefers aiTitle/customTitle anywhere in the file (Claude
  // Code writes an `ai-title` record after the first turn); the picker must use
  // the same precedence or the imported title differs from the scanned one.
  let fieldTitle: string | undefined
  let userTitle: string | undefined
  let cwd: string | undefined
  let lineageId: string | undefined
  let lastMessageAt: number | undefined
  let sessionId: string | undefined
  let segmentStartAt: number | undefined
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (lineageId === undefined && record['type'] === 'user' && typeof record['uuid'] === 'string') {
      lineageId = record['uuid']
    }
    if (record['type'] === 'session_meta') {
      const payload = record['payload'] as Record<string, unknown> | undefined
      if (payload !== undefined) {
        if (sessionId === undefined && typeof payload['session_id'] === 'string') sessionId = payload['session_id']
        if (cwd === undefined && typeof payload['cwd'] === 'string') cwd = payload['cwd']
        if (segmentStartAt === undefined) {
          const stamp = payload['timestamp'] ?? record['timestamp']
          const time = typeof stamp === 'number'
            ? stamp
            : typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN
          if (Number.isFinite(time)) segmentStartAt = time
        }
      }
    }
    if (record['type'] === 'user' || record['type'] === 'assistant') {
      const stamp = record['timestamp']
      const time = typeof stamp === 'number'
        ? stamp
        : typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN
      if (Number.isFinite(time) && (lastMessageAt === undefined || time > lastMessageAt)) lastMessageAt = time
    }
    if (record['type'] === 'response_item') {
      const payload = record['payload'] as Record<string, unknown> | undefined
      if (payload?.['type'] === 'message' && (payload['role'] === 'user' || payload['role'] === 'assistant')) {
        const stamp = record['timestamp']
        const time = typeof stamp === 'number'
          ? stamp
          : typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN
        if (Number.isFinite(time) && (lastMessageAt === undefined || time > lastMessageAt)) lastMessageAt = time
        if (userTitle === undefined && payload['role'] === 'user') {
          const raw = firstTextBlock(payload['content'])
          if (raw !== undefined) userTitle = cleanTitleText(raw)
        }
      }
    }
    if (cwd === undefined) {
      if (record['type'] === 'workspace-directories') {
        const dirs = record['directories']
        if (Array.isArray(dirs) && typeof dirs[0] === 'string') cwd = dirs[0]
      }
      if (cwd === undefined && typeof record['cwd'] === 'string') cwd = record['cwd']
    }
    if (fieldTitle === undefined) {
      for (const field of ['aiTitle', 'customTitle', 'title']) {
        const value = record[field]
        if (typeof value === 'string' && value.trim() !== '') {
          fieldTitle = value.trim().slice(0, 80)
          break
        }
      }
    }
    if (userTitle === undefined && record['type'] === 'user') {
      const message = record['message'] as { content?: unknown } | undefined
      const raw = firstTextBlock(message?.content)
      if (raw !== undefined) userTitle = cleanTitleText(raw)
    }
    if (fieldTitle !== undefined && cwd !== undefined && lineageId !== undefined && lastMessageAt !== undefined) break
  }
  const title = fieldTitle ?? userTitle
  const lineage = sessionId ?? lineageId
  return {
    headHash,
    ...(title === undefined ? {} : { title }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(lineage === undefined ? {} : { lineageId: lineage }),
    ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(segmentStartAt === undefined ? {} : { segmentStartAt }),
  }
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

  // Detach while the session header still exists: DSH's workspace entity
  // filters `sessionIds` by a session-cwd check, so deleting the log first makes
  // the session invisible to the registry and leaves an empty folder behind.
  await (workspace === undefined
    ? detachSessionFromWorkspaces(dshHome(), record.dshSessionId)
    : workspace.detach(record.dshSessionId))

  const removedPaths = await removeSessionDirectories(record.dshSessionId)
  await store.remove(providerId, sourceSessionId)
  return {
    providerId,
    sourceSessionId,
    dshSessionId: record.dshSessionId,
    removedPaths,
    evicted: status !== undefined,
  }
}

/** Remove an imported session's log from every project directory. */
export async function removeSessionDirectories(dshSessionId: string): Promise<string[]> {
  if (!dshSessionId.startsWith('import-')) {
    throw new Error(`拒绝删除非本插件创建的会话：${dshSessionId}`)
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
    const candidate = join(projectDir, dshSessionId)
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
  return removedPaths
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
  /** All rollout files composing a segmented session (Codex). */
  sourcePaths?: string[]
  /**
   * Logical session id. A rewind branch row carries the id of the branch that
   * owns the ledger record, so the rebuilt log keeps the same DSH identity.
   */
  sourceSessionId?: string
  options: ImportOptions
  /** Provider rules for local file links; absent means leave source text as-is. */
  provider?: ProviderDescriptor
}

type ImageMedia = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** DSH attachment service slice the importer needs. */
export interface AttachmentsFace {
  saveImages(inputs: readonly { data: Uint8Array; mediaType: ImageMedia; name?: string }[]): Promise<readonly DshImageRef[]>
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024

function sniffImageType(bytes: Uint8Array): ImageMedia | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp'
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  return undefined
}

async function readImageFile(path: string): Promise<{ data: Uint8Array; mediaType: ImageMedia; name?: string } | undefined> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size <= 0 || info.size > MAX_IMAGE_BYTES) return undefined
    const data = new Uint8Array(await readFile(path))
    const mediaType = sniffImageType(data)
    return mediaType === undefined ? undefined : { data, mediaType, name: basename(path) }
  } catch {
    return undefined
  }
}

async function fetchImageUrl(url: string): Promise<{ data: Uint8Array; mediaType: ImageMedia } | undefined> {
  try {
    let data: Uint8Array
    let declared: string | undefined
    if (url.startsWith('data:')) {
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
      if (match === null) return undefined
      data = new Uint8Array(Buffer.from(match[2], 'base64'))
      declared = match[1]
    } else {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
      if (!response.ok) return undefined
      data = new Uint8Array(await response.arrayBuffer())
      declared = response.headers.get('content-type') ?? undefined
    }
    if (data.byteLength <= 0 || data.byteLength > MAX_IMAGE_BYTES) return undefined
    const mediaType =
      sniffImageType(data) ??
      (declared === 'image/png' || declared === 'image/jpeg' || declared === 'image/webp' || declared === 'image/gif'
        ? declared
        : undefined)
    return mediaType === undefined ? undefined : { data, mediaType }
  } catch {
    return undefined
  }
}

/** Local copies first (durable); the signed provider URL only while valid. */
function createImageResolver(attachments: AttachmentsFace): ImageResolverPort {
  return {
    async resolve(images) {
      const loaded = await Promise.all(
        images.map(async image => {
          const local = image.localPath === undefined ? undefined : await readImageFile(image.localPath)
          return local ?? (image.url === undefined ? undefined : await fetchImageUrl(image.url))
        }),
      )
      const inputs = loaded.filter(
        (image): image is { data: Uint8Array; mediaType: ImageMedia; name?: string } => image !== undefined,
      )
      if (inputs.length === 0) return []
      try {
        return await attachments.saveImages(inputs)
      } catch (cause) {
        console.warn('[dsh-session-import] 图片附件保存失败', cause)
        return []
      }
    },
  }
}

/** Keep files that still exist; the message itself carries their paths. */
export function createFileResolver(): FileResolverPort {
  return {
    async resolve(files) {
      const existing = await Promise.all(files.map(async file => {
        const info = await stat(file.localPath).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code !== 'ENOENT') {
            console.warn(`[dsh-session-import] 文件附件读取失败：${file.localPath}`, cause)
          }
          return undefined
        })
        if (info === undefined || !info.isFile() || info.size <= 0) return undefined
        return {
          localPath: file.localPath,
          ...(file.mention === undefined ? {} : { mention: file.mention }),
        }
      }))
      return existing.filter((file): file is ResolvedFileAttachment => file !== undefined)
    },
  }
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
  attachments?: AttachmentsFace,
  liveStatus?: (sessionId: string) => string | undefined,
  evictLive?: (sessionId: string) => Promise<void>,
  deleteSession?: (sessionId: string) => Promise<void>,
): Promise<ImportResult> {
  const sourcePaths = request.sourcePaths !== undefined && request.sourcePaths.length > 0
    ? request.sourcePaths
    : [request.sourcePath]
  let parsed: ParsedSession
  if (request.provider?.family === 'codex-db') {
    const marker = '#thread='
    const markerIndex = request.sourcePath.lastIndexOf(marker)
    const threadId = request.sourceSessionId !== undefined && request.sourceSessionId !== ''
      ? request.sourceSessionId
      : markerIndex < 0 ? '' : request.sourcePath.slice(markerIndex + marker.length)
    if (threadId === '') throw new Error('Codex 导入缺少会话 ID')
    const sessionsAsset = request.provider.assets.sessions
    parsed = await parseCodexDb(threadId, {
      providerId: request.providerId,
      root: rootsFor(request.provider)[0] ?? expandHome('~/.codex'),
      database: sessionsAsset?.layout.database ?? DEFAULT_CODEX_DB,
      ...(sessionsAsset?.title?.fields === undefined ? {} : { titleFields: sessionsAsset.title.fields }),
      ...(sessionsAsset?.title?.fromFirstUserMessage === undefined
        ? {}
        : { fromFirstUserMessage: sessionsAsset.title.fromFirstUserMessage }),
    })
  } else if (request.provider?.family === 'codex-jsonl') {
    parsed = await parseCodexJsonl(sourcePaths, { providerId: request.providerId })
  } else {
    parsed = await parseClaudeJsonl(request.sourcePath, { providerId: request.providerId })
  }
  const adapted = adaptFileLinks(parsed.events, request.provider?.fileLinks?.assistant, parsed.cwd)
  const logicalId = request.sourceSessionId === undefined || request.sourceSessionId === ''
    ? parsed.sourceSessionId
    : request.sourceSessionId
  const session: ParsedSession = {
    ...(adapted.links === 0 ? parsed : { ...parsed, events: adapted.events }),
    sourceSessionId: logicalId,
  }
  if (adapted.links > 0) {
    console.info(
      `[dsh-session-import] 文件链接: ${adapted.links} 处 -> ${adapted.files} 个文件（${session.sourceSessionId}）`,
    )
  }
  const state = new ImportStateStore(join(dshHome(), 'session-import', 'state.json'))
  const result = await importSession(
    {
      persistence,
      state,
      files: createFileResolver(),
      ...(attachments === undefined ? {} : { images: createImageResolver(attachments) }),
      ...(liveStatus === undefined ? {} : { liveStatus }),
      ...(evictLive === undefined ? {} : { evictLive }),
      ...(deleteSession === undefined ? {} : { deleteSession }),
    },
    session,
    request.options,
  )

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
