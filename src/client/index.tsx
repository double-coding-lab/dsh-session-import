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
let leaveCurrentSession: ((removedId: string) => void) | undefined

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
}

interface WorkspaceGroup {
  key: string
  label: string
  path?: string
  createdAt: number
  sessions: ScannedSession[]
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

function groupByWorkspace(list: ScannedSession[]): WorkspaceGroup[] {
  const map = new Map<string, WorkspaceGroup>()
  for (const item of list) {
    const key = item.cwd ?? ''
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
  message?: string
}

const BADGE: Record<ScannedSession['status'], string> = {
  new: '未导入',
  imported: '已导入',
  grown: '有新增',
  failed: '失败',
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

/** Status as an icon (label in the tooltip) so the row stays quiet. */
function StatusIcon({ status }: { status: ScannedSession['status'] }): React.ReactElement | null {
  if (status === 'new') return null
  const label = BADGE[status]
  return (
    <span className={`dsi-status dsi-status-${status}`} title={label} aria-label={label} role="img">
      {status === 'imported' && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="m8.5 12 2.5 2.5 4.5-4.5" />
        </svg>
      )}
      {status === 'grown' && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
      )}
      {status === 'failed' && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4.5" />
          <path d="M12 16h.01" />
        </svg>
      )}
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

function Section(): React.ReactElement {
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const [sessions, setSessions] = useState<Record<string, ScannedSession[]>>({})
  const [expanded, setExpanded] = useState<string | undefined>()
  const [openWorkspaces, setOpenWorkspaces] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Record<string, Set<string>>>({})
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [retractTarget, setRetractTarget] = useState<{ providerId: string; item: ScannedSession } | undefined>()
  const [retracting, setRetracting] = useState(false)
  const [retractError, setRetractError] = useState('')
  const [status, setStatus] = useState<string>('')
  const [error, setError] = useState<string>('')

  const load = useCallback(async () => {
    try {
      const health = await getJson<{ providers: ProviderSummary[] }>('/health')
      setProviders(health.providers)
      for (const provider of health.providers) {
        const listing = await getJson<{ sessions: ScannedSession[] }>(`/sessions?provider=${provider.id}`)
        setSessions(current => ({ ...current, [provider.id]: listing.sessions }))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = useCallback((providerId: string, sessionId: string) => {
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

  const selectAll = useCallback((providerId: string) => {
    setSelected(current => {
      const next = { ...current }
      const all = sessions[providerId] ?? []
      const set = next[providerId] ?? new Set<string>()
      next[providerId] = set.size === all.length ? new Set() : new Set(all.map(item => item.sourceSessionId))
      return next
    })
  }, [sessions])

  /** Toggle one workspace's sessions without touching the rest of the provider. */
  const selectMany = useCallback((providerId: string, ids: string[]) => {
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

  const totalSelected = useMemo(
    () => Object.values(selected).reduce((sum, set) => sum + set.size, 0),
    [selected],
  )

  const retract = useCallback(async () => {
    if (retractTarget === undefined) return
    const { providerId, item } = retractTarget
    const label = item.title ?? item.sourceSessionId.slice(0, 8)
    const wasCurrent = item.dshSessionId !== undefined && isCurrentSession?.(item.dshSessionId) === true
    setRetracting(true)
    setRetractError('')
    setStatus('正在撤回…')
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
      setRetractTarget(undefined)
      setStatus(`已撤回「${label}」`)
      if (item.dshSessionId !== undefined) forgetSession?.(item.dshSessionId)
      if (wasCurrent) {
        leaveCurrentSession?.(item.dshSessionId ?? '')
        // Navigation may rebuild the workspace surface; append after it settles.
        setTimeout(() => showToast(`已撤回「${label}」`), 0)
      } else {
        showToast(`已撤回「${label}」`)
      }
      refreshSidebar?.()
      void load()
    } catch (cause) {
      setRetractError(cause instanceof Error ? cause.message : String(cause))
      setStatus('')
    } finally {
      setRetracting(false)
    }
  }, [load, retractTarget])

  const runImport = useCallback(async () => {
    setBusy(true)
    setError('')
    const results: ImportResultView[] = []
    try {
      for (const provider of providers) {
        const ids = selected[provider.id]
        if (ids === undefined || ids.size === 0) continue
        const list = sessions[provider.id] ?? []
        for (const sessionId of ids) {
          const target = list.find(item => item.sourceSessionId === sessionId)
          if (target === undefined) continue
          setStatus(`正在导入 ${provider.name} · ${sessionId.slice(0, 8)}`)
          const response = await fetch(`${API}/import`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ providerId: provider.id, sourcePath: target.sourcePath }),
          })
          const payload = (await response.json()) as { result?: ImportResultView; error?: string }
          results.push(payload.result ?? { status: 'failed', sourceSessionId: sessionId, message: payload.error })
        }
      }
      const imported = results.filter(item => item.status === 'imported').length
      const skipped = results.filter(item => item.status === 'skipped').length
      const failed = results.filter(item => item.status === 'failed').length
      setStatus(`完成：导入 ${imported} · 跳过 ${skipped} · 失败 ${failed}`)
      // The host wrote sessions outside the client's session controller; without
      // this the sidebar keeps the old list until a full page reload.
      refreshSidebar?.()
      void load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [load, providers, selected, sessions])

  return (
    <div className="dsi-section">
      <div className="dsi-head">
        <h1 className="dsi-title">会话导入</h1>
        <p className="dsi-subtitle">把其他编辑器里的会话带进 DSH，导入后可直接继续对话。</p>
      </div>

      {providers.map(provider => {
        const list = sessions[provider.id]
        const chosen = selected[provider.id] ?? new Set<string>()
        const open = expanded === provider.id
        const sessionRow = (item: ScannedSession): React.ReactElement => (
          <label
            className="dsi-check dsi-item"
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
            <StatusIcon status={item.status} />
            {item.status !== 'new' && (
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
                  setRetractTarget({ providerId: provider.id, item })
                }}
              >
                {retracting && retractTarget?.item.sourceSessionId === item.sourceSessionId
                  ? <Spinner />
                  : <RetractIcon />}
              </button>
            )}
          </label>
        )
        const groups = list === undefined ? [] : groupByWorkspace(list)
        const workspaceGroups = groups
          .filter(group => !isScratchWorkspace(group.key))
          .sort((a, b) => b.createdAt - a.createdAt)
        const recentSessions = groups
          .filter(group => isScratchWorkspace(group.key))
          .flatMap(group => group.sessions)
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
        const recentKey = `${provider.id}::__recent__`
        const recentOpen = openWorkspaces.has(recentKey)
        const chosenInRecent = recentSessions.filter(session => chosen.has(session.sourceSessionId)).length
        const importedInRecent = recentSessions.filter(session => session.status === 'imported' || session.status === 'grown').length
        return (
          <div className="dsi-group" key={provider.id}>
            <div className="dsi-group-head">
              <button
                className="dsi-toggle"
                type="button"
                aria-expanded={open}
                onClick={() => setExpanded(open ? undefined : provider.id)}
              >
                <Chevron open={open} />
                <ProviderIcon icon={provider.icon} name={provider.name} />
                <span className="dsi-group-title">{provider.name}</span>
              </button>
              <div className="dsi-head-end">
                <span className="dsi-meta-inline">
                  {list === undefined ? '扫描中…' : `${list.length} 会话 · ${workspaceGroups.length} 工作区`}
                  {chosen.size > 0 ? ` · 已选 ${chosen.size}` : ''}
                </span>
                {list !== undefined && list.length > 0 && (
                  <label className="dsi-check">
                    <input
                      className="dsi-box-input"
                      type="checkbox"
                      checked={chosen.size === list.length}
                      onChange={() => selectAll(provider.id)}
                    />
                    <span className="dsi-box" aria-hidden>
                      {chosen.size === list.length ? <Check /> : chosen.size > 0 ? <span className="dsi-box-dash" /> : null}
                    </span>
                    <span>全选</span>
                  </label>
                )}
              </div>
            </div>

            {open && list !== undefined && (
              <div className="dsi-workspaces">
                {workspaceGroups.map(group => {
                  const wsKey = `${provider.id}::${group.key}`
                  const wsOpen = openWorkspaces.has(wsKey)
                  const chosenInGroup = group.sessions.filter(session => chosen.has(session.sourceSessionId)).length
                  const importedInGroup = group.sessions.filter(session => session.status === 'imported' || session.status === 'grown').length
                  const failedInGroup = group.sessions.filter(session => session.status === 'failed').length
                  return (
                    <div className="dsi-ws" key={wsKey}>
                      <div className="dsi-ws-head">
                        <button
                          className="dsi-ws-toggle"
                          type="button"
                          aria-expanded={wsOpen}
                          title={group.path}
                          onClick={() => toggleWorkspace(wsKey)}
                        >
                          <Chevron open={wsOpen} />
                          <Folder />
                          <span className="dsi-ws-name">{group.label}</span>
                        </button>
                        <span className="dsi-meta-inline">
                          {group.sessions.length} 个会话
                          {importedInGroup > 0 ? ` · 已导入 ${importedInGroup}` : ''}
                          {failedInGroup > 0 ? ` · 失败 ${failedInGroup}` : ''}
                          {chosenInGroup > 0 ? ` · 已选 ${chosenInGroup}` : ''}
                        </span>
                        <label className="dsi-check dsi-ws-check" title="全选该工作区">
                          <input
                            className="dsi-box-input"
                            type="checkbox"
                            checked={chosenInGroup === group.sessions.length}
                            onChange={() => selectMany(provider.id, group.sessions.map(session => session.sourceSessionId))}
                          />
                          <span className="dsi-box" aria-hidden>
                            {chosenInGroup === group.sessions.length
                              ? <Check />
                              : chosenInGroup > 0
                                ? <span className="dsi-box-dash" />
                                : null}
                          </span>
                        </label>
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
                    <div className="dsi-ws-head">
                      <button
                        className="dsi-ws-toggle"
                        type="button"
                        aria-expanded={recentOpen}
                        onClick={() => toggleWorkspace(recentKey)}
                      >
                        <Chevron open={recentOpen} />
                        <Folder />
                        <span className="dsi-ws-name">最近任务</span>
                      </button>
                      <span className="dsi-meta-inline">
                        {recentSessions.length} 个会话
                        {importedInRecent > 0 ? ` · 已导入 ${importedInRecent}` : ''}
                        {chosenInRecent > 0 ? ` · 已选 ${chosenInRecent}` : ''}
                      </span>
                      <label className="dsi-check dsi-ws-check" title="全选最近任务">
                        <input
                          className="dsi-box-input"
                          type="checkbox"
                          checked={chosenInRecent === recentSessions.length}
                          onChange={() => selectMany(provider.id, recentSessions.map(session => session.sourceSessionId))}
                        />
                        <span className="dsi-box" aria-hidden>
                          {chosenInRecent === recentSessions.length
                            ? <Check />
                            : chosenInRecent > 0
                              ? <span className="dsi-box-dash" />
                              : null}
                        </span>
                      </label>
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

      {error !== '' && <p className="dsi-error">{error}</p>}

      <div className="dsi-footer">
        <span className="dsi-meta-inline">{status === '' ? `已选 ${totalSelected} 项` : status}</span>
        <button className="dsi-primary" type="button" disabled={busy || retracting || totalSelected === 0} onClick={() => setConfirming(true)}>
          {busy ? '导入中…' : '导入'}
        </button>
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
            <h2>撤回导入</h2>
            <p>
              将删除 DSH 中的「{retractTarget.item.title ?? retractTarget.item.sourceSessionId.slice(0, 8)}」及其对话记录。源工具里的会话不受影响，之后仍可重新导入。
            </p>
            {retractTarget.item.dshSessionId !== undefined
              && isCurrentSession?.(retractTarget.item.dshSessionId) === true && (
                <p>该会话当前已打开，撤回后会关闭当前视图。</p>
              )}
            {retractError !== '' && <p className="dsi-error">{retractError}</p>}
            <div className="dsi-dialog-actions">
              <button className="dsi-ghost" type="button" disabled={retracting} onClick={() => setRetractTarget(undefined)}>取消</button>
              <button className="dsi-primary" type="button" disabled={retracting} onClick={() => void retract()}>
                {retracting ? <><Spinner /> 正在撤回…</> : '撤回'}
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
.dsi-group-head{display:flex;align-items:center;gap:8px;min-height:36px}
.dsi-toggle{display:flex;flex:none;align-items:center;gap:8px;border:0;padding:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsi-toggle:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.dsi-group-title{font-size:14px;line-height:22px;font-weight:400;color:var(--dsw-alias-label-primary)}
.dsi-head-end{margin-left:auto;display:flex;align-items:center;gap:12px}
.dsi-group-sub{margin:-6px 0 0 20px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}

.dsi-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transform:rotate(-90deg)}
.dsi-chevron-open{transform:none}
@media (prefers-reduced-motion: no-preference){.dsi-chevron{transition:transform 140ms var(--ds-ease-in-out,ease-in-out)}}

.dsi-workspaces{display:flex;flex-direction:column;gap:2px;padding:0 0 0 20px;min-width:0}
.dsi-ws{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsi-ws-head{display:flex;align-items:center;gap:8px;min-width:0}
.dsi-ws-toggle{flex:1;min-width:0;display:flex;align-items:center;gap:8px;border:0;padding:4px 0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsi-ws-toggle:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.dsi-ws-check{flex:none}
.dsi-ws-name{min-width:0;flex:0 1 auto;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsi-ws-head .dsi-meta-inline{margin-left:auto;flex:none;white-space:nowrap}
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
.dsi-spin{animation:dsi-spin .8s linear infinite}
@keyframes dsi-spin{to{transform:rotate(360deg)}}

.dsi-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-top:0.5px solid var(--dsw-alias-border-l2)}
.dsi-row-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding-right:48px}
.dsi-row-title{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsi-row-desc{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary)}


.dsi-footer{display:flex;align-items:center;justify-content:flex-end;gap:12px;padding-top:16px;border-top:0.5px solid var(--dsw-alias-border-l2)}
.dsi-meta-inline{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsi-primary{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;padding:0 16px;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:14px;font-weight:400;line-height:22px;cursor:pointer}
.dsi-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dsi-primary:disabled{background:var(--dsw-alias-button-primary-dimmed);color:var(--dsw-alias-label-tertiary);cursor:not-allowed}
.dsi-primary:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.dsi-ghost{height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;cursor:pointer}
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
  leaveCurrentSession = removedId => {
    const ui = get?.('uiWorkspace') as UiWorkspaceFace | undefined
    try {
      const snapshot = sessions?.list?.getSnapshot()
      const fallback = snapshot?.ids.find(id => {
        const row = snapshot.byId[id]
        return id !== removedId && row !== undefined && row.blank !== true
          && row.parentSessionId === undefined && row.origin !== 'subagent'
      })
      if (fallback !== undefined && ui?.openSession !== undefined) ui.openSession(fallback)
      else ui?.clearMain?.()
    } catch (cause) {
      console.warn('[dsh-session-import] 关闭当前会话视图失败', cause)
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
    if (timer !== undefined) clearTimeout(timer)
    document.getElementById(STYLE_ID)?.remove()
  }
}
