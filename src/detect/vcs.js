/**
 * Git facts — read-only, and never fatal.
 *
 * Stage 0 runs against whatever the human happens to have: a fresh `git init`
 * with no commits, a detached HEAD mid-bisect, a clone with no remote, a
 * directory that is not a repo at all, or a machine with no git installed.
 * Every one of those has been hit in the wild and none of them may take the
 * interview down. A missing fact costs one extra question; an exception costs
 * the whole session.
 *
 * Nothing here writes to the repo. GIT_OPTIONAL_LOCKS=0 is set because
 * `git status` will otherwise refresh — and briefly lock — the index of a repo
 * the human may be actively working in, which is a rude thing for a read-only
 * inspection to do.
 *
 * `run()` lives in this file rather than its own because git is by far its
 * heaviest user and the module plan for src/detect/ is fixed at four files.
 */

import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { run, DEFAULT_TIMEOUT_MS } from './exec.js'

/** A repo with 40k dirty paths is a fact, not a list worth carrying around. */
const MAX_DIRTY_PATHS = 200

/** The shape returned when we know nothing. Every key in the contract is present. */
export function emptyVcs() {
  return {
    isRepo: false,
    branch: null,
    remoteHost: null,
    remoteUrl: null,
    dirty: false,
    dirtyPaths: [],
    authors90d: null,
    headSha: null,
    // Extras beyond the contract, all cheap and all things the interview
    // would otherwise have to ask about.
    detached: false,
    commits90d: null,
    dirtyCount: 0,
    repoRoot: null,
  }
}

/**
 * @param {string} root
 * @param {{gitBin?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<{vcs: object, warnings: object[]}>}
 */
export async function detectVcs(root, opts = {}) {
  const gitBin = opts.gitBin || 'git'
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const warnings = []
  const vcs = emptyVcs()

  const git = (...args) => run(gitBin, ['--no-pager', ...args], { cwd: root, timeoutMs })

  const inside = await git('rev-parse', '--is-inside-work-tree')
  if (!inside.ok) {
    if (inside.code === null) {
      // git never ran. We do not know whether this is a repo — say so rather
      // than reporting isRepo:false, which would be an assertion we cannot make.
      warnings.push({
        code: 'git-unavailable',
        message: `Could not run git: ${inside.reason}`,
        hint: 'Install git, or answer the repository questions by hand.',
      })
      return {
        vcs: {
          ...vcs,
          degraded: true,
          reason: inside.reason,
          hint: 'Install git so the interview can pre-fill branch, remote and author facts.',
        },
        warnings,
      }
    }
    // git answered: not a repository. That is a fact, not a failure.
    return { vcs, warnings }
  }
  // Inside a bare repo or a .git directory this prints "false".
  if (inside.stdout.trim() !== 'true') return { vcs, warnings }

  vcs.isRepo = true

  const [top, branchRes, symRes, remotes, status, shortlog, head] = await Promise.all([
    git('rev-parse', '--show-toplevel'),
    git('rev-parse', '--abbrev-ref', 'HEAD'),
    git('symbolic-ref', '--short', 'HEAD'),
    git('remote', 'get-url', 'origin'),
    git('status', '--porcelain'),
    // A revision MUST be passed: given none, git shortlog reads stdin and a
    // never-written pipe would hang the interview forever.
    git('shortlog', '-sne', '--since=90.days', 'HEAD'),
    git('rev-parse', 'HEAD'),
  ])

  if (top.ok) {
    vcs.repoRoot = top.stdout.trim()
    if (!(await samePath(vcs.repoRoot, root))) {
      warnings.push({
        code: 'nested-repo',
        message: `${resolve(root)} is not the root of its repository — ${vcs.repoRoot} is.`,
        hint: 'Governance installed here will only cover a subtree. Confirm this is the project you meant.',
      })
    }
  }

  // --abbrev-ref prints the literal "HEAD" when detached and fails outright in
  // a repo with no commits; symbolic-ref answers correctly in the zero-commit
  // case, which is exactly what a fresh `git init` looks like.
  const abbrev = branchRes.ok ? branchRes.stdout.trim() : ''
  if (abbrev && abbrev !== 'HEAD') {
    vcs.branch = abbrev
  } else if (symRes.ok && symRes.stdout.trim()) {
    vcs.branch = symRes.stdout.trim()
  } else {
    vcs.detached = abbrev === 'HEAD'
  }

  let remoteUrl = remotes.ok ? remotes.stdout.trim() : ''
  if (!remoteUrl) {
    // No `origin` does not mean no remote — a fork workflow often names it
    // `upstream`. Take the first one rather than reporting nothing.
    const list = await git('remote')
    const first = list.ok ? list.stdout.split('\n').map((l) => l.trim()).filter(Boolean)[0] : null
    if (first) {
      const url = await git('remote', 'get-url', first)
      if (url.ok) remoteUrl = url.stdout.trim()
    }
  }
  if (remoteUrl) {
    const parsed = parseRemote(remoteUrl)
    vcs.remoteHost = parsed.host
    vcs.remoteUrl = parsed.url
  }

  if (status.ok) {
    const paths = parseStatus(status.stdout)
    vcs.dirtyCount = paths.length
    vcs.dirty = paths.length > 0
    vcs.dirtyPaths = paths.slice(0, MAX_DIRTY_PATHS)
  } else {
    warnings.push({
      code: 'git-status-failed',
      message: `Could not read working-tree status: ${status.reason}`,
      hint: 'The clean/dirty precondition for gates will have to be confirmed by hand.',
    })
  }

  vcs.headSha = head.ok ? head.stdout.trim() || null : null

  if (vcs.headSha === null) {
    // A repo with no commits genuinely has zero authors in the last 90 days.
    vcs.authors90d = 0
    vcs.commits90d = 0
  } else if (shortlog.ok) {
    const lines = shortlog.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    vcs.authors90d = lines.length
    // Names and emails are deliberately parsed and discarded: this report gets
    // written into generated docs, and a governance file is no place to
    // publish a contributor's email address.
    vcs.commits90d = lines.reduce((n, l) => n + (Number.parseInt(l, 10) || 0), 0)
  }

  return { vcs, warnings }
}

/**
 * Host of a git remote, for both SSH and HTTPS spellings.
 *
 * Credentials embedded in an HTTPS remote (https://user:ghp_xxx@github.com/…)
 * are redacted here and nowhere else, because this URL is copied into the
 * generated report and a governance doc that leaks a token is worse than no
 * governance doc.
 *
 * @returns {{host: string|null, url: string|null}}
 */
export function parseRemote(raw) {
  const input = String(raw || '').trim()
  if (!input) return { host: null, url: null }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input)) {
    try {
      const u = new URL(input)
      const hasSecret = Boolean(u.password) || (u.username && u.username !== 'git')
      if (hasSecret) {
        const port = u.port ? `:${u.port}` : ''
        return { host: u.hostname || null, url: `${u.protocol}//***@${u.hostname}${port}${u.pathname}` }
      }
      return { host: u.hostname || null, url: input }
    } catch {
      return { host: null, url: input }
    }
  }

  // scp-like: [user@]host:path — the form `git remote add` writes by default.
  // The host must look like a host, otherwise a Windows path (C:\src\repo)
  // parses as a machine called "C".
  const scp = /^(?:([^@/\\]+)@)?([^:/\\@]+):(?!\/)(.+)$/.exec(input)
  if (scp && scp[2].length > 1) return { host: scp[2], url: input }

  return { host: null, url: input }
}

function parseStatus(stdout) {
  const paths = []
  for (const raw of stdout.split('\n')) {
    if (!raw.trim()) continue
    let p = raw.slice(3)
    const arrow = p.indexOf(' -> ')
    if (arrow !== -1) p = p.slice(arrow + 4) // a rename: the new name is the live one
    paths.push(unquote(p))
  }
  return paths
}

/** git quotes paths containing non-ASCII or control characters, C-style. */
function unquote(p) {
  if (p.length > 1 && p.startsWith('"') && p.endsWith('"')) {
    try {
      return JSON.parse(p)
    } catch {
      return p.slice(1, -1)
    }
  }
  return p
}

/** True if two paths name the same directory, resolving symlinks (/var vs /private/var). */
async function samePath(a, b) {
  try {
    return (await realpath(a)) === (await realpath(b))
  } catch {
    return resolve(a) === resolve(b)
  }
}
