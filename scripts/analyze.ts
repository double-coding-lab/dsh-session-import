/**
 * Dry-run analyzer: parse one transcript and report what an import would cost.
 * Writes nothing. Useful before wiring the DSH importer.
 *
 *   node scripts/analyze.ts <path-to-session.jsonl> [--full]
 */
import { parseClaudeJsonl } from '../src/host/parsers/claude-jsonl.ts'
import type { SourceEvent } from '../src/shared/types.ts'

const args = process.argv.slice(2)
const target = args.find(arg => !arg.startsWith('--'))
const full = args.includes('--full')

if (!target) {
  console.error('usage: node scripts/analyze.ts <path-to-session.jsonl> [--full]')
  process.exit(2)
}

const startedAt = performance.now()
const parsed = await parseClaudeJsonl(target, {
  providerId: 'qoder',
  includeFullHistory: full,
})
const elapsed = performance.now() - startedAt

const byKind = new Map<SourceEvent['kind'], number>()
let chars = 0
let largest = 0
let largestKind = ''

for (const event of parsed.events) {
  byKind.set(event.kind, (byKind.get(event.kind) ?? 0) + 1)
  const text =
    event.kind === 'tool-call' ? event.args : 'text' in event ? event.text : ''
  chars += text.length
  if (text.length > largest) {
    largest = text.length
    largestKind = event.kind
  }
}

// Rough mixed CJK/latin estimate; replaced by real token metering later.
const estimateTokens = Math.round(chars / 2.2)

console.log('=== session ===')
console.log(`path        ${parsed.sourcePath}`)
console.log(`sessionId   ${parsed.sourceSessionId}`)
console.log(`cwd         ${parsed.cwd ?? '(none)'}`)
console.log(`title       ${parsed.title ?? '(none)'}`)
console.log(`window      ${full ? 'full history' : 'from last compaction boundary'}`)
console.log('')
console.log('=== source ===')
console.log(`lines           ${parsed.stats.lines}`)
console.log(`bad lines       ${parsed.stats.badLines}`)
console.log(`records         ${parsed.stats.records}`)
console.log(`mainline        ${parsed.stats.mainlineRecords}`)
console.log(`sidechain skip  ${parsed.stats.sidechainRecords}`)
console.log(`compact bounds  ${parsed.stats.compactBoundaries}`)
console.log('')
console.log('=== events ===')
for (const [kind, count] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${kind.padEnd(15)} ${count}`)
}
console.log('')
console.log('=== cost ===')
console.log(`chars           ${chars.toLocaleString()}`)
console.log(`est. tokens     ${estimateTokens.toLocaleString()}`)
console.log(`largest text    ${largest.toLocaleString()} chars (${largestKind})`)
console.log(`parse time      ${elapsed.toFixed(0)} ms`)
console.log('')
console.log('=== ignored record types ===')
console.log(parsed.stats.ignoredTypes)
