/**
 * The gates a repository runs on the developer's machine through git hooks it
 * ships itself: a hooks directory wired with `git config core.hooksPath <dir>`.
 *
 * The Swift app of the 0.4.2 field test keeps its real pre-push gate in
 * `scripts/hooks/pre-push`, wired by one README line. Detection listed
 * `xcodebuild -version` as the verification instead, because it looked only at
 * CI, `.husky/`, and `.git/hooks/`. These hooks are the project's own answer to
 * "what must pass before this leaves the machine", so they are reported with
 * where they were found and whether this clone has them switched on.
 *
 * Nothing is executed and no hook is read beyond its name; the agent reads the
 * script. `.git/config` is read as text (never through `git`) to say whether
 * the wiring is on in this clone.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Hooks that can stop a commit, a merge, a rebase or a push. */
const GATING_HOOKS = new Set(['pre-commit', 'commit-msg', 'pre-merge-commit', 'pre-push', 'pre-rebase'])
const HOOK_FILE = /^(pre-commit|prepare-commit-msg|commit-msg|pre-merge-commit|pre-push|pre-rebase)$/

/** Directory names that hold hooks by convention, whether or not a document names them. */
const CONVENTIONAL = new Set(['.githooks', 'githooks', '.git-hooks', 'git-hooks', 'scripts/hooks', 'scripts/git-hooks', 'script/hooks', 'tools/hooks', 'hooks'])

const WIRING = /git\s+config\s+(?:--(?:local|worktree)\s+)?core\.hooksPath\s+["']?([A-Za-z0-9_.][\w./-]*)["']?/

/** Files that document or script a clone's setup. */
const SETUP_DOCS = /^(README|CONTRIBUTING|DEVELOPMENT|HACKING|AGENTS|CLAUDE|Makefile|makefile|justfile|Justfile|package\.json)(\.[\w]+)?$|^docs\/[^/]+\.(md|rst|txt)$/i

/**
 * @param {string} root
 * @param {{files: string[]}} walked
 * @returns {Promise<object[]>} [{dir, hooks, files, wiring, documentedIn, wired}]
 */
export async function detectLocalGates(root, walked) {
  const read = async (f) => { try { return await readFile(join(root, f), 'utf8') } catch { return null } }
  const files = walked.files.filter((f) => !f.startsWith('.git/') && !f.startsWith('.husky/') && !/(^|\/)node_modules\//.test(f))

  // Where each directory is documented as the hooks path.
  const documented = new Map()
  for (const f of files.filter((f) => f.split('/').length <= 2 && SETUP_DOCS.test(f)).sort()) {
    const text = await read(f)
    if (text === null) continue
    text.split(/\r?\n/).forEach((line, i) => {
      const dir = cleanDir(WIRING.exec(line)?.[1])
      if (dir && !documented.has(dir)) documented.set(dir, `${f}:${i + 1}`)
    })
  }

  const byDir = new Map()
  for (const f of files) {
    const at = f.lastIndexOf('/')
    const dir = at === -1 ? '' : f.slice(0, at)
    if (!dir || !HOOK_FILE.test(f.slice(at + 1))) continue
    if (!documented.has(dir) && !CONVENTIONAL.has(dir)) continue
    if (!byDir.has(dir)) byDir.set(dir, [])
    byDir.get(dir).push(f)
  }

  const configured = cleanDir(/^\s*hooksPath\s*=\s*(\S+)/m.exec((await read('.git/config')) || '')?.[1])
  const hasConfig = (await read('.git/config')) !== null
  const gates = []
  for (const [dir, list] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
    const names = list.map((f) => f.slice(f.lastIndexOf('/') + 1)).sort()
    if (!names.some((n) => GATING_HOOKS.has(n))) continue
    gates.push({
      dir,
      hooks: names,
      files: list.sort(),
      wiring: `git config core.hooksPath ${dir}`,
      documentedIn: documented.get(dir) ?? null,
      wired: hasConfig ? configured === dir : null,
    })
  }
  return gates
}

/** A repo-relative directory, or null for anything absolute, parent-relative or computed. */
function cleanDir(d) {
  if (typeof d !== 'string') return null
  const t = d.trim().replace(/^\.\//, '').replace(/\/+$/, '')
  if (!t || t.startsWith('/') || t.split('/').includes('..') || /[$`]/.test(t)) return null
  return t
}
