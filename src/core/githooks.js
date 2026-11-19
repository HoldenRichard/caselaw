/**
 * The one enforcement point every agent shares: git's pre-commit.
 *
 * Live hooks exist per agent tool and none of them is universal. A commit is,
 * so the staged-change gates run there too (`gate.mjs --mode staged`, exit 1
 * when a block-severity gate fires).
 *
 * `.git/hooks/pre-commit` is per-clone and never committed, so it is NOT an
 * artifact in the manifest: `check` in CI would call it missing on every fresh
 * clone. It is written at install and upgrade, found again by its marker line,
 * and removed by eject only while it is still byte-for-byte what we wrote.
 *
 * Never clobber. A hook that is not ours, or a hooks framework (husky,
 * lefthook, pre-commit, core.hooksPath), owns its own wiring; we print the
 * exact line to add and `doctor` reports it unwired until it is there.
 */

import { readFile, writeFile, mkdir, chmod, rm, stat, realpath } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'

export const HOOK_MARKER = '# caselaw-managed pre-commit hook'
export const HOOK_LINE = 'node .caselaw/bin/gate.mjs --mode staged'
const RUNNER_MARK = '.caselaw/bin/gate.mjs'

/** The hook we write: quiet when nothing fired, the whole report when something did. */
export function hookScript() {
  return [
    '#!/bin/sh',
    HOOK_MARKER,
    '# Runs the staged-change gates. Gates live in .caselaw/gates.json; `caselaw eject` removes this file.',
    'root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0',
    'runner="$root/.caselaw/bin/gate.mjs"',
    'if [ ! -f "$runner" ]; then echo "caselaw: gate runner not found at $runner; nothing was checked. Run caselaw doctor." >&2; exit 0; fi',
    'if ! command -v node >/dev/null 2>&1; then echo "caselaw: node is not on PATH; nothing was checked." >&2; exit 0; fi',
    'out=$(node "$runner" --mode staged --root "$root" 2>&1); code=$?',
    'if [ "$code" -ne 0 ] || ! printf \'%s\\n\' "$out" | grep -Eq \'^0 fires .* 0 degraded\'; then printf \'%s\\n\' "$out" >&2; fi',
    'exit "$code"',
    '',
  ].join('\n')
}

function git(root, args) {
  return new Promise((done) => {
    execFile('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5000 }, (err, stdout) => done({ ok: !err, stdout: String(stdout ?? '').trim() }))
  })
}

const read = async (p) => { try { return await readFile(p, 'utf8') } catch { return null } }
const exists = async (p) => { try { await stat(p); return true } catch { return false } }

const LEFTHOOK = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', 'lefthook.toml']
const PRE_COMMIT = ['.pre-commit-config.yaml', '.pre-commit-config.yml']

/** The snippet to add to each framework, naming the line that runs the gates. */
function noticeFor(framework, file) {
  const line = HOOK_LINE
  switch (framework) {
    case 'lefthook':
      return `Add to ${file}:\n    pre-commit:\n      commands:\n        caselaw:\n          run: ${line}`
    case 'pre-commit':
      return `Add under repos: in ${file}:\n    - repo: local\n      hooks:\n        - id: caselaw\n          name: caselaw gates\n          entry: ${line}\n          language: system\n          pass_filenames: false\n          always_run: true`
    default:
      return `Add this line to ${file}:\n    ${line}`
  }
}

/**
 * What stands at the pre-commit seam.
 *
 * state: 'no-git' | 'nested' | 'absent' | 'ours' | 'foreign' | 'framework'
 * wired: whether a commit will run our gates
 * notice: what to add by hand, when we may not write it
 *
 * @returns {Promise<{state: string, wired: boolean, path: string|null, framework: string|null, notice: string|null}>}
 */
export async function inspectPreCommit(root) {
  const none = (state, extra = {}) => ({ state, wired: false, path: null, framework: null, notice: null, ...extra })
  const top = await git(root, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return none('no-git')
  const [here, base] = [await realRoot(root), await realRoot(top.stdout)]
  if (here !== base) {
    const sub = relative(base, here).split('\\').join('/')
    return none('nested', { notice: `This install is in ${sub || 'a subdirectory'}, below the git root, so no pre-commit hook is written for it. Add this line to the repository's pre-commit hook:\n    (cd ${sub} && ${HOOK_LINE})` })
  }

  // A hooks framework owns the seam. Its own file is where the line belongs.
  const hooksPath = await git(root, ['config', '--get', 'core.hooksPath'])
  const frameworks = []
  if (await exists(join(root, '.husky'))) frameworks.push({ framework: 'husky', file: '.husky/pre-commit' })
  for (const f of LEFTHOOK) if (await exists(join(root, f))) { frameworks.push({ framework: 'lefthook', file: f }); break }
  for (const f of PRE_COMMIT) if (await exists(join(root, f))) { frameworks.push({ framework: 'pre-commit', file: f }); break }
  if (hooksPath.ok && hooksPath.stdout && !frameworks.length) {
    const dir = hooksPath.stdout.replace(/\/+$/, '')
    // Husky 9 points core.hooksPath at .husky/_ and keeps the scripts one level up.
    frameworks.push({ framework: 'core.hooksPath', file: `${/^\.husky\/_$/.test(dir) ? '.husky' : dir}/pre-commit` })
  }
  if (frameworks.length) {
    for (const f of frameworks) {
      if ((await read(join(root, f.file)))?.includes(RUNNER_MARK)) return { state: 'framework', wired: true, path: f.file, framework: f.framework, notice: null }
    }
    const f = frameworks[0]
    return { state: 'framework', wired: false, path: f.file, framework: f.framework, notice: noticeFor(f.framework, f.file) }
  }

  const hooks = await git(root, ['rev-parse', '--git-path', 'hooks'])
  const dir = hooks.ok && hooks.stdout ? (isAbsolute(hooks.stdout) ? hooks.stdout : resolve(root, hooks.stdout)) : join(root, '.git/hooks')
  const path = join(dir, 'pre-commit')
  const text = await read(path)
  if (text === null) return { state: 'absent', wired: false, path, framework: null, notice: null }
  if (text.includes(HOOK_MARKER)) return { state: 'ours', wired: true, path, framework: null, notice: null }
  if (text.includes(RUNNER_MARK)) return { state: 'foreign', wired: true, path, framework: null, notice: null }
  return { state: 'foreign', wired: false, path, framework: null, notice: noticeFor('hook', relative(root, path) || path) }
}

async function realRoot(p) {
  try { return await realpath(p) } catch { return resolve(p) }
}

export const BLOCK_BEGIN = '# >>> caselaw gates (`caselaw eject` removes this block)'
export const BLOCK_END = '# <<< caselaw gates'

/**
 * The block added to a shell hook a framework owns (husky, a core.hooksPath
 * directory). It runs first, right under the shebang, so an `exec` or `exit`
 * later in the user's hook cannot skip it, and it only ever exits on a block.
 */
export function hookBlock() {
  return [
    BLOCK_BEGIN,
    'caselaw_root=$(git rev-parse --show-toplevel 2>/dev/null)',
    'if [ -n "$caselaw_root" ] && [ -f "$caselaw_root/.caselaw/bin/gate.mjs" ] && command -v node >/dev/null 2>&1; then',
    '  caselaw_out=$(node "$caselaw_root/.caselaw/bin/gate.mjs" --mode staged --root "$caselaw_root" 2>&1); caselaw_code=$?',
    '  if [ "$caselaw_code" -ne 0 ] || ! printf \'%s\\n\' "$caselaw_out" | grep -Eq \'^0 fires .* 0 degraded\'; then printf \'%s\\n\' "$caselaw_out" >&2; fi',
    '  [ "$caselaw_code" -eq 0 ] || exit "$caselaw_code"',
    'fi',
    BLOCK_END,
  ].join('\n')
}

/** Shell-script frameworks take a marked block; YAML ones (lefthook, pre-commit) are printed, never edited. */
const SHELL_FRAMEWORKS = new Set(['husky', 'core.hooksPath'])

function withBlock(text) {
  if (text === null || !text.trim()) return `#!/bin/sh\n${hookBlock()}\n`
  const lines = text.split('\n')
  const at = lines[0].startsWith('#!') ? 1 : 0
  lines.splice(at, 0, hookBlock())
  return lines.join('\n')
}

/** Text with our block removed; null when only a shebang would remain (the file was ours alone). */
export function withoutBlock(text) {
  const re = new RegExp(`${BLOCK_BEGIN.replace(/[.*+?^${}()|[\]\\`]/g, '\\$&')}[\\s\\S]*?${BLOCK_END}\\n?`)
  const out = text.replace(re, '')
  return /^(#![^\n]*\n?)?\s*$/.test(out) ? null : out
}

/**
 * Write our hook where nothing stands; add a marked block to a husky or
 * core.hooksPath hook (the init plan names it before anything is written).
 * A YAML framework or a foreign .git/hooks file is reported, never touched.
 */
export async function installPreCommit(root) {
  const st = await inspectPreCommit(root)
  if (st.state === 'framework' && !st.wired && SHELL_FRAMEWORKS.has(st.framework)) {
    const abs = join(root, st.path)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, withBlock(await read(abs)), 'utf8')
    await chmod(abs, 0o755)
    return { ...st, wired: true, installed: true, notice: null }
  }
  if (st.state !== 'absent') return { ...st, installed: false }
  await mkdir(join(st.path, '..'), { recursive: true })
  await writeFile(st.path, hookScript(), 'utf8')
  await chmod(st.path, 0o755)
  return { ...st, state: 'ours', wired: true, installed: true }
}

/**
 * The hook eject may remove: ours, and unedited. A marked hook someone has
 * since edited stays, and is reported, like any other file they made theirs.
 *
 * @returns {Promise<null | {path: string, action: 'delete'|'keep', reason?: string}>}
 */
export async function ejectableHook(root) {
  const hooks = await git(root, ['rev-parse', '--git-path', 'hooks'])
  if (!hooks.ok || !hooks.stdout) return null
  const path = join(isAbsolute(hooks.stdout) ? hooks.stdout : resolve(root, hooks.stdout), 'pre-commit')
  const text = await read(path)
  if (text === null || !text.includes(HOOK_MARKER)) return null
  return text === hookScript() ? { path, action: 'delete' } : { path, action: 'keep', reason: 'you edited it' }
}

/** A framework hook holding our block: eject strips the block (and deletes a file left with only a shebang). */
export async function ejectableBlock(root) {
  const hooksPath = await git(root, ['config', '--get', 'core.hooksPath'])
  const dirs = ['.husky', hooksPath.ok && hooksPath.stdout ? hooksPath.stdout.replace(/\/+$/, '').replace(/^\.husky\/_$/, '.husky') : null].filter(Boolean)
  for (const dir of [...new Set(dirs)]) {
    const abs = join(root, dir, 'pre-commit')
    const text = await read(abs)
    if (text?.includes(BLOCK_BEGIN)) return { path: abs, next: withoutBlock(text) }
  }
  return null
}

export async function stripBlock({ path, next }) {
  if (next === null) await rm(path, { force: true })
  else await writeFile(path, next, 'utf8')
}

export async function removeHook(path) {
  await rm(path, { force: true })
}
