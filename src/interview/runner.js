/**
 * The interview runner.
 *
 * Enforces the four rules that keep a fifteen-minute interview at fifteen
 * minutes, all of which are checkable rather than aspirational:
 *
 *  1. A hard question budget per session. The runner refuses to exceed it —
 *     if a session grows, a question gets cut, not the cap raised.
 *  2. One question at a time, ranked by (impact × still-unanswered).
 *  3. Write-back after EVERY answer, so an interrupted interview resumes.
 *  4. `?` records an explicit hole. The runner never guesses, and never
 *     silently omits — the hole is rendered into the artifact and reported
 *     by the audit.
 */

import { questionsFor, rank, optionsFor, sessionMeta, SESSIONS } from './questions.js'
import { setAnswer, SKIPPED } from '../core/answers.js'

/**
 * Run one session.
 *
 * @param {object} o
 * @param {number} o.session
 * @param {object} o.doc          answers document (mutated + persisted per answer)
 * @param {object} o.detected     Stage 0 report
 * @param {object} o.prompt       prompt adapter
 * @param {(doc:object)=>Promise<void>} [o.persist]  called after each answer
 */
export async function runSession({ session, doc, detected, prompt, persist, reconfigure = false }) {
  const meta = sessionMeta(session)
  if (!meta) throw new Error(`No such session: ${session}`)

  // Already-answered questions are not re-asked. Without this, `init` run a
  // second time re-interrogates the user and — worse — an empty or piped
  // stdin silently replaces good answers with holes. Re-asking is opt-in via
  // `reconfigure`, so destroying an existing answer is always deliberate.
  const settled = (id) =>
    !reconfigure &&
    (Object.prototype.hasOwnProperty.call(doc.answers, id) || doc.unanswered.some((u) => u.id === id))

  prompt.note(`\n── Session ${meta.n}/${SESSIONS.length}: ${meta.title} · ~${meta.minutes} min`)

  const asked = []
  const seen = new Set()

  // Eligibility is recomputed after every answer, not resolved up front.
  // Most of session 1 is gated on the answer to its own first question, so a
  // set computed against empty answers would filter out everything that
  // matters and silently ask two questions instead of five.
  for (;;) {
    const eligible = questionsFor(session, doc.answers, detected).filter(
      (q) => !seen.has(q.id) && !settled(q.id),
    )
    if (eligible.length === 0) break

    if (asked.length >= meta.budget) {
      // The static invariant is asserted by the test suite; this is the
      // runtime backstop so a bad edit reaches a developer as an error rather
      // than reaching a user as a twenty-question interrogation.
      throw new Error(
        `Session ${session} (${meta.title}) still has ${eligible.length} question(s) ` +
          `after spending its budget of ${meta.budget}. Cut a question rather than raising the cap.`,
      )
    }

    const q = rank(eligible, doc.answers)[0]
    const value = await askOne(q, { doc, detected, prompt })
    setAnswer(doc, q.id, value, { question: q })
    seen.add(q.id)
    asked.push(q.id)
    if (persist) await persist(doc)
  }

  return { asked, session }
}

/** Ask a single question, dispatching on its declared type. */
export async function askOne(q, { doc, detected, prompt }) {
  const ctx = { detected, answers: doc.answers }

  switch (q.type) {
    case 'text':
      return prompt.text(q)

    case 'number':
      return prompt.number(q)

    case 'confirm':
      return prompt.confirm(q)

    case 'select':
      return prompt.select({ ...q, options: optionsFor(q, ctx) })

    case 'multiselect':
      return prompt.multiselect({ ...q, options: optionsFor(q, ctx) })

    case 'triage':
      return askTriage(q, { doc, prompt })

    default:
      throw new Error(`Question "${q.id}" has unknown type "${q.type}"`)
  }
}

/**
 * The triage interaction: for each item the user already selected, classify
 * the boundary. Asked as a run of one-keystroke selects rather than a single
 * compound question, because a compound question is where people start
 * answering carelessly — and this particular answer is the one the whole
 * artifact is built on.
 */
async function askTriage(q, { doc, prompt }) {
  const items = doc.answers[q.over] || []
  if (!items.length) return {}

  prompt.note(`\n${q.prompt}`)
  if (q.help) prompt.note(`  ${q.help}`)

  const out = {}
  for (const item of items) {
    const value = await prompt.select({
      id: `${q.id}:${item}`,
      prompt: `  “${labelFor(item, q)}” —`,
      options: q.options,
    })
    if (value === SKIPPED) continue // an unclassified boundary is a hole, not a default
    out[item] = value
  }
  return out
}

function labelFor(item, q) {
  const known = (q.itemLabels || {})[item]
  return known || item
}

/** Run every session in order. */
export async function runInterview({ doc, detected, prompt, persist, reconfigure = false, sessions = SESSIONS.map((s) => s.n) }) {
  const transcript = []
  for (const n of sessions) {
    if (!questionsFor(n, doc.answers, detected).length) continue
    transcript.push(await runSession({ session: n, doc, detected, prompt, persist, reconfigure }))
  }
  return transcript
}
