/** File-edit policy with explicit directory, home and environment inputs. */
import { existsSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'

const DOC_SUFFIXES = new Set(['.md', '.mdx', '.markdown', '.txt', '.canvas', '.base', '.rst'])

/** Nearest Git root; targets and .git entries need not be regular files. */
function gitRoot(start) {
  let current = start
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function isInside(parent, child) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/** Classify a path lexically, consulting only Git and bypass marker existence. */
export function classifyEdit({ raw, base, home, env = {} }) {
  if (env.CLAUDE_DIRECT_EDIT === '1' || env.DSH_DIRECT_EDIT === '1') return { verdict: 'allow' }

  const expanded = raw === '~' ? home : raw.startsWith('~/') ? resolve(home, raw.slice(2)) : raw
  if (!isAbsolute(expanded) && !base) return { verdict: 'deny', reason: 'relative-without-base' }
  const target = isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded)

  const configText = /^(?:requirements.*|constraints.*|cmakelists)\.txt$/i.test(basename(target))
  if (DOC_SUFFIXES.has(extname(target).toLowerCase()) && !configText) return { verdict: 'allow' }
  if (isInside(resolve(home, '.claude'), target)) return { verdict: 'allow' }

  const root = gitRoot(dirname(target))
  if (!root || existsSync(join(root, '.claude', 'direct-edit'))) return { verdict: 'allow' }
  return { verdict: 'deny', reason: 'repository-code', target, root }
}
