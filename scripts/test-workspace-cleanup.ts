/**
 * Workspace cleanup self-check: detaching the last session must unregister the
 * workspace record (the directory and session logs stay), while a workspace
 * that still has another session must be left alone.
 *
 *   node scripts/test-workspace-cleanup.ts
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detachSessionFromWorkspaces } from '../src/host/workspaces.ts'

const home = await mkdtemp(join(tmpdir(), 'dsh-workspace-test-'))

try {
  await mkdir(join(home, 'storages'), { recursive: true })
  const file = join(home, 'storages', 'workspace.json')
  const records = {
    a: { path: 'E:\\projects\\only-import', title: 'only-import', sessionIds: ['import-a'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    b: { path: 'E:\\projects\\shared', title: 'shared', sessionIds: ['import-b', 'native-c'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  }
  await writeFile(file, `${JSON.stringify({
    unit: { name: 'workspace', version: 1 },
    global: { initialized: true, workspaceIds: ['a', 'b'] },
    tables: { workspaces: records },
  }, null, 2)}\n`, 'utf8')

  const changed = await detachSessionFromWorkspaces(home, 'import-a')
  if (!changed) throw new Error('detach 没有报告变更')

  let store = JSON.parse(await readFile(file, 'utf8')) as {
    global: { workspaceIds: string[] }
    tables: { workspaces: Record<string, { sessionIds: string[] }> }
  }
  if (store.tables.workspaces['a'] !== undefined) throw new Error('最后一个会话撤回后工作区 a 仍存在')
  if (store.global.workspaceIds.includes('a')) throw new Error('global.workspaceIds 仍包含 a')
  if (store.tables.workspaces['b'] === undefined) throw new Error('仍有会话的工作区 b 被误删')

  await detachSessionFromWorkspaces(home, 'import-b')
  store = JSON.parse(await readFile(file, 'utf8')) as typeof store
  if (store.tables.workspaces['b'] === undefined) throw new Error('b 还有 native-c，不应删除')
  if (store.tables.workspaces['b']?.sessionIds.includes('import-b')) throw new Error('import-b 未从 b 移除')

  console.log('✅ 工作区清理自检通过（空工作区注销，非空工作区保留）')
} finally {
  await rm(home, { recursive: true, force: true })
}
