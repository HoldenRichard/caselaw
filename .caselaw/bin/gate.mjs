/**
 * The gate runner — the thing that actually executes a project's gates.
 *
 * This file is VENDORED into the target project. It is one file, zero
 * dependencies, `node:` builtins only, and it must keep working after the
 * harness package is uninstalled. Nothing here may import from `src/`.
 *
 * WHY IT EXISTS IN THIS SHAPE
 *
 * The failure this project is built to avoid is the *decorative guardrail*: a
 * generated file that looks like a policy, is committed, is trusted, and is
 * read by nothing. A gate does not exist because it is written down. It exists
 * because a known-bad input has been observed reaching it and being refused.
 * Every kind below therefore has a test named
 * `POSITIVE CONTROL: <kind> blocks <specific bad thing>`, and a kind with no
 * such test is not considered implemented.
 *
 * THE SECOND FAILURE — the one that kills the first — is a gate that breaks the
 * workflow. A hook that throws on malformed stdin, or exits non-zero because
 * `yaml` is not installed, gets deleted within a day, and then nothing is
 * enforced at all. So the rules here are absolute:
 *
 *   1. The tool's own failure NEVER blocks. Bad stdin, unreadable config, a
 *      malformed glob, a missing binary, an internal throw: report, exit 0.
 *   2. "Could not run" is never reported as "found nothing". A check that could
 *      not run comes back `{degraded: true, reason, hint}` and is printed in a
 *      separate section in every mode. This is the same distinction `run()` in
 *      src/detect/exec.js draws between "the tool answered non-zero" and "the
 *      tool never ran", for the same reason.
 *   3. Only `severity: "block"` can fail a run. New gates start as `warn` and
 *      earn `block` from the fire log.
 *
 * TRUST NOTE. The `shell` kind executes what `.caselaw/gates.json` says. That
 * file is repo content and an agent can write it, so it is trusted AS CODE and
 * belongs in review like code. Everything else here treats config as data:
 * globs and patterns are compiled, never evaluated, and every child process is
 * `execFile` with an argument array — never a shell string.
 */

import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// Limits. Every one of these exists so a large repo cannot hang a PreToolUse
// hook, which fires on every single edit an agent makes.
// ---------------------------------------------------------------------------

/** Files above this are skipped and REPORTED as skipped, never silently passed. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024
/** A NUL in this many leading bytes means binary; scanning it is meaningless. */
const BINARY_SNIFF_BYTES = 8192
/** Walking a monorepo must terminate. Exceeding this degrades the whole run. */
const MAX_TREE_FILES = 20_000
/** One pattern hitting thousands of times is a config bug, not a thousand bugs. */
const MAX_MATCHES_PER_FILE = 200
/** Brace expansion is combinatorial; refuse rather than allocate. */
const BRACE_LIMIT = 512
/** git is only ever asked cheap questions. */
const GIT_TIMEOUT_MS = 5_000
const DEFAULT_SHELL_TIMEOUT_MS = 30_000
/** Paths handed to one `shell` invocation before it is split into chunks. */
const DEFAULT_MAX_PATHS = 500
/** A hook that blocks on stdin forever is worse than a hook that misses a gate. */
const STDIN_TIMEOUT_MS = 2_000
const MAX_STDIN_BYTES = 8 * 1024 * 1024
/** Characters either side of a match searched for a grandfather `context`. */
const GRANDFATHER_WINDOW = 160

export const MODES = ['pre', 'post', 'staged', 'all']

export const KINDS = [
  'banned-content',
  'required-content',
  'cross-file',
  'file-invariant',
  'path-scope',
  'paired-edit',
  'shell',
]

/**
 * Which modes each kind can honestly run in.
 *
 * A gate's own `modes` may NARROW this and may never widen it. Widening would
 * let a config ask for, say, `file-invariant` in `pre` mode — where the file on
 * disk is the OLD one — and quietly produce a verdict about the wrong bytes.
 */
const KIND_MODES = {
  'banned-content': ['pre', 'post', 'staged', 'all'],
  'required-content': ['pre', 'post', 'staged', 'all'],
  'cross-file': ['post', 'staged', 'all'],
  'file-invariant': ['post', 'staged', 'all'],
  'path-scope': ['pre', 'post', 'staged'],
  'paired-edit': ['post', 'staged'],
  shell: ['post', 'staged', 'all'],
}

/** Exit codes, in one place, because three callers depend on them. */
export const EXIT = { OK: 0, FAILED: 1, PRE_BLOCK: 2 }

const CHILD_ENV = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  NO_COLOR: '1',
}

const BOM = '﻿'
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// ===========================================================================
// Glob matching
// ===========================================================================

/**
 * Supported: `**`, `*`, `?`, and brace alternation `{a,b}`.
 *
 * Deliberately minimatch-compatible on the one point people get bitten by:
 * `*.md` does NOT match `docs/a.md`. A glob is anchored at the repo root and
 * `*` never crosses a `/`. Write `**\/*.md` if that is what you meant. The
 * alternative — gitignore's implicit "match at any depth" — makes `exclude`
 * silently much wider than it reads, and an over-wide exclude is an unnoticed
 * hole in a gate.
 *
 * Matching is case-SENSITIVE regardless of the filesystem, so a gate behaves
 * the same on a developer's macOS laptop and in Linux CI.
 */

/** @type {Map<string, {ok: true, regexes: RegExp[]} | {ok: false, reason: string}>} */
const globCache = new Map()

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Split `a,b` on commas that are not inside a nested brace group. */
function splitTopLevel(body) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of body) {
    if (ch === '{') depth++
    else if (ch === '}') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  parts.push(cur)
  return parts
}

function findBraceClose(s, open) {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}' && --depth === 0) return i
  }
  return -1
}

/** `a/{b,c}/d` -> [`a/b/d`, `a/c/d`]. Returns null if it would explode. */
function expandBraces(pattern) {
  const out = []
  const queue = [pattern]
  while (queue.length) {
    if (out.length + queue.length > BRACE_LIMIT) return null
    const p = queue.shift()
    const open = p.indexOf('{')
    const close = open === -1 ? -1 : findBraceClose(p, open)
    // An unbalanced brace is a literal brace, not an error: refusing the whole
    // glob would take out a gate over a typo in a filename.
    if (open === -1 || close === -1) {
      out.push(p)
      continue
    }
    const head = p.slice(0, open)
    const tail = p.slice(close + 1)
    for (const alt of splitTopLevel(p.slice(open + 1, close))) queue.push(head + alt + tail)
  }
  return out
}

function segmentToRe(seg) {
  let out = ''
  for (const ch of seg) {
    if (ch === '*') out += '[^/]*'
    else if (ch === '?') out += '[^/]'
    else out += escapeRe(ch)
  }
  return out
}

function oneGlobToRegex(pattern) {
  const segs = pattern.split('/')
  let src = '^'
  for (let i = 0; i < segs.length; i++) {
    const last = i === segs.length - 1
    if (segs[i] === '**') {
      if (last) {
        // Trailing `**` means "everything below this", so it requires at least
        // one character. `docs/**` covers `docs/a` and `docs/a/b`, not `docs`.
        src += '.+'
      } else {
        // `**/` must also match ZERO directories, or `docs/**\/*.md` would miss
        // `docs/a.md` — the single most common surprise in hand-rolled globs.
        src += '(?:[^/]*/)*'
        continue
      }
    } else {
      src += segmentToRe(segs[i])
    }
    if (!last) src += '/'
  }
  return new RegExp(src + '$')
}

/**
 * Compile a glob, memoized.
 * @returns {{ok: true, regexes: RegExp[]} | {ok: false, reason: string}}
 */
export function compileGlob(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { ok: false, reason: 'glob must be a non-empty string' }
  }
  const hit = globCache.get(pattern)
  if (hit) return hit
  let result
  try {
    const expanded = expandBraces(pattern)
    if (expanded === null) {
      result = { ok: false, reason: `glob "${pattern}" expands to more than ${BRACE_LIMIT} alternatives` }
    } else {
      result = { ok: true, regexes: expanded.map(oneGlobToRegex) }
    }
  } catch (err) {
    result = { ok: false, reason: `glob "${pattern}" could not be compiled: ${shortError(err)}` }
  }
  globCache.set(pattern, result)
  return result
}

/** POSIX-ify a path and drop a leading `./` so Windows and `./x` compare equal. */
export function toPosix(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * Does `path` match `pattern`?
 * A pattern that cannot be compiled matches NOTHING and returns false — callers
 * that need to know a glob was bad ask `compileGlob` directly, which is what
 * gate evaluation does so it can degrade instead of silently under-matching.
 */
export function matchGlob(pattern, path) {
  const compiled = compileGlob(pattern)
  if (!compiled.ok) return false
  const p = toPosix(path)
  return compiled.regexes.some((re) => re.test(p))
}

export function matchAny(patterns, path) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false
  return patterns.some((g) => matchGlob(g, path))
}

// ===========================================================================
// Small utilities
// ===========================================================================

function shortError(err) {
  const m = String(err?.message ?? err ?? 'unknown error')
  return m.split('\n')[0].slice(0, 200)
}

function str(v) {
  return typeof v === 'string' ? v.trim() : ''
}

function stripBom(text) {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text
}

/** 1-based line number of a character offset. */
function lineAt(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/** A short, single-line excerpt safe to print in a terminal report. */
function excerpt(s, max = 80) {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function uniq(arr) {
  return [...new Set(arr)]
}

/**
 * Run an external tool and never throw.
 *
 * `ran: false` means the tool never answered — missing binary, bad cwd, killed
 * on timeout. That is IGNORANCE and must degrade. `ran: true` with a non-zero
 * `code` is an ANSWER and may fire. Conflating the two turns "eslint is not
 * installed" into "your code is broken", which is how a gate loses its
 * credibility in one afternoon.
 */
function runTool(file, args, { cwd, timeoutMs = GIT_TIMEOUT_MS, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolvePromise) => {
    let child
    const done = (r) =>
      resolvePromise({ ran: false, code: null, stdout: '', stderr: '', reason: null, timedOut: false, ...r })
    try {
      child = execFile(
        file,
        args,
        { cwd, timeout: timeoutMs, maxBuffer, env: CHILD_ENV, encoding: 'utf8', windowsHide: true },
        (err, stdout, stderr) => {
          if (!err) return done({ ran: true, code: 0, stdout, stderr })
          const timedOut = Boolean(err.killed) || err.signal === 'SIGTERM'
          if (timedOut) {
            return done({
              stdout: stdout ?? '',
              stderr: stderr ?? '',
              reason: `${file} timed out after ${timeoutMs}ms`,
              timedOut: true,
            })
          }
          if (typeof err.code === 'number') {
            return done({ ran: true, code: err.code, stdout: stdout ?? '', stderr: stderr ?? '' })
          }
          done({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            reason:
              err.code === 'ENOENT'
                ? `${file} is not installed (or not on PATH)`
                : err.code === 'EACCES'
                  ? `${file} is not executable`
                  : `${file} could not be run (${err.code ?? shortError(err)})`,
          })
        },
      )
    } catch (err) {
      return done({ reason: `${file} could not be spawned (${err?.code ?? shortError(err)})` })
    }
    child.on('error', () => {}) // the callback already reports it; this stops an uncaught throw
  })
}

// ===========================================================================
// Config
// ===========================================================================

export const DEFAULT_CONFIG_PATH = '.caselaw/gates.json'

/**
 * Read and validate `.caselaw/gates.json`.
 *
 * Never throws, and never refuses wholesale over one bad entry. Three tiers of
 * config problem, chosen so that a mistake costs you the smallest possible
 * amount of enforcement:
 *
 *   dropped   the gate CANNOT run (no id, unknown kind, `command` with a space).
 *             Reported loudly. The other gates still run — one broken gate must
 *             not disable the other nine.
 *   defaulted a missing `severity` becomes `warn`, because a new gate is
 *             supposed to start as `warn` anyway.
 *   problem   the gate RUNS but the config is wrong — most importantly a
 *             missing `origin`. `origin` is required by the schema (it is what
 *             lets an audit spot a gate no rule asked for), but dropping the
 *             gate over it would trade real enforcement for a bookkeeping
 *             error. So it runs, and the problem is printed in every mode.
 *
 * @param {string} root
 * @param {{configPath?: string}} [opts]
 * @returns {Promise<{ok: boolean, present: boolean, degraded: boolean,
 *   reason: string|null, hint: string|null, path: string, version: number|null,
 *   gates: object[], problems: {gate: string|null, level: string, message: string}[]}>}
 */
export async function loadConfig(root, opts = {}) {
  const rel = opts.configPath ?? DEFAULT_CONFIG_PATH
  const path = isAbsolute(rel) ? rel : join(resolve(root ?? '.'), rel)
  const base = {
    ok: true,
    present: false,
    degraded: false,
    reason: null,
    hint: null,
    path: toPosix(isAbsolute(rel) ? rel : rel),
    version: null,
    gates: [],
    problems: [],
  }

  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') {
      // No config is a real answer — "this project has no gates yet" — not a
      // degradation. It is still printed, because a runner installed with zero
      // gates is precisely the decorative-guardrail state.
      return { ...base, reason: `no gate config at ${base.path}`, hint: 'promote a rule with `caselaw gate add`' }
    }
    return {
      ...base,
      ok: false,
      degraded: true,
      reason: `cannot read ${base.path} (${err?.code ?? shortError(err)})`,
      hint: 'check the file permissions; no gates ran',
    }
  }

  let parsed
  try {
    parsed = JSON.parse(stripBom(raw))
  } catch (err) {
    return {
      ...base,
      ok: false,
      present: true,
      degraded: true,
      reason: `${base.path} is not valid JSON: ${shortError(err)}`,
      hint: 'fix the JSON; until then NO gates are running',
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ...base,
      ok: false,
      present: true,
      degraded: true,
      reason: `${base.path} must be a JSON object with a "gates" array`,
      hint: 'see runtime/schema/gates.schema.json',
    }
  }
  if (!Array.isArray(parsed.gates)) {
    return {
      ...base,
      ok: false,
      present: true,
      degraded: true,
      reason: `${base.path} has no "gates" array`,
      hint: 'see runtime/schema/gates.schema.json',
    }
  }

  const { gates, problems, version } = validateGates(parsed)
  return { ...base, present: true, version, gates, problems }
}

/**
 * The gate-level half of config loading, callable without a file so an inline
 * config in a test and a real `.caselaw/gates.json` cannot diverge. Divergence
 * would mean the tests prove something production does not do — the exact
 * failure mode this whole project is aimed at.
 *
 * @param {object} parsed a parsed config document
 * @returns {{gates: object[], problems: {gate: string|null, level: string, message: string}[], version: number|null}}
 */
export function validateGates(parsed) {
  const problems = []
  const gates = []
  const seen = new Set()
  const version = Number.isFinite(parsed?.version) ? parsed.version : null

  if (version !== 1) {
    problems.push({
      gate: null,
      level: 'problem',
      // Running the understood subset beats refusing: a vendored runtime that
      // downs every gate because the config was bumped is a workflow break.
      message: `config version ${JSON.stringify(parsed?.version)} is not 1 — running the gate kinds this runtime understands`,
    })
  }

  for (const [i, g] of (Array.isArray(parsed?.gates) ? parsed.gates : []).entries()) {
    const where = `gates[${i}]`
    if (!g || typeof g !== 'object' || Array.isArray(g)) {
      problems.push({ gate: null, level: 'dropped', message: `${where} is not an object` })
      continue
    }
    const id = str(g.id)
    if (!id) {
      problems.push({ gate: null, level: 'dropped', message: `${where} has no id` })
      continue
    }
    if (!KEBAB_RE.test(id)) {
      problems.push({ gate: id, level: 'problem', message: `${where} id "${id}" is not kebab-case` })
    }
    if (seen.has(id)) {
      // Both still run — silently dropping the second would remove a check the
      // author believes exists — but the fire log keys on id, so say so.
      problems.push({ gate: id, level: 'problem', message: `duplicate gate id "${id}"; fire telemetry will conflate them` })
    }
    seen.add(id)

    const kind = str(g.kind)
    if (!KINDS.includes(kind)) {
      problems.push({
        gate: id,
        level: 'dropped',
        message: `${where} has unknown kind "${kind}" — this runtime knows: ${KINDS.join(', ')}`,
      })
      continue
    }

    let severity = str(g.severity)
    if (severity !== 'warn' && severity !== 'block') {
      problems.push({
        gate: id,
        level: 'defaulted',
        message: severity
          ? `severity "${severity}" is not warn|block; treating as warn`
          : 'no severity; treating as warn',
      })
      severity = 'warn'
    }

    if (!str(g.origin)) {
      // Reported, but the gate still RUNS. `origin` is required by the schema
      // because it is what lets an audit spot a gate no rule asked for — but
      // dropping a working gate over a bookkeeping omission trades real
      // enforcement for tidiness, and enforcement is the point.
      problems.push({
        gate: id,
        level: 'problem',
        message: 'no `origin` — nothing records which rule this gate mechanises, so an audit cannot tell if it is orphaned',
      })
    }

    if (kind === 'shell') {
      const command = str(g.command)
      if (!command) {
        problems.push({ gate: id, level: 'dropped', message: 'shell gate has no `command`' })
        continue
      }
      if (/\s/.test(command)) {
        // Caught here rather than left to ENOENT, because "command": "npm run
        // lint" fails in a way that reads like a missing binary and sends the
        // author looking in the wrong place.
        problems.push({
          gate: id,
          level: 'dropped',
          message: `shell \`command\` "${command}" contains whitespace — it is an executable, not a shell string; put arguments in \`args\``,
        })
        continue
      }
    }

    const modes = Array.isArray(g.modes) ? g.modes.filter((m) => MODES.includes(m)) : null
    if (Array.isArray(g.modes) && modes.length !== g.modes.length) {
      problems.push({ gate: id, level: 'problem', message: `\`modes\` contains values outside ${MODES.join('|')}` })
    }

    gates.push({ ...g, id, kind, severity, modes, origin: str(g.origin) || null })
  }

  return { gates, problems, version }
}

// ===========================================================================
// Result shapes
// ===========================================================================

/**
 * @typedef {object} Fire
 * @property {string} gate
 * @property {string} kind
 * @property {'warn'|'block'} severity
 * @property {string|null} path
 * @property {number|null} line
 * @property {string} label   short name of what matched or failed
 * @property {string} detail  one sentence a human can act on
 * @property {string} message the gate's own message
 * @property {string|null} origin
 */

/**
 * @typedef {object} GateResult
 * @property {string} gate
 * @property {string} kind
 * @property {'warn'|'block'} severity
 * @property {string|null} origin
 * @property {Fire[]} fires
 * @property {boolean} degraded  a check could not run — NOT the same as clean
 * @property {string|null} reason
 * @property {string|null} hint
 * @property {{reason: string, hint: string|null}[]} degradations
 * @property {boolean} skipped   not applicable in this mode, with a stated why
 * @property {string|null} skipReason
 * @property {number} filesChecked
 * @property {string[]} notes
 */

function emptyResult(gate) {
  return {
    gate: gate.id,
    kind: gate.kind,
    severity: gate.severity,
    origin: gate.origin ?? null,
    fires: [],
    degraded: false,
    reason: null,
    hint: null,
    degradations: [],
    skipped: false,
    skipReason: null,
    filesChecked: 0,
    notes: [],
  }
}

/** Record that part of this gate could not run. Additive: a gate can be half-degraded. */
function addDegradation(out, reason, hint = null) {
  out.degradations.push({ reason, hint })
  out.degraded = true
  if (out.reason === null) {
    out.reason = reason
    out.hint = hint
  }
  return out
}

function skipResult(out, reason) {
  out.skipped = true
  out.skipReason = reason
  return out
}

function makeFire(gate, { path = null, line = null, label, detail }) {
  return {
    gate: gate.id,
    kind: gate.kind,
    severity: gate.severity,
    path: path === null ? null : toPosix(path),
    line: Number.isFinite(line) ? line : null,
    label,
    detail,
    message: str(gate.message) || '',
    origin: gate.origin ?? null,
  }
}

// ===========================================================================
// Context — everything a gate is allowed to see
// ===========================================================================

/**
 * Three path sets, kept apart on purpose:
 *
 *   writes     what is being written RIGHT NOW. `path-scope` guards these.
 *   targets    what content kinds scan. In `pre` this is proposed text that is
 *              not on disk; everywhere else it is files on disk.
 *   changeSet  the whole change under consideration. `paired-edit` needs this,
 *              and when it is null that kind SKIPS with a reason rather than
 *              passing, because "I cannot see the change set" and "the pair was
 *              edited" are not the same claim.
 *
 * @param {object} opts
 * @returns {Promise<object>}
 */
export async function makeContext(opts = {}) {
  const root = resolve(opts.root ?? process.cwd())
  const mode = MODES.includes(opts.mode) ? opts.mode : 'all'
  const maxFileBytes = Number.isFinite(opts.maxFileBytes) ? opts.maxFileBytes : MAX_FILE_BYTES
  const notes = []

  /** @type {Map<string, {path: string, text: string, whole: boolean}>} */
  const overrides = new Map()
  for (const p of opts.proposed ?? []) {
    if (!p || typeof p.path !== 'string') continue
    overrides.set(toPosix(p.path), { path: toPosix(p.path), text: String(p.text ?? ''), whole: p.whole !== false })
  }

  /** @type {Map<string, object>} */
  const readCache = new Map()
  let treeCache = null

  async function readDoc(rel) {
    const key = toPosix(rel)
    if (overrides.has(key)) {
      const o = overrides.get(key)
      return { ok: true, text: o.text, whole: o.whole, source: 'proposed' }
    }
    if (readCache.has(key)) return readCache.get(key)
    const result = await readFromDisk(join(root, key), maxFileBytes)
    readCache.set(key, result)
    return result
  }

  /** Every file in the repo. git first (it honours .gitignore for free). */
  async function tree() {
    if (treeCache) return treeCache
    treeCache = await listRepoFiles(root)
    if (treeCache.degraded) notes.push(treeCache.reason)
    return treeCache
  }

  const ctx = {
    root,
    mode,
    now: opts.now instanceof Date ? opts.now : new Date(),
    maxFileBytes,
    writes: opts.writes ?? null,
    targets: opts.targets ?? null,
    changeSet: opts.changeSet ?? null,
    changeSetReason: opts.changeSetReason ?? null,
    overrides,
    notes,
    readDoc,
    tree,
  }
  return ctx
}

async function readFromDisk(abs, maxBytes) {
  let st
  try {
    st = await stat(abs)
  } catch (err) {
    return {
      ok: false,
      reason: err?.code === 'ENOENT' ? 'does not exist' : `cannot stat (${err?.code ?? shortError(err)})`,
      hint: null,
    }
  }
  if (!st.isFile()) return { ok: false, reason: 'not a regular file', hint: null }
  if (st.size > maxBytes) {
    return {
      ok: false,
      reason: `${st.size} bytes is over the ${maxBytes}-byte read cap — NOT scanned`,
      hint: 'raise maxFileBytes, or exclude this path from the gate',
    }
  }
  let buf
  try {
    buf = await readFile(abs)
  } catch (err) {
    return { ok: false, reason: `cannot read (${err?.code ?? shortError(err)})`, hint: null }
  }
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return { ok: false, reason: 'looks binary (NUL byte) — NOT scanned', hint: 'exclude binaries from this gate' }
  }
  return { ok: true, text: stripBom(buf.toString('utf8')), whole: true, source: 'disk', bytes: st.size }
}

/** Tracked + untracked-not-ignored via git; a plain walk when git cannot answer. */
async function listRepoFiles(root) {
  const r = await runTool('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  if (r.ran && r.code === 0) {
    const files = r.stdout.split('\0').filter(Boolean).map(toPosix)
    if (files.length > MAX_TREE_FILES) {
      return {
        files: files.slice(0, MAX_TREE_FILES),
        degraded: true,
        reason: `repo has ${files.length} files; only the first ${MAX_TREE_FILES} were considered`,
      }
    }
    return { files, degraded: false, reason: null }
  }
  const walked = await walkTree(root)
  return walked
}

const WALK_SKIP_DIRS = new Set(['.git', 'node_modules', '.caselaw'])

async function walkTree(root) {
  const files = []
  let truncated = false
  async function visit(dirAbs, prefix) {
    if (truncated) return
    let entries
    try {
      entries = await readdir(dirAbs, { withFileTypes: true })
    } catch {
      return // an unreadable directory is not a reason to abandon the run
    }
    for (const e of entries) {
      if (files.length >= MAX_TREE_FILES) {
        truncated = true
        return
      }
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (WALK_SKIP_DIRS.has(e.name)) continue
        await visit(join(dirAbs, e.name), rel)
      } else if (e.isFile()) {
        files.push(rel)
      }
    }
  }
  await visit(root, '')
  return {
    files,
    degraded: truncated,
    reason: truncated ? `stopped walking after ${MAX_TREE_FILES} files; the rest were NOT checked` : null,
  }
}

// ===========================================================================
// Shared gate plumbing
// ===========================================================================

/** Validate a gate's globs once, degrading on any that cannot compile. */
function gateGlobs(gate, out) {
  const take = (value, field) => {
    const list = Array.isArray(value) ? value : value == null ? [] : [value]
    const good = []
    for (const g of list) {
      const c = compileGlob(g)
      if (c.ok) good.push(g)
      // A bad glob is the quiet killer: it matches nothing, so the gate passes
      // everything and looks healthy. It has to degrade.
      else addDegradation(out, `${field}: ${c.reason}`, 'fix the glob; until then this gate matches less than you think')
    }
    return good
  }
  return { paths: take(gate.paths, '`paths`'), exclude: take(gate.exclude, '`exclude`') }
}

/** No `paths` means every candidate file. `exclude` always wins. */
function inScope(path, globs) {
  if (matchAny(globs.exclude, path)) return false
  if (globs.paths.length === 0) return true
  return matchAny(globs.paths, path)
}

/**
 * Read the files this gate applies to.
 * @returns {Promise<{skip: string|null, units: {path: string, text: string, whole: boolean}[], matched: number}>}
 */
async function selectUnits(gate, ctx, out) {
  const globs = gateGlobs(gate, out)
  if (ctx.targets === null) {
    return { skip: `no file list is available in mode "${ctx.mode}"`, units: [], matched: 0 }
  }
  const picked = uniq(ctx.targets.map(toPosix)).filter((p) => inScope(p, globs))
  const units = []
  for (const p of picked) {
    const r = await ctx.readDoc(p)
    if (!r.ok) {
      if (r.reason === 'does not exist') continue // deleted in this change set; nothing to scan
      addDegradation(out, `${p}: ${r.reason}`, r.hint)
      continue
    }
    units.push({ path: p, text: r.text, whole: r.whole !== false })
  }
  out.filesChecked = units.length
  return { skip: null, units, matched: picked.length }
}

/** Compile `{literal|regex, label}` entries; a bad regex degrades, never throws. */
function compilePatterns(list, out, field = '`patterns`') {
  const compiled = []
  const entries = Array.isArray(list) ? list : []
  if (entries.length === 0) {
    addDegradation(out, `${field} is empty — this gate checks nothing`, 'add at least one { literal | regex, label }')
    return compiled
  }
  for (const [i, p] of entries.entries()) {
    const spec = typeof p === 'string' ? { literal: p } : p
    if (!spec || typeof spec !== 'object') {
      addDegradation(out, `${field}[${i}] is not a pattern object`, null)
      continue
    }
    const label = str(spec.label) || str(spec.literal) || str(spec.regex) || `pattern ${i}`
    if (typeof spec.regex === 'string') {
      try {
        // `g` is forced on so scanning finds every occurrence; a caller-supplied
        // `g`/`y` would otherwise make lastIndex behaviour config-dependent.
        const flags = 'g' + (str(spec.flags).replace(/[^imsu]/g, '') || '')
        compiled.push({ re: new RegExp(spec.regex, flags), label, kind: 'regex' })
      } catch (err) {
        addDegradation(out, `${field}[${i}] regex is invalid: ${shortError(err)}`, 'fix the pattern; it is currently checking nothing')
      }
      continue
    }
    if (typeof spec.literal === 'string' && spec.literal.length > 0) {
      compiled.push({ re: new RegExp(escapeRe(spec.literal), 'g'), label, kind: 'literal' })
      continue
    }
    addDegradation(out, `${field}[${i}] has neither \`literal\` nor \`regex\``, null)
  }
  return compiled
}

/** Every match of a compiled pattern, capped so one bad regex cannot flood. */
function matchesOf(pattern, text, out, where) {
  const found = []
  pattern.re.lastIndex = 0
  let m
  while ((m = pattern.re.exec(text)) !== null) {
    found.push({ index: m.index, text: m[0] })
    if (m[0].length === 0) pattern.re.lastIndex++ // a zero-width match would spin
    if (found.length >= MAX_MATCHES_PER_FILE) {
      out.notes.push(`${where}: stopped after ${MAX_MATCHES_PER_FILE} matches of "${pattern.label}"`)
      break
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// Grandfathering
// ---------------------------------------------------------------------------

/**
 * A grandfather entry buys time for a known violation. It is a promise to come
 * back, so `reason` and `expires` are mandatory: an entry without them is a
 * permanent silent exemption, which is indistinguishable from deleting the gate
 * for that string. An invalid or expired entry STOPS SUPPRESSING and is
 * reported — the violation reappears, which is the whole point of the expiry.
 */
function normalizeGrandfathers(gate, now, out) {
  const entries = Array.isArray(gate.grandfather) ? gate.grandfather : []
  const live = []
  for (const [i, e] of entries.entries()) {
    const where = `grandfather[${i}]`
    if (!e || typeof e !== 'object') {
      out.notes.push(`${where} is not an object; it suppresses nothing`)
      continue
    }
    const context = str(e.context)
    const reason = str(e.reason)
    const expires = str(e.expires)
    const problems = []
    if (!context) problems.push('no `context`')
    if (!reason) problems.push('no `reason`')
    if (!expires) problems.push('no `expires`')
    const when = expires ? new Date(expires) : null
    if (expires && Number.isNaN(when?.getTime())) problems.push(`\`expires\` "${expires}" is not a date`)
    if (problems.length) {
      out.notes.push(`${where} (${excerpt(context) || 'unnamed'}) suppresses NOTHING: ${problems.join(', ')}`)
      continue
    }
    if (when.getTime() < now.getTime()) {
      out.notes.push(`${where} expired ${expires} — "${excerpt(context, 48)}" is no longer grandfathered`)
      continue
    }
    live.push({ context, reason, expires, path: str(e.path) || null, window: Number.isFinite(e.window) ? e.window : GRANDFATHER_WINDOW })
  }
  return live
}

function suppressedBy(grandfathers, text, index, matchText, path) {
  for (const g of grandfathers) {
    if (g.path && !matchGlob(g.path, path)) continue
    const from = Math.max(0, index - g.window)
    const to = Math.min(text.length, index + matchText.length + g.window)
    if (text.slice(from, to).includes(g.context)) return g
  }
  return null
}

// ---------------------------------------------------------------------------
// JSON helpers, shared by decode:"json", cross-file and file-invariant
// ---------------------------------------------------------------------------

/** RFC 6901. Returns a reason rather than throwing, so a bad pointer degrades. */
export function jsonPointer(doc, pointer) {
  if (pointer === undefined || pointer === null || pointer === '') return { ok: true, value: doc }
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) {
    return { ok: false, reason: `JSON pointer ${JSON.stringify(pointer)} must be "" or start with "/"` }
  }
  let cur = doc
  const walked = []
  for (const rawTok of pointer.slice(1).split('/')) {
    const tok = rawTok.replace(/~1/g, '/').replace(/~0/g, '~')
    walked.push(tok)
    if (cur === null || typeof cur !== 'object') {
      return { ok: false, reason: `"/${walked.join('/')}" — the parent is not an object or array` }
    }
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(tok)) return { ok: false, reason: `"/${walked.join('/')}" — "${tok}" is not an array index` }
      cur = cur[Number(tok)]
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, tok)) {
        return { ok: false, reason: `"/${walked.join('/')}" does not exist` }
      }
      cur = cur[tok]
    }
    if (cur === undefined) return { ok: false, reason: `"/${walked.join('/')}" does not exist` }
  }
  return { ok: true, value: cur }
}

/**
 * Every string a JSON document contains, DECODED, with its pointer.
 *
 * This is the whole reason `decode: "json"` exists. `"em — dash"` in a
 * .json file contains no em dash at the byte level, so a scan of the raw text
 * finds nothing and reports clean. Any escape works the same way — `/`
 * hides a slash, `A` hides an A. A content gate over JSON that does not
 * decode first is a gate with a documented bypass.
 */
function jsonStringUnits(doc) {
  const units = []
  const walk = (node, pointer) => {
    if (typeof node === 'string') {
      units.push({ at: pointer || '/', text: node })
      return
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${pointer}/${i}`))
      return
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        const esc = k.replace(/~/g, '~0').replace(/\//g, '~1')
        // Keys are scanned too: a banned string is no less banned for being a
        // property name. Marked so a report does not show two different hits at
        // the same pointer with no way to tell them apart.
        units.push({ at: `${pointer}/${esc} (key)`, text: k })
        walk(v, `${pointer}/${esc}`)
      }
    }
  }
  walk(doc, '')
  return units
}

// ===========================================================================
// Kind 1 — banned-content
// ===========================================================================

async function kindBannedContent(gate, ctx, out) {
  const patterns = compilePatterns(gate.patterns, out)
  const grandfathers = normalizeGrandfathers(gate, ctx.now, out)
  const sel = await selectUnits(gate, ctx, out)
  if (sel.skip) return skipResult(out, sel.skip)
  if (patterns.length === 0) return out

  for (const unit of sel.units) {
    /** @type {{text: string, at: string|null}[]} */
    let pieces
    if (gate.decode === 'json') {
      let doc
      try {
        doc = JSON.parse(unit.text)
      } catch (err) {
        addDegradation(
          out,
          `${unit.path}: decode:"json" was requested but the file is not valid JSON (${shortError(err)})`,
          'remove `decode` or fix the file — this file was NOT scanned',
        )
        continue
      }
      pieces = jsonStringUnits(doc)
    } else {
      pieces = [{ text: unit.text, at: null }]
    }

    for (const piece of pieces) {
      for (const p of patterns) {
        for (const m of matchesOf(p, piece.text, out, unit.path)) {
          if (suppressedBy(grandfathers, piece.text, m.index, m.text, unit.path)) continue
          const line = piece.at === null ? lineAt(unit.text, m.index) : null
          const where = piece.at === null ? '' : ` at ${piece.at}`
          out.fires.push(
            makeFire(gate, {
              path: unit.path,
              line,
              label: p.label,
              detail:
                `${p.label}${where}: ${JSON.stringify(excerpt(m.text, 60))}` +
                (unit.whole ? '' : ' (in the proposed text, not the whole file)'),
            }),
          )
        }
      }
    }
  }
  return out
}

// ===========================================================================
// Kind 2 — required-content
// ===========================================================================

async function kindRequiredContent(gate, ctx, out) {
  const patterns = compilePatterns(gate.requires ?? gate.patterns, out, '`requires`')
  const sel = await selectUnits(gate, ctx, out)
  if (sel.skip) return skipResult(out, sel.skip)
  if (patterns.length === 0) return out

  // A gate whose globs match nothing has enforced nothing, and reports clean.
  // In a whole-tree run that is exactly the decorative guardrail, so say it out
  // loud. In the change-set modes an empty match just means nothing relevant
  // changed, which is the normal case and must stay quiet.
  if (sel.matched === 0 && ctx.mode === 'all') {
    return addDegradation(
      out,
      `no file matched ${gate.paths ? JSON.stringify(gate.paths) : 'this gate'} — the requirement was never checked`,
      'fix `paths`, or delete the gate; as written it can never fire',
    )
  }

  for (const unit of sel.units) {
    // A `pre`-mode Edit gives us a FRAGMENT. "the fragment does not contain
    // **Origin:**" is true of almost every edit and says nothing about the
    // file, so requiring content of a fragment would fire constantly and the
    // hook would be switched off. Whole-file writes are checkable; fragments
    // wait for post/staged.
    if (!unit.whole) {
      out.notes.push(`${unit.path}: only a proposed fragment is visible; the requirement is checked once the write lands`)
      continue
    }
    for (const p of patterns) {
      p.re.lastIndex = 0
      if (!p.re.test(unit.text)) {
        out.fires.push(
          makeFire(gate, {
            path: unit.path,
            line: null,
            label: p.label,
            detail: `missing required content: ${p.label}`,
          }),
        )
      }
    }
  }
  return out
}

// ===========================================================================
// Kind 3 — cross-file
// ===========================================================================

/**
 * "These two files must stay in sync", declaratively.
 *
 * The most valuable kind, and the reason is social rather than technical: the
 * alternative is a bespoke check script per invariant, which nobody reviews,
 * nobody deletes when the invariant dies, and which drifts into the same
 * decorative state this whole tool exists to prevent.
 */
async function kindCrossFile(gate, ctx, out) {
  const extracts = Array.isArray(gate.extract) ? gate.extract : []
  const asserts = Array.isArray(gate.assert) ? gate.assert : []
  if (extracts.length === 0 || asserts.length === 0) {
    return addDegradation(out, 'cross-file needs both `extract` and `assert`', 'see runtime/schema/gates.schema.json')
  }

  // In the change-set modes, only run when something in scope actually moved —
  // otherwise every edit re-reads every cross-file source.
  if (ctx.mode !== 'all' && Array.isArray(gate.paths) && gate.paths.length > 0) {
    const globs = gateGlobs(gate, out)
    const touched = (ctx.changeSet ?? ctx.targets ?? []).map(toPosix)
    if (!touched.some((p) => inScope(p, globs))) {
      return skipResult(out, 'nothing in this change set matches the gate\'s `paths`')
    }
  }

  /** @type {Map<string, {values: any[], sources: string[]}>} */
  const bag = new Map()
  for (const [i, ex] of extracts.entries()) {
    const name = str(ex?.name) || `extract[${i}]`
    const got = await runExtract(ex, ctx, out, name)
    if (got === null) return out // already degraded; a partial extraction must not be asserted on
    bag.set(name, got)
  }

  for (const [i, a] of asserts.entries()) {
    const type = str(a?.type)
    const where = `assert[${i}]`
    const need = (key) => {
      const n = str(a?.[key])
      if (!n) {
        addDegradation(out, `${where} (${type || 'no type'}) has no \`${key}\``, null)
        return null
      }
      if (!bag.has(n)) {
        addDegradation(out, `${where} refers to extract "${n}", which is not defined`, `defined: ${[...bag.keys()].join(', ') || 'none'}`)
        return null
      }
      return bag.get(n)
    }

    if (type === 'unique') {
      const set = need('of')
      if (!set) continue
      const counts = new Map()
      for (const v of set.values) {
        const k = keyOf(v)
        counts.set(k, (counts.get(k) ?? 0) + 1)
      }
      for (const [k, n] of counts) {
        if (n > 1) {
          out.fires.push(
            makeFire(gate, {
              path: set.sources[0] ?? null,
              label: 'duplicate',
              detail: `${a.of}: ${JSON.stringify(k)} appears ${n} times but must be unique (from ${set.sources.join(', ')})`,
            }),
          )
        }
      }
      continue
    }

    if (type === 'set_equal' || type === 'subset') {
      const left = need('left')
      const right = left && need('right')
      if (!left || !right) continue
      const R = new Set(right.values.map(keyOf))
      const L = new Set(left.values.map(keyOf))
      const onlyLeft = [...L].filter((v) => !R.has(v))
      const onlyRight = type === 'set_equal' ? [...R].filter((v) => !L.has(v)) : []
      if (onlyLeft.length) {
        out.fires.push(
          makeFire(gate, {
            path: left.sources[0] ?? null,
            label: type === 'subset' ? 'not a subset' : 'only in left',
            detail: `${a.left} has ${onlyLeft.length} value(s) missing from ${a.right}: ${onlyLeft.slice(0, 8).map((v) => JSON.stringify(v)).join(', ')}`,
          }),
        )
      }
      if (onlyRight.length) {
        out.fires.push(
          makeFire(gate, {
            path: right.sources[0] ?? null,
            label: 'only in right',
            detail: `${a.right} has ${onlyRight.length} value(s) missing from ${a.left}: ${onlyRight.slice(0, 8).map((v) => JSON.stringify(v)).join(', ')}`,
          }),
        )
      }
      continue
    }

    if (type === 'field_agrees') {
      const left = need('left')
      const right = left && need('right')
      if (!left || !right) continue
      const key = str(a.key)
      if (!key) {
        // No join key: both sides must be single-valued, and those two values
        // must agree. This is the "version in package.json == version in the
        // README badge" case, which is most of what people actually want.
        if (left.values.length !== 1 || right.values.length !== 1) {
          addDegradation(
            out,
            `${where} has no \`key\`, so both sides must yield exactly one value (got ${left.values.length} and ${right.values.length})`,
            'add `key` to join on a field, or narrow the extract pointers',
          )
          continue
        }
        if (keyOf(left.values[0]) !== keyOf(right.values[0])) {
          out.fires.push(
            makeFire(gate, {
              path: left.sources[0] ?? null,
              label: 'disagreement',
              detail: `${a.left} is ${JSON.stringify(left.values[0])} but ${a.right} is ${JSON.stringify(right.values[0])} (${left.sources.join(', ')} vs ${right.sources.join(', ')})`,
            }),
          )
        }
        continue
      }
      const field = str(a.field)
      if (!field) {
        addDegradation(out, `${where} has \`key\` but no \`field\` to compare`, null)
        continue
      }
      const index = (side) => {
        const m = new Map()
        for (const v of side.values) if (v && typeof v === 'object') m.set(keyOf(v[key]), v)
        return m
      }
      const L = index(left)
      const R = index(right)
      for (const [k, lv] of L) {
        if (!R.has(k)) continue // set_equal is the assertion for presence; this one is about agreement
        const rv = R.get(k)
        if (keyOf(lv[field]) !== keyOf(rv[field])) {
          out.fires.push(
            makeFire(gate, {
              path: left.sources[0] ?? null,
              label: 'disagreement',
              detail: `${key}=${JSON.stringify(k)}: ${a.left}.${field} is ${JSON.stringify(lv[field])} but ${a.right}.${field} is ${JSON.stringify(rv[field])}`,
            }),
          )
        }
      }
      continue
    }

    if (type === 'count') {
      const set = need('of')
      if (!set) continue
      const n = set.values.length
      const checks = []
      if (Number.isFinite(a.equals)) checks.push([n === a.equals, `exactly ${a.equals}`])
      if (Number.isFinite(a.min)) checks.push([n >= a.min, `at least ${a.min}`])
      if (Number.isFinite(a.max)) checks.push([n <= a.max, `at most ${a.max}`])
      if (checks.length === 0) {
        addDegradation(out, `${where} (count) has none of \`equals\`, \`min\`, \`max\``, null)
        continue
      }
      for (const [pass, what] of checks) {
        if (pass) continue
        out.fires.push(
          makeFire(gate, {
            path: set.sources[0] ?? null,
            label: 'count',
            detail: `${a.of} has ${n} value(s); expected ${what} (from ${set.sources.join(', ')})`,
          }),
        )
      }
      continue
    }

    addDegradation(
      out,
      `${where} has unknown type ${JSON.stringify(type)}`,
      'known: unique, set_equal, subset, field_agrees, count',
    )
  }
  return out
}

/** Stable comparison key. Objects compare by shape, not identity. */
function keyOf(v) {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

/**
 * @returns {Promise<{values: any[], sources: string[]}|null>} null means the
 *   extraction failed and `out` has been degraded — the caller must NOT assert
 *   on a partial extraction, because a half-read list looks exactly like a
 *   violation of `set_equal`.
 */
async function runExtract(ex, ctx, out, name) {
  if (!ex || typeof ex !== 'object') {
    addDegradation(out, `extract "${name}" is not an object`, null)
    return null
  }
  const spec = str(ex.file)
  if (!spec) {
    addDegradation(out, `extract "${name}" has no \`file\``, null)
    return null
  }

  let files
  if (/[*?{]/.test(spec)) {
    const tree = await ctx.tree()
    files = tree.files.filter((f) => matchGlob(spec, f))
    if (files.length === 0) {
      addDegradation(out, `extract "${name}": no file matches ${JSON.stringify(spec)}`, 'fix the glob; nothing was extracted')
      return null
    }
  } else {
    files = [toPosix(spec)]
  }

  const values = []
  const sources = []
  for (const f of files) {
    const doc = await ctx.readDoc(f)
    if (!doc.ok) {
      addDegradation(out, `extract "${name}": ${f} ${doc.reason}`, doc.hint ?? 'the invariant was NOT checked')
      return null
    }
    sources.push(f)

    if (typeof ex.regex === 'string') {
      let re
      try {
        re = new RegExp(ex.regex, 'g' + (str(ex.flags).replace(/[^imsu]/g, '') || ''))
      } catch (err) {
        addDegradation(out, `extract "${name}": regex is invalid (${shortError(err)})`, null)
        return null
      }
      let m
      let n = 0
      while ((m = re.exec(doc.text)) !== null) {
        values.push(m[1] !== undefined ? m[1] : m[0])
        if (m[0].length === 0) re.lastIndex++
        if (++n >= MAX_MATCHES_PER_FILE) break
      }
      continue
    }

    let parsed
    try {
      parsed = JSON.parse(doc.text)
    } catch (err) {
      addDegradation(
        out,
        `extract "${name}": ${f} is not valid JSON (${shortError(err)})`,
        'use `regex` to extract from non-JSON files',
      )
      return null
    }
    const at = jsonPointer(parsed, ex.pointer ?? '')
    if (!at.ok) {
      addDegradation(out, `extract "${name}": ${f} ${at.reason}`, 'the invariant was NOT checked')
      return null
    }

    const select = str(ex.select) || null
    let items
    if (select === 'self') items = [at.value]
    else if (select === 'keys') {
      if (!at.value || typeof at.value !== 'object' || Array.isArray(at.value)) {
        addDegradation(out, `extract "${name}": select:"keys" needs an object at ${ex.pointer ?? '""'}`, null)
        return null
      }
      items = Object.keys(at.value)
    } else if (Array.isArray(at.value)) items = at.value
    else if (at.value && typeof at.value === 'object') items = Object.values(at.value)
    else items = [at.value]

    const field = str(ex.field)
    if (field) {
      for (const item of items) {
        const got = field.startsWith('/') ? jsonPointer(item, field) : { ok: item != null && typeof item === 'object' && field in item, value: item?.[field] }
        // A missing field is a real answer about that item, not a broken
        // extract: undefined joins the list so `unique`/`set_equal` can see it.
        values.push(got.ok ? got.value : undefined)
      }
    } else {
      values.push(...items)
    }
  }
  return { values, sources }
}

// ===========================================================================
// Kind 4 — file-invariant
// ===========================================================================

async function kindFileInvariant(gate, ctx, out) {
  const sel = await selectUnits(gate, ctx, out)
  if (sel.skip) return skipResult(out, sel.skip)

  const parses = str(gate.parses)
  const wantsNewline = gate.endsWithNewline === true
  const maxBytes = Number.isFinite(gate.maxBytes) ? gate.maxBytes : null
  const frontmatter = Array.isArray(gate.requiredFrontmatter) ? gate.requiredFrontmatter.map(str).filter(Boolean) : []

  if (!parses && !wantsNewline && maxBytes === null && frontmatter.length === 0) {
    return addDegradation(out, 'file-invariant asserts nothing', 'set parses / endsWithNewline / maxBytes / requiredFrontmatter')
  }

  for (const unit of sel.units) {
    if (parses === 'json') {
      try {
        JSON.parse(unit.text)
      } catch (err) {
        out.fires.push(
          makeFire(gate, { path: unit.path, label: 'invalid json', detail: `does not parse as JSON: ${shortError(err)}` }),
        )
      }
    } else if (parses === 'yaml') {
      // No YAML parser exists in `node:` builtins and this file may not add a
      // dependency. Guessing at YAML with regexes would produce confident wrong
      // verdicts on anchors, multi-line scalars and flow style, which is worse
      // than saying nothing. Degrade, loudly, once per gate.
      addDegradation(
        out,
        'yaml parsing is unavailable: the vendored runtime has no YAML parser and no dependencies',
        'use a `shell` gate (e.g. `yq`/`python -c`) for YAML, or switch the file to JSON',
      )
      break
    } else if (parses) {
      addDegradation(out, `unknown \`parses\` value ${JSON.stringify(parses)}`, 'known: json, yaml')
      break
    }

    if (wantsNewline && !unit.text.endsWith('\n')) {
      out.fires.push(
        makeFire(gate, { path: unit.path, label: 'no trailing newline', detail: 'file does not end with a newline' }),
      )
    }

    if (maxBytes !== null) {
      const bytes = Buffer.byteLength(unit.text, 'utf8')
      if (bytes > maxBytes) {
        out.fires.push(
          makeFire(gate, { path: unit.path, label: 'too large', detail: `${bytes} bytes exceeds maxBytes ${maxBytes}` }),
        )
      }
    }

    if (frontmatter.length) {
      const keys = frontmatterKeys(unit.text)
      if (keys === null) {
        out.fires.push(
          makeFire(gate, {
            path: unit.path,
            line: 1,
            label: 'no frontmatter',
            detail: `no --- frontmatter block; required keys: ${frontmatter.join(', ')}`,
          }),
        )
      } else {
        for (const k of frontmatter) {
          if (!keys.has(k) || keys.get(k) === '') {
            out.fires.push(
              makeFire(gate, {
                path: unit.path,
                line: 1,
                label: `frontmatter.${k}`,
                detail: keys.has(k) ? `frontmatter key "${k}" is empty` : `frontmatter key "${k}" is missing`,
              }),
            )
          }
        }
      }
    }
  }
  return out
}

/**
 * Top-level keys of a `---` frontmatter block.
 *
 * A key-presence SCAN, not a YAML parse — see the yaml note above. It reads
 * unindented `key: value` lines and nothing else, which is exactly the subset
 * `requiredFrontmatter` asks about. Returns null when there is no block at all.
 * @returns {Map<string,string>|null}
 */
export function frontmatterKeys(text) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return null
  const keys = new Map()
  for (const line of m[1].split(/\r?\n/)) {
    const km = /^([A-Za-z0-9_.$-]+)[ \t]*:[ \t]*(.*)$/.exec(line)
    if (km) keys.set(km[1], km[2].trim())
  }
  return keys
}

// ===========================================================================
// Kind 5 — path-scope
// ===========================================================================

/** `paths` here are the FORBIDDEN globs; `exclude` carves holes in them. */
async function kindPathScope(gate, ctx, out) {
  const globs = gateGlobs(gate, out)
  if (globs.paths.length === 0) {
    return addDegradation(out, 'path-scope has no `paths`, so it forbids nothing', 'list the globs writes are not allowed under')
  }
  if (ctx.writes === null) {
    return skipResult(out, `mode "${ctx.mode}" exposes no write set; path-scope guards writes`)
  }
  for (const w of uniq(ctx.writes.map(toPosix))) {
    if (!inScope(w, globs)) continue
    out.fires.push(
      makeFire(gate, {
        path: w,
        label: 'write out of scope',
        detail: `writes under ${JSON.stringify(globs.paths)} are not allowed`,
      }),
    )
  }
  out.filesChecked = ctx.writes.length
  return out
}

// ===========================================================================
// Kind 6 — paired-edit
// ===========================================================================

async function kindPairedEdit(gate, ctx, out) {
  const when = Array.isArray(gate.when) ? gate.when : []
  const require = Array.isArray(gate.require) ? gate.require : []
  if (when.length === 0 || require.length === 0) {
    return addDegradation(out, 'paired-edit needs both `when` and `require` globs', 'see runtime/schema/gates.schema.json')
  }
  // The load-bearing skip. With no change set we cannot tell "the pair was
  // edited" from "we cannot see what was edited", and reporting the second as
  // the first is a gate that passes for the wrong reason forever.
  if (ctx.changeSet === null) {
    return skipResult(out, ctx.changeSetReason ?? `the change set is unknown in mode "${ctx.mode}"`)
  }

  const changed = uniq(ctx.changeSet.map(toPosix))
  out.filesChecked = changed.length
  const triggers = changed.filter((p) => matchAny(when, p))
  if (triggers.length === 0) return out
  if (changed.some((p) => matchAny(require, p))) return out

  out.fires.push(
    makeFire(gate, {
      path: triggers[0],
      label: 'unpaired change',
      detail: `${triggers.slice(0, 5).join(', ')}${triggers.length > 5 ? ` (+${triggers.length - 5} more)` : ''} changed, but nothing matching ${JSON.stringify(require)} did`,
    }),
  )
  return out
}

// ===========================================================================
// Kind 7 — shell
// ===========================================================================

async function kindShell(gate, ctx, out) {
  const command = str(gate.command)
  const args = (Array.isArray(gate.args) ? gate.args : []).map((a) => String(a))
  const timeoutMs = Number.isFinite(gate.timeoutMs) ? gate.timeoutMs : DEFAULT_SHELL_TIMEOUT_MS
  const maxPaths = Number.isFinite(gate.maxPaths) ? Math.max(1, gate.maxPaths) : DEFAULT_MAX_PATHS
  const passPaths = str(gate.passPaths) || 'args'
  if (!command) return addDegradation(out, 'shell gate has no `command`', null)

  const globs = gateGlobs(gate, out)
  const source = ctx.targets ?? ctx.changeSet ?? []
  const paths = Array.isArray(gate.paths) && gate.paths.length > 0
    ? uniq(source.map(toPosix)).filter((p) => inScope(p, globs))
    : []
  if (Array.isArray(gate.paths) && gate.paths.length > 0 && paths.length === 0) {
    return skipResult(out, 'nothing in scope changed, so the command was not run')
  }
  out.filesChecked = paths.length

  const batches = passPaths === 'args' && paths.length > maxPaths ? chunk(paths, maxPaths) : [paths]
  for (const batch of batches) {
    const finalArgs = passPaths === 'args' ? [...args, ...batch] : args
    const r = await runTool(command, finalArgs, {
      cwd: gate.cwd ? join(ctx.root, str(gate.cwd)) : ctx.root,
      timeoutMs,
    })
    if (!r.ran) {
      // Not installed, not executable, timed out. Ignorance, not a verdict.
      addDegradation(out, `${r.reason}`, `install ${command}, or remove the "${gate.id}" gate`)
      return out
    }
    if (r.code !== 0) {
      const detail = excerpt(r.stderr || r.stdout, 300) || `exit ${r.code}`
      out.fires.push(
        makeFire(gate, {
          path: batch.length === 1 ? batch[0] : null,
          label: `${command} exit ${r.code}`,
          detail,
        }),
      )
    }
  }
  return out
}

// ===========================================================================
// runGate
// ===========================================================================

const KIND_FNS = {
  'banned-content': kindBannedContent,
  'required-content': kindRequiredContent,
  'cross-file': kindCrossFile,
  'file-invariant': kindFileInvariant,
  'path-scope': kindPathScope,
  'paired-edit': kindPairedEdit,
  shell: kindShell,
}

function modeSkipReason(kind, mode) {
  if (mode === 'pre') {
    if (kind === 'cross-file') return 'cross-file compares whole files on disk; the proposed write has not landed'
    if (kind === 'file-invariant') return 'file-invariant needs the finished file; pre mode sees only the proposed text'
    if (kind === 'paired-edit') return 'paired-edit needs the whole change set; pre mode sees one proposed write'
    if (kind === 'shell') return 'shell runs against files on disk; the proposed write has not landed'
  }
  if (mode === 'all') {
    if (kind === 'path-scope') return 'path-scope guards writes; mode "all" is a whole-tree scan with no writes'
    if (kind === 'paired-edit') return 'paired-edit needs a change set; mode "all" has none'
  }
  return `${kind} does not run in mode "${mode}"`
}

/**
 * Run one gate. Never throws.
 * @param {object} gate a gate that has already been through `loadConfig`
 * @param {object} ctx from `makeContext`
 * @returns {Promise<GateResult>}
 */
export async function runGate(gate, ctx) {
  const out = emptyResult(gate)
  try {
    const applicable = KIND_MODES[gate.kind]
    if (!applicable) return skipResult(out, `unknown kind "${gate.kind}"`)
    if (!applicable.includes(ctx.mode)) return skipResult(out, modeSkipReason(gate.kind, ctx.mode))
    if (Array.isArray(gate.modes) && gate.modes.length && !gate.modes.includes(ctx.mode)) {
      return skipResult(out, `this gate is limited to modes: ${gate.modes.join(', ')}`)
    }
    return await KIND_FNS[gate.kind](gate, ctx, out)
  } catch (err) {
    // The last line of defence. A gate that throws degrades; it never blocks,
    // and it never takes the other gates down with it.
    return addDegradation(
      out,
      `gate "${gate.id}" threw: ${shortError(err)}`,
      'this is a bug in the gate runner or an unhandled config shape; the gate did NOT run',
    )
  }
}

// ===========================================================================
// Telemetry
// ===========================================================================

/**
 * One JSON line per fire in `.caselaw/gate-fires.jsonl`.
 *
 * This is what makes warn -> block promotion evidence-based: you can say "this
 * gate fired 14 times in three weeks and was never a false positive" instead of
 * guessing. Gitignored and local by design.
 *
 * Writing it MUST NEVER fail the run. A read-only checkout, a CI container with
 * no write access, a full disk: all no-ops. Losing telemetry is a rounding
 * error; a hook that dies because it could not write a log file is a deleted
 * hook.
 */
export async function recordFires(root, fires, mode, enabled = true) {
  if (!enabled || !Array.isArray(fires) || fires.length === 0) return { written: 0, error: null }
  try {
    const dir = join(resolve(root), '.caselaw')
    await mkdir(dir, { recursive: true })
    const ts = new Date().toISOString()
    const lines =
      fires
        .map((f) => JSON.stringify({ ts, gate: f.gate, mode, path: f.path ?? null, severity: f.severity }))
        .join('\n') + '\n'
    await appendFile(join(dir, 'gate-fires.jsonl'), lines, 'utf8')
    return { written: fires.length, error: null }
  } catch (err) {
    return { written: 0, error: err?.code ?? shortError(err) }
  }
}

// ===========================================================================
// evaluate
// ===========================================================================

/**
 * Where each mode gets its three path sets when the caller does not supply
 * them. `undefined` means "work it out"; an explicit `null` means "this set is
 * genuinely unknown", which is what makes `paired-edit` skip instead of pass.
 */
async function deriveSets(root, mode, opts) {
  const notes = []
  const out = {}
  const given = (k) => Object.prototype.hasOwnProperty.call(opts, k) && opts[k] !== undefined
  for (const k of ['targets', 'writes', 'changeSet', 'changeSetReason']) if (given(k)) out[k] = opts[k]
  const need = (k) => !(k in out)

  if (mode === 'all') {
    if (need('targets')) {
      const tree = await listRepoFiles(root)
      out.targets = tree.files
      if (tree.degraded) notes.push(tree.reason)
    }
    if (need('writes')) out.writes = null
    if (need('changeSet')) out.changeSet = null
    if (need('changeSetReason')) out.changeSetReason = 'mode "all" scans the whole tree and has no change set'
  } else if (mode === 'staged') {
    if (need('targets') || need('writes') || need('changeSet')) {
      const staged = await stagedNames(root)
      if (staged.names === null) {
        // git could not answer. Everything degrades to "unknown" — which for
        // paired-edit and path-scope means a stated skip, not a pass.
        notes.push(`cannot list staged files (${staged.reason}); nothing was checked`)
        if (need('targets')) out.targets = []
        if (need('writes')) out.writes = null
        if (need('changeSet')) out.changeSet = null
        if (need('changeSetReason')) out.changeSetReason = `git could not list staged files (${staged.reason})`
      } else {
        if (need('targets')) out.targets = staged.names
        if (need('writes')) out.writes = staged.names
        if (need('changeSet')) out.changeSet = staged.names
      }
    }
  } else {
    // pre / post are driven by a hook payload; the caller supplies the sets.
    // If a caller supplied proposed text but no targets, check the proposed
    // paths rather than nothing. Silently scanning an empty set is the exact
    // "did not run" / "found nothing" confusion this module exists to prevent.
    if (need('targets')) {
      const fromProposed = (opts.proposed ?? [])
        .map((p) => (p && typeof p.path === 'string' ? toPosix(p.path) : null))
        .filter(Boolean)
      out.targets = uniq(fromProposed)
    }
    if (need('writes')) out.writes = null
    if (need('changeSet')) out.changeSet = null
    if (need('changeSetReason')) out.changeSetReason = `mode "${mode}" was given no change set`
  }
  return { sets: out, notes }
}

/**
 * Run every gate and summarise. Never throws.
 *
 * @param {{root?: string, mode?: string, config?: object, configPath?: string,
 *   writes?: string[]|null, targets?: string[]|null, changeSet?: string[]|null,
 *   changeSetReason?: string|null, proposed?: {path: string, text: string, whole?: boolean}[],
 *   telemetry?: boolean, now?: Date, maxFileBytes?: number}} [opts]
 */
export async function evaluate(opts = {}) {
  const root = resolve(opts.root ?? process.cwd())
  const mode = MODES.includes(opts.mode) ? opts.mode : 'all'

  const loaded = opts.config
    ? { ok: true, present: true, degraded: false, reason: null, hint: null, path: '(inline)', version: null, gates: [], problems: [] }
    : await loadConfig(root, { configPath: opts.configPath })

  // An inline config goes through the SAME validation a file does, so a test
  // can never prove behaviour production does not have.
  const gates = opts.config ? normalizeInline(opts.config, loaded) : loaded.gates

  const { sets, notes: setNotes } = await deriveSets(root, mode, opts)
  const ctx = await makeContext({ ...opts, ...sets, root, mode })
  ctx.notes.push(...setNotes)

  /** @type {GateResult[]} */
  const results = []
  for (const gate of gates) results.push(await runGate(gate, ctx))

  const fires = results.flatMap((r) => r.fires)
  const blocking = fires.filter((f) => f.severity === 'block')
  const degraded = results.filter((r) => r.degraded)
  const skipped = results.filter((r) => r.skipped)

  const telemetry = await recordFires(root, fires, mode, opts.telemetry !== false)

  return {
    ok: blocking.length === 0,
    mode,
    root,
    config: {
      path: loaded.path,
      present: loaded.present,
      degraded: loaded.degraded,
      reason: loaded.reason,
      hint: loaded.hint,
      problems: loaded.problems,
      gateCount: gates.length,
    },
    results,
    fires,
    blocking,
    warnings: fires.filter((f) => f.severity === 'warn'),
    degraded,
    skipped,
    notes: ctx.notes,
    telemetry,
  }
}

/** Run an inline config object through exactly the rules a file gets. */
function normalizeInline(config, loaded) {
  const { gates, problems, version } = validateGates(config)
  loaded.problems = problems
  loaded.version = version
  return gates
}

// ===========================================================================
// Hook input (Claude Code)
// ===========================================================================

/**
 * Pull every piece of PROPOSED text out of a PreToolUse payload.
 *
 * Write carries the whole file in `content`; Edit carries a fragment in
 * `new_string`; MultiEdit carries several in `edits[].new_string`. `whole`
 * records which, because a fragment can prove a banned string is PRESENT but
 * can never prove a required string is ABSENT.
 *
 * Never throws. An unrecognised payload yields `{path: null}` and the caller
 * exits 0 — a hook that dies on an unfamiliar tool blocks every tool.
 */
export function extractHookInput(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'hook payload is not an object', path: null, texts: [], whole: false, toolName: null }
  }
  const toolName = str(payload.tool_name) || null
  const input = payload.tool_input
  if (!input || typeof input !== 'object') {
    return { ok: false, reason: 'hook payload has no tool_input object', path: null, texts: [], whole: false, toolName }
  }
  const path = str(input.file_path) || null
  const texts = []
  let whole = false
  if (typeof input.content === 'string') {
    texts.push(input.content)
    whole = true
  }
  if (typeof input.new_string === 'string') texts.push(input.new_string)
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) if (e && typeof e.new_string === 'string') texts.push(e.new_string)
  }
  if (!path) {
    return { ok: false, reason: `tool "${toolName ?? 'unknown'}" has no file_path; nothing to check`, path: null, texts: [], whole: false, toolName }
  }
  return { ok: true, reason: null, path, texts, whole: whole && texts.length === 1, toolName }
}

/** Read stdin with a hard timeout. A hook must never wait forever on a pipe. */
async function readStdin(timeoutMs = STDIN_TIMEOUT_MS) {
  if (process.stdin.isTTY) return { ok: true, text: '', reason: 'stdin is a tty' }
  return new Promise((resolvePromise) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.stdin.removeAllListeners('data')
      process.stdin.removeAllListeners('end')
      process.stdin.removeAllListeners('error')
      resolvePromise(r)
    }
    const timer = setTimeout(() => finish({ ok: false, text: '', reason: `stdin did not close within ${timeoutMs}ms` }), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    process.stdin.on('data', (c) => {
      size += c.length
      if (size > MAX_STDIN_BYTES) return finish({ ok: false, text: '', reason: 'stdin exceeded the size cap' })
      chunks.push(c)
    })
    process.stdin.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8'), reason: null }))
    process.stdin.on('error', (err) => finish({ ok: false, text: '', reason: `stdin error (${err?.code ?? shortError(err)})` }))
  })
}

// ===========================================================================
// Change sets
// ===========================================================================

async function stagedNames(root) {
  const r = await runTool('git', ['-C', root, 'diff', '--cached', '--name-only', '-z'])
  if (!r.ran) return { names: null, reason: r.reason }
  if (r.code !== 0) return { names: null, reason: `git exited ${r.code} (not a repository?)` }
  return { names: r.stdout.split('\0').filter(Boolean).map(toPosix), reason: null }
}

/**
 * Working tree + index + untracked. Used by `post` so `paired-edit` can see the
 * sibling file an agent already edited earlier in the session — without it,
 * every paired-edit gate would fire on the first half of every legitimate pair.
 */
async function workingChangeSet(root) {
  const vsHead = await runTool('git', ['-C', root, 'diff', '--name-only', '-z', 'HEAD'])
  let names = []
  if (vsHead.ran && vsHead.code === 0) {
    names = vsHead.stdout.split('\0').filter(Boolean)
  } else {
    // No commits yet: fall back to index + worktree separately.
    const cached = await runTool('git', ['-C', root, 'diff', '--cached', '--name-only', '-z'])
    const dirty = await runTool('git', ['-C', root, 'diff', '--name-only', '-z'])
    if (!cached.ran && !dirty.ran) return { names: null, reason: cached.reason ?? dirty.reason }
    if (cached.ran && cached.code !== 0 && dirty.ran && dirty.code !== 0) {
      return { names: null, reason: `git exited ${cached.code} (not a repository?)` }
    }
    names = [...cached.stdout.split('\0'), ...dirty.stdout.split('\0')].filter(Boolean)
  }
  const untracked = await runTool('git', ['-C', root, 'ls-files', '-z', '--others', '--exclude-standard'])
  if (untracked.ran && untracked.code === 0) names.push(...untracked.stdout.split('\0').filter(Boolean))
  return { names: uniq(names.map(toPosix)), reason: null }
}

// ===========================================================================
// Reporting
// ===========================================================================

function fireLine(f) {
  const tag = f.severity === 'block' ? 'BLOCK' : 'warn '
  const at = f.path ? `${f.path}${f.line ? `:${f.line}` : ''}` : '(no path)'
  return `${tag}  ${f.gate}  ${at}\n        ${f.detail}`
}

/** The one-line reason a PreToolUse block puts on stderr, for the agent to read. */
function blockReason(result) {
  const lines = result.blocking.map((f) => {
    const at = f.path ? `${f.path}${f.line ? `:${f.line}` : ''}` : ''
    const msg = f.message ? ` ${f.message}` : ''
    const origin = f.origin ? ` [rule: ${f.origin}]` : ''
    return `${f.gate} (${f.kind}) ${at}: ${f.detail}.${msg}${origin}`
  })
  return `caselaw gate blocked this change:\n  ${lines.join('\n  ')}`
}

function humanReport(result) {
  const lines = []
  const n = result.config.gateCount
  lines.push(`harness gates — mode ${result.mode} — ${n} gate${n === 1 ? '' : 's'}`)

  if (!result.config.present) {
    lines.push(`  ${result.config.reason}${result.config.hint ? ` (${result.config.hint})` : ''}`)
  }
  if (result.config.degraded) {
    lines.push('', 'CONFIG NOT USABLE — no gates ran', `  ${result.config.reason}`)
    if (result.config.hint) lines.push(`  -> ${result.config.hint}`)
  }
  const configProblems = result.config.problems.filter((p) => p.level !== 'defaulted')
  if (configProblems.length) {
    lines.push('', 'CONFIG PROBLEMS')
    for (const p of configProblems) lines.push(`  [${p.level}] ${p.gate ? `${p.gate}: ` : ''}${p.message}`)
  }

  if (result.fires.length) {
    lines.push('')
    for (const f of result.fires) {
      lines.push(fireLine(f))
      if (f.message) lines.push(`        ${f.message}`)
      if (f.origin) lines.push(`        origin: ${f.origin}`)
    }
  }

  // Always its own section, always after the fires: a degraded check that got
  // mixed in with clean ones is how "did not run" becomes "found nothing".
  if (result.degraded.length) {
    lines.push('', 'DEGRADED — these checks could not run, which is NOT a pass')
    for (const r of result.degraded) {
      for (const d of r.degradations) {
        lines.push(`  ${r.gate} (${r.kind}): ${d.reason}`)
        if (d.hint) lines.push(`    -> ${d.hint}`)
      }
    }
  }

  if (result.skipped.length) {
    lines.push('', 'SKIPPED — not applicable here')
    for (const r of result.skipped) lines.push(`  ${r.gate} (${r.kind}): ${r.skipReason}`)
  }

  const notes = result.results.flatMap((r) => r.notes.map((t) => `  ${r.gate}: ${t}`)).concat(result.notes.map((t) => `  ${t}`))
  if (notes.length) {
    lines.push('', 'NOTES')
    lines.push(...notes)
  }

  lines.push(
    '',
    `${result.fires.length} fire${result.fires.length === 1 ? '' : 's'} ` +
      `(${result.blocking.length} blocking, ${result.warnings.length} warn) · ` +
      `${result.degraded.length} degraded · ${result.skipped.length} skipped`,
  )
  if (result.telemetry?.error) {
    lines.push(`(fire log not written: ${result.telemetry.error} — this does not affect the result)`)
  }
  return lines.join('\n')
}

// ===========================================================================
// main
// ===========================================================================

function parseArgs(argv) {
  const out = { mode: null, host: null, root: null, config: null, json: false, telemetry: true, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => argv[++i] ?? ''
    if (a === '--mode') out.mode = val()
    else if (a.startsWith('--mode=')) out.mode = a.slice(7)
    else if (a === '--host') out.host = val()
    else if (a.startsWith('--host=')) out.host = a.slice(7)
    else if (a === '--root') out.root = val()
    else if (a.startsWith('--root=')) out.root = a.slice(7)
    else if (a === '--config') out.config = val()
    else if (a.startsWith('--config=')) out.config = a.slice(9)
    else if (a === '--json') out.json = true
    else if (a === '--no-telemetry') out.telemetry = false
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

const USAGE = `caselaw gate runner

  node gate.mjs --mode pre    --host claude   PreToolUse: hook JSON on stdin, exit 2 to block
  node gate.mjs --mode post   --host claude   PostToolUse: re-read from disk, {"decision":"block"} on stdout
  node gate.mjs --mode staged                 git diff --cached, exit 1 if a block-severity gate fires
  node gate.mjs --mode all                    whole tree (CI), exit 1 if a block-severity gate fires

  --root <dir>      project root (default: cwd)
  --config <path>   gate config (default: ${DEFAULT_CONFIG_PATH})
  --json            machine-readable result instead of the report
  --no-telemetry    do not append to .caselaw/gate-fires.jsonl
`

/**
 * @returns {Promise<number>} the process exit code. Returned rather than
 *   applied so tests can assert on it without spawning — though the exit-code
 *   matrix is ALSO tested through a real subprocess, because that is the
 *   contract three callers actually depend on.
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? ((s) => process.stdout.write(s))
  const stderr = io.stderr ?? ((s) => process.stderr.write(s))
  const args = parseArgs(argv)

  if (args.help) {
    stdout(USAGE)
    return EXIT.OK
  }

  try {
    const root = resolve(args.root ?? process.cwd())
    const mode = args.mode
    if (!MODES.includes(mode)) {
      // Bad invocation is OUR failure, and our failures never block.
      stderr(`caselaw gate: --mode must be one of ${MODES.join(', ')} (got ${JSON.stringify(mode ?? null)})\n`)
      return EXIT.OK
    }
    if (args.host && args.host !== 'claude') {
      stderr(`caselaw gate: unknown --host ${JSON.stringify(args.host)}; reading Claude Code hook JSON\n`)
    }

    const common = { root, mode, configPath: args.config ?? undefined, telemetry: args.telemetry }

    if (mode === 'pre' || mode === 'post') return await runHookMode(mode, common, args, stdout, stderr)

    // `staged` and `all` derive their own path sets inside evaluate().
    const result = await evaluate(common)
    stdout(args.json ? JSON.stringify(result, null, 2) + '\n' : humanReport(result) + '\n')
    return result.blocking.length > 0 ? EXIT.FAILED : EXIT.OK
  } catch (err) {
    stderr(`caselaw gate: internal error, no gates enforced (${shortError(err)})\n`)
    return EXIT.OK
  }
}

async function runHookMode(mode, common, args, stdout, stderr) {
  const raw = await readStdin()
  if (!raw.ok) {
    stderr(`caselaw gate: ${raw.reason}; nothing was checked\n`)
    return EXIT.OK
  }
  if (!raw.text.trim()) {
    stderr('caselaw gate: empty hook payload; nothing was checked\n')
    return EXIT.OK
  }

  let payload
  try {
    payload = JSON.parse(raw.text)
  } catch (err) {
    stderr(`caselaw gate: hook payload is not valid JSON (${shortError(err)}); nothing was checked\n`)
    return EXIT.OK
  }

  const hook = extractHookInput(payload)
  if (!hook.ok) {
    stderr(`caselaw gate: ${hook.reason}\n`)
    return EXIT.OK
  }

  const root = common.root
  const rel = isAbsolute(hook.path) ? toPosix(relative(root, hook.path)) : toPosix(hook.path)
  if (!rel || rel.startsWith('../')) {
    stderr(`caselaw gate: ${hook.path} is outside ${root}; nothing was checked\n`)
    return EXIT.OK
  }

  /** @type {any} */
  const opts = { ...common, writes: [rel] }
  if (mode === 'pre') {
    opts.proposed = hook.texts.map((t) => ({ path: rel, text: t, whole: hook.whole }))
    opts.targets = hook.texts.length ? [rel] : []
    opts.changeSet = null
    opts.changeSetReason = 'pre mode sees only the proposed write'
    // Several fragments for one path collapse in the overrides map, so join
    // them: a banned string split across two edits of one MultiEdit still has
    // to be caught, and joining is what makes each fragment reachable.
    if (hook.texts.length > 1) {
      opts.proposed = [{ path: rel, text: hook.texts.join('\n'), whole: false }]
    }
  } else {
    opts.targets = [rel]
    const ws = await workingChangeSet(root)
    opts.changeSet = ws.names === null ? null : uniq([...ws.names, rel])
    opts.changeSetReason = ws.names === null ? `git could not describe the change set (${ws.reason})` : null
  }

  const result = await evaluate(opts)

  if (args.json) {
    stdout(JSON.stringify(result, null, 2) + '\n')
    return EXIT.OK
  }

  // Everything that is not a block goes to stderr: in Claude Code, stderr is
  // shown in the transcript without altering the tool's fate, which is exactly
  // what a warning and a degraded check should do.
  const asides = []
  if (result.config.degraded) asides.push(`config not usable: ${result.config.reason}`)
  for (const f of result.warnings) asides.push(`warn ${f.gate}: ${f.detail}${f.message ? ` — ${f.message}` : ''}`)
  for (const r of result.degraded) for (const d of r.degradations) asides.push(`degraded ${r.gate}: ${d.reason}`)
  if (asides.length) stderr(`caselaw gate (${mode}):\n  ${asides.join('\n  ')}\n`)

  if (result.blocking.length === 0) return EXIT.OK

  if (mode === 'pre') {
    stderr(blockReason(result) + '\n')
    return EXIT.PRE_BLOCK
  }
  stdout(JSON.stringify({ decision: 'block', reason: blockReason(result) }) + '\n')
  return EXIT.OK
}

// `import.meta.main` is Node >= 24; the argv comparison covers 20 and 22, which
// package.json still supports.
const invokedDirectly =
  typeof import.meta.main === 'boolean'
    ? import.meta.main
    : Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (err) => {
      // Unreachable in principle — main() catches everything. If it is ever
      // reached, the answer is still "do not break the workflow".
      process.stderr.write(`caselaw gate: unhandled error, no gates enforced (${shortError(err)})\n`)
      process.exitCode = EXIT.OK
    },
  )
}
