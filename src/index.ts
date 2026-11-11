/**
 * Plugin entry: mounts the session-import HTTP surface on the DSH web server.
 *
 * Routes (all under `/dsh-session-import/api`):
 *   GET  /health    plugin + provider discovery
 *   GET  /sessions  scan one provider's transcripts (metadata only)
 *   POST /import    parse + write a real DSH session
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'

import type { ImportOptions, ImportResult, ProviderDescriptor } from './shared/types.ts'
import { DEFAULT_IMPORT_OPTIONS } from './shared/types.ts'
import type { PersistencePort, ProjectionCachePort, SessionHandle, SessionHeaderLike } from './host/importer.ts'
import type { AttachmentsFace, RetractRuntime, WorkspacePort } from './host/service.ts'
import {
  backfillTitles,
  dshHome,
  loadLiveRecords,
  removeSessionDirectories,
  retractImport,
  runImport,
  scanProvider,
} from './host/service.ts'
import { attachSessionToWorkspace, detachSessionFromWorkspaces } from './host/workspaces.ts'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string }

export const name = 'dsh-session-import'
export const version = pkg.version
export const inject = ['webServer']

/** Route prefix; the panel calls `<prefix>/api/*`. */
export const ROUTE_PREFIX = '/dsh-session-import'

interface ImportBatchTarget {
  providerId: string
  sourcePath: string
  sourcePaths?: string[]
  sourceSessionId?: string
  providerName?: string
  title?: string
  cwd?: string
  bytes?: number
  mtimeMs?: number
  previousStatus?: string
}

interface ImportJobEntry extends ImportResult {
  providerName: string
  title?: string
  sourcePath: string
  cwd?: string
  sourceBytes?: number
  sourceMtime?: string
  previousStatus?: string
  startedAt: string
  finishedAt: string
  durationMs: number
}

interface ImportJobState {
  startedAt: string
  finishedAt?: string
  total: number
  done: number
  running: boolean
  results: ImportJobEntry[]
}

/**
 * Batch imports run in the host, not in the panel: closing the settings page
 * must not stop the queue. The panel polls this state to show progress.
 */
let importJob: ImportJobState | undefined

/** Load every `providers/<id>/provider.json` shipped with the package. */
interface LoadedProvider {
  descriptor: ProviderDescriptor
  dir: string
}

function loadProviderEntries(): LoadedProvider[] {
  const root = join(here, '..', 'providers')
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .flatMap(entry => {
        const dir = join(root, entry.name)
        try {
          const raw = readFileSync(join(dir, 'provider.json'), 'utf8')
          return [{ descriptor: JSON.parse(raw) as ProviderDescriptor, dir }]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

function loadProviders(): ProviderDescriptor[] {
  return loadProviderEntries().map(entry => entry.descriptor)
}

/** Icon URL version so replacing a mark busts the browser cache immediately. */
function iconVersion(dir: string, icon: string): string {
  try {
    return String(Math.round(statSync(resolve(dir, icon)).mtimeMs))
  } catch {
    return '0'
  }
}

function iconMime(file: string): string {
  switch (extname(file).toLowerCase()) {
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.webp':
      return 'image/webp'
    case '.ico':
      return 'image/x-icon'
    case '.jpg':
      return 'image/jpeg'
    default:
      return 'application/octet-stream'
  }
}

interface RouteFace {
  register(route: {
    kind: 'prefix' | 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Narrow slice of DSH's live `workspaceRegistry` service. */
interface WorkspaceEntityFace {
  id: string
  path: string
  sessionIds: string[]
  /** DSH's raw record; `sessionIds` filters by a live session-cwd check. */
  record?: { sessionIds?: unknown }
  attachSession(sessionId: string): Promise<void>
  detachSession(sessionId: string): Promise<void>
}

interface WorkspaceRegistryFace {
  create(path: string, title: string): Promise<WorkspaceEntityFace>
  resolveByPath(path: string): Promise<WorkspaceEntityFace | undefined>
  list(): WorkspaceEntityFace[]
  delete?(id: string): Promise<boolean>
}

/** Narrow slice of the live agent registry; agents live for the host process. */
interface LiveAgentFace {
  status: string
  cancel(cause: unknown, options?: unknown): void
  whenIdle(): Promise<void>
  scope?: { dispose?(): Promise<void> }
}

interface AgentRegistryFace {
  get(id: string): LiveAgentFace | undefined
  store?: Map<string, unknown>
  detachEntered?(entry: unknown): void
}

/** Narrow slice of the live session store. */
interface HostSessionsFace {
  get(id: string): { id: string } | undefined
  liveEntryFor?(session: unknown): { detach(): void }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      cause => {
        clearTimeout(timer)
        reject(cause)
      },
    )
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function importOptionsFrom(body: Record<string, unknown>): ImportOptions {
  return {
    ...DEFAULT_IMPORT_OPTIONS,
    keepReasoning: body.keepReasoning === true,
  }
}

export function apply(ctx: Context): () => void {
  // Workspace membership is established at import time. Never re-attach on
  // startup: deleting a Workspace is an explicit user action, and DSH keeps
  // its Sessions under 「未分组」 rather than recreating the group.
  const loose = ctx as Context & { get?: (service: string) => unknown }
  const webServer = loose.get?.('webServer') as RouteFace | undefined
  const rawPersistence = loose.get?.('sessionPersistence') as
    | {
        create(header: unknown, options?: unknown): Promise<SessionHandle>
        open(id: unknown, access: unknown, options?: unknown): Promise<SessionHandle>
        stat?(id: unknown, options?: unknown): Promise<{ header: SessionHeaderLike } | undefined>
      }
    | undefined
  const projectionCache = (): ProjectionCachePort | undefined =>
    loose.get?.('sessionProjectionCache') as ProjectionCachePort | undefined
  const attachments = (): AttachmentsFace | undefined =>
    loose.get?.('attachments') as AttachmentsFace | undefined

  // DSH hands out per-session handles; the importer only needs this narrow slice.
  const persistence: PersistencePort | undefined =
    rawPersistence === undefined
      ? undefined
      : {
          create: header => rawPersistence.create(header),
          open: (id, access) => rawPersistence.open(id, access ?? 'read'),
          ...(typeof rawPersistence.stat === 'function'
            ? { stat: async (id: string) => rawPersistence.stat?.(id) }
            : {}),
        }

  if (persistence !== undefined) {
    // The projection cache mounts after this plugin, so wait for the service
    // instead of sampling `get()` during apply.
    ctx.inject(['sessionProjectionCache'], cacheCtx => {
      const cache = cacheCtx.get('sessionProjectionCache') as ProjectionCachePort | undefined
      void backfillTitles(persistence, cache)
        .then(result => {
          if (result.titled > 0 || result.warmed > 0) {
            console.info(
              `[dsh-session-import] 标题回填：${result.titled}/${result.scanned}，投影预热：${result.warmed}/${result.scanned}`,
            )
          }
        })
        .catch(cause => console.warn('[dsh-session-import] 标题回填失败', cause))
    })
  }

  // Live attach through the running registry so the sidebar updates immediately.
  // The file writer remains as a fallback for hosts without the service.
  const workspace: WorkspacePort = {
    attach: async (sessionId, cwd) => {
      if (cwd === undefined || cwd === '') return { attached: false, reason: '会话没有 cwd' }
      const registry = loose.get?.('workspaceRegistry') as WorkspaceRegistryFace | undefined
      if (registry === undefined || typeof registry.create !== 'function') {
        return attachSessionToWorkspace(dshHome(), sessionId, cwd)
      }
      try {
        const entity =
          (await registry.resolveByPath(cwd)) ?? (await registry.create(cwd, basename(cwd) || cwd))
        await entity.attachSession(sessionId)
        return { attached: true, workspacePath: entity.path }
      } catch (cause) {
        console.warn('[dsh-session-import] 在线挂载失败，回退文件', cause)
        return attachSessionToWorkspace(dshHome(), sessionId, cwd)
      }
    },
    detach: async sessionId => {
      const registry = loose.get?.('workspaceRegistry') as WorkspaceRegistryFace | undefined
      if (registry !== undefined && typeof registry.list === 'function') {
        try {
          for (const entity of registry.list()) {
            const rawIds = Array.isArray(entity.record?.sessionIds)
              ? entity.record.sessionIds as string[]
              : entity.sessionIds
            if (Array.isArray(rawIds) && rawIds.includes(sessionId)) {
              const wasOnly = rawIds.length === 1
              await entity.detachSession(sessionId)
              if (wasOnly && typeof registry.delete === 'function') {
                try {
                  await registry.delete(entity.id)
                } catch (cause) {
                  console.warn('[dsh-session-import] 空工作区清理失败', cause)
                }
              }
              return true
            }
          }
        } catch (cause) {
          console.warn('[dsh-session-import] 在线撤回挂载失败，回退文件', cause)
        }
      }
      return detachSessionFromWorkspaces(dshHome(), sessionId)
    },
  }

  // A Session that was ever opened stays resident in the host for the life of
  // the process, and `session/list` keeps returning it even after its log is
  // gone. Retraction therefore has to run DSH's own teardown first: stop the
  // agent, drop its scope, then unregister the agent and session. The steps are
  // idempotent, so the owner fiber's later teardown remains safe.
  const retractRuntime: RetractRuntime = {
    liveStatus: sessionId => {
      const registry = loose.get?.('agents') as AgentRegistryFace | undefined
      const agent = registry?.get(sessionId)
      if (agent !== undefined) return agent.status
      const sessions = loose.get?.('sessions') as HostSessionsFace | undefined
      return sessions?.get(sessionId) === undefined ? undefined : 'attached'
    },
    evict: async sessionId => {
      const registry = loose.get?.('agents') as AgentRegistryFace | undefined
      const agent = registry?.get(sessionId)
      if (agent !== undefined) {
        try {
          agent.cancel({ kind: 'disposed' })
        } catch (cause) {
          console.warn('[dsh-session-import] 停止会话失败', cause)
        }
        await withTimeout(agent.whenIdle(), 5000, '该会话仍在收尾，请稍后再撤回')
        try {
          await agent.scope?.dispose?.()
        } catch (cause) {
          console.warn('[dsh-session-import] 释放会话作用域失败', cause)
        }
        const entry = registry?.store?.get(sessionId)
        if (entry !== undefined) {
          try {
            registry?.detachEntered?.(entry)
          } catch (cause) {
            console.warn('[dsh-session-import] 注销会话 Agent 失败', cause)
          }
        }
      }
      const sessions = loose.get?.('sessions') as HostSessionsFace | undefined
      const session = sessions?.get(sessionId)
      if (session !== undefined) {
        try {
          sessions?.liveEntryFor?.(session)?.detach()
        } catch (cause) {
          throw new Error(`无法从 DSH 会话列表移除该会话：${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }
    },
  }

  if (typeof webServer?.register !== 'function') {
    console.warn('[dsh-session-import] webServer 服务不可用，HTTP 接口未挂载')
    return () => {}
  }

  // Rewind branches rewrite an existing import: remove the old log, then write
  // the active branch under the same session id.
  const deleteSession = async (sessionId: string): Promise<void> => {
    await removeSessionDirectories(sessionId)
  }

  const dispose = webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname

      try {
        if (path === `${ROUTE_PREFIX}/api/health`) {
          sendJson(res, 200, {
            ok: true,
            plugin: name,
            version,
            providers: loadProviderEntries().map(({ descriptor: provider, dir }) => ({
              id: provider.id,
              name: provider.name,
              family: provider.family,
              assets: Object.keys(provider.assets),
              ...(provider.icon === undefined
                ? {}
                : { icon: `${ROUTE_PREFIX}/api/icon?provider=${encodeURIComponent(provider.id)}&v=${iconVersion(dir, provider.icon)}` }),
            })),
            services: {
              persistence: persistence !== undefined,
              projectionCache: projectionCache() !== undefined,
              workspaceRegistry: loose.get?.('workspaceRegistry') !== undefined,
            },
          })
          return
        }

        if (path === `${ROUTE_PREFIX}/api/sessions`) {
          const providerId = url.searchParams.get('provider') ?? ''
          const provider = loadProviders().find(item => item.id === providerId)
          if (provider === undefined) {
            sendJson(res, 400, { ok: false, error: 'unknown-provider', providerId })
            return
          }
          const records = await loadLiveRecords()
          const sessions = await scanProvider(provider, records)
          sendJson(res, 200, { ok: true, providerId, count: sessions.length, sessions })
          return
        }

        if (path === `${ROUTE_PREFIX}/api/import` && req.method === 'POST') {
          if (persistence === undefined) {
            sendJson(res, 503, { ok: false, error: 'sessionPersistence 不可用' })
            return
          }
          const body = await readJson(req)
          const providerId = typeof body.providerId === 'string' ? body.providerId : ''
          const sourcePath = typeof body.sourcePath === 'string' ? body.sourcePath : ''
          const provider = loadProviders().find(item => item.id === providerId)
          if (provider === undefined || sourcePath === '') {
            sendJson(res, 400, { ok: false, error: 'providerId 与 sourcePath 必填' })
            return
          }
          const result = await runImport(persistence, {
            providerId,
            sourcePath,
            ...(Array.isArray(body.sourcePaths) && body.sourcePaths.every(value => typeof value === 'string')
              ? { sourcePaths: body.sourcePaths as string[] }
              : {}),
            ...(typeof body.sourceSessionId === 'string' && body.sourceSessionId !== ''
              ? { sourceSessionId: body.sourceSessionId }
              : {}),
            options: importOptionsFrom(body),
            provider,
          }, workspace, projectionCache(), attachments(), retractRuntime.liveStatus, retractRuntime.evict, deleteSession)
          sendJson(res, 200, { ok: result.status !== 'failed', result })
          return
        }

        if (path === `${ROUTE_PREFIX}/api/import-batch` && req.method === 'POST') {
          if (persistence === undefined) {
            sendJson(res, 503, { ok: false, error: 'sessionPersistence 不可用' })
            return
          }
          if (importJob?.running === true) {
            sendJson(res, 409, { ok: false, error: '已有导入任务进行中' })
            return
          }
          const body = await readJson(req)
          const rawTargets = Array.isArray(body.targets) ? body.targets : []
          const targets: ImportBatchTarget[] = []
          for (const raw of rawTargets) {
            if (raw === null || typeof raw !== 'object') continue
            const item = raw as Record<string, unknown>
            if (typeof item['providerId'] !== 'string' || item['providerId'] === '') continue
            if (typeof item['sourcePath'] !== 'string' || item['sourcePath'] === '') continue
            targets.push({
              providerId: item['providerId'],
              sourcePath: item['sourcePath'],
              ...(Array.isArray(item['sourcePaths']) && item['sourcePaths'].every(value => typeof value === 'string')
                ? { sourcePaths: item['sourcePaths'] as string[] }
                : {}),
              ...(typeof item['sourceSessionId'] === 'string' && item['sourceSessionId'] !== ''
                ? { sourceSessionId: item['sourceSessionId'] }
                : {}),
              ...(typeof item['providerName'] === 'string' ? { providerName: item['providerName'] } : {}),
              ...(typeof item['title'] === 'string' ? { title: item['title'] } : {}),
              ...(typeof item['cwd'] === 'string' ? { cwd: item['cwd'] } : {}),
              ...(typeof item['bytes'] === 'number' ? { bytes: item['bytes'] } : {}),
              ...(typeof item['mtimeMs'] === 'number' ? { mtimeMs: item['mtimeMs'] } : {}),
              ...(typeof item['previousStatus'] === 'string' ? { previousStatus: item['previousStatus'] } : {}),
            })
          }
          if (targets.length === 0) {
            sendJson(res, 400, { ok: false, error: 'targets 必填' })
            return
          }
          const options = importOptionsFrom(body)
          const job: ImportJobState = {
            startedAt: new Date().toISOString(),
            total: targets.length,
            done: 0,
            running: true,
            results: [],
          }
          importJob = job
          const JOB_CONCURRENCY = 3
          // The workspace registry mutates one entity per attach, so attach is
          // serialized while the heavier per-session work overlaps.
          const attachTail = { current: Promise.resolve() as Promise<unknown> }
          const serializedWorkspace: WorkspacePort | undefined = workspace === undefined
            ? undefined
            : {
                attach: (sessionId, cwd) => {
                  const run = attachTail.current.then(() => workspace.attach(sessionId, cwd))
                  attachTail.current = run.then(() => undefined, () => undefined)
                  return run
                },
                detach: sessionId => workspace.detach(sessionId),
              }
          const runOne = async (target: ImportBatchTarget): Promise<void> => {
            const provider = loadProviders().find(item => item.id === target.providerId)
            const startedAt = new Date().toISOString()
            const attemptStarted = Date.now()
            let result: ImportResult
            try {
              result = await runImport(persistence, {
                providerId: target.providerId,
                sourcePath: target.sourcePath,
                ...(target.sourcePaths === undefined ? {} : { sourcePaths: target.sourcePaths }),
                ...(target.sourceSessionId === undefined ? {} : { sourceSessionId: target.sourceSessionId }),
                options,
                provider,
              }, serializedWorkspace, projectionCache(), attachments(), retractRuntime.liveStatus, retractRuntime.evict, deleteSession)
            } catch (cause) {
              result = {
                status: 'failed',
                providerId: target.providerId,
                sourceSessionId: '',
                turns: 0,
                events: 0,
                truncated: 0,
                repaired: 0,
                message: cause instanceof Error ? cause.message : String(cause),
              }
            }
            job.results.push({
              ...result,
              providerName: target.providerName ?? provider?.name ?? target.providerId,
              ...(target.title === undefined ? {} : { title: target.title }),
              sourcePath: target.sourcePath,
              ...(target.cwd === undefined ? {} : { cwd: target.cwd }),
              ...(target.bytes === undefined ? {} : { sourceBytes: target.bytes }),
              ...(target.mtimeMs === undefined ? {} : { sourceMtime: new Date(target.mtimeMs).toISOString() }),
              ...(target.previousStatus === undefined ? {} : { previousStatus: target.previousStatus }),
              startedAt,
              finishedAt: new Date().toISOString(),
              durationMs: Date.now() - attemptStarted,
            })
            job.done += 1
          }
          void (async () => {
            try {
              let next = 0
              const workers = Array.from({ length: Math.min(JOB_CONCURRENCY, targets.length) }, async () => {
                while (true) {
                  const index = next++
                  if (index >= targets.length) return
                  await runOne(targets[index])
                }
              })
              await Promise.all(workers)
            } finally {
              job.running = false
              job.finishedAt = new Date().toISOString()
            }
          })()
          sendJson(res, 200, { ok: true, startedAt: job.startedAt, total: job.total })
          return
        }

        if (path === `${ROUTE_PREFIX}/api/import-status`) {
          sendJson(res, 200, { ok: true, job: importJob ?? null })
          return
        }

        if (path === `${ROUTE_PREFIX}/api/retract` && req.method === 'POST') {
          if (importJob?.running === true) {
            sendJson(res, 409, { ok: false, error: '导入进行中，暂不能撤回' })
            return
          }
          const body = await readJson(req)
          const providerId = typeof body.providerId === 'string' ? body.providerId : ''
          const sourceSessionId = typeof body.sourceSessionId === 'string' ? body.sourceSessionId : ''
          if (providerId === '' || sourceSessionId === '') {
            sendJson(res, 400, { ok: false, error: 'providerId 与 sourceSessionId 必填' })
            return
          }
          const result = await retractImport(providerId, sourceSessionId, workspace, retractRuntime)
          sendJson(res, 200, { ok: true, result })
          return
        }

        if (path === `${ROUTE_PREFIX}/api/icon`) {
          const providerId = url.searchParams.get('provider') ?? ''
          const entry = loadProviderEntries().find(item => item.descriptor.id === providerId)
          const icon = entry?.descriptor.icon
          if (entry === undefined || icon === undefined) {
            sendJson(res, 404, { ok: false, error: 'no-icon' })
            return
          }
          const base = resolve(entry.dir)
          const file = resolve(base, icon)
          if (!file.startsWith(base + sep)) {
            sendJson(res, 400, { ok: false, error: 'bad-icon-path' })
            return
          }
          try {
            const data = readFileSync(file)
            res.statusCode = 200
            res.setHeader('content-type', iconMime(file))
            // Provider icons live in the plugin directory and can change without
            // a URL change; a cached hour would keep showing the old mark.
            res.setHeader('cache-control', 'no-cache, max-age=0')
            res.end(data)
          } catch {
            sendJson(res, 404, { ok: false, error: 'icon-missing' })
          }
          return
        }

        sendJson(res, 404, { ok: false, error: 'not-found', path })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  console.log(`[dsh-session-import] v${version} 已挂载 ${ROUTE_PREFIX}/api（persistence: ${persistence !== undefined}）`)
  return dispose
}
