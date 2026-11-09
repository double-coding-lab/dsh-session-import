/**
 * Recovery self-test: a transcript without `active-leaf` must still import.
 *
 * Qoder writes `active-leaf` on a clean shutdown; an interrupted session leaves
 * it out. The parser must fall back to the newest childless message and ignore
 * abandoned branches instead of returning zero events.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseClaudeJsonl } from '../src/host/parsers/claude-jsonl.ts'

const fixture = resolve(fileURLToPath(new URL('../fixtures/no-active-leaf.jsonl', import.meta.url)))
const parsed = await parseClaudeJsonl(fixture, { providerId: 'qoder' })
const assistantTexts = parsed.events
  .filter(event => event.kind === 'assistant')
  .map(event => (event.kind === 'assistant' ? event.text : ''))

const problems: string[] = []
if (parsed.events.length === 0) problems.push('缺少 active-leaf 时不应解析为空')
if (parsed.stats.mainlineRecords !== 4) problems.push(`主线应为 4 条，实际 ${parsed.stats.mainlineRecords}`)
if (!assistantTexts.some(text => text.includes('收到'))) problems.push('应选中最新叶子所在的主线')
if (assistantTexts.some(text => text.includes('放弃的分支'))) problems.push('不应把被放弃的分支导入主线')
if (parsed.title !== '你好') problems.push(`标题应为「你好」，实际「${parsed.title ?? ''}」`)

if (problems.length === 0) {
  console.log('✅ 无 active-leaf 恢复自检通过（最新叶子 + 分支隔离）')
} else {
  console.log(`❌ 无 active-leaf 恢复自检失败（${problems.length} 项）：`)
  for (const problem of problems) console.log(`   - ${problem}`)
  process.exit(1)
}
