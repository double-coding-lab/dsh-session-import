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

/** Conversation asset: where transcripts live and how to read their metadata. */
export interface SessionAsset {
  roots: ProviderRoots
  layout: ProviderLayout
  cwd?: { from?: string }
  title?: { fields?: string[]; fromFirstUserMessage?: boolean }
}

/** A local file syntax a provider writes into assistant text. */
export type FileLinkSyntax = 'markdown-link'

/** Which link destinations count as local files for a rule. */
export type FileLinkAccept = 'file-url' | 'absolute-path' | 'relative-path'

/**
 * One provider-level file-link rule. Providers differ: Qoder writes
 * `[name](file:///D:/…)`; another tool may emit bare absolute or workspace
 * relative paths. The adapter is shared, the rule is data.
 */
export interface FileLinkRule {
  syntax: FileLinkSyntax
  accept: FileLinkAccept[]
  /** Optional extension gate (`[".md", ".pdf"]`); empty or absent accepts any. */
  extensions?: string[]
}

export interface FileLinksAsset {
  assistant?: FileLinkRule[]
}

/** One local file referenced by a source assistant message. */
export interface SourceFileReference {
  /** Absolute path, as declared after provider normalization. */
  path: string
  /** The link label when it adds information beyond the file name. */
  description?: string
}

/** One built-in provider entry (`providers/<id>/provider.json`). Pure data. */
export interface ProviderDescriptor {
  schemaVersion: 1
  id: string
  name: string
  /** Official app icon, relative to the provider directory (png/svg/webp/ico/jpg). */
  icon?: string
  family: SourceFamily
  assets: {
    /** Only sessions are supported: DSH has no consumer for anything else. */
    sessions?: SessionAsset
  }
  fileLinks?: FileLinksAsset
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
  | { kind: 'assistant'; time: number; text: string; model?: string; files?: SourceFileReference[] }
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
  /** Skill bodies the source tool injected as user messages; dropped. */
  injectedUserMessages: number
  ignoredTypes: Record<string, number>
  blocks: Record<string, number>
}

/** Import-time knobs chosen by the user or the profile config. */
export interface ImportOptions {
  /** Hard cap per single text block; head and tail survive around a marker. */
  perTextLimit: number
  /** Keep plaintext reasoning blocks. */
  keepReasoning: boolean
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
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
  /** How many DSH events have been written; the append cursor for growth. */
  importedEventCount: number
  /** Hash of the leading events, to detect a source window that slid. */
  prefixHash: string
  importedAt: number
  lastImportAt: number
  status: 'ok' | 'partial' | 'failed'
}

export type ImportStatus = 'imported' | 'skipped' | 'busy' | 'failed'

export interface ImportResult {
  /** Workspace the imported session was attached to, when registration succeeded. */
  workspacePath?: string
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
