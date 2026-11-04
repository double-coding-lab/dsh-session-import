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

import type { ParseStats, ParsedSession, SourceEvent } from '../../shared/types.ts'

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
function mainlineOf(byUuid: Map<string, RawRecord>, leafUuid: string | undefined): RawRecord[] {
  if (!leafUuid) return []
  const chain: RawRecord[] = []
  const seen = new Set<string>()
  let current = byUuid.get(leafUuid)
  while (current && current.uuid && !seen.has(current.uuid)) {
    seen.add(current.uuid)
    chain.push(current)
    const parent = typeof current.parentUuid === 'string' ? byUuid.get(current.parentUuid) : undefined
    current = parent
  }
  return chain.reverse()
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
    ignoredTypes: {},
    blocks: {},
  }

  const records: RawRecord[] = []
  const byUuid = new Map<string, RawRecord>()
  let leafUuid: string | undefined
  let sessionId: string | undefined
  let cwd: string | undefined
  let title: string | undefined

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

  const mainline = mainlineOf(byUuid, leafUuid)
  stats.mainlineRecords = mainline.length

  // Window mode: start at the newest compaction boundary the tool itself wrote.
  let startIndex = 0
  if (!options.includeFullHistory) {
    for (let index = mainline.length - 1; index >= 0; index -= 1) {
      const record = mainline[index]
      if (record?.type === 'system' && record.subtype === 'compact_boundary') {
        startIndex = index
        break
      }
    }
  }

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

    const time = toTime(record.timestamp) ?? endedAt ?? Date.now()
    const content = record.message?.content

    if (record.type === 'user') {
      const blocks = Array.isArray(content) ? content : [{ type: 'text', text: blockText(content) }]
      const texts: string[] = []
      for (const raw of blocks) {
        if (!raw || typeof raw !== 'object') continue
        const block = raw as { type?: string; text?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown }
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
        }
      }
      if (texts.length > 0) {
        push({ kind: 'turn-boundary', time })
        push({ kind: 'user', time, text: texts.join('\n\n') })
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
    const firstUser = events.find(event => event.kind === 'user')
    if (firstUser && firstUser.kind === 'user') {
      title = firstUser.text.replace(/\s+/g, ' ').slice(0, 80)
    }
  }

  return {
    sourceSessionId: sessionId ?? basename(sourcePath, '.jsonl'),
    providerId: options.providerId,
    sourcePath,
    cwd,
    title,
    startedAt,
    endedAt,
    events,
    stats,
  }
}
