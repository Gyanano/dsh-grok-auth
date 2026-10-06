import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function resolveGrokCommand(command: string): string {
  if (process.platform !== 'win32' || command !== 'grok') return command
  const inheritedPath = Object.entries(process.env).find(([name]) => name.toLowerCase() === 'path')?.[1] ?? ''
  const directories = inheritedPath.split(';').map(directory => directory.replace(/^"|"$/g, '')).filter(Boolean)
  for (const directory of [...directories, join(homedir(), '.grok', 'bin')]) {
    const executable = join(directory, 'grok.exe')
    try {
      if (statSync(executable).isFile()) return executable
    } catch { /* Try the next installation directory. */ }
  }
  return command
}
