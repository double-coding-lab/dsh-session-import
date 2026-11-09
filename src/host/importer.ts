/**
 * Import pipeline: parsed session → durable DSH session.
 *
 * DSH's persistence is injected as a port rather than imported, so this module
 * runs (and is tested) outside a DSH process. Inside DSH the port is a thin
 * adapter over `ctx.sessionPersistence`.
 */
import { createHash } from 'node:crypto'
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
  read(offset?: number, length?: number): Promise<{ events: readonly DshEvent[] }>
}

/** The immutable header fields the projection cache binds its checkpoint to. */
export interface SessionHeaderLike {
  version: number
  id: string
  createdAt: number
  cwd?: string
  isSeeded: boolean
}

/**
 * DSH's persistent projection cache. A cold session-list row reads its title
 * from this cache only, so an imported log needs a checkpoint to show a name
 * before the session is opened.
 */
export interface ProjectionCachePort {
  coldSnapshot(
    meta: SessionHeaderLike,
    inheritedEventCount: number,
    events: readonly DshEvent[],
  ): unknown
  cachedSnapshot?(
    meta: SessionHeaderLike,
    keys?: readonly string[],
  ): { values: Record<string, unknown> } | undefined
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
  /** Read or open-for-append an existing log. */
  open(id: string, access?: 'read' | 'write'): Promise<SessionHandle>
  /** Header-only read; used to bind the projection cache checkpoint. */
  stat?(id: string): Promise<{ header: SessionHeaderLike } | undefined>
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

const TITLE_EVENT_TYPE = 'session/title'

/**
 * The sidebar reads a session's title from this log event; without it the
 * imported session shows as 「未命名」. Fallback source = deterministic,
 * no model call.
 */
export function sessionTitleEvent(title: string | undefined, events: readonly DshEvent[]): DshEvent | undefined {
  if (title === undefined) return undefined
  const text = title.replace(/[\u0000-\u001f\u007f\u009b]/g, ' ').replace(/\s+/g, ' ').trim()
  if (text === '') return undefined
  const firstUser = events.find(event => event.type === 'user/message')
  return {
    type: TITLE_EVENT_TYPE,
    seq: events.length,
    time: events.at(-1)?.time ?? Date.now(),
    data: {
      title: text.slice(0, 60),
      messageSeqs: firstUser === undefined ? [] : [firstUser.seq],
      source: { kind: 'fallback' },
    },
  }
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

/**
 * Hash the leading events of a mapped log. Two mappings of the same source
 * produce the same prefix; a slid window does not.
 */
export function prefixHashOf(events: readonly DshEvent[], count = 64): string {
  const slice = events.slice(0, Math.min(count, events.length))
  return createHash('sha256')
    .update(JSON.stringify(slice.map(event => [event.type, event.seq, event.data])))
    .digest('hex')
    .slice(0, 16)
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

  // Growth: append only what the source added since the last import. A source
  // window that slid (compaction, truncation) changes the prefix, which makes
  // appending unsafe — refuse instead of corrupting the log.
  if (existing !== undefined) {
    let previous = existing.importedEventCount
    let previousHash = existing.prefixHash
    let cursor = 0
    const probe = await deps.persistence.open(existing.dshSessionId, 'read')
    try {
      const page = await probe.read()
      cursor = page.events.length
      // Legacy records predate the append cursor; recover it from the stored log.
      if (previous === undefined || previousHash === undefined) {
        const storedMapped = page.events.filter(event => event.type !== TITLE_EVENT_TYPE)
        previous = storedMapped.length
        previousHash = prefixHashOf(storedMapped, Math.min(64, previous))
      }
    } finally {
      await probe.close()
    }
    const hash = prefixHashOf(mapped.events, Math.min(64, previous))
    if (previousHash !== hash) {
      await deps.state.upsert({ ...existing, lastImportAt: now(), status: 'failed' })
      return {
        status: 'failed',
        providerId: parsed.providerId,
        sourceSessionId: parsed.sourceSessionId,
        dshSessionId: existing.dshSessionId,
        turns: 0,
        events: 0,
        truncated: mapped.truncated,
        repaired: mapped.repairedCalls,
        message: '源会话窗口已前移，无法增量追加；请先撤回再重新导入',
      }
    }

    if (mapped.events.length <= previous) {
      await deps.state.upsert({ ...existing, fingerprint, lastImportAt: now() })
      return {
        status: 'skipped',
        providerId: parsed.providerId,
        sourceSessionId: parsed.sourceSessionId,
        dshSessionId: existing.dshSessionId,
        turns: 0,
        events: 0,
        truncated: mapped.truncated,
        repaired: mapped.repairedCalls,
        message: '没有新增事件',
      }
    }

    const tail = mapped.events.slice(previous).map((event, index) => ({ ...event, seq: cursor + index }))
    const writeHandle = await deps.persistence.open(existing.dshSessionId, 'write')
    try {
      await writeHandle.append(tail)
      await writeHandle.flush()
    } finally {
      await writeHandle.close()
    }

    await deps.state.upsert({
      ...existing,
      fingerprint,
      importedTurns: mapped.turns,
      importedEventCount: previous + tail.length,
      prefixHash: prefixHashOf(mapped.events, Math.min(64, previous + tail.length)),
      lastImportAt: now(),
      status: 'ok',
    })

    return {
      status: 'imported',
      providerId: parsed.providerId,
      sourceSessionId: parsed.sourceSessionId,
      dshSessionId: existing.dshSessionId,
      turns: mapped.turns,
      events: tail.length,
      truncated: mapped.truncated,
      repaired: mapped.repairedCalls,
      message: `增量追加 ${tail.length} 条事件`,
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
  const titleEvent = sessionTitleEvent(parsed.title, rebased)
  const appended = titleEvent === undefined ? rebased : [...rebased, titleEvent]
  try {
    await handle.append(appended)
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

  if (storedCount < appended.length) {
    return {
      status: 'failed',
      providerId: parsed.providerId,
      sourceSessionId: parsed.sourceSessionId,
      dshSessionId: sessionId,
      turns: mapped.turns,
      events: rebased.length,
      truncated: mapped.truncated,
      repaired: mapped.repairedCalls,
      message: `回读校验失败：写入 ${appended.length} 条，读回 ${storedCount} 条`,
    }
  }

  const record: ImportRecord = {
    providerId: parsed.providerId,
    sourceSessionId: parsed.sourceSessionId,
    sourcePath: parsed.sourcePath,
    fingerprint,
    dshSessionId: sessionId,
    importedTurns: mapped.turns,
    importedEventCount: rebased.length,
    prefixHash: prefixHashOf(rebased, Math.min(64, rebased.length)),
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
