/**
 * WorkBuddy keeps the user-facing title and space membership in
 * `~/.workbuddy/workbuddy.db`, not in the transcript. The transcript also has
 * no title record for automation runs, so without this lookup the picker falls
 * back to the first eight characters of the session id.
 */
import { stat } from 'node:fs/promises'

export interface WorkBuddySessionMeta {
  id: string
  title?: string
  customTitle?: string
  cwd?: string
  isPlayground: boolean
  projectId?: string
  /** Background runs sharing this id collapse to the newest row (automation). */
  backgroundGroupId?: string
}

interface CachedMeta {
  mtimeMs: number
  sessions: Map<string, WorkBuddySessionMeta>
}

const cache = new Map<string, CachedMeta>()

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

export async function loadWorkBuddyMeta(databasePath: string): Promise<Map<string, WorkBuddySessionMeta>> {
  let mtimeMs: number
  try {
    mtimeMs = (await stat(databasePath)).mtimeMs
  } catch {
    return new Map()
  }
  const cached = cache.get(databasePath)
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.sessions

  let sessions = new Map<string, WorkBuddySessionMeta>()
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const rows = db.prepare(
        'SELECT id, title, custom_title, cwd, is_playground, project_id FROM sessions WHERE deleted_at IS NULL',
      ).all() as Array<Record<string, unknown>>
      const automationByConversation = new Map<string, string>()
      try {
        const runs = db.prepare('SELECT automation_id, runs_json FROM automation_runs').all() as Array<Record<string, unknown>>
        for (const run of runs) {
          const automationId = text(run['automation_id'])
          if (automationId === undefined) continue
          let parsed: unknown
          try {
            parsed = JSON.parse(String(run['runs_json'] ?? '[]'))
          } catch {
            continue
          }
          if (!Array.isArray(parsed)) continue
          for (const item of parsed) {
            if (item === null || typeof item !== 'object') continue
            const conversationId = text((item as Record<string, unknown>)['conversationId'])
            if (conversationId !== undefined) automationByConversation.set(conversationId, automationId)
          }
        }
      } catch {
        // Older WorkBuddy versions may not have automation_runs.
      }
      for (const row of rows) {
        const id = text(row['id'])
        if (id === undefined) continue
        const title = text(row['title'])
        const customTitle = text(row['custom_title'])
        const cwd = text(row['cwd'])
        const projectId = text(row['project_id'])
        const automationId = automationByConversation.get(id)
        sessions.set(id, {
          id,
          ...(title === undefined ? {} : { title }),
          ...(customTitle === undefined ? {} : { customTitle }),
          ...(cwd === undefined ? {} : { cwd }),
          isPlayground: Number(row['is_playground'] ?? 0) === 1,
          ...(projectId === undefined ? {} : { projectId }),
          ...(automationId === undefined ? {} : { backgroundGroupId: automationId }),
        })
      }
    } finally {
      db.close()
    }
  } catch {
    sessions = new Map()
  }
  cache.set(databasePath, { mtimeMs, sessions })
  return sessions
}
