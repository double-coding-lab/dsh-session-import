/**
 * Scratch directories are one-off task folders, not projects. Every provider
 * uses the same rule so the picker can put them in one 「最近任务」 bucket and
 * imports do not create workspaces for them.
 */
export function isScratchWorkspacePath(cwd?: string): boolean {
  if (cwd === undefined || cwd === '') return true
  const path = cwd.replace(/\\/g, '/')
  if (/\/\.qoderwork\/workspace\//i.test(path)) return true
  if (/\/Documents\/Qoder\/\d{4}-\d{2}-\d{2}\//i.test(path)) return true
  // Codex Desktop opens projectless chats in a dated scratch folder.
  if (/(^|\/)Documents\/Codex$/i.test(path)) return true
  if (/\/Documents\/Codex\/\d{4}-\d{2}-\d{2}\//i.test(path)) return true
  const name = path.replace(/\/+$/, '').split('/').pop() ?? ''
  return /^chat-\d+$/i.test(name)
}
