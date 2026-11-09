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
import { existsSync, promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'

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
  if (entry === undefined) return { attached: false, reason: `没有与 ${cwd} 对应的工作区` }
  if (entry.sessionIds.includes(sessionId)) return { attached: true, workspacePath: entry.path }

  entry.sessionIds.push(sessionId)
  entry.updatedAt = new Date().toISOString()
  await writeStore(file, store)
  return { attached: true, workspacePath: entry.path }
}

/** Drop `sessionId` from every workspace so a retracted import leaves no ghost row. */
export async function detachSessionFromWorkspaces(dshHome: string, sessionId: string): Promise<boolean> {
  const file = storageFile(dshHome)
  if (!existsSync(file)) return false
  const store = await readStore(file)
  const workspaces = store?.tables?.workspaces
  if (workspaces === undefined) return false

  let changed = false
  for (const entry of Object.values(workspaces)) {
    const index = entry.sessionIds.indexOf(sessionId)
    if (index < 0) continue
    entry.sessionIds.splice(index, 1)
    entry.updatedAt = new Date().toISOString()
    changed = true
  }
  if (changed) await writeStore(file, store)
  return changed
}
