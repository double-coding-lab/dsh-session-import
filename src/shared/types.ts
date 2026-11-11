/**
 * Shared contracts for dsh-session-import.
 *
 * The middle layer (`SourceEvent`) is the whole point of the plugin: providers
 * describe *where* sessions live, family parsers turn native records into
 * `SourceEvent`, and only the mapper knows DSH event semantics. Adding a tool
 * of an already-supported family therefore needs no code at all.
 */

/** Format family — selects the parser implementation. */
export type SourceFamily = 'claude-jsonl' | 'codex-jsonl' | 'codex-db'

/** Per-platform candidate root directories, `~` allowed. */
export interface ProviderRoots {
  win32?: string[]
  darwin?: string[]
  linux?: string[]
}

export interface ProviderLayout {
  /** Glob relative to a root, e.g. `*​/*.jsonl`. */
  sessionGlob: string
  /** Additional globs (e.g. flat archives beside dated session folders). */
  sessionGlobs?: string[]
  /** Optional glob for subagent transcripts. */
  subagentGlob?: string
  /**
   * SQLite-backed source (Codex Desktop). Paths are relative to the provider
   * root; `layout` is a placeholder for the shared asset contract.
   */
  database?: {
    state: string
    history: string
    globalState?: string
  }
}

/** One machine-only session rule; every declared condition must match. */
export interface SessionIgnoreRule {
  /** Case-insensitive substring of the session cwd (workspace path). */
  cwdContains?: string
  /** Exact picker title. */
  title?: string
}

/** Conversation asset: where transcripts live and how to read their metadata. */
export interface SessionAsset {
  roots: ProviderRoots
  layout: ProviderLayout
  cwd?: { from?: string }
  title?: { fields?: string[]; fromFirstUserMessage?: boolean }
  /**
   * How transcripts of one logical conversation relate:
   * - `branch`: rewinds fork the history; show the newest branch (Claude Code).
   * - `segments`: resumes append new rollout files; compose all in order (Codex).
   */
  lineage?: { mode?: 'branch' | 'segments' }
  /**
   * Machine-only transcripts (plugin telemetry, acks, internal probes) that the
   * picker hides. Matched on picker metadata so no provider id branch is needed.
   */
  ignore?: { titlePrefixes?: string[]; sessions?: SessionIgnoreRule[] }
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

/** An image the source tool attached to a user message. */
export interface SourceImage {
  /** Local copy on disk (Qoder keeps one under `~/.qoder/tmp/<project>/images/<session>/`). */
  localPath?: string
  /** Provider URL (signed, may expire) or a `data:` URL. */
  url?: string
}

/** Durable DSH image reference embedded in a stored message block. */
export interface DshImageRef {
  attachmentId: string
  mediaType: string
  width: number
  height: number
  bytes: number
  name?: string
}

/** A normalized conversation event, independent of any tool's format. */
export type SourceEvent =
  | { kind: 'user'; time: number; text: string; images?: SourceImage[]; imageRefs?: DshImageRef[] }
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
  /** All rollout files that compose this session (Codex resumes). */
  segmentPaths?: string[]
  /** First human-turn UUID; rewind branches of one conversation share it. */
  lineageId?: string
  /** Sources without a physical file (Codex DB) supply their own fingerprint. */
  fingerprint?: { bytes: number; mtimeMs: number; headHash: string }
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
  /** Ordered rollout files composing a segmented session (Codex). */
  sourcePaths?: string[]
  /** First human-turn UUID; binds rewind branches to one imported session. */
  lineageId?: string
  fingerprint: { bytes: number; mtimeMs: number; headHash: string }
  dshSessionId: string
  importedTurns: number
  /** How many DSH events have been written; the append cursor for growth. */
  importedEventCount: number
  /** Hash of the leading events, to detect a source window that slid. */
  prefixHash: string
  /** Hash of the mapped events just before the append cursor; detects parser drift. */
  boundaryHash?: string
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
  /** True when the DSH session was rewritten from a newer rewind branch. */
  rebuilt?: boolean
}
