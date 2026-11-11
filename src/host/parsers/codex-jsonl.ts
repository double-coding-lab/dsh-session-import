/**
 * `codex-jsonl` family parser.
 *
 * Codex Desktop/CLI writes one rollout JSONL per resume segment:
 * `{"timestamp","ordinal","type","payload"}` records starting with
 * `session_meta`. One logical thread can span several rollout files; the host
 * passes them in start order and this parser concatenates them, closing the
 * previous turn at each segment boundary.
 */
import { createReadStream } from 'node:fs'
import { basename } from 'node:path'
import { createInterface } from 'node:readline'

import type { ParseStats, ParsedSession, SourceEvent, SourceImage } from '../../shared/types.ts'
import { cleanTitleText } from './claude-jsonl.ts'

interface RawRecord {
  timestamp?: string | number
  ordinal?: number
  type?: string
  payload?: Record<string, unknown>
}

export interface CodexParseOptions {
  providerId: string
}

/** Context Codex injects as user-role input; it is not human conversation. */
const SYNTHETIC_USER_PREFIXES = [
  '<environment_context',
  '<user_instructions',
  '<INSTRUCTIONS',
  '<app-context',
  '<send_user_message_question',
  '# AGENTS.md instructions',
]

function isSyntheticUserText(text: string): boolean {
  const trimmed = text.trimStart()
  return SYNTHETIC_USER_PREFIXES.some(prefix => trimmed.startsWith(prefix))
}

function toTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map(part => {
        if (typeof part === 'string') return part
        if (part !== null && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (value !== null && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') {
    return (value as { text: string }).text
  }
  return ''
}

/** Reasoning summaries/copies; the encrypted payload itself has no text. */
function reasoningText(payload: Record<string, unknown>): string {
  const parts: string[] = []
  for (const key of ['content', 'summary']) {
    const blocks = payload[key]
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block === null || typeof block !== 'object') continue
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string' && text.trim() !== '' && !parts.includes(text)) parts.push(text)
    }
  }
  return parts.join('\n\n')
}

function toolOutputText(output: unknown): string {
  const text = textOf(output)
  if (text !== '') return text
  if (output === undefined || output === null) return ''
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

export async function parseCodexJsonl(
  sourcePaths: string | string[],
  options: CodexParseOptions,
): Promise<ParsedSession> {
  const paths = (Array.isArray(sourcePaths) ? sourcePaths : [sourcePaths]).filter(path => path !== '')
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

  const events: SourceEvent[] = []
  let startedAt: number | undefined
  let endedAt: number | undefined
  let sessionId: string | undefined
  let cwd: string | undefined
  let title: string | undefined
  let model: string | undefined

  const push = (event: SourceEvent): void => {
    if (startedAt === undefined) startedAt = event.time
    endedAt = event.time
    events.push(event)
  }

  for (const [segmentIndex, path] of paths.entries()) {
    const stream = createReadStream(path, { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    let segmentStart: number | undefined
    try {
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
        const type = record.type ?? 'unknown'
        const payload = record.payload ?? {}
        const time = toTime(record.timestamp) ?? segmentStart ?? endedAt ?? Date.now()

        if (type === 'session_meta') {
          if (sessionId === undefined && typeof payload['session_id'] === 'string') sessionId = payload['session_id']
          if (cwd === undefined && typeof payload['cwd'] === 'string') cwd = payload['cwd']
          if (cwd === undefined && Array.isArray(payload['runtime_workspace_roots'])) {
            const root = payload['runtime_workspace_roots'][0]
            if (typeof root === 'string') cwd = root
          }
          if (segmentStart === undefined) {
            segmentStart = toTime(payload['timestamp']) ?? time
            // A resume segment continues the same conversation; close the
            // previous turn where the new rollout begins.
            if (segmentIndex > 0 && events.length > 0) push({ kind: 'turn-boundary', time: segmentStart })
          }
          continue
        }
        if (type === 'turn_context') {
          if (typeof payload['cwd'] === 'string' && cwd === undefined) cwd = payload['cwd']
          if (typeof payload['model'] === 'string' && payload['model'] !== '') model = payload['model']
          continue
        }
        if (type !== 'response_item') {
          stats.ignoredTypes[type] = (stats.ignoredTypes[type] ?? 0) + 1
          continue
        }

        const itemType = typeof payload['type'] === 'string' ? payload['type'] : 'unknown'
        if (itemType === 'message') {
          const role = payload['role']
          if (role === 'developer' || role === 'system') {
            stats.ignoredTypes[`message:${String(role)}`] = (stats.ignoredTypes[`message:${String(role)}`] ?? 0) + 1
            continue
          }
          const content = payload['content']
          const texts: string[] = []
          const images: SourceImage[] = []
          if (Array.isArray(content)) {
            for (const raw of content) {
              if (raw === null || typeof raw !== 'object') continue
              const block = raw as { type?: string; text?: unknown; image_url?: unknown; url?: unknown }
              stats.blocks[block.type ?? 'unknown'] = (stats.blocks[block.type ?? 'unknown'] ?? 0) + 1
              if (block.type === 'input_text' || block.type === 'output_text' || block.type === 'text') {
                if (typeof block.text === 'string') texts.push(block.text)
              } else if (block.type === 'input_image' || block.type === 'image_url') {
                const url = block.image_url ?? block.url
                if (typeof url === 'string' && url !== '') images.push({ url })
              }
            }
          } else if (typeof content === 'string') {
            texts.push(content)
          }
          const text = texts.filter(part => part !== '').join('\n\n')
          if (role === 'user') {
            if (isSyntheticUserText(text)) {
              stats.injectedUserMessages += 1
              continue
            }
            if (text === '' && images.length === 0) continue
            push({ kind: 'turn-boundary', time })
            push({ kind: 'user', time, text, ...(images.length > 0 ? { images } : {}) })
            if (title === undefined) title = cleanTitleText(text)
          } else if (role === 'assistant') {
            if (text === '') continue
            push({ kind: 'assistant', time, text, ...(model === undefined ? {} : { model }) })
          } else {
            stats.ignoredTypes[`message:${String(role)}`] = (stats.ignoredTypes[`message:${String(role)}`] ?? 0) + 1
          }
          continue
        }
        if (itemType === 'reasoning') {
          const text = reasoningText(payload)
          if (text !== '') push({ kind: 'reasoning', time, text })
          else stats.ignoredTypes['reasoning:encrypted'] = (stats.ignoredTypes['reasoning:encrypted'] ?? 0) + 1
          continue
        }
        if (itemType === 'custom_tool_call' || itemType === 'function_call') {
          const callId = String(payload['call_id'] ?? payload['id'] ?? '')
          const name = String(payload['name'] ?? 'exec')
          const input = payload['input'] ?? payload['arguments'] ?? {}
          const args = typeof input === 'string' ? JSON.stringify({ input }) : JSON.stringify(input)
          push({ kind: 'tool-call', time, callId, name, args })
          continue
        }
        if (itemType === 'custom_tool_call_output' || itemType === 'function_call_output') {
          const callId = String(payload['call_id'] ?? '')
          push({ kind: 'tool-result', time, callId, text: toolOutputText(payload['output'] ?? payload['result']) })
          continue
        }
        stats.ignoredTypes[`response_item:${itemType}`] = (stats.ignoredTypes[`response_item:${itemType}`] ?? 0) + 1
      }
    } finally {
      lines.close()
      stream.destroy()
    }
  }

  if (title === undefined) {
    for (const event of events) {
      if (event.kind !== 'user') continue
      const candidate = cleanTitleText(event.text)
      if (candidate !== undefined) {
        title = candidate
        break
      }
    }
  }

  stats.mainlineRecords = stats.records
  return {
    sourceSessionId: sessionId ?? basename(paths[0] ?? '', '.jsonl'),
    providerId: options.providerId,
    sourcePath: paths[paths.length - 1] ?? '',
    ...(paths.length > 0 ? { segmentPaths: paths } : {}),
    ...(sessionId === undefined ? {} : { lineageId: sessionId }),
    cwd,
    title,
    startedAt,
    endedAt,
    events,
    stats,
  }
}
