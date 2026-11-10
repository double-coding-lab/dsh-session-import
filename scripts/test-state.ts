/**
 * Ledger concurrency self-check: separate store instances writing the same
 * file must not race each other's temp rename or lose records.
 *
 *   node scripts/test-state.ts
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ImportStateStore } from '../src/host/state.ts'
import type { ImportRecord } from '../src/shared/types.ts'

function record(sourceSessionId: string): ImportRecord {
  return {
    providerId: 'qoder',
    sourceSessionId,
    sourcePath: `/tmp/${sourceSessionId}.jsonl`,
    fingerprint: { bytes: 1, mtimeMs: 1, headHash: 'x' },
    dshSessionId: `import-${sourceSessionId}`,
    importedTurns: 1,
    importedEventCount: 1,
    prefixHash: 'x',
    importedAt: 1,
    lastImportAt: 1,
    status: 'ok',
  }
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-state-test-'))
try {
  const file = join(dir, 'state.json')
  const first = new ImportStateStore(file)
  const second = new ImportStateStore(file)
  await Promise.all([first.upsert(record('a')), second.upsert(record('b'))])

  let records = await first.load()
  if (records['qoder:a'] === undefined || records['qoder:b'] === undefined) {
    throw new Error(`并发 upsert 丢记录：${Object.keys(records).join(',')}`)
  }

  await Promise.all([first.remove('qoder', 'a'), second.upsert(record('c'))])
  records = await first.load()
  if (records['qoder:a'] !== undefined) throw new Error('并发 remove 未生效')
  if (records['qoder:b'] === undefined || records['qoder:c'] === undefined) {
    throw new Error(`并发 remove/upsert 丢记录：${Object.keys(records).join(',')}`)
  }

  console.log('✅ 账本并发自检通过（两个 store 并发写不丢记录）')
} finally {
  await rm(dir, { recursive: true, force: true })
}
