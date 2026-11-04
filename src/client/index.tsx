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

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function tokens(bytes: number): string {
  const value = Math.round(bytes / 4)
  return value > 1000 ? `≈${Math.round(value / 1000)}K tokens` : `≈${value} tokens`
}

function day(ms: number): string {
  const date = new Date(ms)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

/** Official chevron: points right when collapsed, down when expanded. */
function Chevron({ open }: { open: boolean }): React.ReactElement {
  return (
    <svg
      className={`dsi-chevron${open ? ' dsi-chevron-open' : ''}`}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <path d="M4 6.5 8 10.5 12 6.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Check(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3.5 8.5 6.5 11.5 12.5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Native-style selector: pill trigger + elevated popup with a check on the value. */
function Selector<T extends string>(props: {
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const current = props.options.find(option => option.value === props.value)

  return (
    <div className="dsi-picker" ref={box}>
      <button
        className="dsi-switcher"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span className="dsi-switcher-label">{current?.label ?? props.value}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="dsi-menu" role="listbox">
          {props.options.map(option => (
            <button
              key={option.value}
              className="dsi-menu-item"
              type="button"
              role="option"
              aria-selected={option.value === props.value}
              onClick={() => {
                props.onChange(option.value)
                setOpen(false)
              }}
            >
              <span>{option.label}</span>
              {option.value === props.value && <span className="dsi-menu-check"><Check /></span>}
            </button>
          ))}
        </div>
      )}
    </div>
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
    <div className="dsi-section">
      <div className="dsi-head">
        <h1 className="dsi-title">会话导入</h1>
        <p className="dsi-subtitle">把其他编辑器里的会话带进 DSH，导入后可直接继续对话。</p>
      </div>

      {providers.map(provider => {
        const list = sessions[provider.id]
        const chosen = selected[provider.id] ?? new Set<string>()
        const open = expanded === provider.id
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
                <span className="dsi-group-title">{provider.name}</span>
              </button>
              <div className="dsi-head-end">
                <span className="dsi-meta-inline">
                  {list === undefined ? '扫描中…' : `${list.length} 个会话`}
                  {chosen.size > 0 ? ` · 已选 ${chosen.size}` : ''}
                </span>
                {list !== undefined && list.length > 0 && (
                  <label className="dsi-check">
                    <input
                      className="dsi-box"
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
                        className="dsi-box"
                        type="checkbox"
                        checked={chosen.has(item.sourceSessionId)}
                        onChange={() => toggle(provider.id, item.sourceSessionId)}
                      />
                      <span className="dsi-item-id">{item.sourceSessionId.slice(0, 8)}</span>
                      <span className={`dsi-badge dsi-badge-${item.status}`}>{BADGE[item.status]}</span>
                      <span className="dsi-item-meta">{mb(item.bytes)} · {tokens(item.bytes)} · {day(item.mtimeMs)}</span>
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

            {open && <div className="dsi-group-sub">{list === undefined ? '正在读取目录…' : '按最近修改时间排序'}</div>}
          </div>
        )
      })}

      <div className="dsi-row">
        <div className="dsi-row-text">
          <div className="dsi-row-title">保真度</div>
          <div className="dsi-row-desc">可续聊窗口只带最近一段对话，完整历史包含全部内容。</div>
        </div>
        <Selector
          value={fidelity}
          options={[
            { value: 'window', label: '可续聊窗口' },
            { value: 'full', label: '完整历史' },
          ]}
          onChange={setFidelity}
        />
      </div>

      {error !== '' && <p className="dsi-error">{error}</p>}

      <div className="dsi-footer">
        <span className="dsi-meta-inline">{status === '' ? `已选 ${totalSelected} 项` : status}</span>
        <button className="dsi-primary" type="button" disabled={busy || totalSelected === 0} onClick={() => setConfirming(true)}>
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
              将导入 {totalSelected} 个会话，保真度「{fidelity === 'window' ? '可续聊窗口' : '完整历史'}」。
              导入后会出现在左侧会话列表，可直接继续对话。
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
.dsi-toggle:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsi-group-title{font-size:14px;line-height:22px;font-weight:400;color:var(--dsw-alias-label-primary)}
.dsi-head-end{margin-left:auto;display:flex;align-items:center;gap:12px}
.dsi-group-sub{margin:-6px 0 0 24px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}

.dsi-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transform:rotate(-90deg)}
.dsi-chevron-open{transform:none}
@media (prefers-reduced-motion: no-preference){.dsi-chevron{transition:transform 140ms var(--ds-ease-in-out,ease-in-out)}}

.dsi-list{list-style:none;margin:0;padding:0 0 0 24px;display:flex;flex-direction:column;gap:2px;max-height:300px;overflow:auto}
.dsi-item{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px;line-height:20px;cursor:pointer}
.dsi-item-id{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.dsi-item-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}

.dsi-check{display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsi-box{appearance:none;-webkit-appearance:none;flex:none;width:16px;height:16px;margin:0;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-layer-1);cursor:pointer;position:relative}
.dsi-box:checked{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.dsi-box:checked::after{content:'';position:absolute;left:4.5px;top:1.5px;width:4px;height:8px;border:solid var(--dsw-alias-button-primary-label);border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}
.dsi-box:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}

.dsi-badge{font-size:11px;line-height:18px;padding:0 6px;border-radius:var(--dsw-radius-xs);border:0.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
.dsi-badge-imported{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.dsi-badge-grown{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l3)}
.dsi-badge-failed{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsi-link{margin-left:auto;border:0;padding:0;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:12px;cursor:pointer}
.dsi-link:hover{text-decoration:underline}

.dsi-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-top:0.5px solid var(--dsw-alias-border-l2)}
.dsi-row-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding-right:48px}
.dsi-row-title{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsi-row-desc{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary)}

.dsi-picker{position:relative;flex:none}
.dsi-switcher{display:inline-flex;align-items:center;gap:12px;height:36px;white-space:nowrap;border:none;border-radius:var(--dsw-radius-md);padding:0 14px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer}
@media (hover: hover){.dsi-switcher:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.dsi-switcher:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsi-switcher-label{max-width:240px;overflow:hidden;text-overflow:ellipsis}
.dsi-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:20;min-width:180px;display:flex;flex-direction:column;gap:2px;padding:6px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent)}
.dsi-menu-item{display:flex;align-items:center;justify-content:space-between;gap:12px;height:36px;padding:0 10px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer;text-align:left}
.dsi-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsi-menu-check{flex:none;display:inline-flex;color:var(--dsw-alias-label-primary)}

.dsi-footer{display:flex;align-items:center;gap:12px;padding-top:14px}
.dsi-meta-inline{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsi-primary{height:36px;padding:0 16px;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-button-primary-bg);color:var(--dsw-alias-button-primary-label);font:inherit;font-size:14px;cursor:pointer}
.dsi-primary:disabled{opacity:.5;cursor:not-allowed}
.dsi-primary:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsi-ghost{height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;cursor:pointer}
.dsi-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}

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
    if (timer !== undefined) clearTimeout(timer)
    document.getElementById(STYLE_ID)?.remove()
  }
}
