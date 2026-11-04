/**
 * Plugin entry: mounts the session-import HTTP surface on the DSH web server.
 *
 * The panel lands in a later step; this entry already exposes a health route
 * and the provider list so an install can be verified with one request.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string }

export const name = 'dsh-session-import'
export const version = pkg.version
export const inject = ['webServer']

/** Route prefix; the panel calls `<prefix>/api/*`. */
export const ROUTE_PREFIX = '/dsh-session-import'

interface ProviderSummary {
  id: string
  name: string
  family: string
  assets: string[]
}

/** Read `providers/<id>/provider.json` from the installed package. */
function loadProviders(): ProviderSummary[] {
  const root = join(here, '..', 'providers')
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .flatMap(entry => {
        try {
          const raw = readFileSync(join(root, entry.name, 'provider.json'), 'utf8')
          const parsed = JSON.parse(raw) as { id?: string; name?: string; family?: string; assets?: object }
          return [
            {
              id: parsed.id ?? entry.name,
              name: parsed.name ?? entry.name,
              family: parsed.family ?? 'unknown',
              assets: Object.keys(parsed.assets ?? {}),
            },
          ]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

interface RouterFace {
  register(options: {
    kind: 'prefix' | 'exact'
    path: string
    handler: (req: unknown, res: unknown) => void | Promise<void>
  }): () => void
}

export function apply(ctx: Context): () => void {
  const loose = ctx as Context & { get?: (service: string) => unknown }
  const webServer = loose.get?.('webServer') as { router?: RouterFace } | undefined
  const router = webServer?.router

  if (router === undefined) {
    console.warn('[dsh-session-import] webServer.router 不可用，HTTP 接口未挂载')
    return () => {}
  }

  const dispose = router.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => {
      const request = req as { url?: string }
      const response = res as {
        statusCode: number
        setHeader(name: string, value: string): void
        end(body: string): void
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const path = url.pathname

      response.setHeader('content-type', 'application/json; charset=utf-8')

      if (path === `${ROUTE_PREFIX}/api/health`) {
        const providers = loadProviders()
        response.statusCode = 200
        response.end(
          JSON.stringify({
            ok: true,
            plugin: name,
            version,
            providers,
            capabilities: { sessions: true, memory: false },
          }),
        )
        return
      }

      response.statusCode = 404
      response.end(JSON.stringify({ ok: false, error: 'not-found', path }))
    },
  })

  console.log(`[dsh-session-import] v${version} 已挂载 ${ROUTE_PREFIX}/api`)
  return dispose
}
