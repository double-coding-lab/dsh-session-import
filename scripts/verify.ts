/**
 * Structural self-check: parse → map → validate the event log the way DSH
 * will read it. Fails loudly on any imbalance, because a log with unbalanced
 * turns or unpaired tool traffic is refused by the real session loader.
 *
 *   node scripts/verify.ts <path-to-session.jsonl> [--full] [--max-turns N]
 */
import { parseClaudeJsonl } from '../src/host/parsers/claude-jsonl.ts'
import { mapToDshEvents } from '../src/host/mapper.ts'
import { DEFAULT_IMPORT_OPTIONS } from '../src/shared/types.ts'

const args = process.argv.slice(2)
const target = args.find(arg => !arg.startsWith('--'))
if (!target) {
  console.error('usage: node scripts/verify.ts <path> [--full] [--max-turns N]')
  process.exit(2)
}

const maxTurnsIndex = args.indexOf('--max-turns')
const maxTurns = maxTurnsIndex >= 0 ? Number(args[maxTurnsIndex + 1] ?? 80) : 80

const options = {
  ...DEFAULT_IMPORT_OPTIONS,
  fidelity: args.includes('--full') ? ('full' as const) : ('window' as const),
  maxTurns,
}

const parsed = await parseClaudeJsonl(target, {
  providerId: 'qoder',
  includeFullHistory: options.fidelity === 'full',
})
const mapped = mapToDshEvents(parsed.events, options)

const problems: string[] = []

// seq must be contiguous from 0
mapped.events.forEach((event, index) => {
  if (event.seq !== index) problems.push(`seq 断裂：第 ${index} 条 seq=${event.seq}`)
})

let openTurns = 0
let openSteps = 0
const openCalls = new Set<string>()

for (const event of mapped.events) {
  switch (event.type) {
    case 'turn/start':
      openTurns += 1
      break
    case 'turn/end':
      openTurns -= 1
      if (openTurns < 0) problems.push('turn/end 多于 turn/start')
      break
    case 'step/start':
      openSteps += 1
      break
    case 'step/end':
      openSteps -= 1
      if (openSteps < 0) problems.push('step/end 多于 step/start')
      break
    case 'tool/call':
      openCalls.add(String(event.data.callId))
      break
    case 'tool/result': {
      const message = event.data.message as { source?: { callId?: string } }
      const callId = message.source?.callId ?? ''
      if (!openCalls.has(callId)) problems.push(`tool/result 无对应 call：${callId}`)
      openCalls.delete(callId)
      break
    }
  }
}

if (openTurns !== 0) problems.push(`未闭合的 turn：${openTurns}`)
if (openSteps !== 0) problems.push(`未闭合的 step：${openSteps}`)
if (openCalls.size > 0) problems.push(`未闭合的 tool call：${openCalls.size}`)

console.log(`title      ${parsed.title ?? '(none)'}`)
console.log(`window     ${options.fidelity}${options.fidelity === 'window' ? ` (maxTurns=${options.maxTurns})` : ''}`)
console.log('')
console.log(`turns      ${mapped.turns}`)
console.log(`steps      ${mapped.steps}`)
console.log(`events     ${mapped.events.length}`)
console.log(`chars      ${mapped.estimatedChars.toLocaleString()}  (~${Math.round(mapped.estimatedChars / 2.2).toLocaleString()} tokens)`)
console.log('')
console.log(`truncated  ${mapped.truncated}`)
console.log(`repaired   ${mapped.repairedCalls} (孤儿调用补错误结果)`)
console.log(`orphan     ${mapped.orphanResults} (无主的 result 已丢弃)`)
console.log(`reasoning  ${mapped.droppedReasoning} dropped`)
console.log('')

if (problems.length === 0) {
  console.log('✅ 结构自检通过')
} else {
  console.log(`❌ 结构自检失败（${problems.length} 项）：`)
  for (const problem of problems.slice(0, 20)) console.log(`   - ${problem}`)
  process.exit(1)
}
