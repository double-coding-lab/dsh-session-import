/**
 * Host-side service layer: provider discovery, session scanning, and the real
 * import run against DSH's own persistence.
 */
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import type { ImportOptions, ImportRecord, ImportResult, ProviderDescriptor } from '../shared/types.ts'
import { importSession, type PersistencePort } from './importer.ts'
import { parseClaudeJsonl } from './parsers/claude-jsonl.ts'
import { ImportStateStore, recordKey } from './state.ts'

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

/** Read the idempotency ledger (missing/corrupt file reads as empty). */
export async function loadRecords(): Promise<Record<string, ImportRecord>> {
  return new ImportStateStore(join(dshHome(), 'session-import', 'state.json')).load()
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
    includeFullHistory: request.options.fidelity === 'full',
  })
  const state = new ImportStateStore(join(dshHome(), 'session-import', 'state.json'))
  return importSession({ persistence, state }, parsed, request.options)
}
