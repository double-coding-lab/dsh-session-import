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
import { isAbsolute, relative } from 'node:path'
import { createInterface } from 'node:readline'

import type {
  DshImageRef,
  ImportOptions,
  ImportRecord,
  ImportResult,
  ParsedSession,
  SourceEvent,
  SourceFileAttachment,
  SourceImage,
} from '../shared/types.ts'
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

/** Host-side port: durably store source images and return DSH attachment refs. */
export interface ImageResolverPort {
  resolve(images: readonly SourceImage[]): Promise<readonly DshImageRef[]>
}

/** One source file that still exists locally, plus its original text token. */
export interface ResolvedFileAttachment {
  localPath: string
  /** Exact source token that represented the file, when it was inline text. */
  mention?: string
}

/** Host-side port: keep source files that still exist so text can reference them. */
export interface FileResolverPort {
  resolve(files: readonly SourceFileAttachment[]): Promise<readonly ResolvedFileAttachment[]>
}

export interface ImportDeps {
  persistence: PersistencePort
  state: ImportStateStore
  images?: ImageResolverPort
  files?: FileResolverPort
  /** Live session lookup; a resident session owns the log's write handle. */
  liveStatus?: (sessionId: string) => string | undefined
  /** Tear down a resident session so the append can take the write handle. */
  evictLive?: (sessionId: string) => Promise<void>
  /** Remove an imported session's log so a rewind branch can be rebuilt. */
  deleteSession?: (sessionId: string) => Promise<void>
  now?: () => number
}

/**
 * Attachment lists that only repeat the paths of files which became inline
 * references are noise once those references render as chips. Qoder uses
 * `- 文件：<path>` list entries, Claude Code embeds `@"<path>"` mentions, and
 * Codex leaves a markdown link token that the parser records as `mention`.
 */
function stripImportedAttachmentLines(
  text: string,
  importedPaths: readonly string[],
  importedMentions: readonly string[] = [],
): string {
  if (importedPaths.length === 0 && importedMentions.length === 0) return text
  const wanted = new Set(importedPaths)
  let next = text
  for (const mention of importedMentions) next = next.split(mention).join('')
  if (importedMentions.length > 0) next = next.replace(/[ \t]{2,}/g, ' ')
  for (const path of importedPaths) {
    next = next.split(`@"${path}"`).join('')
    next = next.split(`@'${path}'`).join('')
  }
  const kept: string[] = []
  let removed = 0
  for (const line of next.split('\n')) {
    const match = /^-\s*文件[：:]\s*(.+)$/.exec(line.trim())
    if (match !== null && wanted.has((match[1] ?? '').trim())) {
      removed += 1
      continue
    }
    kept.push(line)
  }
  if (removed === 0 && next === text) return text
  const out: string[] = []
  for (let index = 0; index < kept.length; index += 1) {
    const line = kept[index] ?? ''
    const header = line.trim()
    if (header === '附件引用：' || header === '附件引用:') {
      let hasFileLine = false
      for (let after = index + 1; after < kept.length; after += 1) {
        const value = (kept[after] ?? '').trim()
        if (value === '') continue
        hasFileLine = /^-\s*文件[：:]/.test(value)
        break
      }
      if (!hasFileLine) continue
    }
    out.push(line)
  }
  return out.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * DSH renders `@path` tokens in user text as clickable file chips (the same
 * grammar the composer writes). Workspace-relative paths read like a native
 * pick; whitespace needs the quoted `@"path"` form.
 */
function fileMentionToken(path: string, cwd: string | undefined): string | undefined {
  let target = path
  if (cwd !== undefined && cwd !== '') {
    const rel = relative(cwd, path)
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) target = rel
  }
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(target)) return undefined
  return /\s/u.test(target) ? `@"${target}"` : `@${target}`
}

/** Attach native file references before mapping; missing files stay in text. */
async function resolveEventAttachments(
  events: readonly SourceEvent[],
  images: ImageResolverPort | undefined,
  files: FileResolverPort | undefined,
  cwd: string | undefined,
): Promise<SourceEvent[]> {
  if (images === undefined && files === undefined) return [...events]
  const out: SourceEvent[] = []
  for (const event of events) {
    if (event.kind !== 'user' || ((event.images?.length ?? 0) === 0 && (event.files?.length ?? 0) === 0)) {
      out.push(event)
      continue
    }
    let imageRefs: readonly DshImageRef[] = []
    if ((event.images?.length ?? 0) > 0 && images !== undefined) {
      try {
        imageRefs = await images.resolve(event.images ?? [])
      } catch (cause) {
        console.warn('[dsh-session-import] 图片解析失败', cause)
      }
    }
    let storedFiles: readonly ResolvedFileAttachment[] = []
    if ((event.files?.length ?? 0) > 0 && files !== undefined) {
      try {
        storedFiles = await files.resolve(event.files ?? [])
      } catch (cause) {
        console.warn('[dsh-session-import] 文件解析失败', cause)
      }
    }
    const allImagesImported = imageRefs.length === (event.images?.length ?? 0)
    const imagePaths = allImagesImported
      ? (event.images ?? [])
          .map(image => image.localPath)
          .filter((path): path is string => path !== undefined && path !== '')
      : []
    const referenced = storedFiles.flatMap(file => {
      const token = fileMentionToken(file.localPath, cwd)
      return token === undefined ? [] : [{ ...file, token }]
    })
    let text = event.text
    for (const file of referenced) {
      if (file.mention !== undefined && file.mention !== '') text = text.split(file.mention).join(file.token)
    }
    if (imagePaths.length > 0 || referenced.length > 0) {
      text = stripImportedAttachmentLines(
        text,
        [...imagePaths, ...referenced.map(file => file.localPath)],
      )
    }
    const appended = referenced
      .filter(file => file.mention === undefined || file.mention === '')
      .map(file => file.token)
    if (appended.length > 0) text = [text, ...appended].filter(part => part !== '').join('\n')
    out.push({
      kind: 'user',
      time: event.time,
      text,
      ...(imageRefs.length > 0 ? { imageRefs: [...imageRefs] } : {}),
    })
  }
  return out
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
  // DSH only accepts empty messageSeqs for user-set titles; a fallback title
  // must cite an earlier human message, so tool-only sessions get no title.
  if (firstUser === undefined) return undefined
  return {
    type: TITLE_EVENT_TYPE,
    seq: events.length,
    time: events.at(-1)?.time ?? Date.now(),
    data: {
      title: text.slice(0, 60),
      messageSeqs: [firstUser.seq],
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

/** Compare source paths the way Windows does (case-insensitive, either slash). */
function sameSourcePath(left: string, right: string): boolean {
  const norm = (value: string): string => value.replace(/\\/g, '/').toLowerCase()
  return norm(left) === norm(right)
}

function samePathList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => sameSourcePath(value, right[index] ?? ''))
}

/** First user-turn UUID, read cheaply from the transcript head. */
async function readLineageId(path: string): Promise<string | undefined> {
  try {
    const stream = createReadStream(path, { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      let seen = 0
      for await (const line of lines) {
        seen += 1
        if (seen > 500) break
        if (line.trim() === '') continue
        try {
          const record = JSON.parse(line) as { type?: string; uuid?: unknown }
          if (record.type === 'user' && typeof record.uuid === 'string') return record.uuid
        } catch {
          // skip malformed lines the parser also tolerates
        }
      }
      return undefined
    } finally {
      lines.close()
      stream.destroy()
    }
  } catch {
    return undefined
  }
}

/** Timestamp of the last human/AI message, ignoring tool-result tails. */
function lastMessageTime(events: readonly SourceEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.kind === 'user' || event?.kind === 'assistant') return event.time
  }
  return undefined
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

/** Hash of the mapped events just before the append cursor (middle-of-log anchor). */
export function boundaryHashOf(events: readonly DshEvent[], cursor: number, count = 32): string {
  const end = Math.max(0, Math.min(cursor, events.length))
  const slice = events.slice(Math.max(0, end - count), end)
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
  // Database-backed sources have no stat-able file; their parser fingerprints
  // the finished items it read instead.
  const fingerprint = parsed.fingerprint ?? await fingerprintSource(parsed.sourcePath)
  const lastMessageAt = lastMessageTime(parsed.events)
  const key = recordKey(parsed.providerId, parsed.sourceSessionId)

  const records = await deps.state.load()
  const existing = records[key]
  const sameSegments = parsed.segmentPaths === undefined
    ? true
    : existing?.sourcePaths !== undefined && samePathList(existing.sourcePaths, parsed.segmentPaths)
  if (
    existing !== undefined
    && sameSourcePath(existing.sourcePath, parsed.sourcePath)
    && sameFingerprint(existing.fingerprint, fingerprint)
    && sameSegments
  ) {
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

  const mapped = mapToDshEvents(
    await resolveEventAttachments(parsed.events, deps.images, deps.files, parsed.cwd),
    options,
  )
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
    // DSH keeps one writer per session; an opened session owns the handle until
    // its agent/session is unregistered. Tear an idle one down like retract does.
    const live = deps.liveStatus?.(existing.dshSessionId)
    if (live !== undefined) {
      let released = false
      if (live !== 'running' && deps.evictLive !== undefined) {
        try {
          await deps.evictLive(existing.dshSessionId)
          released = true
        } catch (cause) {
          console.warn('[dsh-session-import] 释放会话占用失败', cause)
        }
      }
      if (!released) {
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
          message: live === 'running'
            ? '该会话正在生成回复，请等本轮结束后再导入'
            : '该会话在 DSH 中打开且无法释放写入占用；请重启 DSH 后再试，或撤回后重新导入',
        }
      }
    }

    // Two cases rewrite instead of append: a Claude Code rewind forked the
    // conversation into a new transcript, and a Codex thread moved from an old
    // rollout file to the desktop database. Both keep the DSH identity but the
    // old log content must be replaced. Segmented sources never take this path:
    // their files are parts, not branches.
    if (parsed.segmentPaths === undefined && !sameSourcePath(existing.sourcePath, parsed.sourcePath) && deps.deleteSession !== undefined) {
      const expected = existing.lineageId
      const observed = parsed.lineageId
      const lineageOk = expected !== undefined && observed !== undefined
        ? expected === observed
        : observed !== undefined && (await readLineageId(existing.sourcePath)) === observed
      if (lineageOk) {
        try {
          await deps.deleteSession(existing.dshSessionId)
          await deps.state.remove(parsed.providerId, existing.sourceSessionId)
          const rebuilt = await importSession(deps, parsed, options, signal)
          if (rebuilt.status !== 'imported') return rebuilt
          return {
            ...rebuilt,
            rebuilt: true,
            message: `已按最新内容重建（${mapped.turns} 轮 / ${mapped.events.length} 条事件）`,
          }
        } catch (cause) {
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
            message: `按最新分支重建失败：${cause instanceof Error ? cause.message : String(cause)}`,
          }
        }
      }
    }

    let previous = existing.importedEventCount
    let previousHash = existing.prefixHash
    let cursor = 0
    let storedMaxTurn = 0
    let storedOpenTurn = false
    const probe = await deps.persistence.open(existing.dshSessionId, 'read')
    let storedLogUnreadable = false
    try {
      const page = await probe.read()
      cursor = page.events.length
      for (const event of page.events) {
        const turn = (event.data as { turn?: unknown } | undefined)?.turn
        if (typeof turn === 'number' && turn > storedMaxTurn) storedMaxTurn = turn
        if (event.type === 'turn/start') storedOpenTurn = true
        if (event.type === 'turn/end') storedOpenTurn = false
      }
      // Legacy records predate the append cursor; recover it from the stored log.
      if (previous === undefined || previousHash === undefined) {
        const storedMapped = page.events.filter(event => event.type !== TITLE_EVENT_TYPE)
        previous = storedMapped.length
        previousHash = prefixHashOf(storedMapped, Math.min(64, previous))
      }
    } catch {
      storedLogUnreadable = true
    } finally {
      await probe.close()
    }
    if (storedLogUnreadable) {
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
        message: '现有 DSH 会话日志已损坏，无法增量导入；请先撤回再重新导入（撤回会删除该会话，包括在 DSH 中续聊的内容）',
      }
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
      await deps.state.upsert({
        ...existing,
        ...(existing.lineageId === undefined && parsed.lineageId !== undefined ? { lineageId: parsed.lineageId } : {}),
        ...(parsed.segmentPaths === undefined ? {} : { sourcePaths: parsed.segmentPaths }),
        fingerprint,
        lastImportAt: now(),
      })
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

    // Appending must start on a turn boundary whose numbers continue the log.
    // The session may have been continued inside DSH (runtime turns consume
    // numbers), and a parser upgrade can shift the cursor; neither may desync
    // turn numbers or the log is rejected as corrupt on load.
    const tailRaw = mapped.events.slice(previous)
    const firstStart = tailRaw.find(event => event.type === 'turn/start')
    const firstTurn = firstStart === undefined ? undefined : (firstStart.data as { turn?: unknown }).turn
    if (tailRaw[0]?.type !== 'turn/start' || typeof firstTurn !== 'number') {
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
        message: '新增内容不是从回合开头开始，无法安全追加；请先撤回再重新导入',
      }
    }
    const boundaryOk =
      existing.boundaryHash !== undefined &&
      previous !== undefined &&
      boundaryHashOf(mapped.events, previous) === existing.boundaryHash
    const offset = storedMaxTurn + 1 - firstTurn
    if (storedOpenTurn || offset < 0 || (offset > 0 && !boundaryOk)) {
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
        message: storedOpenTurn
          ? '该会话有未结束的回合，暂不能追加；请先撤回再重新导入'
          : '会话已在 DSH 中继续过或解析规则已升级，无法安全追加；请先撤回再重新导入',
      }
    }
    const tail = tailRaw.map((event, index) => {
      const data = event.data as Record<string, unknown>
      const shifted =
        offset === 0 || typeof data['turn'] !== 'number'
          ? event
          : { ...event, data: { ...data, turn: data['turn'] + offset } }
      return { ...shifted, seq: cursor + index }
    })
    const writeHandle = await deps.persistence.open(existing.dshSessionId, 'write')
    try {
      await writeHandle.append(tail)
      await writeHandle.flush()
    } finally {
      await writeHandle.close()
    }

    await deps.state.upsert({
      ...existing,
      ...(existing.lineageId === undefined && parsed.lineageId !== undefined ? { lineageId: parsed.lineageId } : {}),
      ...(parsed.segmentPaths === undefined ? {} : { sourcePaths: parsed.segmentPaths }),
      fingerprint,
      importedTurns: mapped.turns,
      importedEventCount: previous + tail.length,
      prefixHash: prefixHashOf(mapped.events, Math.min(64, previous + tail.length)),
      boundaryHash: boundaryHashOf(mapped.events, mapped.events.length),
      ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
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
    ...(parsed.segmentPaths === undefined ? {} : { sourcePaths: parsed.segmentPaths }),
    ...(parsed.lineageId === undefined ? {} : { lineageId: parsed.lineageId }),
    fingerprint,
    dshSessionId: sessionId,
    importedTurns: mapped.turns,
    importedEventCount: rebased.length,
    prefixHash: prefixHashOf(rebased, Math.min(64, rebased.length)),
    boundaryHash: boundaryHashOf(rebased, rebased.length),
    ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
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
