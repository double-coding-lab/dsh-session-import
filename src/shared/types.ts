/**
 * Shared contracts for dsh-session-import.
 *
 * The middle layer (`SourceEvent`) is the whole point of the plugin: providers
 * describe *where* sessions live, family parsers turn native records into
 * `SourceEvent`, and only the mapper knows DSH event semantics. Adding a tool
 * of an already-supported family therefore needs no code at all.
 */

/** Format family — selects the parser implementation. */
export type SourceFamily = 'claude-jsonl' | 'codex-jsonl'

/** Per-platform candidate root directories, `~` allowed. */
export interface ProviderRoots {
  win32?: string[]
  darwin?: string[]
  linux?: string[]
}

export interface ProviderLayout {
  /** Glob relative to a root, e.g. `*​/*.jsonl`. */
  sessionGlob: string
  /** Optional glob for subagent transcripts. */
  subagentGlob?: string
}

/** One built-in provider entry (`providers/<id>/provider.json`). Pure data. */
export interface ProviderDescriptor {
  schemaVersion: 1
  id: string
  name: string
  family: SourceFamily
  roots: ProviderRoots
  layout: ProviderLayout
  cwd?: { from?: string }
  title?: { fields?: string[]; fromFirstUserMessage?: boolean }
  capabilities?: {
    resume?: boolean
    images?: boolean
    subagents?: boolean
    reasoning?: boolean
  }
}

/** A normalized conversation event, independent of any tool's format. */
export type SourceEvent =
  | { kind: 'user'; time: number; text: string }
  | { kind: 'assistant'; time: number; text: string; model?: string }
  | { kind: 'reasoning'; time: number; text: string }
  | { kind: 'tool-call'; time: number; callId: string; name: string; args: string }
  | { kind: 'tool-result'; time: number; callId: string; text: string; isError?: boolean }
  | { kind: 'turn-boundary'; time: number }

/** Parsed conversation plus everything the importer needs to report on it. */
export interface ParsedSession {
  sourceSessionId: string
  providerId: string
  sourcePath: string
  cwd?: string
  title?: string
  startedAt?: number
  endedAt?: number
  events: SourceEvent[]
  stats: ParseStats
}

export interface ParseStats {
  lines: number
  badLines: number
  records: number
  mainlineRecords: number
  sidechainRecords: number
  compactBoundaries: number
  ignoredTypes: Record<string, number>
  blocks: Record<string, number>
}

/** Import-time knobs chosen by the user or the profile config. */
export interface ImportOptions {
  /** `window` = resumable window only; `full` = replay everything. */
  fidelity: 'window' | 'full'
  /** Keep at most this many recent turns in `window` mode. 0 = unlimited. */
  maxTurns: number
  /** Hard cap per single text block; head and tail survive around a marker. */
  perTextLimit: number
  /** Keep plaintext reasoning blocks. */
  keepReasoning: boolean
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  fidelity: 'window',
  maxTurns: 80,
  perTextLimit: 262_144,
  keepReasoning: false,
}

/** Persisted idempotency record, keyed by provider + source session. */
export interface ImportRecord {
  providerId: string
  sourceSessionId: string
  sourcePath: string
  fingerprint: { bytes: number; mtimeMs: number; headHash: string }
  dshSessionId: string
  importedTurns: number
  importedAt: number
  lastImportAt: number
  status: 'ok' | 'partial' | 'failed'
}

export type ImportStatus = 'imported' | 'skipped' | 'busy' | 'failed'

export interface ImportResult {
  status: ImportStatus
  providerId: string
  sourceSessionId: string
  dshSessionId?: string
  turns: number
  events: number
  truncated: number
  repaired: number
  message?: string
}
