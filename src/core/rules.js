/**
 * Case law — the rules a project mined from its own incidents.
 *
 * A rule is legitimate only if it cites the incident that proved it. A rule
 * without an incident behind it is someone else's superstition, and copying it
 * in is how a governance system turns into a cargo cult. This module is what
 * enforces that: it can read a rule, tell you what is wrong with it, and move
 * it between the three directories — but it will not let a citation go
 * unchecked, and it will not let a file decide its own promotion.
 *
 * Two boundaries run through everything below.
 *
 *   1. THE HUMAN GATE. Only a human moves a file between proposed/ and
 *      active/. An agent drafts; a person ratifies. `interactive === true` is
 *      the caller's assertion that a human is present, and it is never
 *      inferred here — a module that guesses whether someone is watching is a
 *      module that ratifies rules at 3am.
 *
 *   2. THE USER-ORIGIN GATE. A rule proposal is untrusted content. It may have
 *      been drafted by an agent out of a README, a web page, or tool output,
 *      and it may contain text aimed at whatever reads it next. So: nothing in
 *      a rule file is ever executed, nothing in it selects a path, and nothing
 *      in it supplies the ratifier's identity. The only thing we take from the
 *      file is prose to display and hex we hand to `git cat-file` after
 *      checking it is hex. Directive-looking text in the body is data. It gets
 *      round-tripped, and it gets ignored.
 */

import { readFile, writeFile, mkdir, readdir, rm, lstat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, basename } from 'node:path'
import { normalize, hash } from './text.js'

/** Where case law lives. Relative to the project root, POSIX, on every OS. */
export const RULE_DIRS = {
  active: 'docs/rules/active',
  proposed: 'docs/rules/proposed',
  candidates: 'docs/rules/candidates',
}

/** Every problem code `validateRule` can emit, so callers can switch exhaustively. */
export const PROBLEM_CODES = [
  'missing-section',
  'origin-unresolvable',
  'origin-unverified',
  'trigger-too-broad',
  'multiple-rules',
  'enforcement-invalid',
  'name-mismatch',
  'not-kebab-case',
]

const KNOWN_ORDER = ['trigger', 'rule', 'origin', 'enforcement', 'ratified']
const KNOWN = new Set(KNOWN_ORDER)
const LABELS = {
  trigger: 'Trigger',
  rule: 'Rule',
  origin: 'Origin',
  enforcement: 'Enforcement',
  ratified: 'Ratified',
}

/**
 * A section header. Strict on purpose: `**Label:**` at the start of a line and
 * nothing else. `**Label**:` is a near miss that produces a loud
 * missing-section error rather than a quiet partial parse, which is the
 * failure direction we want from a doctrine file.
 */
const SECTION_RE = /^\*\*([^*:\n]+):\*\*[ \t]*(.*)$/
const H1_RE = /^#[ \t]+(.+?)\s*$/
/** A thematic break ends the rule body; whatever follows is a human footer. */
const THEMATIC_BREAK_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ENFORCEMENT_RE = /^(?:memory|checklist|machine:[a-z0-9][a-z0-9._/-]*)$/
/** Filenames are built from this and nothing else — see `ruleFile`. */
const SAFE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_NAME_LEN = 100

// ---------------------------------------------------------------------------
// Parsing and serializing
// ---------------------------------------------------------------------------

/**
 * Parse a rule file.
 *
 * @param {string} text
 * @param {{path?: string}} [opts]
 * @returns {{name: string|null, trigger: string|null, rule: string|null,
 *            origin: string|null, enforcement: string|null, ratified: string|null,
 *            extras: {label: string, key: string, value: string}[],
 *            sections: {label: string, key: string, value: string}[],
 *            preamble: string, footer: string, raw: string,
 *            path: string|null, file: string|null}}
 */
export function parseRule(text, opts = {}) {
  if (typeof text !== 'string') {
    throw new RuleError('parseRule expects the file text as a string', { code: 'BAD_INPUT' })
  }
  const raw = normalize(text)
  const lines = raw.split('\n')

  let name = null
  /** @type {{label: string, key: string, lines: string[]}[]} */
  const sections = []
  const preambleLines = []
  const footerLines = []
  let current = null
  let inFooter = false

  for (const line of lines) {
    if (inFooter) {
      footerLines.push(line)
      continue
    }
    if (name === null && current === null && sections.length === 0) {
      const h1 = H1_RE.exec(line)
      if (h1) {
        name = h1[1].trim()
        continue
      }
    }
    // A horizontal rule only ends the body once the body has started; a file
    // that opens with one is malformed rather than footer-only.
    if (sections.length > 0 && THEMATIC_BREAK_RE.test(line)) {
      inFooter = true
      footerLines.push(line)
      continue
    }
    const sec = SECTION_RE.exec(line)
    if (sec) {
      const label = sec[1].trim()
      current = { label, key: label.toLowerCase(), lines: [] }
      if (sec[2].trim()) current.lines.push(sec[2])
      sections.push(current)
      continue
    }
    if (current) current.lines.push(line)
    else preambleLines.push(line)
  }

  const parsedSections = sections.map((s) => ({
    label: s.label,
    key: s.key,
    value: trimBlock(s.lines.join('\n')),
  }))

  /** First occurrence wins; a second `**Rule:**` is a validation error, not a merge. */
  const firstOf = (key) => parsedSections.find((s) => s.key === key)?.value ?? null
  const extras = parsedSections.filter((s) => !KNOWN.has(s.key))

  const path = opts.path ?? null
  return {
    name,
    trigger: firstOf('trigger'),
    rule: firstOf('rule'),
    origin: firstOf('origin'),
    enforcement: firstOf('enforcement'),
    ratified: firstOf('ratified'),
    extras,
    sections: parsedSections,
    preamble: trimBlock(preambleLines.join('\n')),
    footer: trimBlock(footerLines.join('\n')),
    raw,
    path,
    file: path ? basename(path) : null,
  }
}

/**
 * Render a rule back to markdown.
 *
 * Ordering is taken from `fields.sections` when present, so a parsed file
 * round-trips in its original order — including extra sections, which authors
 * place deliberately. Known sections that were absent are inserted at their
 * canonical position (Origin before Enforcement, Ratified last), and a
 * duplicate known section collapses to one, because the whole point of
 * `multiple-rules` is that a file carries one rule.
 *
 * @param {object} fields
 * @returns {string}
 */
export function serializeRule(fields) {
  if (!fields || typeof fields !== 'object') {
    throw new RuleError('serializeRule expects a fields object', { code: 'BAD_INPUT' })
  }
  const name = typeof fields.name === 'string' ? fields.name.trim() : ''
  if (!name) {
    throw new RuleError('A rule cannot be written without a name (its H1 title)', {
      code: 'MISSING_NAME',
    })
  }

  const value = (key) => {
    const v = fields[key]
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }
  const extraQueue = (fields.extras ?? []).map((e) => ({
    label: e.label,
    key: (e.key ?? e.label ?? '').toLowerCase(),
    value: typeof e.value === 'string' ? e.value.trim() : '',
    used: false,
  }))

  /** @type {{known?: string, extra?: {label: string, value: string}}[]} */
  const order = []
  const seen = new Set()
  for (const s of fields.sections ?? []) {
    if (KNOWN.has(s.key)) {
      if (seen.has(s.key)) continue
      seen.add(s.key)
      order.push({ known: s.key })
      continue
    }
    // Match by label so an extra dropped from `extras` disappears and one whose
    // value was rewritten emits the new value.
    const match = extraQueue.find((e) => !e.used && e.key === s.key)
    if (match) {
      match.used = true
      order.push({ extra: match })
    }
  }
  for (const key of KNOWN_ORDER) {
    if (seen.has(key)) continue
    seen.add(key)
    const rank = KNOWN_ORDER.indexOf(key)
    const at = order.findIndex((o) => o.known && KNOWN_ORDER.indexOf(o.known) > rank)
    if (at === -1) order.push({ known: key })
    else order.splice(at, 0, { known: key })
  }
  for (const e of extraQueue) if (!e.used) order.push({ extra: e })

  const parts = [`# ${name}`]
  const preamble = typeof fields.preamble === 'string' ? fields.preamble.trim() : ''
  if (preamble) parts.push(preamble)

  for (const item of order) {
    if (item.known) {
      const v = value(item.known)
      if (v) parts.push(`**${LABELS[item.known]}:** ${v}`)
    } else if (item.extra && item.extra.value) {
      parts.push(`**${item.extra.label}:** ${item.extra.value}`)
    }
  }

  const footer = typeof fields.footer === 'string' ? fields.footer.trim() : ''
  if (footer) parts.push(footer)

  return parts.join('\n\n') + '\n'
}

// ---------------------------------------------------------------------------
// Reference detection — what counts as citing an incident
// ---------------------------------------------------------------------------

const URL_RE = /\bhttps?:\/\/[^\s<>()[\]]+/gi
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\b/g
const ISSUE_RE = /(?:[\w./-]*#\d+)\b|\b[A-Z][A-Z0-9]{1,}-\d+\b/g
const HEX_TOKEN_RE = /\b[0-9a-fA-F]{7,40}\b/g
const COMMITISH_RE = /(?:commit|sha|rev|revision|@)\W*$/i

/**
 * Pull every kind of reference out of an Origin.
 *
 * URLs and dates are stripped before SHA scanning, because a URL path segment
 * and `20260812` are both hex-shaped and neither is a commit.
 *
 * The SHA heuristic errs toward NOT claiming a token is a SHA, since a false
 * positive produces a loud `origin-unresolvable` error on a perfectly good
 * citation. A token qualifies if it is a full 40 chars, or mixes digits and
 * a–f (which real short SHAs almost always do and English words never do —
 * "defaced" and "acceded" are hex-only words), or is preceded by `commit`,
 * `sha`, `rev` or `@`.
 *
 * @param {string} text
 * @returns {{shas: string[], dates: string[], issues: string[], urls: string[], total: number}}
 */
export function findReferences(text) {
  const src = typeof text === 'string' ? text : ''
  const urls = src.match(URL_RE) ?? []
  let rest = src.replace(URL_RE, ' ')
  const dates = rest.match(ISO_DATE_RE) ?? []
  rest = rest.replace(ISO_DATE_RE, ' ')
  const issues = rest.match(ISSUE_RE) ?? []
  rest = rest.replace(ISSUE_RE, ' ')

  const shas = []
  for (const m of rest.matchAll(HEX_TOKEN_RE)) {
    const token = m[0]
    const before = rest.slice(Math.max(0, m.index - 16), m.index)
    const qualifies =
      token.length === 40 ||
      (/\d/.test(token) && /[a-f]/i.test(token)) ||
      COMMITISH_RE.test(before)
    if (qualifies) shas.push(token)
  }

  return { shas, dates, issues, urls, total: urls.length + dates.length + issues.length + shas.length }
}

/**
 * Triggers that name no kind of work. A rule that always applies is not a
 * rule, it is a mood.
 *
 * Matched against the WHOLE trigger after normalization, never as a substring:
 * "any change to the database schema" names a kind of work and must pass.
 */
const AMBIENT_TRIGGERS = new Set([
  'always',
  'every session',
  'all work',
  'any change',
  'everything',
  '*',
  'every time',
  'all the time',
  'anything',
  'any work',
  'every change',
  'all changes',
  'any changes',
  'all sessions',
  'any session',
  'every task',
  'all tasks',
  'any task',
  'everywhere',
])

function isAmbientTrigger(trigger) {
  const t0 = trigger.trim()
  if (/^[*_`\s]+$/.test(t0)) return true // a bare wildcard
  const normalized = t0
    .toLowerCase()
    .replace(/[`"'*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:on|for|during|in)\s+/, '')
    .replace(/[.!?;,]+$/, '')
    .trim()
  return AMBIENT_TRIGGERS.has(normalized)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Check a parsed rule.
 *
 * Synchronous, so it can be used inside a render loop or a status line. That
 * is why the reference resolver is synchronous too — see `gitRefResolver`. A
 * resolver that returns a promise is rejected loudly rather than treated as a
 * truthy "yes, that commit exists", which is the exact bug that would let
 * every citation pass unchecked.
 *
 * @param {object} parsed
 * @param {{resolveRef?: ((sha: string) => boolean|null)|false, root?: string,
 *          filename?: string, ratifying?: boolean, foreign?: boolean}} [opts]
 * @returns {{ok: boolean, problems: {code: string, severity: string, message: string, hint: string}[]}}
 */
export function validateRule(parsed, opts = {}) {
  if (!parsed || typeof parsed !== 'object') {
    throw new RuleError('validateRule expects a parsed rule', { code: 'BAD_INPUT' })
  }
  const { ratifying = false, foreign = false } = opts
  const filename = opts.filename ?? parsed.file ?? null

  /** @type {{code: string, severity: string, message: string, hint: string}[]} */
  const problems = []
  const add = (code, severity, message, hint) => problems.push({ code, severity, message, hint })

  const trigger = str(parsed.trigger)
  const ruleText = str(parsed.rule)
  const origin = str(parsed.origin)

  if (!trigger) {
    add('missing-section', 'error', '**Trigger:** is missing or empty.', 'Name the kind of work this fires on.')
  }
  if (!ruleText) {
    add('missing-section', 'error', '**Rule:** is missing or empty.', 'State one imperative rule, and what to do when its check fails.')
  }

  if (trigger && isAmbientTrigger(trigger)) {
    add(
      'trigger-too-broad',
      'error',
      `Trigger "${trigger}" fires ambiently.`,
      'A rule that always applies is not a rule, it is a mood. Name a describable kind of work — "any change to the auth flow", not "any change".',
    )
  }

  const ruleSections = (parsed.sections ?? []).filter((s) => s.key === 'rule')
  if (ruleSections.length > 1) {
    add(
      'multiple-rules',
      'error',
      `This file carries ${ruleSections.length} **Rule:** sections.`,
      'One rule per file. Split it, so each rule can be cited, ratified and retired on its own.',
    )
  }

  // --- Origin: the citation, and the whole reason this module exists.
  if (!origin) {
    if (foreign) {
      // A candidate legitimately has no Origin of your own — that is what
      // adopting supplies. Reporting it as a missing section would train
      // people to ignore the report.
      add(
        'origin-unverified',
        ratifying ? 'error' : 'warn',
        'This candidate carries no Origin of your own.',
        'Adopt it with your own incident: `harness rule adopt <name> --origin "<what happened here>"`.',
      )
    } else {
      add('missing-section', 'error', '**Origin:** is missing or empty.', 'Cite the incident that proved this rule — a commit SHA, a dated session, an issue.')
    }
  } else {
    const refs = findReferences(origin)
    const declaredUnverified = /\bunverified\b/i.test(origin)
    if (declaredUnverified || refs.total === 0) {
      add(
        'origin-unverified',
        // Warn while it sits in proposed/ — "I believe this but cannot cite it"
        // is an honest state and must be representable. Fatal at ratification,
        // because that is the moment the citation has to be real.
        ratifying ? 'error' : 'warn',
        declaredUnverified
          ? 'Origin is marked unverified.'
          : 'Origin cites nothing checkable — no commit, date, issue or URL.',
        'Before this can be ratified, point at the incident: a commit SHA, an ISO date, #123, or a URL.',
      )
    }
    if (refs.shas.length && opts.resolveRef !== false) {
      const resolveRef = opts.resolveRef ?? gitRefResolver(opts.root ?? process.cwd())
      const missing = []
      const unknown = []
      for (const sha of refs.shas) {
        const answer = resolveRef(sha)
        if (answer && typeof answer.then === 'function') {
          throw new RuleError(
            'resolveRef returned a promise, but validateRule is synchronous. ' +
              'An awaited-looking resolver would make every citation pass unchecked; pass a synchronous one.',
            { code: 'ASYNC_RESOLVER' },
          )
        }
        if (answer === true) continue
        // null means "could not ask" (no git, not a repo) — ignorance, not
        // evidence. exec.js draws the same line for the same reason.
        if (answer === null || answer === undefined) unknown.push(sha)
        else missing.push(sha)
      }
      if (missing.length) {
        add(
          'origin-unresolvable',
          foreign ? 'warn' : 'error',
          `Origin cites ${missing.length === 1 ? 'a commit' : 'commits'} not in this repository: ${missing.join(', ')}.`,
          foreign
            ? "That SHA belongs to the project this candidate came from, which is why adopting requires your own Origin."
            : 'Fix the SHA, or cite the incident another way. A citation nobody can follow is not a citation.',
        )
      }
      if (unknown.length) {
        add(
          'origin-unresolvable',
          'warn',
          `Could not check ${unknown.join(', ')} — git did not answer (not installed, or this is not a repository).`,
          'Not a verdict on the citation. Re-run inside the repo to check it.',
        )
      }
    }
  }

  const enforcement = str(parsed.enforcement).toLowerCase()
  if (!ENFORCEMENT_RE.test(enforcement)) {
    add(
      'enforcement-invalid',
      'error',
      enforcement
        ? `Enforcement "${parsed.enforcement}" is not one of memory | checklist | machine:<gate-id>.`
        : '**Enforcement:** is missing.',
      'Say how it is enforced: `memory` (an agent must remember), `checklist` (a human step), or `machine:<gate-id>` (a gate that fails the build).',
    )
  }

  const name = str(parsed.name)
  if (!name || !KEBAB_RE.test(name)) {
    add(
      'not-kebab-case',
      'warn',
      name ? `Rule name "${name}" is not kebab-case.` : 'This file has no H1 rule name.',
      'Name it like a file: `one-writer-per-repo`. The name is how it gets cited.',
    )
  }
  if (name && filename) {
    const stem = basename(filename).replace(/\.md$/i, '')
    if (stem !== name) {
      add(
        'name-mismatch',
        'warn',
        `H1 says "${name}" but the file is "${basename(filename)}".`,
        `Rename one of them so the rule can be found by the name people cite.`,
      )
    }
  }

  return { ok: !problems.some((p) => p.severity === 'error'), problems }
}

/**
 * The default Origin checker: does this repository contain that commit?
 *
 * Synchronous (spawnSync) so `validateRule` can stay synchronous, memoized
 * because a listing validates many rules that cite the same incident, and
 * tri-state: true = present, false = absent, null = could not ask. That last
 * one matters — "git is not installed" must never be reported as "your
 * citation is fake".
 *
 * The SHA is re-checked against a hex pattern here even though the parser
 * already matched one. This is the single place file content reaches a child
 * process, so it does not rely on a caller's parsing to stay safe; args are
 * passed as an array, never a shell string.
 *
 * @param {string} root
 * @returns {(sha: string) => boolean|null}
 */
export function gitRefResolver(root = process.cwd()) {
  const cache = new Map()
  return (sha) => {
    if (typeof sha !== 'string' || !/^[0-9a-fA-F]{7,40}$/.test(sha)) return false
    if (cache.has(sha)) return cache.get(sha)
    const res = spawnSync('git', ['-C', root, 'cat-file', '-e', `${sha}^{commit}`], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
    })
    let answer
    if (res.error || res.status === null) answer = null
    else if (res.status === 0) answer = true
    else if (/not a git repository|does not exist/i.test(res.stderr || '')) answer = null
    else answer = false
    cache.set(sha, answer)
    return answer
  }
}

// ---------------------------------------------------------------------------
// The directories
// ---------------------------------------------------------------------------

/**
 * Every rule file in the project, parsed and validated.
 *
 * Candidates are validated as `foreign`: their Origin belongs to the project
 * they came from, so an unresolvable SHA there is expected context rather than
 * a defect in this repo.
 *
 * @param {string} root
 * @param {{resolveRef?: ((sha: string) => boolean|null)|false}} [opts]
 * @returns {Promise<{active: object[], proposed: object[], candidates: object[], skipped: object[]}>}
 */
export async function listRules(root, opts = {}) {
  const resolveRef = opts.resolveRef ?? gitRefResolver(root)
  const out = { active: [], proposed: [], candidates: [], skipped: [] }

  for (const status of /** @type {const} */ (['active', 'proposed', 'candidates'])) {
    const dir = join(root, RULE_DIRS[status])
    let names
    try {
      names = await readdir(dir)
    } catch (err) {
      if (err.code === 'ENOENT') continue // a project with no case law yet
      throw new RuleError(`Cannot read ${RULE_DIRS[status]}: ${err.message}`, { code: 'UNREADABLE' })
    }

    for (const file of names.sort()) {
      const rel = `${RULE_DIRS[status]}/${file}`
      if (!isRuleFile(file)) {
        // README.md, WHY-THIS-IS-EMPTY.md and _template.md are prose for
        // humans and are meant to be here. Anything else that failed the
        // filename test is a rule someone misnamed, and saying nothing about
        // it would mean a rule that silently is not in force.
        if (file.toLowerCase().endsWith('.md') && !isProseFile(file)) {
          out.skipped.push({ status, file, path: rel, reason: 'not a lowercase kebab-case .md rule file' })
        }
        continue
      }
      let text
      try {
        text = await readFile(join(dir, file), 'utf8')
      } catch (err) {
        out.skipped.push({ status, file, path: rel, reason: err.code || err.message })
        continue
      }
      const parsed = parseRule(text, { path: rel })
      const validation = validateRule(parsed, {
        filename: file,
        foreign: status === 'candidates',
        resolveRef,
      })
      out[status].push({
        status,
        name: parsed.name || file.replace(/\.md$/i, ''),
        file,
        path: rel,
        parsed,
        validation,
        ok: validation.ok,
        hash: hash(text),
      })
    }
  }
  return out
}

/**
 * Draft a rule into proposed/.
 *
 * Any `Ratified` stamp in the incoming fields is dropped. A draft cannot
 * arrive pre-ratified; that mark is applied by `ratify` and by nothing else.
 *
 * @param {string} root
 * @param {object} fields
 * @param {{overwrite?: boolean, resolveRef?: ((sha: string) => boolean|null)|false}} [opts]
 */
export async function propose(root, fields, opts = {}) {
  const name = requireName(fields?.name)
  const path = ruleFile(root, 'proposed', name)

  if (await exists(ruleFile(root, 'active', name))) {
    throw new RuleError(
      `"${name}" is already active case law. Refusing to draft over it.`,
      { code: 'ALREADY_ACTIVE', name, path: relPath('active', name) },
    )
  }
  if (!opts.overwrite && (await exists(path))) {
    throw new RuleError(`${relPath('proposed', name)} already exists.`, {
      code: 'EXISTS',
      name,
      path: relPath('proposed', name),
    })
  }

  const text = serializeRule({ ...fields, name, ratified: null })
  const parsed = parseRule(text, { path: relPath('proposed', name) })
  const validation = validateRule(parsed, { filename: `${name}.md`, root, resolveRef: opts.resolveRef })

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
  return { name, path: relPath('proposed', name), parsed, validation, wrote: true }
}

/**
 * Promote proposed/ -> active/. The human gate.
 *
 * @param {string} root
 * @param {string} name
 * @param {{interactive?: boolean, ratifiedBy?: string, now?: Date|string,
 *          resolveRef?: ((sha: string) => boolean|null)|false}} [opts]
 */
export async function ratify(root, name, opts = {}) {
  // Asserted by the caller, never inferred here. A module that decides for
  // itself whether a human is present will eventually decide wrong, silently,
  // in CI.
  if (opts.interactive !== true) {
    throw new RuleError(
      'Ratification requires a human. Call with { interactive: true } from an interactive session — an agent cannot ratify its own proposal.',
      { code: 'NOT_INTERACTIVE', name },
    )
  }
  const ratifiedBy = cleanRatifier(opts.ratifiedBy)
  const ratifiedAt = isoDate(opts.now ?? new Date())

  // Paths come from the validated `name` argument only. Nothing in the file
  // chooses where it lands, whatever its H1 or body says.
  const from = ruleFile(root, 'proposed', name)
  const to = ruleFile(root, 'active', name)

  if (await exists(to)) {
    throw new RuleError(
      `"${name}" already exists in ${RULE_DIRS.active}. Refusing to overwrite active case law — retire it first, or ratify under a different name.`,
      { code: 'ALREADY_ACTIVE', name, path: relPath('active', name) },
    )
  }

  const text = await readRuleFile(from, name, 'proposed')
  const parsed = parseRule(text, { path: relPath('proposed', name) })
  const validation = validateRule(parsed, {
    filename: `${name}.md`,
    root,
    resolveRef: opts.resolveRef,
    ratifying: true, // an unverified Origin is fatal here, warn everywhere else
  })
  if (!validation.ok) {
    const errors = validation.problems.filter((p) => p.severity === 'error')
    throw new RuleError(
      `Cannot ratify "${name}": ${errors.map((e) => e.message).join(' ')}`,
      { code: 'BLOCKED', name, problems: errors, validation },
    )
  }

  // The stamp is built from the CALLER's identity and clock. Any `**Ratified:**`
  // already in the file — forged, copied, or left over — is overwritten here.
  const stamped = serializeRule({
    ...parsed,
    name: parsed.name || name,
    ratified: `${ratifiedAt} by ${ratifiedBy}`,
  })

  // Write the destination before removing the source: a crash between the two
  // leaves a duplicate to reconcile, which is recoverable, rather than a rule
  // that existed in neither directory.
  await mkdir(dirname(to), { recursive: true })
  await writeFile(to, stamped, 'utf8')
  await rm(from, { force: true })

  return {
    name,
    from: relPath('proposed', name),
    to: relPath('active', name),
    ratifiedBy,
    ratifiedAt,
    validation,
    warnings: validation.problems.filter((p) => p.severity === 'warn'),
  }
}

/**
 * Drop a proposal. Also a human act — deleting someone's draft on an agent's
 * say-so is the mirror image of ratifying on one. The removed text is returned
 * so the caller can log what was thrown away.
 *
 * @param {string} root
 * @param {string} name
 * @param {{interactive?: boolean, reason?: string}} [opts]
 */
export async function reject(root, name, opts = {}) {
  if (opts.interactive !== true) {
    throw new RuleError(
      'Rejecting a proposal requires a human. Call with { interactive: true }.',
      { code: 'NOT_INTERACTIVE', name },
    )
  }
  const path = ruleFile(root, 'proposed', name)
  const text = await readRuleFile(path, name, 'proposed')
  await rm(path, { force: true })
  return {
    name,
    path: relPath('proposed', name),
    reason: opts.reason ?? null,
    removed: text,
  }
}

/**
 * Take a shipped candidate and make it yours.
 *
 * The candidate's evidence is another project's. Inheriting it is exactly the
 * cargo-culting this tool exists to prevent, so `origin` is required and the
 * upstream one is demoted to `**Origin (upstream):**` — visible as context,
 * useless as a citation. The result lands in proposed/, never active/: an
 * adopted rule still has to pass a human.
 *
 * @param {string} root
 * @param {string} name
 * @param {{origin?: string, overwrite?: boolean, resolveRef?: ((sha: string) => boolean|null)|false}} [opts]
 */
export async function adopt(root, name, opts = {}) {
  const origin = typeof opts.origin === 'string' ? opts.origin.trim() : ''
  if (!origin) {
    throw new RuleError(
      `Adopting "${name}" requires your own Origin — the incident in THIS project that proved it. ` +
        "Inheriting the upstream project's evidence is the cargo-culting this tool exists to prevent.",
      { code: 'NO_ORIGIN', name },
    )
  }

  const from = ruleFile(root, 'candidates', name)
  const to = ruleFile(root, 'proposed', name)
  if (await exists(ruleFile(root, 'active', name))) {
    throw new RuleError(`"${name}" is already active case law.`, {
      code: 'ALREADY_ACTIVE',
      name,
      path: relPath('active', name),
    })
  }
  if (!opts.overwrite && (await exists(to))) {
    throw new RuleError(`${relPath('proposed', name)} already exists.`, {
      code: 'EXISTS',
      name,
      path: relPath('proposed', name),
    })
  }

  const text = await readRuleFile(from, name, 'candidates')
  const parsed = parseRule(text, { path: relPath('candidates', name) })

  // Upstream evidence, in whichever form the candidate carried it, becomes
  // context: `**Origin (upstream):**` already there, or a plain `**Origin:**`
  // demoted. Your Origin takes the slot theirs occupied, so the document keeps
  // the shape its author gave it and the two citations sit together.
  const upstreamKey = 'origin (upstream)'
  const upstreamIdx = parsed.sections.findIndex((s) => s.key === upstreamKey)
  const upstream = upstreamIdx !== -1 ? parsed.sections[upstreamIdx].value : parsed.origin

  const sections = parsed.sections.filter((s) => s.key !== upstreamKey)
  const extras = parsed.extras.filter((e) => e.key !== upstreamKey)

  let at = sections.findIndex((s) => s.key === 'origin')
  if (at === -1) {
    at = upstreamIdx !== -1 ? Math.min(upstreamIdx, sections.length) : canonicalOriginSlot(sections)
    sections.splice(at, 0, { label: 'Origin', key: 'origin', value: origin })
  }
  if (upstream) {
    const upstreamSection = { label: 'Origin (upstream)', key: upstreamKey, value: upstream }
    sections.splice(at + 1, 0, upstreamSection)
    extras.push(upstreamSection)
  }

  const out = serializeRule({
    ...parsed,
    name: parsed.name || name,
    origin,
    ratified: null, // upstream ratification does not travel
    extras,
    sections,
    footer: ADOPTED_FOOTER, // the candidate footer said "not in force"; it is now proposed
  })
  const reparsed = parseRule(out, { path: relPath('proposed', name) })
  const validation = validateRule(reparsed, {
    filename: `${name}.md`,
    root,
    resolveRef: opts.resolveRef,
  })

  await mkdir(dirname(to), { recursive: true })
  await writeFile(to, out, 'utf8')
  return {
    name,
    from: relPath('candidates', name),
    path: relPath('proposed', name),
    origin,
    upstreamOrigin: upstream,
    parsed: reparsed,
    validation,
  }
}

/**
 * Replaces the candidate's own "not in force" footer, which stops being true
 * the moment it is adopted. Deliberately tenseless: this line stays accurate
 * whether the rule is sitting in proposed/ or has since been ratified, so
 * nothing has to rewrite it later.
 */
const ADOPTED_FOOTER =
  '---\n' +
  "_Adopted from the harness candidate set. The upstream Origin above is that project's_\n" +
  '_evidence, not yours._'

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function str(v) {
  return typeof v === 'string' ? v.trim() : ''
}

/** Drop blank leading/trailing lines, keep the shape of what is inside. */
function trimBlock(text) {
  return text.replace(/^\s+/, '').replace(/\s+$/, '')
}

/** Where an Origin belongs when the file never had one: just above Enforcement. */
function canonicalOriginSlot(sections) {
  const rank = KNOWN_ORDER.indexOf('origin')
  const at = sections.findIndex((s) => KNOWN.has(s.key) && KNOWN_ORDER.indexOf(s.key) > rank)
  return at === -1 ? sections.length : at
}

function isRuleFile(file) {
  if (!file.toLowerCase().endsWith('.md')) return false
  return SAFE_NAME_RE.test(file.slice(0, -3))
}

/** Documentation that lives alongside the rules: `_template.md`, `README.md`, `WHY-THIS-IS-EMPTY.md`. */
function isProseFile(file) {
  const stem = file.slice(0, -3)
  return stem.startsWith('_') || stem.startsWith('.') || /^[A-Z0-9][A-Z0-9-]*$/.test(stem)
}

/**
 * The only place a rule filename is constructed.
 *
 * A rule name reaches us from files, CLI args and agent output, so it is
 * treated as hostile: kebab-case only, which cannot express `..`, a separator,
 * a drive letter or a leading dash.
 */
function ruleFile(root, dir, name) {
  return join(root, RULE_DIRS[dir], `${requireName(name)}.md`)
}

function requireName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new RuleError('A rule name is required', { code: 'BAD_NAME', name })
  }
  const trimmed = name.trim()
  if (trimmed.length > MAX_NAME_LEN || !SAFE_NAME_RE.test(trimmed)) {
    throw new RuleError(
      `"${trimmed}" is not a usable rule name. Use kebab-case: lowercase letters, digits and single hyphens.`,
      { code: 'BAD_NAME', name: trimmed, suggestion: slugify(trimmed) },
    )
  }
  return trimmed
}

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME_LEN)
}

function relPath(dir, name) {
  return `${RULE_DIRS[dir]}/${name}.md`
}

async function exists(p) {
  try {
    await lstat(p)
    return true
  } catch {
    return false
  }
}

/**
 * Read a rule file, refusing symlinks.
 *
 * A rule file is untrusted content in a directory an agent can write to. A
 * symlink there would let `ratify` copy something else entirely into active/
 * under a rule's name.
 */
async function readRuleFile(path, name, dir) {
  let st
  try {
    st = await lstat(path)
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new RuleError(`No rule named "${name}" in ${RULE_DIRS[dir]}.`, {
        code: 'NOT_FOUND',
        name,
        path: relPath(dir, name),
      })
    }
    throw new RuleError(`Cannot read ${relPath(dir, name)}: ${err.message}`, { code: 'UNREADABLE' })
  }
  if (st.isSymbolicLink()) {
    throw new RuleError(
      `${relPath(dir, name)} is a symlink. Rule files must be real files in the repo.`,
      { code: 'SYMLINK', name, path: relPath(dir, name) },
    )
  }
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    throw new RuleError(`Cannot read ${relPath(dir, name)}: ${err.message}`, { code: 'UNREADABLE' })
  }
}

/**
 * The ratifier's name is written into the file. Flattened first, because a
 * name carrying a newline and `**Something:**` could forge a section — the one
 * place caller-supplied text becomes document structure.
 */
function cleanRatifier(who) {
  if (typeof who !== 'string' || !who.trim()) {
    throw new RuleError(
      'ratify() needs opts.ratifiedBy — the human doing the ratifying. It is never taken from the file.',
      { code: 'NO_RATIFIER' },
    )
  }
  const flat = who.replace(/\s+/g, ' ').replace(/[*`]/g, '').trim()
  if (!flat) throw new RuleError('opts.ratifiedBy is empty after normalization', { code: 'NO_RATIFIER' })
  return flat
}

function isoDate(now) {
  const d = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(d.getTime())) {
    throw new RuleError(`"${now}" is not a date`, { code: 'BAD_DATE' })
  }
  return d.toISOString().slice(0, 10)
}

export class RuleError extends Error {
  constructor(message, meta = {}) {
    super(message)
    this.name = 'RuleError'
    Object.assign(this, meta)
  }
}
