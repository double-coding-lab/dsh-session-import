/**
 * Mapper: `SourceEvent[]` → DSH `SessionEvent` drafts.
 *
 * This is the only module that knows DSH event semantics. Its three hard jobs,
 * all forced by what real transcripts look like:
 *
 * 1. Turn/step structure — DSH replay rejects an unbalanced `turn/*` or `step/*`.
 * 2. Tool pairing — a `tool/result` without an open `tool/call` is corrupt
 *    surface state, so orphans are dropped and unanswered calls get a
 *    deterministic error result.
 * 3. Budget — a 65 MB transcript yields ~200 K tokens even after the source's
 *    own compaction window, so per-text truncation and turn windows must apply
 *    here, not merely be configurable.
 */
import { randomUUID } from 'node:crypto'

import type { ImportOptions, SourceEvent } from '../shared/types.ts'

/** One event as it will be appended; `seq` is rebased by the importer. */
export interface DshEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
  surfaceOp?: 'append'
}

export interface MapResult {
  events: DshEvent[]
  turns: number
  steps: number
  truncated: number
  /** Open tool calls closed with a synthetic error result. */
  repairedCalls: number
  /** Results whose call was never seen; dropped. */
  orphanResults: number
  droppedReasoning: number
  estimatedChars: number
}

const TRUNCATION_MARKER = '\n\n[... dsh-session-import: 内容过长已截断 ...]\n\n'

/** Keep head and tail around an explicit marker. */
function truncate(text: string, limit: number, counter: { value: number }): string {
  if (limit <= 0 || text.length <= limit) return text
  counter.value += 1
  const keep = Math.max(1, Math.floor((limit - TRUNCATION_MARKER.length) / 2))
  return text.slice(0, keep) + TRUNCATION_MARKER + text.slice(text.length - keep)
}

/** Select the trailing N turns (a turn starts at each user message). */
function windowEvents(events: SourceEvent[], options: ImportOptions): SourceEvent[] {
  if (options.fidelity === 'full' || options.maxTurns <= 0) return events
  let seen = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.kind === 'user') {
      seen += 1
      if (seen === options.maxTurns) return events.slice(index)
    }
  }
  return events
}

export function mapToDshEvents(source: SourceEvent[], options: ImportOptions): MapResult {
  const events: DshEvent[] = []
  const truncated = { value: 0 }
  let seq = 0
  let turn = 0
  let step = 0
  let turnOpen = false
  let stepOpen = false
  let repairedCalls = 0
  let orphanResults = 0
  let droppedReasoning = 0
  let estimatedChars = 0

  const openCalls = new Set<string>()

  const push = (type: string, time: number, data: Record<string, unknown>, surface = false): void => {
    const event: DshEvent = { type, seq: seq++, time, data }
    if (surface) event.surfaceOp = 'append'
    events.push(event)
  }

  const closeStep = (time: number): void => {
    if (!stepOpen) return
    for (const callId of openCalls) {
      push('tool/result', time, {
        message: {
          id: randomUUID(),
          role: 'user',
          content: [
            {
              type: 'tool-result',
              toolCallId: callId,
              content: [
                {
                  type: 'text',
                  text: '（导入说明）该工具调用在源会话中未记录结果，可能被中断或被源工具压缩截断。',
                },
              ],
              isError: true,
            },
          ],
          source: { kind: 'tool', callId },
        },
      }, true)
      repairedCalls += 1
    }
    openCalls.clear()
    push('step/end', time, { turn, step })
    stepOpen = false
  }

  const closeTurn = (time: number): void => {
    closeStep(time)
    if (!turnOpen) return
    push('turn/end', time, { turn, reason: { kind: 'completed' } })
    turnOpen = false
  }

  const ensureTurn = (time: number): void => {
    if (turnOpen) return
    turn += 1
    push('turn/start', time, { turn })
    turnOpen = true
  }

  const ensureStep = (time: number): void => {
    ensureTurn(time)
    if (stepOpen) return
    step += 1
    push('step/start', time, { turn, step })
    stepOpen = true
  }

  const windowed = windowEvents(source, options)

  for (const event of windowed) {
    switch (event.kind) {
      case 'turn-boundary': {
        closeTurn(event.time)
        break
      }
      case 'user': {
        closeStep(event.time)
        ensureTurn(event.time)
        const text = truncate(event.text, options.perTextLimit, truncated)
        estimatedChars += text.length
        push('user/message', event.time, {
          message: {
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          },
        }, true)
        break
      }
      case 'assistant': {
        // One step == one model call: a new assistant message closes the
        // previous step (flushing any call that never got a result).
        closeStep(event.time)
        ensureStep(event.time)
        const text = truncate(event.text, options.perTextLimit, truncated)
        estimatedChars += text.length
        push('assistant/message', event.time, {
          turn,
          step,
          message: {
            id: randomUUID(),
            role: 'assistant',
            content: [{ type: 'text', text }],
            source: {
              kind: 'model',
              provider: 'session-import',
              model: event.model ?? 'unknown',
            },
          },
        }, true)
        break
      }
      case 'reasoning': {
        if (!options.keepReasoning) {
          droppedReasoning += 1
          break
        }
        closeStep(event.time)
        ensureStep(event.time)
        const text = truncate(event.text, options.perTextLimit, truncated)
        estimatedChars += text.length
        push('assistant/message', event.time, {
          turn,
          step,
          message: {
            id: randomUUID(),
            role: 'assistant',
            content: [{ type: 'reasoning', text }],
            source: { kind: 'model', provider: 'session-import', model: 'unknown' },
          },
        })
        break
      }
      case 'tool-call': {
        ensureStep(event.time)
        openCalls.add(event.callId)
        const args = truncate(event.args, options.perTextLimit, truncated)
        estimatedChars += args.length
        push('tool/call', event.time, {
          turn,
          step,
          callId: event.callId,
          name: event.name,
          arguments: args,
        })
        break
      }
      case 'tool-result': {
        if (!openCalls.has(event.callId)) {
          // Never seen the call: emitting this would make the surface corrupt.
          orphanResults += 1
          break
        }
        ensureStep(event.time)
        openCalls.delete(event.callId)
        const text = truncate(event.text, options.perTextLimit, truncated)
        estimatedChars += text.length
        push('tool/result', event.time, {
          turn,
          step,
          message: {
            id: randomUUID(),
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: event.callId,
                content: [{ type: 'text', text }],
                ...(event.isError === true ? { isError: true } : {}),
              },
            ],
            source: { kind: 'tool', callId: event.callId },
          },
        }, true)
        break
      }
    }
  }

  const lastTime = windowed.at(-1)?.time ?? Date.now()
  closeTurn(lastTime)

  return {
    events,
    turns: turn,
    steps: step,
    truncated: truncated.value,
    repairedCalls,
    orphanResults,
    droppedReasoning,
    estimatedChars,
  }
}
