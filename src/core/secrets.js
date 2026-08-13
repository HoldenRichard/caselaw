/**
 * Secret scanning and publication hygiene.
 *
 * This tool writes files into other people's repos and is itself public, so it
 * carries two obligations that pull in opposite directions:
 *
 *   1. It must be able to tell a user their repo is safe to publish.
 *   2. It must never leak the machine it was generated on.
 *
 * Three layers, in increasing cost and decreasing availability:
 *
 *   scanMachinePaths  pure JS, no external tool, ALWAYS runs. Catches the class
 *                     WE are most likely to commit: absolute home paths and
 *                     personal identifiers baked into generated doctrine files.
 *   scanWorkingTree   gitleaks over the working tree. The everyday fast blocker.
 *   scanHistory       trufflehog over FULL git history, verified secrets only.
 *                     The gate before a repo goes public. A pattern match says
 *                     "this looks like a key"; verification says "this key is
 *                     still live", and only the second one justifies a rewrite
 *                     of history.
 *
 * THE LOAD-BEARING REQUIREMENT is that neither external tool is installed for
 * most people who run this. A gate that breaks the workflow gets deleted within
 * a day, so an absent tool NEVER throws, NEVER blocks, and NEVER exits non-zero
 * — it returns `{ ok: true, degraded: true, reason, hint, findings: [] }`.
 * `degraded` is always present as a boolean, even on a successful scan, because
 * the one mistake a caller must never be able to make is reading "did not run"
 * as "found nothing".
 *
 * REDACTION IS UNCONDITIONAL. Findings get printed to terminals and pasted into
 * issues. No code path here may return a full secret, which also means no error
 * message may echo tool stdout — for gitleaks and trufflehog, stdout IS the
 * secret material.
 */

import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** External scans are slow by nature; the default is generous, not fast. */
export const DEFAULT_TIMEOUT_MS = 120_000
const PROBE_TIMEOUT_MS = 10_000

/** trufflehog can emit a lot of NDJSON on a large history. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

export const INSTALL_HINTS = {
  gitleaks: 'brew install gitleaks — or see https://github.com/gitleaks/gitleaks#installing',
  trufflehog:
    'brew install trufflehog — or see https://github.com/trufflesecurity/trufflehog#installation',
}

// --------------------------------------------------------------------------
// redaction
// --------------------------------------------------------------------------

const MASK = '****'

/**
 * Reduce a matched string to at most its last four characters.
 *
 * The mask is FIXED WIDTH on purpose. A mask that grows with the input leaks
 * the secret's length, which narrows an attacker's search more than people
 * expect, and length is exactly the kind of detail that survives a screenshot.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function redact(value) {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value)
  if (s.length === 0) return ''
  if (s.length <= 4) return MASK
  return MASK + s.slice(-4)
}

const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g

/**
 * Make a tool's own error text safe to put in a `reason`.
 *
 * Tool stdout is never passed through here — it is never surfaced at all. This
 * is for stderr, which normally carries only diagnostics, but "normally" is not
 * a guarantee worth betting a credential on. Runs of 20+ token-ish characters
 * are redacted; `/` and `\` are deliberately excluded from the class so file
 * paths survive segment by segment and the message stays actionable.
 */
function sanitizeToolMessage(text) {
  return String(text ?? '')
    .replace(ANSI_RE, '')
    .replace(/[A-Za-z0-9_\-+=]{20,}/g, (m) => redact(m))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)[0]
    ?.slice(0, 200) ?? ''
}

// --------------------------------------------------------------------------
// process plumbing
// --------------------------------------------------------------------------

/**
 * Run a binary and resolve — never reject — with everything needed to decide
 * whether the run succeeded, found something, or failed.
 *
 * execFile with an argument array, never a shell string: a repo path
 * containing a space, a quote, or a `;` must be an argument, not syntax.
 *
 * @returns {Promise<{code: number|null, stdout: string, stderr: string,
 *                    failed: boolean, errno: string|null, killed: boolean}>}
 */
function run(bin, args, { timeoutMs = DEFAULT_TIMEOUT_MS, cwd } = {}) {
  return new Promise((resolve) => {
    const done = (r) => resolve({ code: null, stdout: '', stderr: '', failed: true, errno: null, killed: false, ...r })
    let child
    try {
      child = execFile(
        bin,
        args,
        { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
        (err, stdout, stderr) => {
          if (!err) return done({ code: 0, stdout, stderr, failed: false })
          done({
            // A numeric err.code is the child's exit status; a string one
            // (ENOENT, ERR_CHILD_PROCESS_STDIO_MAXBUFFER) is a spawn/plumbing
            // failure. Conflating the two is how "tool missing" gets reported
            // as "scan failed, exit 1".
            code: typeof err.code === 'number' ? err.code : null,
            errno: typeof err.code === 'string' ? err.code : null,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            failed: true,
            killed: Boolean(err.killed) || err.signal === 'SIGTERM',
          })
        },
      )
    } catch (err) {
      return done({ errno: err?.code ?? 'SPAWN_FAILED' })
    }
    // execFile's callback already reports spawn errors; this listener only
    // stops a stray 'error' event from surfacing as an uncaught exception.
    child.on('error', () => {})
  })
}

// --------------------------------------------------------------------------
// probing
// --------------------------------------------------------------------------

/**
 * Cached per process, keyed by binary name so a test that injects a fake name
 * cannot poison the entry for the real one (and vice versa). The cache holds
 * the in-flight promise, so two concurrent scans probe once, not twice.
 * @type {Map<string, Promise<{available: true, version: string}|null>>}
 */
let probeCache = new Map()

/** Test seam: forget every cached probe result. */
export function resetProbeCache() {
  probeCache = new Map()
}

function probeBinary(bin, args) {
  if (probeCache.has(bin)) return probeCache.get(bin)
  const p = (async () => {
    const r = await run(bin, args, { timeoutMs: PROBE_TIMEOUT_MS })
    if (r.failed || r.code !== 0) return null
    const m = `${r.stdout}\n${r.stderr}`.match(/(\d+\.\d+\.\d+)/)
    // Available but unparseable version is still available. Refusing to scan
    // because we could not read a version string would be absurd.
    return { available: true, version: m ? m[1] : 'unknown' }
  })()
  probeCache.set(bin, p)
  return p
}

/**
 * Which scanners exist on this machine?
 *
 * `null` for a tool means not installed — an unmistakable value, unlike
 * `{ available: false }`, which reads as truthy at a glance.
 *
 * @param {{bins?: {gitleaks?: string, trufflehog?: string}, force?: boolean}} [opts]
 * @returns {Promise<{gitleaks: {available: true, version: string}|null,
 *                    trufflehog: {available: true, version: string}|null}>}
 */
export async function probeScanners(opts = {}) {
  try {
    if (opts.force) resetProbeCache()
    const gitleaksBin = opts.bins?.gitleaks ?? 'gitleaks'
    const trufflehogBin = opts.bins?.trufflehog ?? 'trufflehog'
    const [gitleaks, trufflehog] = await Promise.all([
      probeBinary(gitleaksBin, ['version']),
      probeBinary(trufflehogBin, ['--version']),
    ])
    return { gitleaks, trufflehog }
  } catch {
    // Probing is diagnostic. If it somehow explodes, report "nothing here" and
    // let the scans degrade — never take the caller down with us.
    return { gitleaks: null, trufflehog: null }
  }
}

// --------------------------------------------------------------------------
// result shapes
// --------------------------------------------------------------------------

function degrade(tool, reason, hint) {
  return { ok: true, degraded: true, reason, hint, findings: [], tool }
}

function ok(tool, findings, extra = {}) {
  return { ok: findings.length === 0, degraded: false, findings, tool, ...extra }
}

const str = (v) => (typeof v === 'string' ? v : '')

/** Report paths relative to the repo root when we can — absolute paths in a
 *  finding are themselves a machine-path leak if the output gets pasted. */
function toRelative(root, filePath) {
  if (!filePath) return '(unknown)'
  if (!isAbsolute(filePath)) return filePath.split(sep).join('/')
  const rel = relative(root, filePath)
  if (!rel || rel.startsWith('..')) return filePath
  return rel.split(sep).join('/')
}

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

// --------------------------------------------------------------------------
// scanWorkingTree — gitleaks, the everyday fast blocker
// --------------------------------------------------------------------------

/**
 * Fast pass over the working tree. Suitable for a pre-commit hook.
 *
 * @param {string} root
 * @param {{bin?: string, timeoutMs?: number, extraArgs?: string[]}} [opts]
 * @returns {Promise<{ok: boolean, degraded: boolean, findings: object[],
 *                    tool: string, reason?: string, hint?: string}>}
 */
export async function scanWorkingTree(root, opts = {}) {
  const tool = 'gitleaks'
  const bin = opts.bin ?? 'gitleaks'
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let reportDir = null

  try {
    if (typeof root !== 'string' || root.length === 0) {
      return degrade(tool, 'no repository root was given', 'pass an absolute path to the repo root')
    }
    const probe = await probeBinary(bin, ['version'])
    if (!probe) return degrade(tool, `${bin} not installed`, INSTALL_HINTS.gitleaks)

    // gitleaks writes its report to a file, so the findings — full, unredacted
    // secrets — land on disk. mkdtemp creates the directory 0700, and the
    // finally block removes it whatever happens.
    reportDir = await mkdtemp(join(tmpdir(), 'harness-secrets-'))
    const reportPath = join(reportDir, 'gitleaks.json')

    const args = [
      'dir',
      '--report-format', 'json',
      '--report-path', reportPath,
      '--no-banner',
      '--no-color',
      '--log-level', 'error',
      // Findings exit 2 instead of the default 1, so a real gitleaks failure
      // can never be read as "we found something". Verified the hard way: a
      // report path it cannot write also exits 1.
      '--exit-code', '2',
      ...(Array.isArray(opts.extraArgs) ? opts.extraArgs : []),
      root,
    ]

    const r = await run(bin, args, { timeoutMs })

    if (r.errno === 'ENOENT') return degrade(tool, `${bin} not installed`, INSTALL_HINTS.gitleaks)
    if (r.killed) {
      return degrade(tool, `gitleaks timed out after ${timeoutMs}ms`, 'raise opts.timeoutMs, or scan a narrower path')
    }
    if (r.errno) {
      return degrade(tool, `gitleaks could not be run (${r.errno})`, INSTALL_HINTS.gitleaks)
    }
    if (r.code !== 0 && r.code !== 2) {
      const detail = sanitizeToolMessage(r.stderr)
      return degrade(
        tool,
        `gitleaks exited ${r.code}${detail ? `: ${detail}` : ''}`,
        'run the same scan by hand to see the full error',
      )
    }

    let raw
    try {
      raw = await readFile(reportPath, 'utf8')
    } catch {
      return degrade(tool, 'gitleaks wrote no report file', 'check that the temp directory is writable')
    }

    let parsed
    try {
      parsed = JSON.parse(raw.trim() || '[]')
    } catch {
      // The byte count is the most we can say, and err.message is deliberately
      // NOT bound or included: V8 quotes the first ten characters of the input
      // back at you ("Unexpected token 'g', \"ghp_A1b2C3\"... is not valid
      // JSON"), and `raw` is unredacted credentials by construction. Ten
      // characters is the whole of a short one.
      return degrade(
        tool,
        `gitleaks report was not valid JSON (${raw.length} bytes)`,
        'check the gitleaks version — the report schema may have changed',
      )
    }
    if (!Array.isArray(parsed)) {
      return degrade(tool, 'gitleaks report was not the expected JSON array', 'check the gitleaks version')
    }

    const findings = parsed.map((f) => ({
      rule: str(f?.RuleID) || 'unknown',
      path: toRelative(root, str(f?.File)),
      line: Number.isFinite(f?.StartLine) ? f.StartLine : null,
      redactedMatch: redact(str(f?.Secret) || str(f?.Match)),
      tool,
      ...(str(f?.Commit) ? { commit: str(f.Commit) } : {}),
    }))

    return ok(tool, findings, { version: probe.version })
  } catch (err) {
    return degrade(tool, `gitleaks scan could not run: ${sanitizeToolMessage(err?.message)}`, INSTALL_HINTS.gitleaks)
  } finally {
    if (reportDir) await rm(reportDir, { recursive: true, force: true }).catch(() => {})
  }
}

// --------------------------------------------------------------------------
// scanHistory — trufflehog, the pre-public gate
// --------------------------------------------------------------------------

/**
 * Deep pass over FULL git history, verified secrets only.
 *
 * @param {string} root
 * @param {{bin?: string, timeoutMs?: number, onlyVerified?: boolean,
 *          extraArgs?: string[]}} [opts]
 *   `onlyVerified: false` swaps verification for `--no-verification`: every
 *   candidate is reported and nothing goes over the network. Useful offline and
 *   in tests; it is NOT the publication gate, because unverified means unknown.
 */
export async function scanHistory(root, opts = {}) {
  const tool = 'trufflehog'
  const bin = opts.bin ?? 'trufflehog'
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const onlyVerified = opts.onlyVerified !== false

  try {
    if (typeof root !== 'string' || root.length === 0) {
      return degrade(tool, 'no repository root was given', 'pass an absolute path to the repo root')
    }
    const probe = await probeBinary(bin, ['--version'])
    if (!probe) return degrade(tool, `${bin} not installed`, INSTALL_HINTS.trufflehog)

    // trufflehog's own error for a non-repo is opaque, and "scanning history"
    // of a directory with no history is a silent pass — the worst outcome.
    if (!(await exists(join(root, '.git')))) {
      return degrade(
        tool,
        'not a git repository — there is no history to scan',
        'run this from the repo root, or `git init` first',
      )
    }

    const args = [
      'git',
      // A bare path is rejected by trufflehog; it wants a URI. pathToFileURL
      // handles spaces and Windows drive letters correctly.
      pathToFileURL(root).href,
      '--json',
      '--no-color',
      '--no-update',
      // --fail makes findings exit 183, which separates "found something" from
      // "the scan broke" (exit 1). Without it trufflehog exits 0 either way.
      '--fail',
      ...(onlyVerified ? ['--only-verified'] : ['--no-verification']),
      ...(Array.isArray(opts.extraArgs) ? opts.extraArgs : []),
    ]

    const r = await run(bin, args, { timeoutMs })

    if (r.errno === 'ENOENT') return degrade(tool, `${bin} not installed`, INSTALL_HINTS.trufflehog)
    if (r.killed) {
      return degrade(
        tool,
        `trufflehog timed out after ${timeoutMs}ms`,
        'history scans are slow on large repos — raise opts.timeoutMs',
      )
    }
    if (r.errno === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return degrade(tool, 'trufflehog produced more output than we can buffer', 'scan a narrower path')
    }
    if (r.errno) {
      return degrade(tool, `trufflehog could not be run (${r.errno})`, INSTALL_HINTS.trufflehog)
    }
    if (r.code !== 0 && r.code !== 183) {
      const detail = sanitizeToolMessage(r.stderr)
      return degrade(
        tool,
        `trufflehog exited ${r.code}${detail ? `: ${detail}` : ''}`,
        'run the same scan by hand to see the full error',
      )
    }

    // --json is NDJSON on stdout; logs go to stderr. Lines that are not objects
    // are banner/progress noise and are skipped, but a line that looks like
    // JSON and will not parse means the format moved under us — degrade rather
    // than report a partial result as if it were the whole answer.
    const records = []
    let unparseable = 0
    for (const line of r.stdout.split('\n')) {
      const t = line.trim()
      if (!t.startsWith('{')) continue
      try {
        records.push(JSON.parse(t))
      } catch {
        unparseable++
      }
    }
    if (unparseable > 0) {
      return degrade(
        tool,
        `trufflehog emitted ${unparseable} unparseable JSON line(s); refusing to report a partial result`,
        'check the trufflehog version — the --json schema may have changed',
      )
    }

    // Belt and braces: --only-verified is the deprecated spelling of
    // --results=verified and could be dropped in a future release. Filtering
    // again here means losing the flag downgrades speed, not correctness.
    const wanted = onlyVerified ? records.filter((x) => x?.Verified === true) : records

    const findings = wanted.map((x) => {
      const g = x?.SourceMetadata?.Data?.Git ?? {}
      return {
        rule: str(x?.DetectorName) || 'unknown',
        path: toRelative(root, str(g.file)),
        line: Number.isFinite(g.line) ? g.line : null,
        redactedMatch: redact(str(x?.Raw) || str(x?.RawV2)),
        tool,
        verified: x?.Verified === true,
        ...(str(g.commit) ? { commit: str(g.commit) } : {}),
      }
    })

    const extra = { version: probe.version, verifiedOnly: onlyVerified }
    // The single most common way this gate is misconfigured: a shallow clone
    // has one commit, so scanning "full history" passes while proving nothing.
    if (await exists(join(root, '.git', 'shallow'))) {
      extra.warning =
        'shallow clone — only part of the history was scanned. In CI set actions/checkout fetch-depth: 0.'
    }
    return ok(tool, findings, extra)
  } catch (err) {
    return degrade(
      tool,
      `trufflehog scan could not run: ${sanitizeToolMessage(err?.message)}`,
      INSTALL_HINTS.trufflehog,
    )
  }
}

// --------------------------------------------------------------------------
// scanMachinePaths — pure JS, always runs
// --------------------------------------------------------------------------

/**
 * Absolute home directories. The capture is the account name: the part that
 * actually identifies whose machine this was generated on.
 *
 * The leading lookbehind stops `/usr/home/x` and `https://host.com/Users/x`
 * from matching, which are not local home paths.
 */
const POSIX_HOME_RE = /(?<![A-Za-z0-9._-])(\/(?:Users|home)\/)([A-Za-z0-9][A-Za-z0-9._-]*)/g

/**
 * Windows home directories, in both slash flavours and tolerant of the doubled
 * backslashes you get once a path has been through a JS or JSON string literal.
 */
const WINDOWS_HOME_RE = /([A-Za-z]:[\\/]{1,2}Users[\\/]{1,2})([A-Za-z0-9][A-Za-z0-9._-]*)/g

/**
 * Any dotted quad with non-word boundaries. Range and octet validity are
 * checked in code rather than in the pattern — a regex that encodes 10/8,
 * 172.16/12 and 192.168/16 is unreadable and gets edited wrong later.
 * The boundaries keep `v10.0.0.5` (a version) and `1.2.3.4.5` out.
 */
const IPV4_RE = /(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w.])/g

function isPrivateIpv4(a, b, c, d) {
  for (const o of [a, b, c, d]) if (!(o >= 0 && o <= 255)) return false
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 1-based line number of an offset. Counted on the RAW text (see below). */
function lineAt(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/**
 * Find machine-identifying content in generated text.
 *
 * This is the layer that always runs, because it catches the class WE are most
 * likely to commit: an interview answer or a resolved path that carries the
 * author's home directory, LAN address, or email into a doctrine file that then
 * ships to strangers.
 *
 * The text is scanned RAW — deliberately not through core/text.js normalize().
 * Normalizing CRLF would shift every offset after the first line ending, and
 * the whole value of `index` is that a caller can point at the exact spot in
 * the file it actually read.
 *
 * @param {string} text
 * @param {{extraIdentifiers?: string[]}} [opts] caller-supplied needles:
 *   emails, usernames, hostnames. Needles shorter than 3 characters are
 *   ignored — they match inside ordinary words and would bury the real hits.
 * @returns {{kind: 'home-path'|'identifier'|'private-ip', match: string,
 *            index: number, line: number, redacted: string}[]}
 */
export function scanMachinePaths(text, { extraIdentifiers = [] } = {}) {
  /** @type {{kind: string, match: string, index: number, line: number, redacted: string}[]} */
  const out = []
  if (typeof text !== 'string' || text.length === 0) return out

  try {
    for (const re of [POSIX_HOME_RE, WINDOWS_HOME_RE]) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(text)) !== null) {
        const [match, prefix, name] = m
        out.push({
          kind: 'home-path',
          match,
          index: m.index,
          line: lineAt(text, m.index),
          // The structural prefix is kept so the finding is recognisable; only
          // the account name is masked.
          redacted: prefix + redact(name),
        })
      }
    }

    IPV4_RE.lastIndex = 0
    let ip
    while ((ip = IPV4_RE.exec(text)) !== null) {
      const [match, a, b, c, d] = ip
      if (!isPrivateIpv4(+a, +b, +c, +d)) continue
      out.push({
        kind: 'private-ip',
        match,
        index: ip.index,
        line: lineAt(text, ip.index),
        // Host octets dropped entirely: the network class is the useful part,
        // the host is the identifying part.
        redacted: `${a}.${b}.x.x`,
      })
    }

    const needles = Array.isArray(extraIdentifiers) ? extraIdentifiers : []
    for (const raw of needles) {
      if (typeof raw !== 'string') continue
      const needle = raw.trim()
      if (needle.length < 3) continue
      const re = new RegExp(escapeRe(needle), 'gi')
      let m
      while ((m = re.exec(text)) !== null) {
        out.push({
          kind: 'identifier',
          match: m[0],
          index: m.index,
          line: lineAt(text, m.index),
          redacted: redact(m[0]),
        })
        // A zero-length match cannot happen (needle.length >= 3), but an
        // unadvanced lastIndex would spin forever if that ever changed.
        if (m.index === re.lastIndex) re.lastIndex++
      }
    }
  } catch {
    // Purely defensive. Return what we found rather than taking the caller
    // down — but note this path can under-report, never over-report.
  }

  const seen = new Set()
  const unique = out.filter((f) => {
    const k = `${f.kind}:${f.index}:${f.match}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  // Two patterns of the same kind can cover the same span: `D:/Users/x` is a
  // Windows home path AND contains a POSIX-looking one. Reporting both is
  // noise, and noise is how a check earns its way onto an ignore list. The
  // widest match of a kind wins; a DIFFERENT kind overlapping the same span is
  // kept, because it is a genuinely different reason to care.
  const kept = unique
    .slice()
    .sort((x, y) => x.index - y.index || y.match.length - x.match.length)
    .filter((f, i, all) =>
      !all.some(
        (g, j) =>
          j < i &&
          g.kind === f.kind &&
          g.index <= f.index &&
          g.index + g.match.length >= f.index + f.match.length,
      ),
    )

  return kept.sort((x, y) => x.index - y.index || x.kind.localeCompare(y.kind))
}
