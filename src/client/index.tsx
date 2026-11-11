/**
 * Settings section: import third-party sessions into DSH.
 *
 * Geometry mirrors the official settings surface:
 * `packages/client/ui-settings-general/src/client/SettingsRoot.module.css` and
 * `.../ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.module.css`
 * (0.5px hairlines, 36px controls, 24px subtitle indent, chevron rotated -90).
 */
import type { Context } from '@deepseek-ai/cordis'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export const inject: string[] = ['locale', 'sessions']

/**
 * The settings nav picks its glyph from a fixed id→icon map and falls back to
 * the gear (which would duplicate 「通用设置」). DSH offers no per-section icon
 * option, so we register under the unused `archived-sessions` id, whose native
 * glyph (an archive box) reads as imported history.
 */
const SECTION_ID = 'archived-sessions'
const STYLE_ID = 'dsh-session-import-style'
const API = '/dsh-session-import/api'
const PROBE_ROUNDS = 6
const PROBE_INTERVAL_MS = 350

interface SlotsFace {
  inject(name: string, callback: () => unknown): unknown
  register(spec: Record<string, unknown>, component: unknown): () => void
}

/** The client session list: importing through the host does not notify it. */
interface SessionsFace {
  refresh(): unknown
  handleSessionRemoved?(sessionId: string): unknown
  list?: {
    getSnapshot(): {
      ids: string[]
      byId: Record<string, {
        retainedBy?: { mainView?: number }
        blank?: boolean
        parentSessionId?: string
        origin?: string
      } | undefined>
    }
  }
}

/** The workspace surface owns the main view's retained Session. */
interface UiWorkspaceFace {
  openSession?(sessionId: string): void
  clearMain?(): void
}

let refreshSidebar: (() => void) | undefined
let forgetSession: ((sessionId: string) => void) | undefined
let isCurrentSession: ((sessionId: string) => boolean) | undefined
let leaveCurrentSession: ((removedId: string) => boolean) | undefined
let moveToSurvivingSession: ((removedId: string, exclude: ReadonlySet<string>) => boolean) | undefined

const SETTINGS_MODAL_SELECTOR = '[data-shortcut-modal="settings"]'
let pendingLeave: MutationObserver | undefined

/**
 * The Host auto-closes its settings dialog when the main view drops back to the
 * blank new-chat state (an onboarding step appears), so view cleanup caused by a
 * retract must wait until the dialog is gone.
 */
function leaveAfterSettingsClose(removedId: string): boolean {
  if (document.querySelector(SETTINGS_MODAL_SELECTOR) === null) return false
  pendingLeave?.disconnect()
  const observer = new MutationObserver(() => {
    if (document.querySelector(SETTINGS_MODAL_SELECTOR) !== null) return
    observer.disconnect()
    if (pendingLeave === observer) pendingLeave = undefined
    leaveCurrentSession?.(removedId)
  })
  pendingLeave = observer
  observer.observe(document.body, { childList: true })
  return true
}

/** A page-level notice survives the settings panel closing after retraction. */
function showToast(text: string, tone: 'success' | 'error' = 'success'): void {
  document.getElementById('dsi-toast')?.remove()
  const toast = document.createElement('div')
  toast.id = 'dsi-toast'
  toast.className = tone === 'error' ? 'dsi-toast dsi-toast-error' : 'dsi-toast'
  toast.textContent = text
  document.body.appendChild(toast)
  setTimeout(() => toast.remove(), 4000)
}

interface ProviderSummary {
  id: string
  name: string
  family: string
  icon?: string
}

interface ScannedSession {
  title?: string
  sourceSessionId: string
  sourcePath: string
  bytes: number
  mtimeMs: number
  status: 'new' | 'imported' | 'grown' | 'failed'
  dshSessionId?: string
  cwd?: string
  createdAtMs?: number
  /** The active source branch differs from the imported one; re-import rebuilds. */
  branchChanged?: boolean
}

interface WorkspaceGroup {
  key: string
  label: string
  path?: string
  createdAt: number
  sessions: ScannedSession[]
}

interface WorkspaceView extends WorkspaceGroup {
  /** Unfiltered sessions, used by workspace-level actions while searching. */
  allSessions: ScannedSession[]
}

interface RetractTarget {
  kind: 'session' | 'workspace' | 'provider'
  providerId: string
  label: string
  items: ScannedSession[]
}

/**
 * Qoder auto-creates scratch folders for one-off tasks (`Documents/Qoder/<date>/<id>`,
 * `.qoderwork/workspace/*`, `chat-N`). Those are tasks without a workspace; a real
 * project folder is a workspace even when it holds a single session.
 */
function isScratchWorkspace(cwd?: string): boolean {
  if (cwd === undefined || cwd === '') return true
  const path = cwd.replace(/\\/g, '/')
  if (/\/\.qoderwork\/workspace\//i.test(path)) return true
  if (/\/Documents\/Qoder\/\d{4}-\d{2}-\d{2}\//i.test(path)) return true
  const name = path.replace(/\/+$/, '').split('/').pop() ?? ''
  return /^chat-\d+$/i.test(name)
}

/** Project display name, matching how the source tool's sidebar labels it. */
function workspaceLabel(cwd?: string): string {
  if (cwd === undefined || cwd === '') return '未归类'
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? cwd
}

/** Windows records the same folder as `E:\a\b` or `e:/a/b`; one key must cover both. */
function canonicalWorkspaceKey(cwd?: string): string {
  if (cwd === undefined || cwd === '') return ''
  const path = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path
}

function groupByWorkspace(list: ScannedSession[]): WorkspaceGroup[] {
  const map = new Map<string, WorkspaceGroup>()
  for (const item of list) {
    const key = canonicalWorkspaceKey(item.cwd)
    let group = map.get(key)
    if (group === undefined) {
      group = { key, label: workspaceLabel(item.cwd), path: item.cwd, createdAt: item.createdAtMs ?? 0, sessions: [] }
      map.set(key, group)
    }
    group.createdAt = Math.max(group.createdAt, item.createdAtMs ?? 0)
    group.sessions.push(item)
  }
  return [...map.values()]
}

interface ImportResultView {
  status: string
  sourceSessionId: string
  turns?: number
  events?: number
  truncated?: number
  repaired?: number
  message?: string
  dshSessionId?: string
  workspacePath?: string
}

interface ImportReportEntry extends ImportResultView {
  providerId: string
  providerName: string
  title?: string
  sourcePath: string
  cwd?: string
  sourceBytes: number
  sourceMtime: string
  previousStatus: ScannedSession['status']
  httpStatus?: number
  startedAt: string
  finishedAt: string
  durationMs: number
}

interface ImportReport {
  kind: 'dsh-session-import.report'
  schemaVersion: 1
  generatedAt: string
  plugin: { name: string; version: string }
  run: {
    startedAt: string
    finishedAt: string
    durationMs: number
    counts: { total: number; imported: number; skipped: number; failed: number }
  }
  results: ImportReportEntry[]
}

/** Host-side batch job state; survives closing the settings panel. */
interface ImportJobView {
  startedAt: string
  finishedAt?: string
  total: number
  done: number
  running: boolean
  results: ImportReportEntry[]
}

const BADGE: Record<ScannedSession['status'], string> = {
  new: '未导入',
  imported: '已导入',
  grown: '有新增内容，可重新导入',
  failed: '失败',
}

interface WorkspaceState {
  kind: 'failed' | 'grown' | 'all' | 'partial'
  text: string
  tone: 'muted' | 'attention' | 'error'
  /** Filled share for the partial progress ring. */
  ratio?: number
}

/** One aggregate state per workspace; the row shows a glyph, the tooltip the full text. */
function workspaceState(sessions: ScannedSession[]): WorkspaceState | undefined {
  const failed = sessions.filter(session => session.status === 'failed').length
  if (failed > 0) return { kind: 'failed', text: `失败 ${failed} 个会话`, tone: 'error' }
  const grown = sessions.filter(session => session.status === 'grown').length
  if (grown > 0) return { kind: 'grown', text: `有新增 ${grown} 个会话，可重新导入`, tone: 'attention' }
  const imported = sessions.filter(session => session.status === 'imported').length
  if (imported === sessions.length) return { kind: 'all', text: '已全部导入', tone: 'muted' }
  if (imported > 0) {
    return { kind: 'partial', text: `部分已导入 ${imported}/${sessions.length}`, tone: 'muted', ratio: imported / sessions.length }
  }
  return undefined
}

/** Official chevron: points right when collapsed, down when expanded. */
function Chevron({ open }: { open: boolean }): React.ReactElement {
  // Verbatim copy of the official settings chevron: 12px box, 16 viewBox,
  // stroke-width 1, rounded corners baked into the path.
  return (
    <svg
      width="12"
      height="12"
      className={`dsi-chevron${open ? ' dsi-chevron-open' : ''}`}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      strokeWidth="1"
    >
      <path
        d="M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6"
        stroke="currentColor"
      />
    </svg>
  )
}

function Check(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function Folder(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="dsi-folder" aria-hidden>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  )
}

/** Native settings search field glyphs: 14px magnifier, 12px clear. */
function SearchIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

function CloseIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
}

/** App tile: the provider's official icon, with a monogram fallback. */
function ProviderIcon({ icon, name }: { icon?: string; name: string }): React.ReactElement {
  if (icon !== undefined && icon !== '') {
    return (
      <span className="dsi-app-icon" aria-hidden>
        <img className="dsi-app-img" src={icon} alt="" />
      </span>
    )
  }
  return (
    <span className="dsi-app-icon dsi-app-generic" aria-hidden>
      {name.trim().charAt(0).toUpperCase()}
    </span>
  )
}

/** Shared 14px glyphs: check-circle done, filled dot = new content, alert failed. */
function StateGlyph({ kind }: { kind: 'imported' | 'grown' | 'failed' }): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {kind === 'imported' && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m8.5 12 2.5 2.5 4.5-4.5" />
        </>
      )}
      {kind === 'grown' && <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />}
      {kind === 'failed' && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4.5" />
          <path d="M12 16h.01" />
        </>
      )}
    </svg>
  )
}

/** Real progress ring: the filled arc is the imported share of a workspace. */
function ProgressGlyph({ ratio }: { ratio: number }): React.ReactElement {
  const circumference = 2 * Math.PI * 9
  const filled = circumference * Math.min(1, Math.max(0.03, ratio))
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="9" strokeOpacity=".25" />
      <circle
        cx="12"
        cy="12"
        r="9"
        strokeDasharray={`${filled} ${circumference - filled}`}
        transform="rotate(-90 12 12)"
      />
    </svg>
  )
}

/** Status as an icon (label in the tooltip) so the row stays quiet. */
function StatusIcon({ status }: { status: ScannedSession['status'] }): React.ReactElement | null {
  if (status === 'new') return null
  const label = BADGE[status]
  return (
    <span className={`dsi-status dsi-status-${status}`} title={label} aria-label={label} role="img">
      <StateGlyph kind={status} />
    </span>
  )
}

function WorkspaceStateIcon({ state }: { state: WorkspaceState }): React.ReactElement {
  return (
    <span className={`dsi-ws-state dsi-ws-state-${state.tone}`} title={state.text} aria-label={state.text} role="img">
      {state.kind === 'partial'
        ? <ProgressGlyph ratio={state.ratio ?? 0.5} />
        : <StateGlyph kind={state.kind === 'all' ? 'imported' : state.kind} />}
    </span>
  )
}

function RetractIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  )
}

function Spinner(): React.ReactElement {
  return (
    <svg className="dsi-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  )
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return (await response.json()) as T
}

function fileStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function Section(): React.ReactElement {
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [sessions, setSessions] = useState<Record<string, ScannedSession[]>>({})
  const [expanded, setExpanded] = useState<string | undefined>()
  const [openWorkspaces, setOpenWorkspaces] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Record<string, Set<string>>>({})
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [retractTarget, setRetractTarget] = useState<RetractTarget>()
  const [retracting, setRetracting] = useState(false)
  const [retractError, setRetractError] = useState('')
  const [status, setStatus] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [pluginVersion, setPluginVersion] = useState('')
  const [report, setReport] = useState<ImportReport>()
  const [query, setQuery] = useState('')
  const [searchClosed, setSearchClosed] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    try {
      const health = await getJson<{ version?: string; providers: ProviderSummary[] }>('/health')
      // Scan every provider in parallel and publish in one commit, so the skeleton
      // covers the whole initial load instead of a second per-provider spinner phase.
      const listings = await Promise.all(
        health.providers.map(async provider => {
          const listing = await getJson<{ sessions: ScannedSession[] }>(`/sessions?provider=${provider.id}`)
          return [provider.id, listing.sessions] as const
        }),
      )
      if (typeof health.version === 'string') setPluginVersion(health.version)
      setSessions(Object.fromEntries(listings))
      setProviders(health.providers)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = useCallback((providerId: string, sessionId: string) => {
    setStatus('')
    setSelected(current => {
      const next = { ...current }
      const set = new Set(next[providerId] ?? [])
      if (set.has(sessionId)) set.delete(sessionId)
      else set.add(sessionId)
      next[providerId] = set
      return next
    })
  }, [])

  const toggleWorkspace = useCallback((key: string) => {
    setOpenWorkspaces(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  /** Toggle one workspace's sessions without touching the rest of the provider. */
  const selectMany = useCallback((providerId: string, ids: string[]) => {
    setStatus('')
    setSelected(current => {
      const next = { ...current }
      const set = new Set(next[providerId] ?? [])
      const allChosen = ids.length > 0 && ids.every(id => set.has(id))
      for (const id of ids) {
        if (allChosen) set.delete(id)
        else set.add(id)
      }
      next[providerId] = set
      return next
    })
  }, [])

  const clearSelection = useCallback(() => {
    setStatus('')
    setSelected({})
  }, [])

  const totalSelected = useMemo(
    () => Object.values(selected).reduce((sum, set) => sum + set.size, 0),
    [selected],
  )

  const selectedWorkspaceCount = useMemo(() => {
    const paths = new Set<string>()
    for (const provider of providers) {
      const chosen = selected[provider.id]
      const list = sessions[provider.id]
      if (chosen === undefined || chosen.size === 0 || list === undefined) continue
      for (const item of list) {
        if (chosen.has(item.sourceSessionId) && !isScratchWorkspace(item.cwd) && item.cwd !== undefined) {
          paths.add(canonicalWorkspaceKey(item.cwd))
        }
      }
    }
    return paths.size
  }, [providers, selected, sessions])

  const branchRebuildCount = useMemo(() => {
    let count = 0
    for (const provider of providers) {
      const chosen = selected[provider.id]
      if (chosen === undefined || chosen.size === 0) continue
      for (const item of sessions[provider.id] ?? []) {
        if (chosen.has(item.sourceSessionId) && item.branchChanged === true) count += 1
      }
    }
    return count
  }, [providers, selected, sessions])

  const retract = useCallback(async () => {
    if (retractTarget === undefined) return
    const { providerId, label, items, kind } = retractTarget
    const currentItem = items.find(item => item.dshSessionId !== undefined && isCurrentSession?.(item.dshSessionId) === true)
    // Removing the session on screen drops the app back to the empty new-chat
    // state, and the Host closes its settings dialog on that transition. Move to
    // a session the batch keeps before its row disappears.
    const retractingIds = new Set(
      items
        .map(item => item.dshSessionId)
        .filter((id): id is string => id !== undefined),
    )
    const movedAway = currentItem?.dshSessionId === undefined
      ? false
      : moveToSurvivingSession?.(currentItem.dshSessionId, retractingIds) === true
    setRetracting(true)
    setRetractError('')
    let done = 0
    const failures: Array<{ item: ScannedSession; message: string }> = []
    try {
      for (const [index, item] of items.entries()) {
        setStatus(kind !== 'session' ? `正在撤回「${label}」 ${index + 1}/${items.length}…` : '正在撤回…')
        try {
          const response = await fetch(`${API}/retract`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ providerId, sourceSessionId: item.sourceSessionId }),
          })
          let payload: { ok?: boolean; error?: string } = {}
          try {
            payload = (await response.json()) as { ok?: boolean; error?: string }
          } catch {
            // non-JSON failure; report the status below
          }
          if (!response.ok || payload.ok !== true) {
            throw new Error(payload.error ?? `HTTP ${response.status}`)
          }
          done += 1
          if (item.dshSessionId !== undefined) forgetSession?.(item.dshSessionId)
        } catch (cause) {
          failures.push({ item, message: cause instanceof Error ? cause.message : String(cause) })
        }
      }
      const summary = failures.length === 0
        ? kind !== 'session'
          ? `已撤回「${label}」的 ${done} 个会话`
          : `已撤回「${label}」`
        : `已撤回 ${done} 个 · 失败 ${failures.length} 个`
      setStatus(summary)
      refreshSidebar?.()
      void load()
      const tone = failures.length === 0 ? 'success' : 'error'
      if (currentItem !== undefined && !movedAway) {
        const removedId = currentItem.dshSessionId ?? ''
        const deferred = leaveAfterSettingsClose(removedId)
        if (!deferred) leaveCurrentSession?.(removedId)
        if (deferred) showToast(summary, tone)
        // Navigation may rebuild the workspace surface; append after it settles.
        else setTimeout(() => showToast(summary, tone), 0)
      } else {
        showToast(summary, tone)
      }
      if (failures.length === 0) {
        setRetractTarget(undefined)
      } else {
        setRetractError(`${failures.length} 个会话撤回失败：${failures[0]?.message ?? '未知错误'}`)
        setRetractTarget({ ...retractTarget, items: failures.map(failure => failure.item) })
      }
    } finally {
      setRetracting(false)
    }
  }, [load, retractTarget])

  const finishFromJob = useCallback((job: ImportJobView): void => {
    const results = job.results
    const imported = results.filter(item => item.status === 'imported').length
    const skipped = results.filter(item => item.status === 'skipped').length
    const failed = results.filter(item => item.status === 'failed').length
    const finishedAt = job.finishedAt ?? new Date().toISOString()
    // Remember what the last run touched; the footer is the only trace after closing.
    // Scratch folders are per-task ids, not workspaces — describe them by title.
    const workspaces = [
      ...new Set(
        results
          .filter(item => !isScratchWorkspace(item.cwd))
          .map(item => (item.cwd === undefined ? '' : workspaceLabel(item.cwd)))
          .filter(name => name !== ''),
      ),
    ]
    const context =
      results.length === 1
        ? [workspaces[0] ?? '', results[0].title ?? ''].filter(part => part !== '').join(' · ')
        : workspaces.length === 0
          ? results[0]?.title === undefined ? '' : `${results[0].title} 等 ${results.length} 个会话`
          : workspaces.length <= 2
            ? workspaces.join('、')
            : `${workspaces.slice(0, 2).join('、')} 等 ${workspaces.length} 个工作区`
    setStatus(`完成：导入 ${imported} · 跳过 ${skipped} · 失败 ${failed}${context === '' ? '' : ` · ${context}`}`)
    setReport({
      kind: 'dsh-session-import.report',
      schemaVersion: 1,
      generatedAt: finishedAt,
      plugin: { name: 'dsh-session-import', version: pluginVersion || 'unknown' },
      run: {
        startedAt: job.startedAt,
        finishedAt,
        durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(job.startedAt)),
        counts: { total: results.length, imported, skipped, failed },
      },
      results,
    })
    // The host wrote sessions outside the client's session controller; without
    // this the sidebar keeps the old list until a full page reload.
    refreshSidebar?.()
    void load()
  }, [load, pluginVersion])

  /** Follow the host-side batch job; closing the panel only stops this poll. */
  const followImportJob = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      while (true) {
        const status = await getJson<{ job?: ImportJobView | null }>('/import-status')
        const job = status.job ?? undefined
        if (job === undefined) break
        if (job.running) {
          setStatus(`正在导入 ${job.done}/${job.total}`)
          await new Promise(resolve => setTimeout(resolve, 700))
          continue
        }
        finishFromJob(job)
        break
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [finishFromJob])

  const runImport = useCallback(async () => {
    setBusy(true)
    setError('')
    setReport(undefined)
    try {
      const targets: Array<{ provider: ProviderSummary; session: ScannedSession }> = []
      for (const provider of providers) {
        const ids = selected[provider.id]
        if (ids === undefined || ids.size === 0) continue
        const list = sessions[provider.id] ?? []
        for (const sessionId of ids) {
          const target = list.find(item => item.sourceSessionId === sessionId)
          if (target !== undefined) targets.push({ provider, session: target })
        }
      }
      // A rebuild deletes and rewrites the log of an already-imported session;
      // leave its view first so the open conversation is not left on a removed log.
      const rebuilding = targets.find(({ session }) =>
        session.branchChanged === true
        && session.dshSessionId !== undefined
        && isCurrentSession?.(session.dshSessionId) === true,
      )
      if (rebuilding?.session.dshSessionId !== undefined) {
        const rebuiltIds = new Set(
          targets
            .map(({ session }) => session.dshSessionId)
            .filter((id): id is string => id !== undefined),
        )
        moveToSurvivingSession?.(rebuilding.session.dshSessionId, rebuiltIds)
      }
      const response = await fetch(`${API}/import-batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          keepReasoning: false,
          targets: targets.map(({ provider, session }) => ({
            providerId: provider.id,
            providerName: provider.name,
            sourcePath: session.sourcePath,
            sourceSessionId: session.sourceSessionId,
            ...(session.title === undefined ? {} : { title: session.title }),
            ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
            bytes: session.bytes,
            mtimeMs: session.mtimeMs,
            previousStatus: session.status,
          })),
        }),
      })
      if (!response.ok) {
        let message = `HTTP ${response.status}`
        try {
          const payload = (await response.json()) as { error?: unknown }
          if (typeof payload.error === 'string' && payload.error !== '') message = payload.error
        } catch {
          // keep the status text
        }
        setError(message)
        if (response.status === 409) await followImportJob()
        return
      }
      await followImportJob()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [followImportJob, providers, selected, sessions])

  // Reopening the panel mid-job resumes the progress display; the last finished
  // run is restored too, so the footer still says what was imported last time.
  const adoptedJob = useRef(false)
  useEffect(() => {
    if (adoptedJob.current) return
    adoptedJob.current = true
    void (async () => {
      try {
        const status = await getJson<{ job?: ImportJobView | null }>('/import-status')
        const job = status.job ?? undefined
        if (job === undefined) return
        if (job.running) {
          await followImportJob()
          return
        }
        if (job.results.length > 0) finishFromJob(job)
      } catch {
        // the panel opens read-only when status cannot be read
      }
    })()
  }, [finishFromJob, followImportJob])

  const exportReport = useCallback(() => {
    if (report === undefined) return
    const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `dsh-session-import-report-${fileStamp(new Date())}.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [report])

  const changeQuery = useCallback((value: string) => {
    setQuery(value)
    setSearchClosed(new Set())
  }, [])

  const toggleSearchGroup = useCallback((key: string) => {
    setSearchClosed(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const queryText = query.trim().toLowerCase()
  const matchesText = (value?: string): boolean =>
    queryText === '' || (value !== undefined && value.toLowerCase().includes(queryText))
  const matchesSession = (item: ScannedSession): boolean =>
    queryText === '' || matchesText(item.title) || item.sourceSessionId.toLowerCase().includes(queryText)

  const providerRows = providers.map(provider => {
    const list = sessions[provider.id]
    if (list === undefined) {
      return {
        provider,
        list,
        workspaceGroups: [] as WorkspaceView[],
        recentSessions: [] as ScannedSession[],
        allRecentSessions: [] as ScannedSession[],
        loading: true,
        visibleCount: 0,
        scopeIds: [] as string[],
      }
    }
    const groups = groupByWorkspace(list)
    const allWorkspaceGroups = groups.filter(group => !isScratchWorkspace(group.key))
    const workspaceGroups = allWorkspaceGroups
      .map(group => {
        const visibleSessions = queryText === '' || matchesText(group.label) || matchesText(group.path)
          ? group.sessions
          : group.sessions.filter(matchesSession)
        return { ...group, sessions: visibleSessions, allSessions: group.sessions }
      })
      .filter(group => group.sessions.length > 0)
      .sort((a, b) => b.createdAt - a.createdAt)
    const allRecentSessions = groups
      .filter(group => isScratchWorkspace(group.key))
      .flatMap(group => group.sessions)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    const recentSessions = allRecentSessions
      .filter(matchesSession)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    const visibleCount = workspaceGroups.reduce((sum, group) => sum + group.sessions.length, 0) + recentSessions.length
    const scopeIds = [
      ...workspaceGroups.flatMap(group => group.sessions.map(session => session.sourceSessionId)),
      ...recentSessions.map(session => session.sourceSessionId),
    ]
    return { provider, list, workspaceGroups, recentSessions, allRecentSessions, loading: false, visibleCount, scopeIds }
  })
  const hasVisibleProvider = providerRows.some(row => row.loading || row.visibleCount > 0)
  const footerSummary = status !== ''
    ? status
    : totalSelected === 0
      ? '已选 0 个会话'
      : selectedWorkspaceCount > 0
        ? `已选 ${totalSelected} 个会话 · ${selectedWorkspaceCount} 个工作区`
        : `已选 ${totalSelected} 个会话`

  return (
    <div className="dsi-section">
      <div className="dsi-head">
        <h1 className="dsi-title">会话导入</h1>
        <p className="dsi-subtitle">把其他编辑器里的会话带进 DSH，导入后可直接继续对话。</p>
      </div>

      <div className="dsi-search">
        <span className="dsi-search-icon"><SearchIcon /></span>
        <input
          className="dsi-search-input"
          type="search"
          value={query}
          placeholder="搜索工作区或会话"
          aria-label="搜索工作区或会话"
          onChange={event => changeQuery(event.target.value)}
        />
        {query !== '' && (
          <button className="dsi-search-clear" type="button" aria-label="清空搜索" onClick={() => changeQuery('')}>
            <CloseIcon />
          </button>
        )}
      </div>

      {loading && (
        <div className="dsi-skeleton" role="status" aria-label="正在扫描本机会话">
          {[148, 118, 172].map((width, index) => (
            <div className="dsi-sk-row" key={index}>
              <span className="dsi-sk-box" />
              <span className="dsi-sk-icon" />
              <span className="dsi-sk-bar" style={{ width }} />
              <span className="dsi-sk-meta" />
            </div>
          ))}
        </div>
      )}

      {!loading && providerRows.map(row => {
        const { provider, list, workspaceGroups, recentSessions, allRecentSessions, scopeIds } = row
        if (queryText !== '' && !row.loading && row.visibleCount === 0) return null
        const chosen = selected[provider.id] ?? new Set<string>()
        const open = queryText !== '' ? !searchClosed.has(provider.id) : expanded === provider.id
        const chosenInScope = scopeIds.filter(id => chosen.has(id)).length
        const allScopeChosen = scopeIds.length > 0 && chosenInScope === scopeIds.length
        const scopeLabel = queryText !== '' ? '全选匹配的会话' : `全选 ${provider.name} 会话`
        const sessionRow = (item: ScannedSession): React.ReactElement => (
          <label
            className={`dsi-check dsi-item${item.status !== 'new' ? ' dsi-item-act' : ''}`}
            title={item.title ?? item.sourceSessionId}
          >
            <input
              className="dsi-box-input"
              type="checkbox"
              checked={chosen.has(item.sourceSessionId)}
              onChange={() => toggle(provider.id, item.sourceSessionId)}
            />
            <span className="dsi-box" aria-hidden>{chosen.has(item.sourceSessionId) && <Check />}</span>
            <span className="dsi-item-title">{item.title ?? item.sourceSessionId.slice(0, 8)}</span>
            {item.status !== 'new' && (
              <span className="dsi-item-slot">
                <StatusIcon status={item.status} />
                <button
                  className="dsi-icon-btn"
                  type="button"
                  title="撤回"
                  aria-label="撤回"
                  disabled={busy || retracting}
                  onClick={event => {
                    event.preventDefault()
                    event.stopPropagation()
                    setRetractError('')
                    setRetractTarget({
                      kind: 'session',
                      providerId: provider.id,
                      label: item.title ?? item.sourceSessionId.slice(0, 8),
                      items: [item],
                    })
                  }}
                >
                  {retracting && retractTarget?.items.some(target => target.sourceSessionId === item.sourceSessionId)
                    ? <Spinner />
                    : <RetractIcon />}
                </button>
              </span>
            )}
          </label>
        )
        const providerRetractables = (list ?? []).filter(
          session => session.status === 'imported' || session.status === 'grown',
        )
        const metaText = list === undefined
          ? '扫描中…'
          : queryText !== ''
            ? `${row.visibleCount} 个匹配会话`
            : `${list.length} 个会话 · ${workspaceGroups.length} 个工作区`
        const recentKey = `${provider.id}::__recent__`
        const recentOpen = queryText !== '' ? !searchClosed.has(recentKey) : openWorkspaces.has(recentKey)
        const chosenInRecent = recentSessions.filter(session => chosen.has(session.sourceSessionId)).length
        const allRecentChosen = recentSessions.length > 0 && chosenInRecent === recentSessions.length
        const recentState = workspaceState(recentSessions)
        const recentRetractables = allRecentSessions.filter(
          session => session.status === 'imported' || session.status === 'grown',
        )
        return (
          <div className="dsi-group" key={provider.id}>
            <div
              className="dsi-group-head"
              onClick={event => {
                const target = event.target as Element | null
                if (target !== null && target.closest('button,label') !== null) return
                if (queryText !== '') toggleSearchGroup(provider.id)
                else setExpanded(open ? undefined : provider.id)
              }}
            >
              {list !== undefined && scopeIds.length > 0 ? (
                <label className="dsi-check dsi-group-check" title={scopeLabel}>
                  <input
                    className="dsi-box-input"
                    type="checkbox"
                    aria-label={scopeLabel}
                    checked={allScopeChosen}
                    onChange={() => selectMany(provider.id, scopeIds)}
                  />
                  <span className="dsi-box" aria-hidden>
                    {allScopeChosen ? <Check /> : chosenInScope > 0 ? <span className="dsi-box-dash" /> : null}
                  </span>
                </label>
              ) : (
                <span className="dsi-check-slot" aria-hidden />
              )}
              <div className="dsi-group-main">
                <button
                  className="dsi-toggle"
                  type="button"
                  aria-expanded={open}
                  title={metaText}
                  onClick={() => {
                    if (queryText !== '') toggleSearchGroup(provider.id)
                    else setExpanded(open ? undefined : provider.id)
                  }}
                >
                  <ProviderIcon icon={provider.icon} name={provider.name} />
                  <span className="dsi-group-title">{provider.name}</span>
                </button>
              </div>
              <span className="dsi-provider-end">
                <span className="dsi-provider-slot">
                  {providerRetractables.length > 0 && (
                    <button
                      className="dsi-icon-btn dsi-provider-retract"
                      type="button"
                      title={`撤回 ${provider.name} 的全部 ${providerRetractables.length} 个已导入会话`}
                      aria-label={`撤回 ${provider.name} 的全部已导入会话`}
                      disabled={busy || retracting}
                      onClick={event => {
                        event.preventDefault()
                        event.stopPropagation()
                        setRetractError('')
                        setRetractTarget({
                          kind: 'provider',
                          providerId: provider.id,
                          label: provider.name,
                          items: providerRetractables,
                        })
                      }}
                    >
                      <RetractIcon />
                    </button>
                  )}
                </span>
                <span className="dsi-toggle-end" aria-hidden>
                  <Chevron open={open} />
                </span>
              </span>
            </div>

            {open && list !== undefined && (
              <div className="dsi-workspaces">
                {workspaceGroups.map(group => {
                  const wsKey = `${provider.id}::${group.key}`
                  const wsOpen = queryText !== '' ? !searchClosed.has(wsKey) : openWorkspaces.has(wsKey)
                  const chosenInGroup = group.sessions.filter(session => chosen.has(session.sourceSessionId)).length
                  const allGroupChosen = chosenInGroup === group.sessions.length
                  const state = workspaceState(group.sessions)
                  const retractables = group.allSessions.filter(
                    session => session.status === 'imported' || session.status === 'grown',
                  )
                  return (
                    <div className="dsi-ws" key={wsKey}>
                      <div
                        className={`dsi-ws-head${retractables.length > 0 ? ' dsi-ws-act' : ''}`}
                        onClick={event => {
                          const target = event.target as Element | null
                          if (target !== null && target.closest('button,label') !== null) return
                          if (queryText !== '') toggleSearchGroup(wsKey)
                          else toggleWorkspace(wsKey)
                        }}
                      >
                        <label className="dsi-check dsi-ws-check" title="全选该工作区">
                          <input
                            className="dsi-box-input"
                            type="checkbox"
                            aria-label="全选该工作区"
                            checked={allGroupChosen}
                            onChange={() => selectMany(provider.id, group.sessions.map(session => session.sourceSessionId))}
                          />
                          <span className="dsi-box" aria-hidden>
                            {allGroupChosen
                              ? <Check />
                              : chosenInGroup > 0
                                ? <span className="dsi-box-dash" />
                                : null}
                          </span>
                        </label>
                        <Folder />
                        <button
                          className="dsi-ws-toggle"
                          type="button"
                          aria-expanded={wsOpen}
                          title={`${group.path} · ${group.sessions.length} 个会话`}
                          onClick={() => {
                            if (queryText !== '') toggleSearchGroup(wsKey)
                            else toggleWorkspace(wsKey)
                          }}
                        >
                          <span className="dsi-ws-name">{group.label}</span>
                        </button>
                        <span className="dsi-ws-slot">
                          {state !== undefined && <WorkspaceStateIcon state={state} />}
                          {retractables.length > 0 && (
                            <button
                              className="dsi-icon-btn dsi-ws-retract"
                              type="button"
                              title={`撤回该工作区的 ${retractables.length} 个已导入会话`}
                              aria-label={`撤回工作区 ${group.label}`}
                              disabled={busy || retracting}
                              onClick={event => {
                                event.preventDefault()
                                event.stopPropagation()
                                setRetractError('')
                                setRetractTarget({
                                  kind: 'workspace',
                                  providerId: provider.id,
                                  label: group.label,
                                  items: retractables,
                                })
                              }}
                            >
                              <RetractIcon />
                            </button>
                          )}
                        </span>
                        <span className="dsi-toggle-end" aria-hidden>
                          <Chevron open={wsOpen} />
                        </span>
                      </div>
                      {wsOpen && (
                        <ul className="dsi-list">
                          {group.sessions.map(item => (
                            <li key={item.sourceSessionId}>{sessionRow(item)}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )
                })}
                {recentSessions.length > 0 && (
                  <div className="dsi-ws" key={recentKey}>
                    <div
                      className={`dsi-ws-head${recentRetractables.length > 0 ? ' dsi-ws-act' : ''}`}
                      onClick={event => {
                        const target = event.target as Element | null
                        if (target !== null && target.closest('button,label') !== null) return
                        if (queryText !== '') toggleSearchGroup(recentKey)
                        else toggleWorkspace(recentKey)
                      }}
                    >
                      <label className="dsi-check dsi-ws-check" title="全选最近任务">
                        <input
                          className="dsi-box-input"
                          type="checkbox"
                          aria-label="全选最近任务"
                          checked={allRecentChosen}
                          onChange={() => selectMany(provider.id, recentSessions.map(session => session.sourceSessionId))}
                        />
                        <span className="dsi-box" aria-hidden>
                          {allRecentChosen
                            ? <Check />
                            : chosenInRecent > 0
                              ? <span className="dsi-box-dash" />
                              : null}
                        </span>
                      </label>
                      <Folder />
                      <button
                        className="dsi-ws-toggle"
                        type="button"
                        aria-expanded={recentOpen}
                        title={`最近任务 · ${recentSessions.length} 个会话`}
                        onClick={() => {
                          if (queryText !== '') toggleSearchGroup(recentKey)
                          else toggleWorkspace(recentKey)
                        }}
                      >
                        <span className="dsi-ws-name">最近任务</span>
                      </button>
                      <span className="dsi-ws-slot">
                        {recentState !== undefined && <WorkspaceStateIcon state={recentState} />}
                        {recentRetractables.length > 0 && (
                          <button
                            className="dsi-icon-btn dsi-ws-retract"
                            type="button"
                            title={`撤回最近任务中的 ${recentRetractables.length} 个已导入会话`}
                            aria-label="撤回最近任务中的已导入会话"
                            disabled={busy || retracting}
                            onClick={event => {
                              event.preventDefault()
                              event.stopPropagation()
                              setRetractError('')
                              setRetractTarget({
                                kind: 'workspace',
                                providerId: provider.id,
                                label: '最近任务',
                                items: recentRetractables,
                              })
                            }}
                          >
                            <RetractIcon />
                          </button>
                        )}
                      </span>
                      <span className="dsi-toggle-end" aria-hidden>
                        <Chevron open={recentOpen} />
                      </span>
                    </div>
                    {recentOpen && (
                      <ul className="dsi-list">
                        {recentSessions.map(item => (
                          <li key={item.sourceSessionId}>{sessionRow(item)}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )}

          </div>
        )
      })}

      {queryText !== '' && !hasVisibleProvider && (
        <p className="dsi-empty">没有匹配的会话</p>
      )}

      {error !== '' && <p className="dsi-error">{error}</p>}

      <div className="dsi-footer">
        <span className="dsi-footer-summary" title={footerSummary}>{footerSummary}</span>
        <div className="dsi-footer-actions">
          {totalSelected > 0 && (
            <button className="dsi-text" type="button" disabled={busy} onClick={clearSelection}>
              清除选择
            </button>
          )}
          {report !== undefined && (
            <button className="dsi-ghost dsi-export" type="button" disabled={busy} onClick={exportReport} title="下载本次导入结果（JSON）">
              导出日志
            </button>
          )}
          <button className="dsi-primary" type="button" disabled={busy || retracting || totalSelected === 0} onClick={() => setConfirming(true)}>
            {busy ? '导入中…' : '导入'}
          </button>
        </div>
      </div>

      {confirming && (
        <div
          className="dsi-mask"
          role="presentation"
          onClick={() => {
            if (!busy) setConfirming(false)
          }}
        >
          <div className="dsi-dialog" role="dialog" aria-modal="true" aria-label="确认导入" onClick={event => event.stopPropagation()}>
            <h2>确认导入</h2>
            <p>
              将导入 {totalSelected} 个会话的完整历史。导入后会出现在左侧会话列表，可直接继续对话。
            </p>
            {branchRebuildCount > 0 && (
              <p>
                其中 {branchRebuildCount} 个会话在源工具里被 rewind 分叉：会按最新分支重建 DSH 会话，被 rewind 掉的旧回合将被替换（源工具文件不受影响）。
              </p>
            )}
            <div className="dsi-dialog-actions">
              <button className="dsi-ghost" type="button" disabled={busy} onClick={() => setConfirming(false)}>取消</button>
              <button
                className="dsi-primary"
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirming(false)
                  void runImport()
                }}
              >
                {busy ? '导入中…' : `导入 ${totalSelected} 个会话`}
              </button>
            </div>
          </div>
        </div>
      )}

      {retractTarget !== undefined && (
        <div
          className="dsi-mask"
          role="presentation"
          onClick={() => {
            if (!retracting) setRetractTarget(undefined)
          }}
        >
          <div className="dsi-dialog" role="dialog" aria-modal="true" aria-label="确认撤回" onClick={event => event.stopPropagation()}>
            <h2>
              {retractTarget.kind === 'workspace'
                ? '撤回工作区'
                : retractTarget.kind === 'provider'
                  ? '撤回应用下的导入会话'
                  : '撤回导入'}
            </h2>
            {retractTarget.kind === 'provider' ? (
              <>
                <p>
                  将撤回「{retractTarget.label}」下全部 {retractTarget.items.length} 个已导入会话及其对话记录。源工具里的会话不受影响，之后仍可重新导入。
                </p>
                <p>若某个工作区撤回后没有其他会话，会一并移除工作区注册；磁盘目录和会话日志不会删除。</p>
              </>
            ) : retractTarget.kind === 'workspace' ? (
              <>
                <p>
                  将撤回工作区「{retractTarget.label}」中的 {retractTarget.items.length} 个已导入会话及其对话记录。源工具里的会话不受影响，之后仍可重新导入。
                </p>
                <p>若撤回后该工作区没有其他会话，会一并移除工作区注册；磁盘目录和会话日志不会删除。</p>
              </>
            ) : (
              <p>
                将删除 DSH 中的「{retractTarget.label}」及其对话记录。源工具里的会话不受影响，之后仍可重新导入。
              </p>
            )}
            {retractTarget.items.some(item => item.dshSessionId !== undefined && isCurrentSession?.(item.dshSessionId) === true) && (
              <p>
                {retractTarget.kind === 'session'
                  ? '该会话当前已打开，撤回后会关闭当前视图。'
                  : '其中 1 个会话当前已打开，撤回后会关闭当前视图。'}
              </p>
            )}
            {retractError !== '' && <p className="dsi-error">{retractError}</p>}
            <div className="dsi-dialog-actions">
              <button
                className="dsi-ghost"
                type="button"
                disabled={retracting}
                onClick={() => {
                  setRetractTarget(undefined)
                  setRetractError('')
                }}
              >
                取消
              </button>
              <button className="dsi-primary" type="button" disabled={retracting} onClick={() => void retract()}>
                {retracting
                  ? <><Spinner /> 正在撤回…</>
                  : retractTarget.kind !== 'session'
                    ? `撤回 ${retractTarget.items.length} 个会话`
                    : '撤回'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function installStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.dsi-section{display:flex;flex-direction:column;gap:14px;width:100%;max-width:760px;font-family:var(--dsw-font-family);color:var(--dsw-alias-label-primary)}
.dsi-head{display:flex;flex-direction:column;gap:4px}
.dsi-title{margin:0;font-size:20px;line-height:28px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsi-subtitle{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}

.dsi-group{display:flex;flex-direction:column;gap:10px}
.dsi-group + .dsi-group{border-top:0.5px solid var(--dsw-alias-border-l2);padding-top:14px}
.dsi-group-head{display:flex;align-items:center;gap:12px;min-height:40px;cursor:pointer}
.dsi-group-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsi-toggle{display:flex;flex:0 1 auto;min-width:0;align-items:center;gap:8px;border:0;padding:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsi-toggle:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.dsi-group-title{min-width:0;font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsi-toggle-end{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;margin:-2px 0;color:var(--dsw-alias-label-tertiary);pointer-events:none}
.dsi-provider-end{flex:none;display:inline-flex;align-items:center;gap:8px}
.dsi-provider-slot{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:24px}
.dsi-group-check{flex:none}
.dsi-check-slot{flex:none;width:16px;height:16px}

.dsi-search{position:relative;display:flex;align-items:center;width:100%;color:var(--dsw-alias-label-tertiary)}
.dsi-search-icon{position:absolute;left:12px;display:inline-flex;pointer-events:none}
.dsi-search-input{box-sizing:border-box;width:100%;height:36px;padding:0 34px 0 36px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.dsi-search-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dsi-search-input::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none}
.dsi-search-input:focus-visible{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)) 18%, transparent)}
.dsi-search-clear{position:absolute;right:6px;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsi-search-clear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsi-search-clear:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}

.dsi-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transform:rotate(-90deg)}
.dsi-chevron-open{transform:none}
@media (prefers-reduced-motion: no-preference){.dsi-chevron{transition:transform 140ms var(--ds-ease-in-out,ease-in-out)}}

.dsi-workspaces{display:flex;flex-direction:column;gap:2px;padding:0 0 0 20px;min-width:0}
.dsi-ws{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsi-ws-head{display:flex;align-items:center;gap:8px;min-width:0;cursor:pointer}
.dsi-ws-toggle{flex:0 1 auto;min-width:0;display:flex;align-items:center;gap:8px;border:0;padding:4px 0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsi-ws-toggle:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.dsi-ws-check{flex:none}
.dsi-ws-name{min-width:0;flex:0 1 auto;max-width:320px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsi-ws-state{display:inline-flex;align-items:center;justify-content:center}
.dsi-ws-state-muted{color:var(--dsw-alias-label-tertiary)}
.dsi-ws-state-attention{color:var(--dsw-alias-label-secondary)}
.dsi-ws-state-error{color:var(--dsw-alias-state-error-primary)}
.dsi-folder{flex:none;color:var(--dsw-alias-label-tertiary)}
.dsi-list{list-style:none;margin:0;padding:0 0 0 22px;display:flex;flex-direction:column;gap:2px;min-width:0}
.dsi-item{display:flex;align-items:center;gap:10px;padding:4px 0;font-size:13px;line-height:20px;cursor:pointer}
.dsi-item-title{flex:1;min-width:0;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.dsi-check{position:relative;display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsi-check.dsi-item{display:flex;width:100%;min-width:0}
.dsi-box-input{position:absolute;left:0;top:50%;transform:translateY(-50%);width:16px;height:16px;margin:0;opacity:0;cursor:pointer}
.dsi-box{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary-foreground);transition:background-color 120ms var(--ds-ease-in-out,ease-in-out),border-color 120ms var(--ds-ease-in-out,ease-in-out)}
.dsi-box-input:checked + .dsi-box{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill)}
.dsi-box-input:focus-visible + .dsi-box{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.dsi-box-dash{width:8px;height:2px;border-radius:1px;background:currentColor}

.dsi-app-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:5px;overflow:hidden}
.dsi-app-img{width:18px;height:18px;object-fit:contain;display:block}
.dsi-app-generic{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:1}
.dsi-status{flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary)}
.dsi-status-imported{color:var(--dsw-alias-label-primary)}
.dsi-status-grown{color:var(--dsw-alias-label-secondary)}
.dsi-status-failed{color:var(--dsw-alias-state-error-primary)}
.dsi-icon-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;margin:-2px 0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsi-icon-btn:hover{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}
.dsi-icon-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.dsi-icon-btn:disabled{opacity:.5;cursor:default}
.dsi-icon-btn:disabled:hover{background:transparent;color:var(--dsw-alias-label-tertiary)}
/* retract swaps into the status slot on hover or its own keyboard focus: row clicks must not pin the swap */
.dsi-ws-slot{position:relative;flex:none;margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:18px;height:24px}
.dsi-item-slot{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:24px;margin:-2px 0}
/* status and retract share one slot: hover or keyboard focus swaps them */
.dsi-ws-act .dsi-ws-retract,.dsi-item-act .dsi-icon-btn{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:24px;height:24px;margin:0;opacity:0;pointer-events:none}
.dsi-ws-act:hover .dsi-ws-retract,.dsi-ws-slot:focus-within .dsi-ws-retract{opacity:1;pointer-events:auto}
.dsi-ws-act:hover .dsi-ws-state,.dsi-ws-slot:focus-within .dsi-ws-state{opacity:0;pointer-events:none}
.dsi-item-act:hover .dsi-icon-btn,.dsi-item-slot:focus-within .dsi-icon-btn{opacity:1;pointer-events:auto}
.dsi-item-act:hover .dsi-status,.dsi-item-slot:focus-within .dsi-status{opacity:0;pointer-events:none}
@media (prefers-reduced-motion: no-preference){.dsi-ws-retract,.dsi-item .dsi-icon-btn,.dsi-ws-state,.dsi-status{transition:opacity 120ms var(--ds-ease-in-out,ease-in-out)}}
@media (hover:none){.dsi-ws-slot,.dsi-item-slot{width:auto;gap:4px}.dsi-ws-act .dsi-ws-retract,.dsi-item-act .dsi-icon-btn{position:static;opacity:1;pointer-events:auto}}
.dsi-spin{animation:dsi-spin .8s linear infinite}
@keyframes dsi-spin{to{transform:rotate(360deg)}}

.dsi-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-top:0.5px solid var(--dsw-alias-border-l2)}
.dsi-row-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding-right:48px}
.dsi-row-title{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsi-row-desc{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary)}


/* sticky pins above the host scroller's 24px bottom padding; offset must stay <= footer height so the cover is continuous, spread fills the side padding */
.dsi-footer{position:sticky;bottom:0;z-index:2;display:flex;align-items:center;gap:12px;padding:12px 0 8px;border-top:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:0 48px 0 24px var(--dsw-alias-bg-layer-1)}
.dsi-footer-summary{flex:1;min-width:0;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;white-space:normal;word-break:break-word;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsi-footer-actions{flex:none;display:flex;align-items:center;gap:8px}
.dsi-empty{margin:0;padding:24px 0;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dsi-skeleton{display:flex;flex-direction:column;padding:10px 0 12px}
.dsi-sk-row{display:flex;align-items:center;gap:12px;min-height:40px}
.dsi-sk-row + .dsi-sk-row{margin-top:14px;padding-top:14px;border-top:0.5px solid var(--dsw-alias-border-l2)}
.dsi-sk-box{flex:none;width:16px;height:16px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-module-platform)}
.dsi-sk-icon{flex:none;width:20px;height:20px;border-radius:5px;background:var(--dsw-alias-bg-module-platform)}
.dsi-sk-bar{height:12px;border-radius:6px;background:var(--dsw-alias-bg-module-platform)}
.dsi-sk-meta{margin-left:auto;flex:none;width:96px;height:12px;border-radius:6px;background:var(--dsw-alias-bg-module-platform)}
.dsi-sk-box,.dsi-sk-icon,.dsi-sk-bar,.dsi-sk-meta{animation:dsi-pulse 1.2s var(--ds-ease-in-out,ease-in-out) infinite}
@keyframes dsi-pulse{0%,100%{opacity:.45}50%{opacity:.9}}
@media (prefers-reduced-motion: reduce){.dsi-sk-box,.dsi-sk-icon,.dsi-sk-bar,.dsi-sk-meta{animation:none;opacity:.6}}
.dsi-primary{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;padding:0 16px;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:14px;font-weight:400;line-height:22px;cursor:pointer}
.dsi-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dsi-primary:disabled{background:var(--dsw-alias-button-primary-dimmed);color:var(--dsw-alias-label-tertiary);cursor:not-allowed}
.dsi-primary:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.dsi-ghost{height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;cursor:pointer}
.dsi-text{height:32px;padding:0 4px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.dsi-text:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dsi-text:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}
.dsi-text:disabled{opacity:.5;cursor:not-allowed}
.dsi-ghost:disabled{opacity:.5;cursor:not-allowed}
.dsi-export{flex:none;height:32px;padding:0 12px;font-size:13px}
.dsi-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}
.dsi-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:1100;max-width:min(480px,86vw);padding:10px 16px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;box-shadow:var(--dsw-elevation-prominent);border:0.5px solid var(--dsw-alias-border-l2)}
.dsi-toast-error{color:var(--dsw-alias-state-error-primary)}

.dsi-mask{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.dsi-dialog{width:min(420px,90vw);background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-panel);padding:24px;display:flex;flex-direction:column;gap:12px;font-family:var(--dsw-font-family);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent)}
.dsi-dialog h2{margin:0;font-size:16px;line-height:24px;font-weight:600}
.dsi-dialog p{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dsi-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
`
  document.head.appendChild(style)
}

export function apply(ctx: Context): () => void {
  installStyles()
  const get = (ctx as Context & { get?: (name: string) => unknown }).get?.bind(ctx)
  const sessions = get?.('sessions') as SessionsFace | undefined
  refreshSidebar =
    sessions === undefined
      ? undefined
      : () => {
          try {
            void Promise.resolve(sessions.refresh()).catch(cause =>
              console.warn('[dsh-session-import] 刷新会话列表失败', cause),
            )
          } catch (cause) {
            console.warn('[dsh-session-import] 刷新会话列表失败', cause)
          }
        }
  forgetSession = sessionId => {
    try {
      sessions?.handleSessionRemoved?.(sessionId)
    } catch (cause) {
      console.warn('[dsh-session-import] 从会话列表移除失败', cause)
    }
  }
  isCurrentSession =
    sessions?.list === undefined
      ? undefined
      : sessionId => {
          try {
            const row = sessions.list?.getSnapshot().byId[sessionId]
            return (row?.retainedBy?.mainView ?? 0) > 0
          } catch {
            return false
          }
        }
  const fallbackSessionId = (removedId: string, exclude?: ReadonlySet<string>): string | undefined => {
    try {
      const snapshot = sessions?.list?.getSnapshot()
      return snapshot?.ids.find(id => {
        const row = snapshot.byId[id]
        return id !== removedId && exclude?.has(id) !== true && row !== undefined && row.blank !== true
          && row.parentSessionId === undefined && row.origin !== 'subagent'
      })
    } catch {
      return undefined
    }
  }
  leaveCurrentSession = removedId => {
    const ui = get?.('uiWorkspace') as UiWorkspaceFace | undefined
    try {
      const fallback = fallbackSessionId(removedId)
      if (fallback !== undefined && ui?.openSession !== undefined) {
        ui.openSession(fallback)
        return true
      }
      ui?.clearMain?.()
      return false
    } catch (cause) {
      console.warn('[dsh-session-import] 关闭当前会话视图失败', cause)
      return false
    }
  }
  moveToSurvivingSession = (removedId, exclude) => {
    const ui = get?.('uiWorkspace') as UiWorkspaceFace | undefined
    const fallback = fallbackSessionId(removedId, exclude)
    if (fallback === undefined || ui?.openSession === undefined) return false
    try {
      ui.openSession(fallback)
      return true
    } catch (cause) {
      console.warn('[dsh-session-import] 切换会话视图失败', cause)
      return false
    }
  }
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const mount = (round: number): void => {
    if (disposed) return
    const slots = get?.('slots') as SlotsFace | undefined
    if (slots === undefined) {
      if (round < PROBE_ROUNDS) timer = setTimeout(() => mount(round + 1), PROBE_INTERVAL_MS)
      return
    }
    try {
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: SECTION_ID, order: 30, label: () => '会话导入' },
          Section,
        ))
      console.info('[dsh-session-import] settings section registered')
    } catch (cause) {
      console.error('[dsh-session-import] settings section registration failed', cause)
    }
  }

  mount(0)
  return () => {
    disposed = true
    refreshSidebar = undefined
    forgetSession = undefined
    isCurrentSession = undefined
    leaveCurrentSession = undefined
    moveToSurvivingSession = undefined
    pendingLeave?.disconnect()
    pendingLeave = undefined
    if (timer !== undefined) clearTimeout(timer)
    document.getElementById(STYLE_ID)?.remove()
  }
}
