/**
 * Client panel: pick a source app, tick the sessions you want, import them.
 *
 * Two levels only (app row → session list), matching the Qoder pattern, with a
 * confirm step before anything is written. Every colour is a DSH design token.
 */
import type { Context } from '@deepseek-ai/cordis'
import { useCallback, useEffect, useMemo, useState } from 'react'

export const inject: string[] = ['locale']

const PANEL_ID = 'dsh-session-import'
const STYLE_ID = 'dsh-session-import-style'
const API = '/dsh-session-import/api'
const PROBE_ROUNDS = 6
const PROBE_INTERVAL_MS = 350

interface SlotsFace {
  inject(name: string, callback: () => unknown): unknown
  register(spec: Record<string, unknown>, component: unknown): () => void
}

interface ProviderSummary {
  id: string
  name: string
  family: string
}

interface ScannedSession {
  sourceSessionId: string
  sourcePath: string
  bytes: number
  mtimeMs: number
}

interface ImportResultView {
  status: string
  sourceSessionId: string
  turns?: number
  events?: number
  message?: string
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Rough budget estimate: ~4 bytes per token for mixed CJK/ASCII. */
function tokens(bytes: number): string {
  const value = Math.round(bytes / 4)
  return value > 1000 ? `≈${Math.round(value / 1000)}K tokens` : `≈${value} tokens`
}

function day(ms: number): string {
  const date = new Date(ms)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return (await response.json()) as T
}

function Panel(): React.ReactElement {
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const [sessions, setSessions] = useState<Record<string, ScannedSession[]>>({})
  const [expanded, setExpanded] = useState<string | undefined>()
  const [selected, setSelected] = useState<Record<string, Set<string>>>({})
  const [fidelity, setFidelity] = useState<'window' | 'full'>('window')
  const [busy, setBusy] = useState(false)
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

  const selectAll = useCallback((providerId: string) => {
    setSelected(current => {
      const next = { ...current }
      const all = sessions[providerId] ?? []
      const set = next[providerId] ?? new Set<string>()
      next[providerId] = set.size === all.length ? new Set() : new Set(all.map(item => item.sourceSessionId))
      return next
    })
  }, [sessions])

  const totalSelected = useMemo(
    () => Object.values(selected).reduce((sum, set) => sum + set.size, 0),
    [selected],
  )

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
            body: JSON.stringify({ providerId: provider.id, sourcePath: target.sourcePath, fidelity }),
          })
          const payload = (await response.json()) as { result?: ImportResultView; error?: string }
          results.push(payload.result ?? { status: 'failed', sourceSessionId: sessionId, message: payload.error })
        }
      }
      const imported = results.filter(item => item.status === 'imported').length
      const skipped = results.filter(item => item.status === 'skipped').length
      const failed = results.filter(item => item.status === 'failed').length
      setStatus(`完成：导入 ${imported} · 跳过 ${skipped} · 失败 ${failed}`)
      void load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [fidelity, load, providers, selected, sessions])

  return (
    <div className="dsi-root">
      <header className="dsi-head">
        <h1 className="dsi-title">从已安装的应用导入</h1>
        <p className="dsi-sub">选择要带进 DSH 的会话，导入后可直接继续对话。</p>
      </header>

      {providers.map(provider => {
        const list = sessions[provider.id]
        const chosen = selected[provider.id] ?? new Set<string>()
        const open = expanded === provider.id
        return (
          <section className="dsi-card" key={provider.id}>
            <button className="dsi-row" type="button" onClick={() => setExpanded(open ? undefined : provider.id)}>
              <span className={`dsi-caret${open ? ' dsi-caret-open' : ''}`} aria-hidden>▸</span>
              <span className="dsi-app">{provider.name}</span>
              <span className="dsi-count">
                {list === undefined ? '扫描中…' : `${list.length} 个会话`}
                {chosen.size > 0 ? ` · 已选 ${chosen.size}` : ''}
              </span>
            </button>

            {open && list !== undefined && (
              <div className="dsi-body">
                <label className="dsi-check dsi-all">
                  <input
                    type="checkbox"
                    checked={chosen.size === list.length && list.length > 0}
                    onChange={() => selectAll(provider.id)}
                  />
                  <span>全选</span>
                </label>
                <ul className="dsi-list">
                  {list.map(item => (
                    <li key={item.sourceSessionId} className="dsi-item">
                      <label className="dsi-check">
                        <input
                          type="checkbox"
                          checked={chosen.has(item.sourceSessionId)}
                          onChange={() => toggle(provider.id, item.sourceSessionId)}
                        />
                        <span className="dsi-id">{item.sourceSessionId.slice(0, 8)}</span>
                        <span className="dsi-meta">{mb(item.bytes)} · {tokens(item.bytes)} · {day(item.mtimeMs)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )
      })}

      {error !== '' && <p className="dsi-error">{error}</p>}

      <footer className="dsi-foot">
        <span className="dsi-status">{status === '' ? `已选 ${totalSelected} 项` : status}</span>
        <select
          className="dsi-select"
          value={fidelity}
          onChange={event => setFidelity(event.target.value === 'full' ? 'full' : 'window')}
        >
          <option value="window">可续聊窗口（推荐）</option>
          <option value="full">完整历史</option>
        </select>
        <button className="dsi-primary" type="button" disabled={busy || totalSelected === 0} onClick={() => void runImport()}>
          {busy ? '导入中…' : '导入'}
        </button>
      </footer>
    </div>
  )
}

function PanelIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 2v8m0 0 3-3m-3 3L5 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 12.5h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/** Single injected stylesheet; all colours come from DSH tokens. */
function installStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.dsi-root{display:flex;flex-direction:column;gap:12px;padding:16px;font-family:var(--dsw-font-family);font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);height:100%;box-sizing:border-box}
.dsi-head{display:flex;flex-direction:column;gap:4px}
.dsi-title{margin:0;font-size:20px;line-height:28px;font-weight:600}
.dsi-sub{margin:0;color:var(--dsw-alias-label-secondary);font-size:14px}
.dsi-card{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-secondary);overflow:hidden}
.dsi-row{display:flex;align-items:center;gap:8px;width:100%;padding:10px 12px;background:none;border:0;cursor:pointer;color:inherit;font:inherit;text-align:left}
.dsi-row:hover{background:var(--dsw-alias-bg-tertiary)}
.dsi-caret{display:inline-block;transition:transform .15s ease;color:var(--dsw-alias-label-tertiary)}
.dsi-caret-open{transform:rotate(90deg)}
.dsi-app{font-weight:600}
.dsi-count{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:13px}
.dsi-body{border-top:1px solid var(--dsw-alias-border-l2);padding:8px 12px 12px}
.dsi-list{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:2px;max-height:320px;overflow:auto}
.dsi-check{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;line-height:20px}
.dsi-all{color:var(--dsw-alias-label-secondary)}
.dsi-id{font-family:var(--dsw-font-family-mono,monospace)}
.dsi-meta{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsi-item{padding:2px 0}
.dsi-foot{display:flex;align-items:center;gap:8px;margin-top:auto;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsi-status{color:var(--dsw-alias-label-secondary);font-size:13px;margin-right:auto}
.dsi-select{height:32px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-secondary);color:inherit;font:inherit;font-size:13px}
.dsi-primary{height:32px;padding:0 16px;border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-button-primary-bg);color:var(--dsw-alias-button-primary-label);font:inherit;font-size:13px;cursor:pointer}
.dsi-primary:disabled{opacity:.5;cursor:not-allowed}
.dsi-primary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dsi-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:13px}
`
  document.head.appendChild(style)
}

export function apply(ctx: Context): () => void {
  installStyles()
  const get = (ctx as Context & { get?: (name: string) => unknown }).get?.bind(ctx)
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
      slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, () => <Panel />))
      slots.inject('sidebar.panellist', () =>
        slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => '会话导入' }, PanelIcon))
      console.info('[dsh-session-import] panel registered')
    } catch (cause) {
      console.error('[dsh-session-import] panel registration failed', cause)
    }
  }

  mount(0)
  return () => {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
    document.getElementById(STYLE_ID)?.remove()
  }
}
