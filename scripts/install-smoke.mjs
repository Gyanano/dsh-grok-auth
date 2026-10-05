import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runPluginCommand } from '@deepseek-ai/dsh-plugin-manager/operations'
import { composeEntries, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'

const sourceRoot = resolve(import.meta.dirname, '..')
if (Boolean(process.env.DSH_SMOKE_NODE) !== Boolean(process.env.DSH_SMOKE_PNPM)) {
  throw new Error('Set both DSH_SMOKE_NODE and DSH_SMOKE_PNPM to select a bundled package manager')
}
const temporary = await mkdtemp(join(tmpdir(), 'dsh-grok-install-'))
try {
  const output = execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], {
    cwd: sourceRoot, encoding: 'utf8',
  })
  const packed = JSON.parse(output.slice(output.lastIndexOf('\n[') + 1))
  const artifact = join(temporary, packed[0].filename)
  const manifest = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'))
  const profileDir = join(temporary, 'profile')
  await mkdir(profileDir)
  const dependencies = Object.fromEntries(Object.entries(manifest.peerDependencies).map(([name, range]) => [
    name, name.startsWith('@deepseek-ai/dsh-') ? '0.2.0-rc.2'
      : name === '@earendil-works/pi-ai' ? '0.87.1'
      : name === '@deepseek-ai/cordis' ? '4.0.4' : range,
  ]))
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-grok-install-smoke', private: true, type: 'module', dependencies,
    dsh: { profile: { bundles: [] } },
  }))
  await writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nautoInstallPeers: true\n')
  const installAnchor = join(temporary, 'package.json')
  await writeFile(installAnchor, JSON.stringify({ name: 'dsh-install-smoke-anchor', private: true }))
  const result = await runPluginCommand({
    profile: 'smoke', dir: profileDir, installAnchor, cwd: sourceRoot, home: temporary,
  }, ['add', artifact, '--ignore-scripts', '--registry=https://registry.npmjs.org'], {
    execution: 'service', outputBytes: 16_384, idleTimeoutMs: 60_000,
    ...(process.env.DSH_SMOKE_NODE ? {
      command: process.env.DSH_SMOKE_NODE,
      args: [process.env.DSH_SMOKE_PNPM],
      ...(process.env.DSH_DESKTOP_NODE_EXECUTABLE ? {
        env: { DSH_DESKTOP_NODE_EXECUTABLE: process.env.DSH_DESKTOP_NODE_EXECUTABLE },
      } : {}),
    } : {}),
  })
  assert.equal(result.exitCode, 0, result.output)
  const installed = JSON.parse(await readFile(join(profileDir, 'node_modules/dsh-grok-auth/package.json'), 'utf8'))
  assert.equal(installed.version, manifest.version)
  const profile = loadProfileDirectory('smoke', profileDir, installAnchor)
  assert.deepEqual(profile.skippedBundles, [])
  const entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
  assert(entries.some(entry => entry.id === 'llm-grok-auth' && entry.name === 'dsh-grok-auth'))
  const host = await import(pathToFileURL(join(profileDir, 'node_modules/dsh-grok-auth/lib/index.js')).href)
  assert.equal(typeof host.apply, 'function')
  assert.equal(host.Config({}).llmEnabled, true)
  console.log(`install smoke: ${installed.name}@${installed.version} installed, selected, composed and imported on DSH 0.2.0-rc.2`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
