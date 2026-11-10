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

export function mapToDshEvents(source: SourceEvent[], options: ImportOptions): MapResult {
  const events: DshEvent[] = []
  const truncated = { value: 0 }
  let seq = 0
  let turn = 0
  let step = 0
  let turnOpen = false
  let stepOpen = false
  /** DSH resumes append their own system/message; the first surface node must be one. */
  let systemHead = false
  let repairedCalls = 0
  let orphanResults = 0
  let droppedReasoning = 0
  let estimatedChars = 0
  /** Files already declared in this turn; `deliverables/presented` is per path. */
  const presentedPaths = new Set<string>()
  let presentedCalls = 0

  const openCalls = new Set<string>()
  /** Deterministic message ids keep re-mapping byte-identical (needed for the growth prefix hash). */
  let messageSeq = 0
  const nextMessageId = (): string => `imp-${(messageSeq += 1)}`
  /** Call ids already advertised by an assistant message in this log. */
  const advertised = new Set<string>()

  const push = (type: string, time: number, data: Record<string, unknown>, surface = false): void => {
    const event: DshEvent = { type, seq: seq++, time, data }
    if (surface) event.surfaceOp = 'append'
    events.push(event)
  }

  const closeStep = (time: number): void => {
    if (!stepOpen) return
    for (const callId of openCalls) {
      push('tool/result', time, {
        turn,
        step,
        message: {
          id: nextMessageId(),
          role: 'tool',
          toolCallId: callId,
          content: [
            {
              type: 'text',
              text: '（导入说明）该工具调用在源会话中未记录结果，可能被中断或被源工具压缩截断。',
            },
          ],
          source: { kind: 'tool', callId },
          isError: true,
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
    // Step numbering restarts per turn: DSH validates the next step as 1.
    step = 0
    presentedPaths.clear()
    push('turn/start', time, { turn })
    turnOpen = true
  }

  const ensureStep = (time: number): void => {
    ensureTurn(time)
    if (stepOpen) return
    step += 1
    push('step/start', time, { turn, step })
    stepOpen = true
    // An empty system node is valid, never projects into model input, and
    // marks the protected surface head DSH requires before later resumes can
    // append their own system/message events.
    if (!systemHead) {
      push('system/message', time, {
        turn,
        step,
        message: {
          id: 'imp-system',
          role: 'system',
          content: [],
          source: { kind: 'system-prompt' },
        },
      }, true)
      systemHead = true
    }
  }

  const windowed = source

  for (let index = 0; index < windowed.length; index += 1) {
    const event = windowed[index]!
    switch (event.kind) {
      case 'turn-boundary': {
        // The boundary carries the *next* user message's time. Closing the
        // previous turn with it would count the user's idle gap as work time
        // (imported transcripts often resume hours or days later).
        closeTurn(events.at(-1)?.time ?? event.time)
        break
      }
      case 'user': {
        if (systemHead) {
          closeStep(event.time)
          ensureTurn(event.time)
        } else {
          // The first user message shares the system head's step, matching how
          // a native session opens.
          ensureStep(event.time)
        }
        const text = truncate(event.text, options.perTextLimit, truncated)
        estimatedChars += text.length
        const content: unknown[] = (event.imageRefs ?? []).map(ref => ({ type: 'image', attachment: ref }))
        if (text !== '') content.push({ type: 'text', text })
        if (content.length === 0) break
        push('user/message', event.time, {
          id: nextMessageId(),
          role: 'user',
          content,
          source: { kind: 'user' },
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
        // DSH only renders an inline-code path as a clickable file chip when
        // the same turn declares that file as a deliverable. Presenting is the
        // native mechanism; it carries no surface node, so the transcript keeps
        // the same shape as the source.
        const freshFiles = (event.files ?? []).filter(file => !presentedPaths.has(file.path))
        if (freshFiles.length > 0) {
          for (const file of freshFiles) presentedPaths.add(file.path)
          presentedCalls += 1
          push('deliverables/presented', event.time, {
            turn,
            callId: `imp-present-${presentedCalls}`,
            files: freshFiles.map(file => ({
              path: file.path,
              ...(file.description === undefined ? {} : { description: file.description }),
            })),
          })
        }
        // DSH admits a tool/call only if an assistant message advertised it, so
        // the calls that immediately follow ride along in this message.
        const content: Record<string, unknown>[] = [{ type: 'text', text }]
        for (let look = index + 1; look < windowed.length; look += 1) {
          const next = windowed[look]!
          if (next.kind !== 'tool-call') break
          content.push({
            type: 'tool-call',
            id: next.callId,
            name: next.name,
            arguments: truncate(next.args, options.perTextLimit, truncated),
          })
          advertised.add(next.callId)
        }
        push('assistant/message', event.time, {
          turn,
          step,
          stream: [],
          message: {
            id: nextMessageId(),
            role: 'assistant',
            content,
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
          stream: [],
          message: {
            id: nextMessageId(),
            role: 'assistant',
            content: [{ type: 'reasoning', text }],
            source: { kind: 'model', provider: 'session-import', model: 'unknown' },
          },
        })
        break
      }
      case 'tool-call': {
        ensureStep(event.time)
        // A tool-only model turn has no assistant text to carry the block, so
        // advertise the call here before the call event itself.
        if (!advertised.has(event.callId)) {
          const blocks: Record<string, unknown>[] = []
          for (let look = index; look < windowed.length; look += 1) {
            const next = windowed[look]!
            if (next.kind !== 'tool-call') break
            blocks.push({
              type: 'tool-call',
              id: next.callId,
              name: next.name,
              arguments: truncate(next.args, options.perTextLimit, truncated),
            })
            advertised.add(next.callId)
          }
          push('assistant/message', event.time, {
            turn,
            step,
            stream: [],
            message: {
              id: nextMessageId(),
              role: 'assistant',
              content: blocks,
              source: { kind: 'model', provider: 'session-import', model: 'unknown' },
            },
          }, true)
        }
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
            id: nextMessageId(),
            role: 'tool',
            toolCallId: event.callId,
            content: [{ type: 'text', text }],
            source: { kind: 'tool', callId: event.callId },
            ...(event.isError === true ? { isError: true } : {}),
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
