/**
 * Import pipeline: parsed session → durable DSH session.
 *
 * DSH's persistence is injected as a port rather than imported, so this module
 * runs (and is tested) outside a DSH process. Inside DSH the port is a thin
 * adapter over `ctx.sessionPersistence`.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'

import type { ImportOptions, ImportRecord, ImportResult, ParsedSession } from '../shared/types.ts'
import { mapToDshEvents, type DshEvent } from './mapper.ts'
import { fingerprintOf, recordKey, sameFingerprint, type ImportStateStore, type SourceFingerprint } from './state.ts'

/**
 * DSH stamps this into every session header; a backend rejects any other value
 * on load. Bump only together with the harness.
 */
export const SESSION_FORMAT_VERSION = 4

/** A storage handle for one session: DSH opens write/read sessions as handles. */
export interface SessionHandle {
  append(events: readonly DshEvent[]): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>
  read(offset?: number, length?: number): Promise<{ events: readonly { type: string; seq: number }[] }>
}

export interface PersistencePort {
  create(header: {
    version: number
    id: string
    createdAt: number
    cwd?: string
    /** Fork lineage marker; DSH rejects a header that omits it. */
    isSeeded: boolean
    delegationDepth: number
  }): Promise<SessionHandle>
  /** Read an existing log back; used as the importer's own acceptance test. */
  open(id: string): Promise<SessionHandle>
}

export interface ImportDeps {
  persistence: PersistencePort
  state: ImportStateStore
  now?: () => number
}

/** Session ids are namespaced so two providers cannot collide. */
export function importedSessionId(providerId: string, sourceSessionId: string): string {
  return `import-${providerId}-${sourceSessionId}`
}

/** First line of the source file, for the cheap rewrite fingerprint. */
async function readHead(path: string): Promise<string> {
  const stream = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) return line.slice(0, 4096)
    return ''
  } finally {
    lines.close()
    stream.destroy()
  }
}

/** Fingerprint a source file without parsing it (stat + head hash). */
export async function fingerprintSource(path: string): Promise<SourceFingerprint> {
  const info = await stat(path)
  return fingerprintOf(info.size, info.mtimeMs, await readHead(path))
}

export async function importSession(
  deps: ImportDeps,
  parsed: ParsedSession,
  options: ImportOptions,
  signal?: AbortSignal,
): Promise<ImportResult> {
  const now = deps.now ?? Date.now
  const info = await stat(parsed.sourcePath)
  const fingerprint = fingerprintOf(info.size, info.mtimeMs, await readHead(parsed.sourcePath))
  const key = recordKey(parsed.providerId, parsed.sourceSessionId)

  const records = await deps.state.load()
  const existing = records[key]
  if (existing !== undefined && sameFingerprint(existing.fingerprint, fingerprint)) {
    return {
      status: 'skipped',
      providerId: parsed.providerId,
      sourceSessionId: parsed.sourceSessionId,
      dshSessionId: existing.dshSessionId,
      turns: 0,
      events: 0,
      truncated: 0,
      repaired: 0,
      message: '源会话未变化，已跳过',
    }
  }

  const mapped = mapToDshEvents(parsed.events, options)
  if (mapped.events.length === 0) {
    return {
      status: 'failed',
      providerId: parsed.providerId,
      sourceSessionId: parsed.sourceSessionId,
      turns: 0,
      events: 0,
      truncated: mapped.truncated,
      repaired: mapped.repairedCalls,
      message: '解析后没有可导入的事件',
    }
  }

  const sessionId = existing?.dshSessionId ?? importedSessionId(parsed.providerId, parsed.sourceSessionId)
  const createdAt = parsed.startedAt ?? now()

  // Persistence requires a contiguous seq starting at the stored next value.
  if (existing !== undefined) {
    return {
      status: 'failed',
      providerId: parsed.providerId,
      sourceSessionId: parsed.sourceSessionId,
      turns: 0,
      events: 0,
      truncated: mapped.truncated,
      repaired: mapped.repairedCalls,
      message: '源会话已增长，增量追平尚未实现（M2）',
    }
  }

  const handle = await deps.persistence.create({
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt,
    ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
    isSeeded: false,
    delegationDepth: 0,
  })
  signal?.throwIfAborted()

  const rebased = mapped.events.map((event, index) => ({ ...event, seq: index }))
  try {
    await handle.append(rebased)
    await handle.flush()
  } finally {
    await handle.close()
  }
  signal?.throwIfAborted()

  // Acceptance test: read the log back through the same loader users will use.
  let storedCount = 0
  const readHandle = await deps.persistence.open(sessionId)
  try {
    const page = await readHandle.read()
    storedCount = page.events.length
  } finally {
    await readHandle.close()
  }

  if (storedCount < rebased.length) {
    return {
      status: 'failed',
      providerId: parsed.providerId,
      sourceSessionId: parsed.sourceSessionId,
      dshSessionId: sessionId,
      turns: mapped.turns,
      events: rebased.length,
      truncated: mapped.truncated,
      repaired: mapped.repairedCalls,
      message: `回读校验失败：写入 ${rebased.length} 条，读回 ${storedCount} 条`,
    }
  }

  const record: ImportRecord = {
    providerId: parsed.providerId,
    sourceSessionId: parsed.sourceSessionId,
    sourcePath: parsed.sourcePath,
    fingerprint,
    dshSessionId: sessionId,
    importedTurns: mapped.turns,
    importedAt: now(),
    lastImportAt: now(),
    status: 'ok',
  }
  await deps.state.upsert(record)

  return {
    status: 'imported',
    providerId: parsed.providerId,
    sourceSessionId: parsed.sourceSessionId,
    dshSessionId: sessionId,
    turns: mapped.turns,
    events: rebased.length,
    truncated: mapped.truncated,
    repaired: mapped.repairedCalls,
  }
}

/** Remove the bookkeeping entry; the DSH session itself is deleted elsewhere. */
export async function forgetImport(
  deps: ImportDeps,
  providerId: string,
  sourceSessionId: string,
): Promise<ImportRecord | undefined> {
  return deps.state.remove(providerId, sourceSessionId)
}
