/**
 * `workbuddy-jsonl` family parser.
 *
 * WorkBuddy appends one JSON record per line under
 * `~/.workbuddy/projects/<workspace>/<sessionId>.jsonl`. Human input lives
 * inside `<user_query>`; everything else in that message is injected context.
 * Compaction writes a `<cb_summary>` user record, and editing a sent message
 * appends a `resend-fork-notice` while leaving the abandoned branch in place.
 * Reading linearly and dropping the abandoned fork ranges keeps the log honest.
 */
import { createReadStream } from 'node:fs'
import { basename } from 'node:path'
import { createInterface } from 'node:readline'

import type { ParseStats, ParsedSession, SourceEvent, SourceFileAttachment, SourceImage } from '../../shared/types.ts'
import { cleanTitleText, type ParseOptions } from './claude-jsonl.ts'

interface WorkBuddyBlock {
  type?: string
  text?: unknown
  blob_path?: unknown
}

interface WorkBuddyRecord {
  type?: string
  role?: string
  id?: string
  parentId?: string | null
  timestamp?: number | string
  content?: unknown
  rawContent?: unknown
  output?: unknown
  providerData?: { model?: unknown }
  sessionId?: string
  cwd?: string
  aiTitle?: unknown
  editedUserItemId?: string
  name?: unknown
  arguments?: unknown
  callId?: unknown
  status?: unknown
  [key: string]: unknown
}

const USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/gu
const CONTINUATION_PREFIX = 'Please continue with the conversation based on the summarized context above.'

function toTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

function blocksOf(value: unknown): WorkBuddyBlock[] {
  return Array.isArray(value)
    ? value.filter((block): block is WorkBuddyBlock => block !== null && typeof block === 'object')
    : []
}

function blockTexts(value: unknown): string[] {
  if (typeof value === 'string') return value === '' ? [] : [value]
  return blocksOf(value)
    .map(block => (typeof block.text === 'string' ? block.text : ''))
    .filter(text => text !== '')
}

function joinedText(value: unknown): string {
  return blockTexts(value).join('\n')
}

/** A compaction summary is tool context, not a human turn. */
export function isWorkBuddyContinuation(text: string): boolean {
  return text.includes('<cb_summary>') || text.includes('<conversation_history_summary>')
    || text.trimStart().startsWith(CONTINUATION_PREFIX)
}

/**
 * The human part of a WorkBuddy user record. Context wrappers are dropped;
 * older records without the `<user_query>` tag fall back to plain text.
 */
export function workbuddyUserQuery(text: string): string | undefined {
  const queries = [...text.matchAll(USER_QUERY)]
    .map(match => (match[1] ?? '').trim())
    .filter(query => query !== '')
  if (queries.length > 0) return queries.join('\n\n')
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.startsWith('<')) return undefined
  if (trimmed.startsWith(CONTINUATION_PREFIX)) return undefined
  return trimmed
}

function imagesOf(blocks: readonly WorkBuddyBlock[]): SourceImage[] {
  const images: SourceImage[] = []
  for (const block of blocks) {
    if (block.type !== 'image_blob_ref' || typeof block.blob_path !== 'string' || block.blob_path === '') continue
    images.push({ localPath: block.blob_path })
  }
  return images
}

function filesOf(text: string): SourceFileAttachment[] {
  const files: SourceFileAttachment[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(/(?:^|\s)@(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z]:[\\/][^\s"']+))/gu)) {
    const path = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (path === '' || seen.has(path)) continue
    seen.add(path)
    files.push({ localPath: path })
  }
  return files
}

/**
 * Indexes of records that belong to a branch the user replaced by editing an
 * earlier message. The abandoned branch runs from the edited user record to
 * its `resend-fork-notice`.
 */
function abandonedRecords(records: readonly WorkBuddyRecord[]): Set<number> {
  const ignored = new Set<number>()
  records.forEach((record, index) => {
    if (record.type !== 'resend-fork-notice' || typeof record.editedUserItemId !== 'string') return
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (ignored.has(cursor)) continue
      const candidate = records[cursor]
      if (candidate?.type !== 'message' || candidate.role !== 'user' || candidate.id !== record.editedUserItemId) continue
      for (let drop = cursor; drop <= index; drop += 1) ignored.add(drop)
      return
    }
  })
  return ignored
}

function pickTitle(events: readonly SourceEvent[]): string | undefined {
  for (const event of events) {
    if (event.kind !== 'user') continue
    const title = cleanTitleText(event.text)
    if (title !== undefined) return title
  }
  return undefined
}

export async function parseWorkbuddyJsonl(
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

  const records: WorkBuddyRecord[] = []
  let sessionId: string | undefined
  let cwd: string | undefined
  let title: string | undefined

  const stream = createReadStream(sourcePath, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of lines) {
    stats.lines += 1
    const trimmed = line.trim()
    if (trimmed === '') continue
    let record: WorkBuddyRecord
    try {
      record = JSON.parse(trimmed) as WorkBuddyRecord
    } catch {
      stats.badLines += 1
      continue
    }
    stats.records += 1
    if (sessionId === undefined && typeof record.sessionId === 'string') sessionId = record.sessionId
    if (cwd === undefined && typeof record.cwd === 'string') cwd = record.cwd
    if (title === undefined && record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim() !== '') {
      title = record.aiTitle.trim()
    }
    records.push(record)
  }

  const ignored = abandonedRecords(records)
  const events: SourceEvent[] = []
  let startedAt: number | undefined
  let endedAt: number | undefined
  let injectedUserMessages = 0

  const push = (event: SourceEvent): void => {
    if (startedAt === undefined) startedAt = event.time
    endedAt = event.time
    events.push(event)
  }
  const closeTurn = (time: number): void => {
    if (events.length > 0) push({ kind: 'turn-boundary', time })
  }

  records.forEach((record, index) => {
    if (ignored.has(index)) return
    const time = toTime(record.timestamp) ?? endedAt ?? 0
    const model = typeof record.providerData?.model === 'string' ? record.providerData.model : undefined

    if (record.type === 'message' && record.role === 'user') {
      const blocks = blocksOf(record.content)
      for (const block of blocks) stats.blocks[block.type ?? 'unknown'] = (stats.blocks[block.type ?? 'unknown'] ?? 0) + 1
      const rawText = joinedText(record.content)
      if (isWorkBuddyContinuation(rawText)) {
        closeTurn(time)
        injectedUserMessages += 1
        return
      }
      const query = workbuddyUserQuery(rawText)
      const images = imagesOf(blocks)
      if (query === undefined) {
        if (images.length === 0) injectedUserMessages += 1
        else {
          closeTurn(time)
          push({ kind: 'user', time, text: '', images })
        }
        return
      }
      const files = filesOf(query)
      closeTurn(time)
      push({
        kind: 'user',
        time,
        text: query,
        ...(images.length > 0 ? { images } : {}),
        ...(files.length > 0 ? { files } : {}),
      })
      return
    }

    if (record.type === 'message' && record.role === 'assistant') {
      for (const block of blocksOf(record.content)) {
        stats.blocks[block.type ?? 'unknown'] = (stats.blocks[block.type ?? 'unknown'] ?? 0) + 1
      }
      const text = joinedText(record.content)
      if (text !== '') push({ kind: 'assistant', time, text, ...(model === undefined ? {} : { model }) })
      return
    }

    if (record.type === 'reasoning') {
      const text = joinedText(record.rawContent)
      if (text !== '') push({ kind: 'reasoning', time, text })
      return
    }

    if (record.type === 'function_call') {
      const name = typeof record.name === 'string' && record.name !== '' ? record.name : 'unknown'
      const args = typeof record.arguments === 'string'
        ? record.arguments
        : JSON.stringify(record.arguments ?? {})
      push({
        kind: 'tool-call',
        time,
        callId: typeof record.callId === 'string' && record.callId !== '' ? record.callId : String(record.id ?? ''),
        name,
        args,
      })
      return
    }

    if (record.type === 'function_call_result') {
      push({
        kind: 'tool-result',
        time,
        callId: typeof record.callId === 'string' ? record.callId : String(record.parentId ?? ''),
        text: joinedText(record.output),
        isError: record.status !== undefined && record.status !== 'completed',
      })
      return
    }

    if (record.type === 'file-history-snapshot' || record.type === 'ai-title' || record.type === 'session-meta'
      || record.type === 'resend-fork-notice') {
      stats.ignoredTypes[record.type] = (stats.ignoredTypes[record.type] ?? 0) + 1
      return
    }

    const key = record.type ?? 'unknown'
    stats.ignoredTypes[key] = (stats.ignoredTypes[key] ?? 0) + 1
  })

  stats.mainlineRecords = records.length - ignored.size
  stats.injectedUserMessages = injectedUserMessages
  if (title === undefined) title = pickTitle(events)

  return {
    sourceSessionId: sessionId ?? basename(sourcePath, '.jsonl'),
    providerId: options.providerId,
    sourcePath,
    ...(sessionId === undefined ? {} : { lineageId: sessionId }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(title === undefined ? {} : { title }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    events,
    stats,
  }
}
