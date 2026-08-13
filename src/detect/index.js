/**
 * Stage 0 — detect, don't ask.
 *
 * Every fact detected here is a question the interview does not have to ask,
 * and the interview has a hard 15-minute budget. That budget is the whole
 * design constraint: this module is allowed to be wrong (the human corrects a
 * pre-filled answer in one keystroke) but it is never allowed to be slow, and
 * it is never allowed to throw.
 *
 * NEVER CRASH THE CALLER. Each detector group is isolated: a missing git, an
 * unreadable directory, a malformed package.json, an absent gh CLI — each
 * degrades to `{degraded: true, reason, hint}` on its own group while every
 * other group still reports. The contract keys are always present with safe
 * defaults, so a consumer reading `report.vcs.isRepo` never gets undefined
 * even when git could not be run at all.
 *
 * The tree is walked exactly ONCE and the result is shared with the detectors
 * that need it, because two walks of a large repo is two coffee breaks.
 */

import { resolve } from 'node:path'
import { detectVcs, emptyVcs } from './vcs.js'
import { detectStack, emptyStack, walk } from './stack.js'
import { detectCommands, emptyCommands } from './commands.js'
import { detectEnvironment, emptyEnvironment } from './environment.js'

export { detectVcs, detectStack, detectCommands, detectEnvironment, walk }

/**
 * @typedef {object} DetectOptions
 * @property {number} [maxFiles]        file budget for the tree walk (default 20000)
 * @property {number} [maxDepth]        depth budget for the tree walk (default 12)
 * @property {number} [timeoutMs]       per-git-invocation timeout (default 5000)
 * @property {boolean} [xcode]          set false to skip `xcodebuild -list`
 * @property {boolean} [gh]             set false to skip the visibility lookup
 * @property {string} [gitBin]
 * @property {string} [ghBin]
 * @property {string} [xcodebuildBin]
 */

/** The full report, with every contract key present and nothing detected. */
export function emptyReport(root = '') {
  const env = emptyEnvironment()
  return {
    root: root ? resolve(root) : '',
    vcs: emptyVcs(),
    stack: emptyStack(),
    commands: emptyCommands(),
    ci: env.ci,
    hooks: env.hooks,
    agentConfig: env.agentConfig,
    deploySurface: env.deploySurface,
    secretSurface: env.secretSurface,
    visibility: env.visibility,
    warnings: [],
    elapsedMs: 0,
  }
}

/**
 * Read everything about a project that can be read without asking a human.
 *
 * Always resolves. Never rejects.
 *
 * @param {string} root
 * @param {DetectOptions} [opts]
 * @returns {Promise<object>}
 */
export async function detect(root, opts = {}) {
  const started = Date.now()
  const report = emptyReport(root)
  const warn = (...ws) => {
    for (const w of ws) if (w) report.warnings.push(w)
  }

  // vcs runs first: the visibility lookup needs the remote host to decide
  // whether asking gh is even worth the spawn.
  const vcsResult = await guard('vcs', () => detectVcs(root, opts), { vcs: emptyVcs(), warnings: [] })
  report.vcs = vcsResult.value.vcs
  warn(...vcsResult.value.warnings, vcsResult.warning)

  const walked = await guard('walk', () => walk(root, opts), {
    files: [],
    dirs: [],
    truncated: false,
    reason: null,
    unreadable: [],
    scanned: 0,
  })
  warn(walked.warning)

  // stack runs before commands: the detected package manager decides whether a
  // node script is spelled `npm run test` or `pnpm run test`, and printing the
  // wrong runner in the interview is a correction the human should not have to
  // make. It is nearly free — the walk is already done.
  const stackResult = await guard('stack', () => detectStack(root, opts, walked.value), {
    stack: emptyStack(),
    warnings: [],
  })
  report.stack = stackResult.value.stack
  warn(...stackResult.value.warnings, stackResult.warning)

  // These two touch disjoint state and can overlap; between them they hold
  // most of stage 0's wall clock (xcodebuild and gh both live here).
  const [cmdResult, envResult] = await Promise.all([
    guard('commands', () => detectCommands(root, opts, { walked: walked.value, stack: report.stack }), {
      commands: emptyCommands(),
      warnings: [],
    }),
    guard('environment', () => detectEnvironment(root, opts, { walked: walked.value, vcs: report.vcs }), {
      environment: emptyEnvironment(),
      warnings: [],
    }),
  ])

  report.commands = cmdResult.value.commands
  warn(...cmdResult.value.warnings, cmdResult.warning)

  const env = envResult.value.environment
  report.ci = env.ci
  report.hooks = env.hooks
  report.agentConfig = env.agentConfig
  report.deploySurface = env.deploySurface
  report.secretSurface = env.secretSurface
  report.visibility = env.visibility
  warn(...envResult.value.warnings, envResult.warning)

  report.elapsedMs = Date.now() - started
  return report
}

/**
 * Run one detector group. An exception escaping a detector is a bug in this
 * module, not a reason to lose the other fifteen facts — so it is caught,
 * converted to a degraded group plus a warning, and the report still ships.
 *
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} fn
 * @param {T} fallback
 * @returns {Promise<{value: T, warning: object|null}>}
 */
async function guard(name, fn, fallback) {
  try {
    return { value: await fn(), warning: null }
  } catch (err) {
    const reason = err?.message || String(err)
    const degraded = markDegraded(fallback, reason, name)
    return {
      value: degraded,
      warning: {
        code: 'detector-failed',
        message: `The ${name} detector failed: ${reason}`,
        hint: `Everything else was still detected. Answer the ${name} questions by hand.`,
      },
    }
  }
}

function markDegraded(fallback, reason, name) {
  const hint = `Answer the ${name} questions by hand; the rest of the report is unaffected.`
  if (!fallback || typeof fallback !== 'object') return fallback
  const out = { ...fallback }
  // Stamp the degradation onto the inner group object when there is one, so a
  // consumer sees it next to the (empty) facts rather than on a wrapper.
  for (const key of ['vcs', 'stack', 'commands', 'environment']) {
    if (out[key] && typeof out[key] === 'object') {
      out[key] = { ...out[key], degraded: true, reason, hint }
      return out
    }
  }
  return { ...out, degraded: true, reason, hint }
}
