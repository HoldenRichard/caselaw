/** Shared checks for the shipped rules (not a test file: node --test only runs *.test.js). */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DEFAULTS_ROOT } from '../../../src/core/defaults.js'

export const RULES_TEMPLATES = join(DEFAULTS_ROOT, '../rules')

/** The distinct kinds of project a rule's section of PRECEDENT.md cites (`- DEF-n, an iOS app, 2026-08-16: ...`). */
export function precedentProjects(file, name) {
  const section = new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(file)?.[1] ?? ''
  return new Set([...section.matchAll(/^- [\w-]+, ([^,]+), \d{4}-\d{2}-\d{2}: /gm)].map((m) => m[1]))
}

/** A shipped rule is read by strangers on every session it triggers: no private names, and short. */
export function assertStrangerReadable(body, name) {
  assert.doesNotMatch(body, /Kabu|Reprompt|\bStir\b|DEF-\d|the study|marketing pipeline|defect ledger/i, `${name} names a private project or ledger id`)
  const words = (body.match(/\S+/g) || []).length
  assert.ok(words <= 175, `${name} is ${words} words; a loaded rule is its statement and a pointer to the evidence`)
}
