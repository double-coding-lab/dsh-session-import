import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mapToDshEvents, type DshEvent } from '../src/host/mapper.ts'
import { parseClaudeJsonl } from '../src/host/parsers/claude-jsonl.ts'
import { DEFAULT_IMPORT_OPTIONS } from '../src/shared/types.ts'

const userExample = '请解释这个标签：<thinking>用户输入的原文</thinking>'
const toolExample = '<thinking>工具输出的原文</thinking>'
const reply = '\n\n正式回复，示例是 `<thinking>example</thinking>`。'
const fenced = '```xml\n<thinking>代码示例</thinking>\n```'
const indented = '    <thinking>缩进代码</thinking>'
const unmatched = '<thinking>仅演示起始标签'
const secondBlock = '<thinking>前文正在演示这个标签</thinking>'
const textBlock = (text: string) => ({ type: 'text', text })
const messages: Array<[string, unknown]> = [
  ['user', userExample],
  ['assistant', [textBlock(`<thinking>R1</thinking>${reply}`)]],
  ['assistant', '<thinking>R2</thinking>\n'],
  ['assistant', [textBlock('\n <thinking>R3\ncontinued</thinking>\n<thinking>R4</thinking>\n    保留正文缩进')]],
  ['assistant', [textBlock('<thinking>R5</thinking>'), { type: 'tool_use', id: 'call-1', name: 'demo', input: { value: 1 } }]],
  ['user', [{ type: 'tool_result', tool_use_id: 'call-1', content: toolExample }]],
  ['assistant', [{ type: 'thinking', thinking: 'native' }, textBlock('完成。')]],
  ['assistant', [{ type: 'thinking', thinking: 'native-prefix' }, textBlock('<thinking>正文里的字面标签</thinking>')]],
  ['assistant', [textBlock(fenced)]],
  ['assistant', [textBlock(indented)]],
  ['assistant', [textBlock(unmatched)]],
  ['assistant', [textBlock('下面是字面示例：'), textBlock(secondBlock)]],
]

function assistantBlocks(events: DshEvent[]): Array<{ type: string; text?: string; id?: string }> {
  return events.filter(event => event.type === 'assistant/message').flatMap(event => {
    const message = event.data.message as { content: Array<{ type: string; text?: string; id?: string }> }
    return message.content
  })
}

const dir = await mkdtemp(join(tmpdir(), 'dsi-inline-thinking-'))
try {
  const file = join(dir, 'sample.jsonl')
  const records = messages.map(([role, content], i) => ({
    type: role, uuid: `msg-${i}`, parentUuid: i === 0 ? null : `msg-${i - 1}`,
    timestamp: 1700000000000 + i, message: { role, content, model: 'fixture' },
  }))
  await writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n')
  const parsed = await parseClaudeJsonl(file, { providerId: 'qoder' })
  const expectedReplies = [reply, '\n    保留正文缩进', '完成。', '<thinking>正文里的字面标签</thinking>', fenced, indented, unmatched, '下面是字面示例：', secondBlock]
  for (const keepReasoning of [false, true]) {
    const result = mapToDshEvents(parsed.events, { ...DEFAULT_IMPORT_OPTIONS, keepReasoning })
    const blocks = assistantBlocks(result.events)
    assert.deepEqual(blocks.filter(b => b.type === 'text').map(b => b.text), expectedReplies, 'visible assistant replies')
    assert.deepEqual(blocks.filter(b => b.type === 'reasoning').map(b => b.text),
      keepReasoning ? ['R1', 'R2', 'R3\ncontinued', 'R4', 'R5', 'native', 'native-prefix'] : [], 'reasoning policy')
    assert.equal(result.droppedReasoning, keepReasoning ? 0 : 7)
    assert.deepEqual(blocks.filter(b => b.type === 'tool-call').map(b => b.id), ['call-1'])
    assert.equal(result.events.filter(e => e.type === 'tool/call').length, 1)
    assert.equal(result.events.filter(e => e.type === 'tool/result').length, 1)
    assert.equal(result.repairedCalls, 0)
    assert.equal(result.orphanResults, 0)
    assert.deepEqual(result.events.find(e => e.type === 'user/message')?.data.content, [textBlock(userExample)])
    const toolMessage = result.events.find(e => e.type === 'tool/result')?.data.message as { content?: unknown }
    assert.deepEqual(toolMessage?.content, [textBlock(toolExample)])
  }
  console.log('Inline thinking import passed')
} finally {
  await rm(dir, { recursive: true, force: true })
}
