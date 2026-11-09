/**
 * Host-side service layer: provider discovery, session scanning, and the real
 * import run against DSH's own persistence.
 */
import { open, readdir, readFile, rm, stat } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import type { ImportOptions, ImportRecord, ImportResult, ProviderDescriptor } from '../shared/types.ts'
import { importSession, type PersistencePort } from './importer.ts'
import { parseClaudeJsonl } from './parsers/claude-jsonl.ts'
import { ImportStateStore, recordKey } from './state.ts'
import { attachSessionToWorkspace, detachSessionFromWorkspaces } from './workspaces.ts'

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
          out.push({
            providerId: provider.id,
            sourcePath: file,
            sourceSessionId: sessionId,
            directory: dir,
            bytes: info.size,
            mtimeMs: info.mtimeMs,
            status,
            ...(await readTitleHint(file).then(title => (title === undefined ? {} : { title }))),
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
 * Cheap title hint for the picker: the source tool's own title when present,
 * otherwise the first human message. Only the head of the file is read, so a
 * 60 MB transcript does not slow the list down.
 */
export async function readTitleHint(file: string): Promise<string | undefined> {
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
    return undefined
  }

  let fallback: string | undefined
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    for (const field of ['aiTitle', 'customTitle', 'title']) {
      const value = record[field]
      if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 80)
    }
    if (fallback === undefined && record['type'] === 'user') {
      const message = record['message'] as { content?: unknown } | undefined
      const content = message?.content
      if (typeof content === 'string') fallback = content
      else if (Array.isArray(content)) {
        const first = content.find(block => (block as { type?: string })?.type === 'text') as { text?: string } | undefined
        if (typeof first?.text === 'string') fallback = first.text
      }
    }
  }
  return fallback?.replace(/\s+/g, ' ').trim().slice(0, 80) || undefined
}

/** Read the idempotency ledger (missing/corrupt file reads as empty). */
export async function loadRecords(): Promise<Record<string, ImportRecord>> {
  return new ImportStateStore(join(dshHome(), 'session-import', 'state.json')).load()
}

export interface RetractResult {
  providerId: string
  sourceSessionId: string
  dshSessionId: string
  removedPaths: string[]
}

/**
 * Delete an imported session and its bookkeeping.
 *
 * DSH exposes no delete API, so this removes the session directory. Safety is
 * deliberate: only ids this plugin created (`import-` prefix) may be removed,
 * and only when the ledger has a record for them.
 */
export async function retractImport(providerId: string, sourceSessionId: string): Promise<RetractResult> {
  const store = new ImportStateStore(join(dshHome(), 'session-import', 'state.json'))
  const record = (await store.load())[recordKey(providerId, sourceSessionId)]
  if (record === undefined) throw new Error('没有导入记录，无法撤回')
  if (!record.dshSessionId.startsWith('import-')) {
    throw new Error(`拒绝删除非本插件创建的会话：${record.dshSessionId}`)
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
    try {
      const info = await stat(candidate)
      if (!info.isDirectory()) continue
      await rm(candidate, { recursive: true, force: true })
      removedPaths.push(candidate)
    } catch {
      // not in this project
    }
  }

  await detachSessionFromWorkspaces(dshHome(), record.dshSessionId)
  await store.remove(providerId, sourceSessionId)
  return {
    providerId,
    sourceSessionId,
    dshSessionId: record.dshSessionId,
    removedPaths,
  }
}

/**
 * Attach every previously imported session to its workspace.
 *
 * Older imports (and anything written by another tool) only produced the
 * session log, so they sit in 「未分组」. Reading the stored header gives the
 * cwd the workspace registry needs, and attaching is idempotent.
 */
export async function backfillWorkspaces(): Promise<{ attached: number; scanned: number }> {
  const sessionsRoot = join(dshHome(), 'sessions')
  let projectDirs: string[] = []
  try {
    projectDirs = (await readdir(sessionsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => join(sessionsRoot, entry.name))
  } catch {
    return { attached: 0, scanned: 0 }
  }

  let attached = 0
  let scanned = 0
  for (const projectDir of projectDirs) {
    let entries: { name: string; isDirectory(): boolean }[] = []
    try {
      entries = await readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('import-')) continue
      scanned += 1
      const cwd = await readSessionCwd(join(projectDir, entry.name))
      if (cwd === undefined) continue
      const outcome = await attachSessionToWorkspace(dshHome(), entry.name, cwd)
      if (outcome.attached) attached += 1
    }
  }
  return { attached, scanned }
}

/** Read the header record of a stored session to recover its cwd. */
async function readSessionCwd(sessionDir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(sessionDir, 'session.v4.jsonl.zstd'))
    const text = zstdDecompressSync(raw).toString('utf8')
    const first = text.split('\n').find(line => line.trim() !== '')
    if (first === undefined) return undefined
    const header = JSON.parse(first) as { cwd?: unknown }
    return typeof header.cwd === 'string' ? header.cwd : undefined
  } catch {
    return undefined
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
}

/**
 * Run one real import. `persistence` is DSH's own service, so the resulting
 * session is a first-class session: it appears in the sidebar and can be
 * resumed.
 */
export async function runImport(
  persistence: PersistencePort,
  request: ImportRequest,
): Promise<ImportResult> {
  const parsed = await parseClaudeJsonl(request.sourcePath, {
    providerId: request.providerId,
  })
  const state = new ImportStateStore(join(dshHome(), 'session-import', 'state.json'))
  const result = await importSession({ persistence, state }, parsed, request.options)

  // A session file on disk is not enough: the sidebar groups by the workspace
  // registry, so an unattached session would show up under 「未分组」.
  if (result.status === 'imported' || result.status === 'appended') {
    const cwd = (parsed as { cwd?: string }).cwd
    const outcome = await attachSessionToWorkspace(dshHome(), result.dshSessionId, cwd)
    console.info('[dsh-session-import] 工作区挂载: ' + (outcome.attached ? outcome.workspacePath : outcome.reason))
    return outcome.attached ? { ...result, workspacePath: outcome.workspacePath } : result
  }
  return result
}
