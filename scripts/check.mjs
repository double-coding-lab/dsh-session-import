/**
 * One command for everything: build both bundles, then run the structural and
 * pipeline self-tests against the committed fixture.
 *
 *   npm run check
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = resolve(root, 'fixtures', 'sample.jsonl')
const recoveryFixture = resolve(root, 'fixtures', 'no-active-leaf.jsonl')

/** Resolve esbuild: local install first, then an explicit override. */
function esbuildBin() {
  const local = resolve(root, 'node_modules', 'esbuild', 'bin', 'esbuild')
  if (existsSync(local)) return local
  const override = process.env.ESBUILD_MODULE
  if (override !== undefined && override !== '') {
    const guess = resolve(dirname(override), '..', 'bin', 'esbuild')
    if (existsSync(guess)) return guess
  }
  throw new Error('找不到 esbuild：npm i -D esbuild，或设置 ESBUILD_MODULE')
}

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const steps = []

function run(label, command, args) {
  process.stdout.write(`\n▸ ${label}\n`)
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false })
  if (result.status !== 0) {
    steps.push({ label, ok: false })
    throw new Error(`${label} 失败（退出码 ${result.status ?? 'signal'}）`)
  }
  steps.push({ label, ok: true })
}

try {
  const esbuild = esbuildBin()

  run('构建宿主 dist/index.js', process.execPath, [esbuild,
    'src/index.ts', '--bundle', '--platform=node', '--format=esm', '--target=node22',
    '--outfile=dist/index.js', '--external:@deepseek-ai/cordis', '--log-level=warning',
  ])

  const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {var module = { exports: {} }; var exports = module.exports;`
  run('构建客户端 dist/client.js', process.execPath, [esbuild,
    'src/client/index.tsx', '--bundle', '--format=cjs', '--platform=browser', '--target=es2022',
    '--jsx=automatic', '--packages=external', '--outfile=dist/client.js',
    `--banner:js=${banner}`, '--footer:js=return module.exports; } });', '--log-level=warning',
  ])

  if (!existsSync(fixture)) throw new Error(`缺少 fixture：${fixture}`)
  run('结构自检（fixture）', process.execPath, ['scripts/verify.ts', fixture])
  run('导入幂等自检（fixture）', process.execPath, ['scripts/test-importer.ts', fixture])
  run('文件链接自检', process.execPath, ['scripts/test-file-links.ts'])
  run('无 active-leaf 恢复自检', process.execPath, ['scripts/test-recovery.ts'])
  run('无 active-leaf 导入自检', process.execPath, ['scripts/test-importer.ts', recoveryFixture])
  run('增量追平自检', process.execPath, ['scripts/test-growth.ts'])
  run('rewind 分支重建自检', process.execPath, ['scripts/test-rebuild.ts'])
  run('Codex 分段导入自检', process.execPath, ['scripts/test-codex.ts'])
  run('Codex 数据库导入自检', process.execPath, ['scripts/test-codex-db.ts'])
  run('用户文件附件自检', process.execPath, ['scripts/test-attachments.ts'])
  run('工作区清理自检', process.execPath, ['scripts/test-workspace-cleanup.ts'])
  run('账本并发自检', process.execPath, ['scripts/test-state.ts'])

  console.log('\n✅ 全部通过：')
  for (const step of steps) console.log(`   · ${step.label}`)
} catch (error) {
  console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`)
  if (steps.length > 0) {
    console.error('   已完成：')
    for (const step of steps) console.error(`   · ${step.label}${step.ok ? '' : '（失败）'}`)
  }
  process.exit(1)
}
