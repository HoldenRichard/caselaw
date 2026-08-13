/**
 * Running external tools, safely.
 *
 * Extracted from vcs.js once commands.js and environment.js both needed it:
 * a helper three modules import does not belong inside one of them.
 *
 * Everything here exists to guarantee that detection can never hang the
 * interview or throw out of a detector.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pExecFile = promisify(execFile)

/** Nothing detection runs is allowed to take longer than this. */
const DEFAULT_TIMEOUT_MS = 5000

/** A tool that prints more than this is malfunctioning; do not buffer it all. */
const MAX_BUFFER = 8 * 1024 * 1024

/**
 * Environment for every child process we spawn.
 * Each entry disables a way an external tool can block or mutate:
 *   GIT_OPTIONAL_LOCKS  — do not take the index lock just to read status
 *   GIT_TERMINAL_PROMPT — never stop the interview on a credential prompt
 *   *_PAGER             — a pager attached to a pipe is a hang waiting to happen
 */
const CHILD_ENV = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  GH_PAGER: 'cat',
  GH_PROMPT_DISABLED: '1',
  NO_COLOR: '1',
}

/**
 * Run an external tool and never throw.
 *
 * The distinction that matters downstream is between "the tool answered, and
 * the answer was a non-zero exit" (code is a number — e.g. git exit 128 means
 * *this is not a repo*, which is a real answer) and "the tool never ran"
 * (code is null — missing binary, bad cwd, timeout), which is ignorance and
 * must be reported as degradation rather than as a fact.
 *
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string,
 *                    code: number|null, reason: string|null, timedOut: boolean}>}
 */
export async function run(file, args, opts = {}) {
  const { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = MAX_BUFFER } = opts
  try {
    const { stdout, stderr } = await pExecFile(file, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer,
      env: CHILD_ENV,
      encoding: 'utf8',
      windowsHide: true,
    })
    return { ok: true, stdout, stderr, code: 0, reason: null, timedOut: false }
  } catch (err) {
    const timedOut = Boolean(err && err.killed)
    return {
      ok: false,
      stdout: typeof err?.stdout === 'string' ? err.stdout : '',
      stderr: typeof err?.stderr === 'string' ? err.stderr : '',
      code: typeof err?.code === 'number' ? err.code : null,
      reason: reasonFor(err, file, timedOut),
      timedOut,
    }
  }
}

function reasonFor(err, file, timedOut) {
  if (timedOut) return `${file} timed out`
  if (err?.code === 'ENOENT') return `${file} is not installed (or not on PATH)`
  if (err?.code === 'EACCES') return `${file} is not executable`
  const line = String(err?.stderr || err?.message || '').split('\n').find((l) => l.trim())
  return line ? line.trim() : `${file} failed`
}

export { DEFAULT_TIMEOUT_MS, MAX_BUFFER, CHILD_ENV }
