import { EventEmitter } from 'node:events'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { spawn } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GrokAuthService } from '../src/grok-auth-service.ts'
import { resolveGrokCommand } from '../src/grok-cli.ts'

const environment = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => environment.home,
}))

describe('Windows Grok CLI discovery', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  let directory: string | undefined
  let ctx: Context | undefined

  afterEach(async () => {
    Object.defineProperty(process, 'platform', platform)
    vi.unstubAllEnvs()
    await ctx?.fiber.dispose()
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  })

  it('probes and logs in with the standard Windows executable absent from the desktop PATH', async () => {
    directory = await mkdtemp(join(tmpdir(), 'grok-cli-windows-'))
    environment.home = directory
    const executable = join(directory, '.grok', 'bin', 'grok.exe')
    await mkdir(join(directory, '.grok', 'bin'), { recursive: true })
    await writeFile(executable, 'test executable placeholder')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    vi.stubEnv('PATH', join(directory, 'empty-path'))
    const spawnImpl = vi.fn((command: string, args: readonly string[] = []) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(),
        unref: vi.fn(), kill: vi.fn(() => true),
      })
      queueMicrotask(() => {
        if (command !== executable) {
          child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
          return
        }
        child.emit('spawn')
        if (args?.[0] === '--version') {
          child.stdout.write('grok 1.0.46 (test)\r\n')
          child.emit('close', 0)
        }
      })
      return child as unknown as ReturnType<typeof spawn>
    })
    ctx = new Context()
    const service = new GrokAuthService(ctx, {
      authJsonPath: join(directory, '.grok', 'auth.json'),
      grokCommand: 'grok', credentialRef: credentialRef('GROK_OAUTH_TOKEN'), spawnImpl: spawnImpl as unknown as typeof spawn,
    })
    await vi.waitFor(() => expect(service.available).toBe(true), { timeout: 500 })
    expect((await service.status()).grokVersion).toBe('grok 1.0.46 (test)')
    await expect(service.login('browser')).resolves.toEqual({ started: true })
    expect(spawnImpl.mock.calls.map(([command, args]) => [command, args])).toEqual([
      [executable, ['--version']], [executable, ['login', '--oauth']],
    ])
  })

  it('preserves an explicitly configured command on either platform', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    expect(resolveGrokCommand('D:\\Tools\\grok.exe')).toBe('D:\\Tools\\grok.exe')
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    expect(resolveGrokCommand('grok')).toBe('grok')
  })

  it.runIf(platform.value === 'win32')('starts a real Windows executable outside PATH', async () => {
    directory = await mkdtemp(join(tmpdir(), 'grok-cli-native-'))
    environment.home = directory
    const executable = join(directory, '.grok', 'bin', 'grok.exe')
    await mkdir(join(directory, '.grok', 'bin'), { recursive: true })
    await copyFile(process.execPath, executable)
    vi.stubEnv('PATH', join(directory, 'empty-path'))
    ctx = new Context()
    const service = new GrokAuthService(ctx, {
      authJsonPath: join(directory, '.grok', 'auth.json'),
      grokCommand: 'grok', credentialRef: credentialRef('GROK_OAUTH_TOKEN'),
    })
    await vi.waitFor(() => expect(service.available).toBe(true), { timeout: 4000 })
    expect((await service.status()).grokVersion).toBe(process.version)
  })
})
