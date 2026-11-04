/**
 * Render a mapped session back into a readable transcript, so a human can
 * judge fidelity before anything is written into DSH.
 *
 *   node scripts/preview.ts <path-to-session.jsonl> [--full] [--turns N] [--out FILE]
 *
 * Output goes wherever `--out` says; nothing is written into the repo by
 * default because transcripts contain real project content.
 */
import { writeFile } from 'node:fs/promises'

import { mapToDshEvents, type DshEvent } from '../src/host/mapper.ts'
import { parseClaudeJsonl } from '../src/host/parsers/claude-jsonl.ts'
import { DEFAULT_IMPORT_OPTIONS } from '../src/shared/types.ts'

const args = process.argv.slice(2)
const target = args.find(arg => !arg.startsWith('--'))
if (!target) {
  console.error('usage: node scripts/preview.ts <path> [--full] [--turns N] [--out FILE]')
  process.exit(2)
}
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const maxTurns = Number(flag('--turns') ?? 80)
const outPath = flag('--out')
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

/** Collapse whitespace and clip, so a row stays readable. */
function clip(text: string, limit = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

const lines: string[] = []
lines.push(`# ${parsed.title ?? '(无标题)'}`)
lines.push('')
lines.push(`- 源会话：\`${parsed.sourcePath}\``)
lines.push(`- 工作目录：\`${parsed.cwd ?? '(未知)'}\``)
lines.push(`- 轮次 ${mapped.turns} · 步骤 ${mapped.steps} · 事件 ${mapped.events.length}`)
lines.push(`- 修复孤儿调用 ${mapped.repairedCalls} · 丢弃 reasoning ${mapped.droppedReasoning} · 截断 ${mapped.truncated}`)
lines.push('')

let turn = 0
let step = 0
const openCalls: string[] = []

const toolName = new Map<string, string>()

for (const event of mapped.events as DshEvent[]) {
  switch (event.type) {
    case 'turn/start':
      turn = Number(event.data.turn)
      lines.push('')
      lines.push(`## 第 ${turn} 轮`)
      break
    case 'user/message': {
      const message = event.data.message as { content: { type: string; text?: string }[] }
      const text = message.content.map(block => block.text ?? '').join('\n')
      lines.push('')
      lines.push(`**用户**：${clip(text, 400)}`)
      break
    }
    case 'assistant/message': {
      step = Number(event.data.step ?? step)
      const message = event.data.message as { content: { type: string; text?: string }[] }
      const text = message.content.map(block => block.text ?? '').join('\n')
      const kind = message.content[0]?.type === 'reasoning' ? '思考' : '助手'
      lines.push('')
      lines.push(`**${kind}**（step ${step}）：${clip(text, 300)}`)
      break
    }
    case 'tool/call': {
      const callId = String(event.data.callId)
      const name = String(event.data.name)
      toolName.set(callId, name)
      openCalls.push(callId)
      lines.push(`  - 🔧 调用 \`${name}\` · ${clip(String(event.data.arguments), 120)}`)
      break
    }
    case 'tool/result': {
      const message = event.data.message as {
        source?: { callId?: string }
        content?: { type: string; content?: { text?: string }[] }[]
      }
      const callId = message.source?.callId ?? ''
      const name = toolName.get(callId) ?? 'unknown'
      const block = message.content?.[0]
      const text = (block?.content ?? []).map(part => part.text ?? '').join('\n')
      const isError = (block as { isError?: boolean } | undefined)?.isError
      const mark = isError === true ? '⚠️ 补的错误结果' : '返回'
      lines.push(`  - ↳ ${mark} \`${name}\`：${clip(text, 160)}`)
      const index = openCalls.indexOf(callId)
      if (index >= 0) openCalls.splice(index, 1)
      break
    }
    default:
      break
  }
}

const report = lines.join('\n')
if (outPath !== undefined) {
  await writeFile(outPath, report, 'utf8')
  console.log(`完整预览已写入：${outPath}`)
  console.log('')
}

// Console shows the head and tail so the shape is visible without scrolling.
const head = lines.slice(0, 46).join('\n')
const tail = lines.slice(-14).join('\n')
console.log(head)
console.log('\n... (中间省略) ...\n')
console.log(tail)
