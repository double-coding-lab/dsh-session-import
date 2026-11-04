/**
 * Import bookkeeping: which source session already became which DSH session.
 *
 * Kept behind a small file-backed store so the pipeline is testable without a
 * running DSH. The key is provider + source session id, and the fingerprint
 * decides "unchanged / grown".
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ImportRecord } from '../shared/types.ts'

export interface SourceFingerprint {
  bytes: number
  mtimeMs: number
  headHash: string
}

/** Hash just enough of the file head to notice an in-place rewrite. */
export function fingerprintOf(bytes: number, mtimeMs: number, head: string): SourceFingerprint {
  return {
    bytes,
    mtimeMs,
    headHash: createHash('sha256').update(head.slice(0, 4096)).digest('hex').slice(0, 16),
  }
}

export function sameFingerprint(a: SourceFingerprint, b: SourceFingerprint): boolean {
  return a.bytes === b.bytes && a.mtimeMs === b.mtimeMs && a.headHash === b.headHash
}

export function recordKey(providerId: string, sourceSessionId: string): string {
  return `${providerId}:${sourceSessionId}`
}

export class ImportStateStore {
  readonly #file: string

  constructor(file: string) {
    this.#file = file
  }

  async load(): Promise<Record<string, ImportRecord>> {
    try {
      const raw = await readFile(this.#file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      return parsed as Record<string, ImportRecord>
    } catch {
      return {}
    }
  }

  async save(records: Record<string, ImportRecord>): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true })
    const temp = `${this.#file}.tmp`
    await writeFile(temp, JSON.stringify(records, null, 2), 'utf8')
    await rename(temp, this.#file)
  }

  async upsert(record: ImportRecord): Promise<void> {
    const records = await this.load()
    records[recordKey(record.providerId, record.sourceSessionId)] = record
    await this.save(records)
  }

  async remove(providerId: string, sourceSessionId: string): Promise<ImportRecord | undefined> {
    const records = await this.load()
    const key = recordKey(providerId, sourceSessionId)
    const found = records[key]
    if (found === undefined) return undefined
    delete records[key]
    await this.save(records)
    return found
  }
}
