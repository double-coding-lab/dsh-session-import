/**
 * Plugin entry: mounts the session-import HTTP surface on the DSH web server.
 *
 * Routes (all under `/dsh-session-import/api`):
 *   GET  /health    plugin + provider discovery
 *   GET  /sessions  scan one provider's transcripts (metadata only)
 *   POST /import    parse + write a real DSH session
 */
import { readFileSync, readdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'

import type { ImportOptions, ProviderDescriptor } from './shared/types.ts'
import { DEFAULT_IMPORT_OPTIONS } from './shared/types.ts'
import type { PersistencePort, SessionHandle } from './host/importer.ts'
import { loadRecords, runImport, scanProvider } from './host/service.ts'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string }

export const name = 'dsh-session-import'
export const version = pkg.version
export const inject = ['webServer']

/** Route prefix; the panel calls `<prefix>/api/*`. */
export const ROUTE_PREFIX = '/dsh-session-import'

/** Load every `providers/<id>/provider.json` shipped with the package. */
function loadProviders(): ProviderDescriptor[] {
  const root = join(here, '..', 'providers')
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .flatMap(entry => {
        try {
          const raw = readFileSync(join(root, entry.name, 'provider.json'), 'utf8')
          return [JSON.parse(raw) as ProviderDescriptor]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

interface RouteFace {
  register(route: {
    kind: 'prefix' | 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
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
    fidelity: body.fidelity === 'full' ? 'full' : 'window',
    maxTurns: typeof body.maxTurns === 'number' ? body.maxTurns : DEFAULT_IMPORT_OPTIONS.maxTurns,
    keepReasoning: body.keepReasoning === true,
  }
}

export function apply(ctx: Context): () => void {
  const loose = ctx as Context & { get?: (service: string) => unknown }
  const webServer = loose.get?.('webServer') as RouteFace | undefined
  const rawPersistence = loose.get?.('sessionPersistence') as
    | {
        create(header: unknown, options?: unknown): Promise<SessionHandle>
        open(id: unknown, access: unknown, options?: unknown): Promise<SessionHandle>
      }
    | undefined

  // DSH hands out per-session handles; the importer only needs this narrow slice.
  const persistence: PersistencePort | undefined =
    rawPersistence === undefined
      ? undefined
      : {
          create: header => rawPersistence.create(header),
          open: id => rawPersistence.open(id, 'read'),
        }

  if (typeof webServer?.register !== 'function') {
    console.warn('[dsh-session-import] webServer 服务不可用，HTTP 接口未挂载')
    return () => {}
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
            providers: loadProviders().map(provider => ({
              id: provider.id,
              name: provider.name,
              family: provider.family,
              assets: Object.keys(provider.assets),
            })),
            services: { persistence: persistence !== undefined },
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
          const records = await loadRecords()
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
            options: importOptionsFrom(body),
          })
          sendJson(res, 200, { ok: result.status !== 'failed', result })
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
