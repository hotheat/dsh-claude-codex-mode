/** Portable test-only lookup: explicit Cordis path first, then the global npm installation. */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { statSync } from 'node:fs'

export function dshRuntime() {
  const candidates = []
  if (process.env.DSH_CORDIS_PATH) candidates.push(resolve(process.env.DSH_CORDIS_PATH))
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 5000 }).trim()
    candidates.push(join(globalRoot, '@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'))
    candidates.push(join(globalRoot, '@deepseek-ai/cordis/lib/index.js'))
  } catch { /* An unavailable npm is reported by the caller's explicit skip. */ }
  for (let path of candidates) {
    try {
      if (statSync(path).isDirectory()) path = join(path, 'package.json')
      const require = createRequire(path)
      return { require, cordis: require.resolve('@deepseek-ai/cordis') }
    } catch { /* Try the next documented lookup. */ }
  }
}
