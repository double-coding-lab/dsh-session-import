import { useEffect, useState } from 'react'

export interface LocaleSnapshot {
  active: string
  revision: number
}

export interface LocaleFace {
  getSnapshot: () => LocaleSnapshot
  subscribe: (listener: () => void) => () => void
}

let localeFace: LocaleFace | undefined

export function bindLocale(face: LocaleFace | undefined): void {
  localeFace = face
}

export function currentLocale(): string {
  return localeFace?.getSnapshot().active ?? 'zh'
}

export function isEnglish(): boolean {
  return currentLocale().toLowerCase().startsWith('en')
}

export function useLocaleRevision(): number {
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (localeFace === undefined) return
    return localeFace.subscribe(() => setRevision(value => value + 1))
  }, [])
  return revision
}

/** Explicit bilingual pair for strings with interpolation. */
export function tx(zh: string, en: string): string {
  return isEnglish() ? en : zh
}

const EN: Record<string, string> = {
  '会话导入': 'Session Import',
  '把其他编辑器里的会话带进 DSH，导入后可直接继续对话。': 'Bring sessions from other coding tools into DSH and keep the conversation going.',
  '搜索工作区或会话': 'Search workspaces or sessions',
  '清空搜索': 'Clear search',
  '正在扫描本机会话': 'Scanning local sessions',
  '最近任务': 'Recent tasks',
  '项目': 'Project',
  '未命名会话': 'Untitled session',
  '未导入': 'Not imported',
  '已导入': 'Imported',
  '有新增内容，可重新导入': 'New content, re-import available',
  '失败': 'Failed',
  '已全部导入': 'All imported',
  '扫描中…': 'Scanning…',
  '没有匹配的会话': 'No matching sessions',
  '清除选择': 'Clear selection',
  '导出日志': 'Export log',
  '下载本次导入结果（JSON）': 'Download the latest import report (JSON)',
  '导入中…': 'Importing…',
  '导入': 'Import',
  '确认导入': 'Confirm import',
  '取消': 'Cancel',
  '撤回': 'Retract',
  '正在撤回…': 'Retracting…',
  '确认撤回': 'Confirm retraction',
  '撤回导入': 'Retract import',
  '撤回工作区': 'Retract workspace',
  '撤回应用下的导入会话': 'Retract all imports for this app',
  '该会话当前已打开，撤回后会关闭当前视图。': 'This session is open; retracting it will close the current view.',
  '其中 1 个会话当前已打开，撤回后会关闭当前视图。': 'One of these sessions is open; retracting it will close the current view.',
  '若撤回后该工作区没有其他会话，会一并移除工作区注册；磁盘目录和会话日志不会删除。': 'If this leaves the workspace empty, its registration is removed too. The folder and session logs stay on disk.',
  '若某个工作区撤回后没有其他会话，会一并移除工作区注册；磁盘目录和会话日志不会删除。': 'Any workspace left empty is unregistered too. Folders and session logs stay on disk.',
  '未知错误': 'Unknown error',
  '没有导入记录，无法撤回': 'No import record found; nothing to retract.',
  '该会话正在生成回复，请等本轮结束后再撤回': 'This session is still generating a reply. Retract it after the current turn finishes.',
  '该会话正在 DSH 中运行，请重启 DSH 后再撤回': 'This session is running in DSH. Restart DSH before retracting it.',
  'Codex 导入缺少会话 ID': 'Codex import is missing a session id.',
  '已有导入任务进行中': 'An import job is already running.',
  '导入进行中，暂不能撤回': 'An import is running; retraction is not available yet.',
  'targets 必填': 'No import targets were provided.',
  'providerId 与 sourceSessionId 必填': 'providerId and sourceSessionId are required.',
  'providerId 与 sourcePath 必填': 'providerId and sourcePath are required.',
  'sessionPersistence 不可用': 'Session persistence is not available.',
  '源会话未变化，已跳过': 'The source session is unchanged; skipped.',
  '解析后没有可导入的事件': 'No importable events were found.',
  '没有新增事件': 'No new events.',
  '源会话窗口已前移，无法增量追加；请先撤回再重新导入': 'The source window moved forward and cannot be appended safely. Retract the import and import it again.',
  '现有 DSH 会话日志已损坏，无法增量导入；请先撤回再重新导入（撤回会删除该会话，包括在 DSH 中续聊的内容）': 'The existing DSH session log is damaged and cannot be appended. Retract it and import again; retraction also deletes turns you added in DSH.',
  '新增内容不是从回合开头开始，无法安全追加；请先撤回再重新导入': 'The new content does not start at a turn boundary and cannot be appended safely. Retract the import and import it again.',
}

export function tr(key: string): string {
  if (!isEnglish()) return key
  return EN[key] ?? key
}

export function sessionsText(count: number): string {
  return isEnglish() ? `${count} session${count === 1 ? '' : 's'}` : `${count} 个会话`
}

export function workspacesText(count: number): string {
  return isEnglish() ? `${count} workspace${count === 1 ? '' : 's'}` : `${count} 个工作区`
}

export function matchesCountText(count: number): string {
  return isEnglish() ? `${count} matching session${count === 1 ? '' : 's'}` : `${count} 个匹配会话`
}

/** Host messages that include counts or a cause. */
export function serverMessage(text: string): string {
  if (!isEnglish()) return text
  const exact = EN[text]
  if (exact !== undefined) return exact
  let match = /^增量追加 (\d+) 条事件$/.exec(text)
  if (match !== null) return `Appended ${match[1]} events.`
  match = /^已按最新内容重建（(\d+) 轮 \/ (\d+) 条事件）$/.exec(text)
  if (match !== null) return `Rebuilt from the latest source (${match[1]} turns / ${match[2]} events).`
  match = /^按最新分支重建失败：(.+)$/.exec(text)
  if (match !== null) return `Rebuild from the latest branch failed: ${match[1]}`
  match = /^回读校验失败：写入 (\d+) 条，读回 (\d+) 条$/.exec(text)
  if (match !== null) return `Read-back check failed: wrote ${match[1]} events, read ${match[2]}.`
  match = /^拒绝删除非本插件创建的会话：(.+)$/.exec(text)
  if (match !== null) return `Refused to delete a session not created by this plugin: ${match[1]}`
  match = /^(\d+) 个会话撤回失败：(.+)$/.exec(text)
  if (match !== null) return `Failed to retract ${match[1]} sessions: ${match[2]}`
  return text
}
