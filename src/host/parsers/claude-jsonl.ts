/**
 * `claude-jsonl` family parser.
 *
 * Covers every tool that writes Claude-Code-style transcripts: Qoder, Claude
 * Code, and relatives. The format is a record stream that forms a DAG
 * (`parentUuid` links) with an explicit active leaf, so reading it linearly is
 * wrong — we rebuild the mainline from the last active leaf instead.
 */
import { createReadStream } from 'node:fs'
import { basename } from 'node:path'
import { createInterface } from 'node:readline'

import type { ParseStats, ParsedSession, SourceEvent, SourceImage } from '../../shared/types.ts'

/** Loose shape of one transcript record; fields are read defensively. */
interface RawRecord {
  type?: string
  subtype?: string
  uuid?: string
  parentUuid?: string | null
  timestamp?: string | number
  sessionId?: string
  cwd?: string
  isSidechain?: boolean
  message?: {
    role?: string
    content?: unknown
    model?: string
  }
  [key: string]: unknown
}

export interface ParseOptions {
  providerId: string
  /** Replay everything instead of starting at the last compaction boundary. */
  includeFullHistory?: boolean
}

function toTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

/** Flatten a content block's payload to plain text (string, block list, or object). */
function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text
          return typeof text === 'string' ? text : ''
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content && typeof content === 'object' && 'text' in content) {
    const text = (content as { text?: unknown }).text
    return typeof text === 'string' ? text : ''
  }
  return ''
}

/** Rebuild the linear mainline ending at `leafUuid`, following `parentUuid`. */
/** Message records can anchor a chain segment; metadata records cannot. */
function isMessageRecord(record: RawRecord): boolean {
  return record.type === 'user' || record.type === 'assistant'
}

/**
 * Every record reachable from `leaf` by walking parents, oldest first.
 * Stops at a compaction point: the source tool writes those with
 * `parentUuid: null`, so the chain before it is a separate segment.
 */
function walkUp(leaf: RawRecord | undefined, byUuid: Map<string, RawRecord>, seen: Set<string>): RawRecord[] {
  const chain: RawRecord[] = []
  let current = leaf
  while (current && current.uuid && !seen.has(current.uuid)) {
    seen.add(current.uuid)
    chain.push(current)
    current = typeof current.parentUuid === 'string' ? byUuid.get(current.parentUuid) : undefined
  }
  return chain
}

/** The newest unseen segment root that starts before `limit` (timestamp ms). */
function newestRootBefore(
  byUuid: Map<string, RawRecord>,
  seen: Set<string>,
  limit: number,
): RawRecord | undefined {
  let best: RawRecord | undefined
  let bestTime = Number.NEGATIVE_INFINITY
  for (const record of byUuid.values()) {
    if (record.uuid === undefined || seen.has(record.uuid)) continue
    if (typeof record.parentUuid === 'string' && byUuid.has(record.parentUuid)) continue
    if (!isMessageRecord(record)) continue
    const time = toTime(record.timestamp)
    if (time === undefined || time >= limit || time <= bestTime) continue
    best = record
    bestTime = time
  }
  return best
}

/**
 * Follow one segment forward from `root`, always taking the newest child, and
 * stop before `limit`. Abandoned branches are not followed: only the path that
 * actually carried the conversation survives.
 */
function walkDown(
  root: RawRecord,
  childrenOf: Map<string, RawRecord[]>,
  seen: Set<string>,
  limit: number,
): RawRecord[] {
  const segment: RawRecord[] = []
  let current: RawRecord | undefined = root
  while (current && current.uuid && !seen.has(current.uuid)) {
    seen.add(current.uuid)
    segment.push(current)
    const kids = (childrenOf.get(current.uuid) ?? [])
      .filter(child => child.uuid !== undefined && !seen.has(child.uuid))
      .map(child => ({ child, time: toTime(child.timestamp) ?? Number.POSITIVE_INFINITY }))
      .filter(entry => entry.time < limit)
      .sort((left, right) => right.time - left.time)
    current = kids[0]?.child
  }
  return segment
}

/**
 * Newest childless message record. A source tool writes `active-leaf` on a
 * clean shutdown; a crash or an interrupted session leaves the marker out, and
 * refusing the whole transcript is wrong — the mainline is still recoverable.
 * Prefer non-sidechain leaves so a subagent tail cannot hijack the mainline.
 */
function newestLeaf(byUuid: Map<string, RawRecord>): RawRecord | undefined {
  const parentIds = new Set<string>()
  for (const record of byUuid.values()) {
    if (typeof record.parentUuid === 'string') parentIds.add(record.parentUuid)
  }
  const pick = (allowSidechain: boolean): RawRecord | undefined => {
    let best: RawRecord | undefined
    let bestTime = Number.NEGATIVE_INFINITY
    for (const record of byUuid.values()) {
      if (!isMessageRecord(record) || record.uuid === undefined) continue
      if (!allowSidechain && record.isSidechain === true) continue
      if (parentIds.has(record.uuid)) continue
      const time = toTime(record.timestamp) ?? Number.NEGATIVE_INFINITY
      if (time > bestTime) {
        best = record
        bestTime = time
      }
    }
    return best
  }
  return pick(false) ?? pick(true)
}

/**
 * Reassemble the whole conversation, not just the chain behind the active leaf.
 *
 * A source tool that compacts its context rewrites the transcript so the
 * post-compaction records hang off a **new root** — walking parents from the
 * active leaf then reaches nothing but the turns after the last compaction.
 * Importing that would silently drop most of the history, so we prepend every
 * earlier segment (newest first) until no older root is left.
 */
function mainlineOf(byUuid: Map<string, RawRecord>, leafUuid: string | undefined): RawRecord[] {
  if (!leafUuid) return []
  const childrenOf = new Map<string, RawRecord[]>()
  for (const record of byUuid.values()) {
    if (record.uuid === undefined || typeof record.parentUuid !== 'string') continue
    const list = childrenOf.get(record.parentUuid) ?? []
    list.push(record)
    childrenOf.set(record.parentUuid, list)
  }

  const seen = new Set<string>()
  const segments: RawRecord[][] = []

  const active = walkUp(byUuid.get(leafUuid), byUuid, seen).reverse()
  if (active.length === 0) return []
  segments.push(active)
  let limit = toTime(active[0]?.timestamp) ?? Number.POSITIVE_INFINITY

  for (let guard = 0; guard < 64; guard += 1) {
    const root = newestRootBefore(byUuid, seen, limit)
    if (root === undefined) break
    const earlier = walkDown(root, childrenOf, seen, limit)
    if (earlier.length === 0) break
    segments.unshift(earlier)
    limit = toTime(earlier[0]?.timestamp) ?? limit
  }

  return segments.flat()
}

/** Openers of synthetic context the source tool injected as a user message. */
const INJECTED_PREFIXES = [
  'This session is being continued',
  'Base directory for this skill',
  'Caveat:',
  'You are a',
  '<',
  '---',
  '# ',
]

/** Skill bodies arrive as user messages; they are tool context, not human input. */
const SKILL_INJECTION_PREFIXES = ['Base directory for this skill']

/** System-generated "user" turns: task notifications, interruptions, XML context. */
function isSyntheticUserText(text: string): boolean {
  const trimmed = text.trimStart()
  if (trimmed.startsWith('<')) return true
  if (trimmed.startsWith('This session is being continued')) return true
  return trimmed.startsWith('[SYSTEM NOTIFICATION') || trimmed.startsWith('[Request interrupted')
}

/** Markdown / skill-invocation links read as noise in a title; keep the label. */
function plainText(text: string): string {
  return text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim()
}

/** People paste a task id or a file path before the actual request; drop it. */
const LEADING_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}[\s:：-]*/
const LEADING_PATH = /^(?:[A-Za-z]:[\\/]|\/|~[\\/])\S*\s*/

/** Shared by the parser and the picker list so both show the same clean title. */
export function cleanTitleText(raw: string): string | undefined {
  let text = raw.trim()
  if (text.length < 2) return undefined
  if (INJECTED_PREFIXES.some(prefix => text.startsWith(prefix))) return undefined
  text = text.replace(LEADING_UUID, '').replace(LEADING_PATH, '').trim()
  text = text.split(/附件引用[：:]/)[0]!.trim()
  const title = plainText(text).slice(0, 80)
  return title === '' ? undefined : title
}

/**
 * Pick a human-meaningful title. The first user records in a transcript are
 * usually injected context (skill listings, continuations, reminders), so we
 * skip those rather than showing a filesystem path as the session name.
 */
function pickTitle(events: SourceEvent[]): string | undefined {
  for (const event of events) {
    if (event.kind !== 'user') continue
    const title = cleanTitleText(event.text)
    if (title !== undefined) return title
  }
  return undefined
}

export async function parseClaudeJsonl(
  sourcePath: string,
  options: ParseOptions,
): Promise<ParsedSession> {
  const stats: ParseStats = {
    lines: 0,
    badLines: 0,
    records: 0,
    mainlineRecords: 0,
    sidechainRecords: 0,
    compactBoundaries: 0,
    injectedUserMessages: 0,
    ignoredTypes: {},
    blocks: {},
  }

  let injectedUserMessages = 0

  const records: RawRecord[] = []
  const byUuid = new Map<string, RawRecord>()
  let leafUuid: string | undefined
  let sessionId: string | undefined
  let cwd: string | undefined
  let title: string | undefined
  let lineageId: string | undefined

  const stream = createReadStream(sourcePath, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })

  for await (const line of lines) {
    stats.lines += 1
    const trimmed = line.trim()
    if (trimmed === '') continue
    let record: RawRecord
    try {
      record = JSON.parse(trimmed) as RawRecord
    } catch {
      stats.badLines += 1
      continue
    }
    stats.records += 1

    if (record.type === 'active-leaf' && typeof record.leafUuid === 'string') {
      leafUuid = record.leafUuid
      continue
    }
    if (typeof record.sessionId === 'string' && sessionId === undefined) {
      sessionId = record.sessionId
    }
    // Rewind branches copy the conversation head verbatim, so the first user
    // record's UUID is the same across every branch of one conversation.
    if (lineageId === undefined && record.type === 'user' && typeof record.uuid === 'string') {
      lineageId = record.uuid
    }
    if (record.type === 'workspace-directories') {
      const dirs = (record as { directories?: unknown }).directories
      if (Array.isArray(dirs) && typeof dirs[0] === 'string') cwd = dirs[0]
    }
    if (typeof record.cwd === 'string' && cwd === undefined) {
      cwd = record.cwd
    }
    if (title === undefined) {
      for (const field of ['aiTitle', 'customTitle'] as const) {
        const value = record[field]
        if (typeof value === 'string' && value.trim() !== '') {
          title = value.trim()
          break
        }
      }
    }
    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      stats.compactBoundaries += 1
    }

    records.push(record)
    if (typeof record.uuid === 'string') byUuid.set(record.uuid, record)
  }

  const activeLeaf = leafUuid === undefined ? undefined : byUuid.get(leafUuid)
  const resolvedLeaf = activeLeaf ?? newestLeaf(byUuid)
  const mainline = mainlineOf(byUuid, resolvedLeaf?.uuid)
  stats.mainlineRecords = mainline.length

  // Full history: the entire mainline, from the first record on. Compaction is
  // dsh's job once the session is imported; pre-trimming here would silently
  // hand the user a partial session.
  const startIndex = 0

  const events: SourceEvent[] = []
  let startedAt: number | undefined
  let endedAt: number | undefined

  const push = (event: SourceEvent): void => {
    if (startedAt === undefined) startedAt = event.time
    endedAt = event.time
    events.push(event)
  }

  for (let index = startIndex; index < mainline.length; index += 1) {
    const record = mainline[index]
    if (!record) continue
    if (record.isSidechain === true) {
      stats.sidechainRecords += 1
      continue
    }
    // Source tools inject synthetic annotations (e.g. "[Image: original 4096x3072…]")
    // as isMeta user records; they are not part of the conversation.
    if (record.isMeta === true) continue

    const time = toTime(record.timestamp) ?? endedAt ?? Date.now()
    const content = record.message?.content

    if (record.type === 'user') {
      const blocks = Array.isArray(content) ? content : [{ type: 'text', text: blockText(content) }]
      const texts: string[] = []
      const images: SourceImage[] = []
      for (const raw of blocks) {
        if (!raw || typeof raw !== 'object') continue
        const block = raw as {
          type?: string
          text?: unknown
          tool_use_id?: unknown
          content?: unknown
          is_error?: unknown
          source?: { type?: string; url?: unknown; media_type?: unknown; data?: unknown }
        }
        stats.blocks[block.type ?? 'unknown'] = (stats.blocks[block.type ?? 'unknown'] ?? 0) + 1
        if (block.type === 'tool_result') {
          push({
            kind: 'tool-result',
            time,
            callId: String(block.tool_use_id ?? ''),
            text: blockText(block.content),
            isError: block.is_error === true,
          })
        } else if (block.type === 'text' || block.type === undefined) {
          const text = blockText(block.text)
          if (text !== '') texts.push(text)
        } else if (block.type === 'image') {
          const source = block.source
          if (source?.type === 'url' && typeof source.url === 'string') images.push({ url: source.url })
          else if (source?.type === 'base64' && typeof source.data === 'string') {
            const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png'
            images.push({ url: `data:${mediaType};base64,${source.data}` })
          }
        }
      }
      const joined = texts.join('\n\n')
      if (joined !== '' || images.length > 0) {
        // The attachment list quotes the local copies in the same order as the
        // image blocks, so a positional pairing recovers durable files even
        // after the provider's signed URL expires.
        const listed = [...joined.matchAll(/^-\s*文件：(.+)$/gm)]
          .map(match => match[1].trim())
          .filter(path => /\.(png|jpe?g|webp|gif)$/i.test(path))
        images.forEach((image, index) => {
          const local = listed[index]
          if (local !== undefined && local !== '') image.localPath = local
        })
        const continuation = joined.startsWith('This session is being continued')
        // The source tool injects skill bodies as user messages. Keeping them
        // imports whole skill documents as if the human had typed them, which
        // both bloats the window and fabricates turns. Continuation summaries
        // are tool context too, but they mark a new context segment: close the
        // previous turn here so a resumed session's idle gap is not reported
        // as work time in the turn footer.
        if (joined !== '' && (SKILL_INJECTION_PREFIXES.some(prefix => joined.startsWith(prefix)) || isSyntheticUserText(joined))) {
          if (continuation) push({ kind: 'turn-boundary', time })
          injectedUserMessages += 1
        } else {
          push({ kind: 'turn-boundary', time })
          push({ kind: 'user', time, text: joined, ...(images.length > 0 ? { images } : {}) })
        }
      }
    } else if (record.type === 'assistant') {
      const blocks = Array.isArray(content) ? content : [{ type: 'text', text: blockText(content) }]
      const model = typeof record.message?.model === 'string' ? record.message.model : undefined
      for (const raw of blocks) {
        if (!raw || typeof raw !== 'object') continue
        const block = raw as { type?: string; text?: unknown; thinking?: unknown; id?: unknown; name?: unknown; input?: unknown }
        stats.blocks[block.type ?? 'unknown'] = (stats.blocks[block.type ?? 'unknown'] ?? 0) + 1
        if (block.type === 'text') {
          const text = blockText(block.text)
          if (text !== '') push({ kind: 'assistant', time, text, model })
        } else if (block.type === 'thinking') {
          const text = blockText(block.thinking)
          if (text !== '') push({ kind: 'reasoning', time, text })
        } else if (block.type === 'tool_use') {
          push({
            kind: 'tool-call',
            time,
            callId: String(block.id ?? ''),
            name: String(block.name ?? 'unknown'),
            args: JSON.stringify(block.input ?? {}),
          })
        }
      }
    } else {
      const key = `${record.type ?? 'unknown'}`
      stats.ignoredTypes[key] = (stats.ignoredTypes[key] ?? 0) + 1
    }
  }

  if (title === undefined) {
    title = pickTitle(events)
  }

  stats.injectedUserMessages = injectedUserMessages

  return {
    sourceSessionId: sessionId ?? basename(sourcePath, '.jsonl'),
    providerId: options.providerId,
    sourcePath,
    ...(lineageId === undefined ? {} : { lineageId }),
    cwd,
    title,
    startedAt,
    endedAt,
    events,
    stats,
  }
}
