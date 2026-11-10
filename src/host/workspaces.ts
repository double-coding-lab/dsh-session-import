/**
 * Workspace membership.
 *
 * DSH's sidebar groups sessions by the workspace registry at
 * `<DSH_HOME>/storages/workspace.json`, not by the session's own `cwd`:
 * a session that is absent from every workspace's `sessionIds` shows up under
 * 「未分组」. Writing the session log alone therefore lands the import in the
 * wrong place, so every import also attaches the new session to the workspace
 * whose `path` matches the session `cwd`.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

interface WorkspaceRecord {
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
  [key: string]: unknown
}

interface WorkspaceStore {
  unit?: { name?: string; version?: number }
  global?: Record<string, unknown>
  tables?: { workspaces?: Record<string, WorkspaceRecord> }
  [key: string]: unknown
}

export interface AttachOutcome {
  attached: boolean
  workspacePath?: string
  /** True when the workspace had to be created because no path matched. */
  created?: boolean
  reason?: string
}

function storageFile(dshHome: string): string {
  return resolve(dshHome, 'storages', 'workspace.json')
}

/** Compare two directories the way Windows does: case-insensitive, no trailing slash. */
function samePath(left: string, right: string): boolean {
  const norm = (value: string): string => value.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
  return norm(left) === norm(right)
}

async function readStore(file: string): Promise<WorkspaceStore | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as WorkspaceStore
  } catch {
    return undefined
  }
}

/** Write through a temp file so a crash cannot leave the registry truncated. */
async function writeStore(file: string, store: WorkspaceStore): Promise<void> {
  const temp = resolve(dirname(file), `.workspace.json.tmp-${process.pid}-${Date.now()}`)
  await fs.writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  await fs.rename(temp, file)
}

/** Attach `sessionId` to the workspace registered for `cwd`. */
export async function attachSessionToWorkspace(
  dshHome: string,
  sessionId: string,
  cwd: string | undefined,
): Promise<AttachOutcome> {
  if (cwd === undefined || cwd === '') return { attached: false, reason: '会话没有 cwd' }
  const file = storageFile(dshHome)
  if (!existsSync(file)) return { attached: false, reason: '没有工作区注册表' }
  const store = await readStore(file)
  const workspaces = store?.tables?.workspaces
  if (workspaces === undefined) return { attached: false, reason: '注册表结构不符' }

  const entry = Object.values(workspaces).find(record => samePath(record.path, cwd))
  const now = new Date().toISOString()

  if (entry === undefined) {
    // No workspace for the source project yet: mirror it, so the imported
    // session lands under the same name it had in the source tool. Duplicate
    // titles are fine — workspaces are addressed by id, sessions by their
    // `import-` prefixed id.
    const id = randomUUID()
    const title = basename(cwd) || cwd
    workspaces[id] = {
      path: cwd,
      title,
      sessionIds: [sessionId],
      createdAt: now,
      updatedAt: now,
    }
    const global = (store.global ?? {}) as Record<string, unknown>
    const ids = Array.isArray(global['workspaceIds']) ? (global['workspaceIds'] as unknown[]) : []
    if (!ids.includes(id)) ids.push(id)
    global['workspaceIds'] = ids
    store.global = global
    await writeStore(file, store)
    return { attached: true, workspacePath: cwd, created: true }
  }

  if (entry.sessionIds.includes(sessionId)) return { attached: true, workspacePath: entry.path }

  entry.sessionIds.push(sessionId)
  entry.updatedAt = now
  await writeStore(file, store)
  return { attached: true, workspacePath: entry.path }
}

/** Drop `sessionId` from every workspace and unregister workspaces left empty. */
export async function detachSessionFromWorkspaces(dshHome: string, sessionId: string): Promise<boolean> {
  const file = storageFile(dshHome)
  if (!existsSync(file)) return false
  const store = await readStore(file)
  const workspaces = store?.tables?.workspaces
  if (workspaces === undefined) return false

  let changed = false
  const removed: string[] = []
  for (const [id, entry] of Object.entries(workspaces)) {
    const index = entry.sessionIds.indexOf(sessionId)
    if (index < 0) continue
    entry.sessionIds.splice(index, 1)
    entry.updatedAt = new Date().toISOString()
    changed = true
    if (entry.sessionIds.length === 0) {
      // DSH's own delete() keeps the directory and session logs; mirror that
      // here so an empty import-only workspace does not linger in the sidebar.
      delete workspaces[id]
      removed.push(id)
    }
  }
  if (removed.length > 0) {
    const global = (store.global ?? {}) as Record<string, unknown>
    if (Array.isArray(global['workspaceIds'])) {
      global['workspaceIds'] = (global['workspaceIds'] as unknown[]).filter(
        value => typeof value !== 'string' || !removed.includes(value),
      )
    }
    store.global = global
  }
  if (changed) await writeStore(file, store)
  return changed
}
