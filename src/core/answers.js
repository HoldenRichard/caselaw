/**
 * answers.json — the canonical artifact.
 *
 * Everything this tool generates is a pure function of this file plus a
 * template version. That is what makes upgrades, idempotent re-runs, drift
 * detection and multi-repo consistency possible instead of "run it once and
 * hope". Users are meant to edit it by hand; it is committed; it diffs well.
 *
 * Written after EVERY answer, not at the end. An interview interrupted at
 * question three leaves a valid file that `init --resume` can pick up, which
 * is the difference between a fifteen-minute commitment and a fifteen-minute
 * gamble.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const ANSWERS_PATH = '.harness/answers.json'
export const SCHEMA_VERSION = 1

export function emptyAnswers({ templateVersion = '1.0', project = {} } = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    templateVersion,
    project,
    answers: {},
    unanswered: [],
    detected: null,
  }
}

export async function load(root) {
  try {
    const raw = await readFile(join(root, ANSWERS_PATH), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      throw new AnswersError(
        `answers.json is schema v${parsed.schemaVersion}, this CLI speaks v${SCHEMA_VERSION}. ` +
          `Run \`harness upgrade\` — refusing to act on a shape I do not understand.`,
        { code: 'SCHEMA_MISMATCH' },
      )
    }
    return parsed
  } catch (err) {
    if (err.code === 'ENOENT') return null
    if (err instanceof AnswersError) throw err
    throw new AnswersError(`${ANSWERS_PATH} is unreadable: ${err.message}`, { code: 'UNREADABLE' })
  }
}

export async function save(root, doc) {
  const p = join(root, ANSWERS_PATH)
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  return doc
}

/**
 * Record one answer. `SKIPPED` is a real, first-class value: it means the human
 * was asked and declined to say, which is different from never having been
 * asked, and different again from an answer of "none". Generators render it as
 * a visible hole; the audit reports it. A confident generated lie is worse.
 */
export const SKIPPED = Symbol.for('harness.skipped')

export function setAnswer(doc, id, value, { question } = {}) {
  if (value === SKIPPED) {
    delete doc.answers[id]
    if (!doc.unanswered.some((u) => u.id === id)) {
      doc.unanswered.push({
        id,
        prompt: question?.prompt || id,
        generates: question?.generates || [],
      })
    }
    return doc
  }
  doc.answers[id] = value
  doc.unanswered = doc.unanswered.filter((u) => u.id !== id)
  return doc
}

export function getAnswer(doc, id) {
  return doc.answers[id]
}

export function isAnswered(doc, id) {
  return Object.prototype.hasOwnProperty.call(doc.answers, id)
}

/** Was this explicitly skipped, as opposed to never reached? */
export function isSkipped(doc, id) {
  return doc.unanswered.some((u) => u.id === id)
}

export class AnswersError extends Error {
  constructor(message, meta = {}) {
    super(message)
    this.name = 'AnswersError'
    Object.assign(this, meta)
  }
}
