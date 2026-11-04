/**
 * Build the client bundle in the shape DSH's client module loader expects:
 * a CJS factory registered on `window.__ModuleLoader__`, with bare packages
 * resolved by the host at require time.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = resolve(root, 'dist', 'client.js')
mkdirSync(dirname(outfile), { recursive: true })

/**
 * esbuild may live outside this repo (installing it here can pull unpublished
 * peer packages), so allow an explicit module path:
 *   ESBUILD_MODULE=<path to esbuild/lib/main.js> npm run build:client
 */
const esbuild = await (async () => {
  try {
    return await import('esbuild')
  } catch {
    const override = process.env.ESBUILD_MODULE
    if (override === undefined || override === '') {
      throw new Error('需要 esbuild：npm i -D esbuild，或设置 ESBUILD_MODULE 指向 esbuild/lib/main.js')
    }
    return await import(pathToFileURL(resolve(override)).href)
  }
})()

const pluginId = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).name

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.tsx'],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  sourcemap: true,
  logLevel: 'info',
  packages: 'external',
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
})
