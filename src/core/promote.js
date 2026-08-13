/**
 * The ladder climber: turning a prose rule into a gate.
 *
 * `harness rule promote <name>` asks what part of the rule is mechanically
 * checkable, builds a gate definition, runs it across the whole tree to see
 * what it would catch TODAY, and only then writes it — as `warn`.
 *
 * Two things this deliberately does NOT do:
 *
 *  - It does not claim the rule is now mechanised. A gate catches the part that
 *    is expressible; the prose stays authoritative for the rest. The rule's
 *    Enforcement line becomes `machine:<id>`, and the rule text stays.
 *  - It does not start blocking. Existing violations are surfaced first and
 *    must be fixed, grandfathered with a reason AND an expiry, or the gate is
 *    dropped. A gate that blocks the moment it is born blocks work that was
 *    already there, which is how gates get disabled on day one.
 */

import { validateGate } from './gates.js'
import { isoDate, addDays } from './dates.js'

/** What a rule can plausibly be mechanised into, given what it says. */
export const MECHANISABLE = [
  {
    kind: 'banned-content',
    question: 'Is there a string or pattern that must never appear?',
    example: 'an em dash in user-facing copy; console.log in shipped code',
    scaffold: ({ paths, patterns, message, origin }) => ({
      kind: 'banned-content', paths, patterns, message, origin,
    }),
  },
  {
    kind: 'required-content',
    question: 'Is there a string that must always be present?',
    example: 'a licence header; a required frontmatter key',
    scaffold: ({ paths, patterns, message, origin }) => ({
      kind: 'required-content', paths, required: patterns, message, origin,
    }),
  },
  {
    kind: 'cross-file',
    question: 'Must two files agree with each other?',
    example: 'a manifest and the content it indexes; a schema and its migration',
    scaffold: ({ paths, extract, assert: assertions, message, origin }) => ({
      kind: 'cross-file', paths, extract, assert: assertions, message, origin,
    }),
  },
  {
    kind: 'paired-edit',
    question: 'Does editing one thing require editing another in the same change?',
    example: 'touching the schema requires a migration',
    scaffold: ({ paths, pairedWith, message, origin }) => ({
      kind: 'paired-edit', paths, pairedWith, message, origin,
    }),
  },
  {
    kind: 'path-scope',
    question: 'Are there paths nothing should write to?',
    example: 'generated directories; vendored code',
    scaffold: ({ paths, message, origin }) => ({ kind: 'path-scope', paths, message, origin }),
  },
  {
    kind: 'shell',
    question: 'Is it only checkable by running a command?',
    example: 'a linter or a bespoke script',
    scaffold: ({ paths, command, message, origin }) => ({
      kind: 'shell', paths, command, message, origin,
    }),
  },
]

/**
 * Suggest which gate kinds fit a rule, by reading what the rule actually says.
 * A hint to order the menu, never a decision — the human picks.
 */
export function suggestKinds(rule) {
  const text = `${rule.trigger || ''} ${rule.rule || ''}`.toLowerCase()
  const score = new Map(MECHANISABLE.map((m) => [m.kind, 0]))
  const bump = (kind, n = 1) => score.set(kind, score.get(kind) + n)

  if (/\b(never|must not|no |ban|forbid|avoid)\b/.test(text)) bump('banned-content', 2)
  if (/\b(always|must (be )?(present|include)|require)\b/.test(text)) bump('required-content', 2)
  if (/\b(in sync|agree|match(es)?|consistent|both files|same commit)\b/.test(text)) bump('cross-file', 2)
  if (/\b(same commit|alongside|together with|migration)\b/.test(text)) bump('paired-edit', 2)
  // More specific than a bare "never": these words name a place, not a prohibition.
  if (/\b(generated|vendored|do not (edit|touch)|read-only)\b/.test(text)) bump('path-scope', 3)
  if (/\b(run|command|script|lint|assert)\b/.test(text)) bump('shell', 1)

  return MECHANISABLE
    .map((m) => ({ ...m, score: score.get(m.kind) }))
    .sort((a, b) => b.score - a.score)
}

/**
 * Build the gate a promotion would write. Pure, so the CLI can show it before
 * anything is saved — show-before-write applies to gates too.
 */
export function buildGate({ rule, kind, answers = {} }) {
  const spec = MECHANISABLE.find((m) => m.kind === kind)
  if (!spec) throw new Error(`No such gate kind: ${kind}`)

  const id = answers.id || rule.name
  const gate = {
    id,
    severity: 'warn', // always: a gate earns `block`, it is never born with it
    origin: rule.file || `docs/rules/active/${rule.name}.md`,
    message: answers.message || firstSentence(rule.rule) || `Violates ${rule.name}.`,
    ...spec.scaffold({
      paths: answers.paths || [],
      patterns: answers.patterns || [],
      extract: answers.extract,
      assert: answers.assert,
      pairedWith: answers.pairedWith,
      command: answers.command,
      message: answers.message || firstSentence(rule.rule),
      origin: rule.file || `docs/rules/active/${rule.name}.md`,
    }),
  }

  const problems = validateGate(gate)
  return { gate, problems, ok: !problems.some((p) => p.severity === 'error') }
}

/**
 * Turn a baseline run into the three choices a human has for pre-existing
 * violations. Never silently grandfathers: the caller must choose per finding,
 * and grandfathering demands a reason and an expiry.
 */
export function baselineDisposition(findings, { now = new Date(), graceDays = 90 } = {}) {
  const expires = addDays(now, graceDays)
  return {
    count: findings.length,
    clean: findings.length === 0,
    choices: ['fix', 'grandfather', 'drop'],
    suggestedExpiry: isoDate(expires),
    findings,
    note:
      findings.length === 0
        ? 'Nothing to clean up. The gate starts on warn and can earn block once it has caught something real.'
        : `${findings.length} existing violation(s). Fix them, grandfather each with a reason and an expiry, or drop the gate — a gate born blocking work that already existed gets disabled on day one.`,
  }
}

/** The rule's Enforcement line after promotion. */
export function enforcementLine(gateId) {
  return `machine:${gateId}`
}

function firstSentence(s) {
  if (!s) return ''
  const m = String(s).trim().match(/^.*?[.!?](\s|$)/)
  return (m ? m[0] : String(s)).trim().slice(0, 200)
}
