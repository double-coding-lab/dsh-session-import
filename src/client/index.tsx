/**
 * Settings section: import third-party sessions into DSH.
 *
 * Registered into `settings.section` (next to 通用设置 / 模型 …) rather than the
 * sidebar, and laid out like a native settings page: rows with a title and a
 * secondary description on the left, the control on the right.
 */
import type { Context } from '@deepseek-ai/cordis'
import { useCallback, useEffect, useMemo, useState } from 'react'

export const inject: string[] = ['locale']

const SECTION_ID = 'session-import'
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
  status: 'new' | 'imported' | 'grown' | 'failed'
  dshSessionId?: string
}

const BADGE: Record<ScannedSession['status'], string> = {
  new: '未导入',
  imported: '已导入',
  grown: '有新增',
  failed: '失败',
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

function Section(): React.ReactElement {
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const [sessions, setSessions] = useState<Record<string, ScannedSession[]>>({})
  const [expanded, setExpanded] = useState<string | undefined>()
  const [selected, setSelected] = useState<Record<string, Set<string>>>({})
  const [fidelity, setFidelity] = useState<'window' | 'full'>('window')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
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

  const retract = useCallback(async (providerId: string, sessionId: string) => {
    try {
      setStatus('正在撤回…')
      const response = await fetch(`${API}/retract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId, sourceSessionId: sessionId }),
      })
      const payload = (await response.json()) as { ok?: boolean; error?: string }
      setStatus(payload.ok === true ? `已撤回 ${sessionId.slice(0, 8)}` : `撤回失败：${payload.error ?? ''}`)
      void load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [load])

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
      <div className="dsi-row dsi-row-head">
        <div className="dsi-text">
          <div className="dsi-label">从已安装的应用导入</div>
          <div className="dsi-desc">选择要带进 DSH 的会话，导入后可以直接继续对话。</div>
        </div>
      </div>

      {providers.map(provider => {
        const list = sessions[provider.id]
        const chosen = selected[provider.id] ?? new Set<string>()
        const open = expanded === provider.id
        return (
          <div className="dsi-group" key={provider.id}>
            <div className="dsi-row">
              <button className="dsi-app" type="button" onClick={() => setExpanded(open ? undefined : provider.id)}>
                <span className={`dsi-caret${open ? ' dsi-caret-open' : ''}`} aria-hidden>▸</span>
                <span className="dsi-label">{provider.name}</span>
              </button>
              <div className="dsi-right">
                <span className="dsi-desc">
                  {list === undefined ? '扫描中…' : `${list.length} 个会话`}
                  {chosen.size > 0 ? ` · 已选 ${chosen.size}` : ''}
                </span>
                {list !== undefined && list.length > 0 && (
                  <label className="dsi-check dsi-inline">
                    <input
                      type="checkbox"
                      checked={chosen.size === list.length}
                      onChange={() => selectAll(provider.id)}
                    />
                    <span>全选</span>
                  </label>
                )}
              </div>
            </div>

            {open && list !== undefined && (
              <ul className="dsi-list">
                {list.map(item => (
                  <li key={item.sourceSessionId}>
                    <label className="dsi-check dsi-item">
                      <input
                        type="checkbox"
                        checked={chosen.has(item.sourceSessionId)}
                        onChange={() => toggle(provider.id, item.sourceSessionId)}
                      />
                      <span className="dsi-id">{item.sourceSessionId.slice(0, 8)}</span>
                      <span className={`dsi-badge dsi-badge-${item.status}`}>{BADGE[item.status]}</span>
                      <span className="dsi-desc">{mb(item.bytes)} · {tokens(item.bytes)} · {day(item.mtimeMs)}</span>
                      {item.status !== 'new' && (
                        <button
                          className="dsi-link"
                          type="button"
                          onClick={event => {
                            event.preventDefault()
                            event.stopPropagation()
                            void retract(provider.id, item.sourceSessionId)
                          }}
                        >
                          撤回
                        </button>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}

      <div className="dsi-row">
        <div className="dsi-text">
          <div className="dsi-label">保真度</div>
          <div className="dsi-desc">可续聊窗口只带最近一段对话，完整历史包含全部内容。</div>
        </div>
        <select
          className="dsi-select"
          value={fidelity}
          onChange={event => setFidelity(event.target.value === 'full' ? 'full' : 'window')}
        >
          <option value="window">可续聊窗口</option>
          <option value="full">完整历史</option>
        </select>
      </div>

      {error !== '' && <div className="dsi-row"><span className="dsi-error">{error}</span></div>}

      <div className="dsi-row dsi-row-foot">
        <span className="dsi-desc">{status === '' ? `已选 ${totalSelected} 项` : status}</span>
        <button className="dsi-primary" type="button" disabled={busy || totalSelected === 0} onClick={() => setConfirming(true)}>
          {busy ? '导入中…' : '导入'}
        </button>
      </div>

      {confirming && (
        <div className="dsi-mask" role="presentation" onClick={() => { if (!busy) setConfirming(false) }}>
          <div className="dsi-dialog" role="dialog" aria-modal="true" aria-label="确认导入" onClick={event => event.stopPropagation()}>
            <h2>确认导入</h2>
            <p>
              将导入 {totalSelected} 个会话，保真度「{fidelity === 'window' ? '可续聊窗口' : '完整历史'}」。
              导入后会出现在左侧会话列表，可直接继续对话。
            </p>
            <div className="dsi-dialog-actions">
              <button className="dsi-ghost" type="button" disabled={busy} onClick={() => setConfirming(false)}>取消</button>
              <button className="dsi-primary" type="button" disabled={busy} onClick={() => { setConfirming(false); void runImport() }}>
                {busy ? '导入中…' : `导入 ${totalSelected} 个会话`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Single injected stylesheet; colours and radii come from DSH tokens. */
function installStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.dsi-root{display:flex;flex-direction:column;font-family:var(--dsw-font-family);font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsi-row{display:flex;align-items:center;gap:16px;padding:14px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsi-row-head{padding-top:0}
.dsi-row-foot{border-bottom:0;padding-bottom:8px}
.dsi-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsi-label{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsi-desc{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsi-right{margin-left:auto;display:flex;align-items:center;gap:12px}
.dsi-app{display:flex;align-items:center;gap:8px;background:none;border:0;padding:0;cursor:pointer;color:inherit;font:inherit}
.dsi-caret{display:inline-block;font-size:11px;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease}
.dsi-caret-open{transform:rotate(90deg)}
.dsi-group{display:flex;flex-direction:column}
.dsi-list{list-style:none;margin:0;padding:0 0 12px 20px;display:flex;flex-direction:column;gap:4px;max-height:280px;overflow:auto;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsi-check{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;line-height:20px}
.dsi-inline{margin-left:4px}
.dsi-item{padding:2px 0}
.dsi-id{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.dsi-select{height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-tertiary);color:inherit;font:inherit;font-size:13px}
.dsi-primary{height:32px;padding:0 16px;border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-button-primary-bg);color:var(--dsw-alias-button-primary-label);font:inherit;font-size:13px;cursor:pointer}
.dsi-primary:disabled{opacity:.5;cursor:not-allowed}
.dsi-primary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dsi-error{color:var(--dsw-alias-state-error-primary);font-size:13px}
.dsi-badge{font-size:11px;line-height:18px;padding:0 6px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dsi-badge-imported{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.dsi-badge-grown{color:var(--dsw-alias-state-warning-primary,#b26a00);border-color:var(--dsw-alias-state-warning-primary,#b26a00)}
.dsi-badge-failed{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsi-link{margin-left:auto;background:none;border:0;padding:0;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:12px;cursor:pointer}
.dsi-link:hover{text-decoration:underline}
.dsi-mask{position:fixed;inset:0;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center;z-index:50}
.dsi-dialog{width:min(420px,90vw);background:var(--dsw-alias-bg-primary);border-radius:var(--dsw-radius-lg);padding:20px;display:flex;flex-direction:column;gap:12px;font-family:var(--dsw-font-family);color:var(--dsw-alias-label-primary);box-shadow:0 8px 24px rgba(0,0,0,.18)}
.dsi-dialog h2{margin:0;font-size:16px;line-height:24px;font-weight:600}
.dsi-dialog p{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsi-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.dsi-ghost{height:32px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:none;color:inherit;font:inherit;font-size:13px;cursor:pointer}
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
      slots.inject('settings.section', () =>
        slots.register(
          {
            name: 'settings.section',
            id: SECTION_ID,
            order: 30,
            label: () => '会话导入',
          },
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
    if (timer !== undefined) clearTimeout(timer)
    document.getElementById(STYLE_ID)?.remove()
  }
}
