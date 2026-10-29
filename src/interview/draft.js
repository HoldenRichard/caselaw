/**
 * The agent's draft of the interview, and the human's confirmation of it.
 *
 * DEF-274: on three outside repositories the lines caselaw derived by itself
 * were the wrong ones, and only what a person typed was specific. An agent that
 * has read the repository can draft those answers. But a draft is a claim, and
 * a claim is re-derived, not carried: the study behind this tool sent a false
 * signing claim to an app reviewer from an agent's memory (DEF-216), and this
 * tool's own README said its source app had shipped when it had not (DEF-748).
 * So every drafted answer names its evidence, the evidence is checked to exist,
 * and a human confirms the draft before anything is generated from it: at a
 * terminal, answer by answer; or in chat, after which `--yes` records it.
 *
 *   caselaw init --draft        write .caselaw/draft.json: every question, what
 *                               detection already knows, and room for answers
 *   (the agent fills it in, then shows the human)
 *   caselaw init --from-draft   confirm it, then generate exactly as `init` does
 */

import { readFile, writeFile, mkdir, rm, access } from 'node:fs/promises'
import { dirname, join, normalize, isAbsolute } from 'node:path'
import { QUESTIONS, optionsFor, TRIAGE_OPTIONS } from './questions.js'
import { SKIPPED } from '../core/answers.js'
import { normalize as normalizeText } from '../core/text.js'

export const DRAFT_PATH = '.caselaw/draft.json'
export const DRAFT_VERSION = 1
export const UNKNOWN = '?'

/** What the agent is told, inside the file it fills in. */
export const HOW_TO_FILL = [
  'Read the README, CONTRIBUTING, CI configuration and docs before answering. The detected block below is what caselaw found on its own; it is a starting point, not an answer.',
  'For each question set "answer", and list "evidence": a path in this repository ("README.md"), a path and line ("CONTRIBUTING.md:42"), or "command: <what you ran>". Paths are checked; one that does not exist fails the draft.',
  'Use option values exactly as listed. Where "allowOther" is true you may add free-text strings for boundaries the options miss.',
  `If the repository does not establish an answer, set "answer" to "${UNKNOWN}". It becomes a visible gap. Never guess: a confident wrong answer is read and believed, and a gap is not.`,
  'Leave "answer" null for a question that does not apply (the interview skips it).',
  'A question marked "alreadyAnswered" was answered earlier by a human. Leave it as it is: a draft does not replace a human answer unless the human runs --from-draft with --reconfigure.',
  'For each surface you name in outside.claims, list in "declarations" under that surface the concrete claims it makes, each as { "claim", "evidence", "truth", "rederive", "checked" }: the claim as the surface states it, evidence naming the file and line that holds it, where the truth lives (a file, a command, a dashboard), and a command that re-derives it if one exists. Leave "checked" empty unless you re-derived the claim from the product just now; an unchecked claim is the point of the register, not a flaw in it.',
  'Then show the human every answer with its evidence and wait for them to confirm or correct it. Only after that run `caselaw init --from-draft --yes`; without a terminal, --yes is the record that a human confirmed.',
]

/** The draft for this repository, carrying any answers already on file. */
export function buildDraft({ doc, detected }) {
  const ctx = { detected, answers: doc.answers }
  return {
    draftVersion: DRAFT_VERSION,
    project: doc.project ?? {},
    howToFill: HOW_TO_FILL,
    detected: {
      languages: (detected.stack?.languages || []).slice(0, 5).map((l) => `${l.name} ${l.pct}%`),
      buildSystem: detected.stack?.buildSystem ?? null,
      commands: Object.fromEntries(Object.entries(detected.commands || {}).filter(([, v]) => v?.cmd).map(([k, v]) => [k, v.cmd])),
      deploySurface: (detected.deploySurface || []).map((d) => d.kind),
      signals: detected.signals ?? {},
      generatedDocs: detected.stack?.generatedDocs ?? [],
      publishing: detected.publishing ?? [],
      ciGates: detected.ciGates ?? { gates: [], shared: [] },
    },
    questions: QUESTIONS.map((q) => ({
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      ...(q.help ? { help: q.help } : {}),
      ...(q.type === 'triage'
        ? { over: q.over, shape: `an object: each answer to ${q.over} -> one of ${TRIAGE_OPTIONS.map((o) => o.value).join(' | ')}` }
        : {}),
      ...(q.type === 'select' || q.type === 'multiselect' || q.type === 'triage'
        ? { options: (q.type === 'triage' ? TRIAGE_OPTIONS : optionsFor(q, ctx)).map(({ value, label }) => ({ value, label })) }
        : {}),
      ...(q.allowOther ? { allowOther: true } : {}),
      ...(q.type === 'number' ? { min: q.min, max: q.max, default: q.default } : {}),
      ...(hasAnswer(doc, q.id) ? { alreadyAnswered: true } : {}),
      answer: doc.answers?.[q.id] ?? null,
      evidence: [],
    })),
    // Not a question: the claims themselves, which the register needs and a
    // short interview cannot ask for. Keyed by the surfaces in outside.claims.
    declarations: doc.answers?.declarations ?? {},
  }
}

/**
 * Problems with the drafted declarations. Every new claim names the file that
 * holds it; claims a human already recorded are carried without evidence.
 */
async function declarationProblems(draft, { root, doc }) {
  const errors = []
  const decl = draft.declarations
  if (decl === undefined || decl === null) return errors
  if (typeof decl !== 'object' || Array.isArray(decl)) return ['declarations: expected an object of surface -> list of claims.']
  const surfaces = new Set((draft.questions || []).find((q) => q.id === 'outside.claims')?.answer || doc.answers?.['outside.claims'] || [])
  const existing = doc.answers?.declarations || {}
  for (const [surface, entries] of Object.entries(decl)) {
    if (!surfaces.has(surface)) { errors.push(`declarations.${surface}: not one of the surfaces answered in outside.claims.`); continue }
    if (!Array.isArray(entries)) { errors.push(`declarations.${surface}: expected a list of claims.`); continue }
    for (const [i, e] of entries.entries()) {
      const at = `declarations.${surface}[${i}]`
      if (!e || typeof e.claim !== 'string' || !e.claim.trim()) { errors.push(`${at}: a declaration needs the claim itself.`); continue }
      if ((existing[surface] || []).some((x) => JSON.stringify(stripEvidence(x)) === JSON.stringify(stripEvidence(e)))) continue
      const ev = Array.isArray(e.evidence) ? e.evidence.filter((x) => typeof x === 'string' && x.trim()) : []
      if (!ev.length) { errors.push(`${at}: name the file and line that holds this claim.`); continue }
      for (const x of ev) {
        const missing = await evidenceProblem(root, x)
        if (missing) errors.push(`${at}: evidence "${x}" ${missing}.`)
      }
      if (e.checked && !/^\d{4}-\d{2}-\d{2}$/.test(e.checked)) errors.push(`${at}: "checked" is a date (YYYY-MM-DD) or empty.`)
    }
  }
  return errors
}

const stripEvidence = ({ evidence, ...rest } = {}) => rest

/**
 * The drafted declarations, kept or dropped as a whole: at a terminal the
 * human sees each claim with the line that holds it; with `accept`, they were
 * confirmed in chat. Returns the provenance entry, or null when nothing applied.
 */
export async function applyDeclarations(draft, doc, { confirmWith = null, accept = false } = {}) {
  const decl = draft.declarations
  const entries = Object.values(decl || {}).flat()
  if (!entries.length) return null
  if (confirmWith) {
    confirmWith.note(`Public claims the agent recorded (${entries.length}):\n${Object.entries(decl)
      .flatMap(([s, list]) => list.map((e) => `  ${s}: "${e.claim}"  (${(e.evidence || []).join(', ') || 'recorded earlier'})`)).join('\n')}`)
    const keep = await confirmWith.select({
      id: 'declarations#confirm',
      prompt: '  Keep these declarations?',
      options: [{ value: 'keep', key: 'k', label: 'keep them' }, { value: 'drop', key: 'd', label: 'drop them; I will record claims myself' }],
    })
    if (keep !== 'keep') return null
  } else if (!accept) {
    return null
  }
  doc.answers.declarations = Object.fromEntries(Object.entries(decl).map(([s, list]) => [s, list.map(stripEvidence)]))
  return {
    by: 'agent-draft',
    evidence: [...new Set(entries.flatMap((e) => e.evidence || []))],
    confirmed: confirmWith ? 'at a terminal' : 'in chat (--yes)',
  }
}

const hasAnswer = (doc, id) => Object.prototype.hasOwnProperty.call(doc.answers || {}, id)

export async function writeDraft(root, draft) {
  const p = join(root, DRAFT_PATH)
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify(draft, null, 2) + '\n', 'utf8')
  return p
}

export async function loadDraft(root) {
  try {
    return JSON.parse(normalizeText(await readFile(join(root, DRAFT_PATH), 'utf8')))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw new Error(`${DRAFT_PATH} is unreadable: ${err.message}`)
  }
}

export async function removeDraft(root) {
  await rm(join(root, DRAFT_PATH), { force: true })
}

/**
 * Everything wrong with a filled draft, as messages a person can act on.
 * An answer is only as good as what it rests on, so evidence is required for
 * every answer and every path it names is checked against the repository.
 *
 * @returns {Promise<string[]>}
 */
export async function validateDraft(draft, { root, detected, doc = { answers: {} } }) {
  const errors = []
  if (!draft || draft.draftVersion !== DRAFT_VERSION) {
    return [`${DRAFT_PATH}: expected draftVersion ${DRAFT_VERSION}; regenerate it with \`caselaw init --draft\`.`]
  }
  const known = new Map(QUESTIONS.map((q) => [q.id, q]))
  const answers = Object.fromEntries((draft.questions || []).map((d) => [d.id, d.answer]))
  for (const d of draft.questions || []) {
    const q = known.get(d.id)
    if (!q) { errors.push(`${d.id}: no such question in this version of caselaw.`); continue }
    if (d.answer === null || d.answer === undefined || d.answer === UNKNOWN) continue
    // A human's earlier answer, carried through unchanged, needs no evidence.
    if (hasAnswer(doc, d.id) && JSON.stringify(doc.answers[d.id]) === JSON.stringify(d.answer)) continue
    const problem = shapeProblem(q, d.answer, { detected, answers })
    if (problem) errors.push(`${d.id}: ${problem}`)
    const ev = Array.isArray(d.evidence) ? d.evidence.filter((e) => typeof e === 'string' && e.trim()) : []
    if (!ev.length) { errors.push(`${d.id}: an answer with no evidence. Name the file or command it rests on, or answer "${UNKNOWN}".`); continue }
    for (const e of ev) {
      const missing = await evidenceProblem(root, e)
      if (missing) errors.push(`${d.id}: evidence "${e}" ${missing}.`)
    }
  }
  return [...errors, ...(await declarationProblems(draft, { root, doc }))]
}

function shapeProblem(q, value, { detected, answers }) {
  switch (q.type) {
    case 'text':
      return typeof value === 'string' ? null : 'expected text.'
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'expected a number.'
      if ((q.min != null && value < q.min) || (q.max != null && value > q.max)) return `expected a number between ${q.min} and ${q.max}.`
      return null
    case 'confirm':
      return typeof value === 'boolean' ? null : 'expected true or false.'
    case 'select': {
      const values = optionsFor(q, { detected, answers }).map((o) => o.value)
      return values.includes(value) ? null : `"${value}" is not one of ${values.join(', ')}.`
    }
    case 'multiselect': {
      if (!Array.isArray(value)) return 'expected a list.'
      const values = new Set(optionsFor(q, { detected, answers }).map((o) => o.value))
      const stray = value.filter((v) => typeof v !== 'string' || (!values.has(v) && !q.allowOther))
      return stray.length ? `not among the options, and this question takes no free text: ${stray.join(', ')}.` : null
    }
    case 'triage': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return 'expected an object of boundary -> physical | chosen | untested.'
      const over = new Set(answers[q.over] || [])
      const kinds = new Set(TRIAGE_OPTIONS.map((o) => o.value))
      const bad = Object.entries(value).filter(([k, v]) => !over.has(k) || !kinds.has(v)).map(([k, v]) => `${k}: ${v}`)
      return bad.length ? `each key must be an answer to ${q.over} and each value physical, chosen or untested; got ${bad.join(', ')}.` : null
    }
    default:
      return `cannot check a "${q.type}" answer.`
  }
}

/** Null when the evidence holds up; otherwise what is wrong with it. */
async function evidenceProblem(root, e) {
  if (/^command:\s*\S/.test(e)) return null
  const path = e.replace(/:\d+(-\d+)?$/, '')
  if (isAbsolute(path) || normalize(path).startsWith('..')) return 'points outside the repository'
  try { await access(join(root, path)); return null } catch { return 'names a file that does not exist here' }
}

/**
 * A prompt adapter that answers from the draft. With a terminal, each drafted
 * answer is shown with its evidence and kept or replaced by the human; without
 * one, drafted answers stand only when `accept` is set (the human confirmed in
 * chat). A question the draft left open goes to the human when there is one,
 * and becomes a gap when there is not.
 *
 * `provenance` records, per question, who answered and on what evidence; it is
 * written into answers.json and rendered into the authority split.
 */
export function draftPrompt(draft, { confirmWith = null, accept = false } = {}) {
  const byId = new Map((draft.questions || []).map((d) => [d.id, d]))
  const provenance = {}

  const drafted = (id) => {
    const [base, item] = id.split(':')
    const d = byId.get(base)
    if (!d || d.answer === null || d.answer === undefined) return { has: false }
    if (item !== undefined) {
      if (d.answer === UNKNOWN) return { has: true, value: UNKNOWN, evidence: d.evidence || [] }
      const v = d.answer?.[item]
      return v === undefined ? { has: false } : { has: true, value: v, evidence: d.evidence || [] }
    }
    return { has: true, value: d.answer, evidence: d.evidence || [] }
  }

  const record = (id, entry) => {
    const [base, item] = id.split(':')
    if (item === undefined) { provenance[base] = entry; return }
    // Triage arrives item by item; keep the weakest confirmation of the set.
    const prev = provenance[base]
    provenance[base] = !prev ? entry : { ...prev, by: prev.by === entry.by ? prev.by : 'agent-draft and human' }
  }

  async function answer(kind, q) {
    const d = drafted(q.id)
    if (!d.has) {
      if (!confirmWith) return SKIPPED
      const v = await confirmWith[kind](q)
      if (v !== SKIPPED) record(q.id, { by: 'human' })
      return v
    }
    if (d.value === UNKNOWN) return SKIPPED
    if (confirmWith) {
      confirmWith.note(`${q.prompt}\n  Drafted: ${show(d.value, q)}\n  From: ${d.evidence.join(', ')}`)
      const keep = await confirmWith.select({
        id: `${q.id}#confirm`,
        prompt: '  Keep the drafted answer?',
        options: [{ value: 'keep', key: 'k', label: 'keep it' }, { value: 'change', key: 'c', label: 'answer it myself' }],
      })
      if (keep === SKIPPED) return SKIPPED
      if (keep === 'change') {
        const v = await confirmWith[kind](q)
        if (v !== SKIPPED) record(q.id, { by: 'human' })
        return v
      }
      record(q.id, { by: 'agent-draft', evidence: d.evidence, confirmed: 'at a terminal' })
      return d.value
    }
    if (!accept) return SKIPPED
    record(q.id, { by: 'agent-draft', evidence: d.evidence, confirmed: 'in chat (--yes)' })
    return d.value
  }

  return {
    provenance,
    text: (q) => answer('text', q),
    number: (q) => answer('number', q),
    select: (q) => answer('select', q),
    multiselect: (q) => answer('multiselect', q),
    confirm: (q) => answer('confirm', q),
    note: (m) => confirmWith?.note(m),
    close: async () => { await confirmWith?.close() },
  }
}

function show(value, q) {
  if (Array.isArray(value)) {
    const labels = new Map((q.options || []).map((o) => [o.value, o.label]))
    return value.map((v) => labels.get(v) || `"${v}"`).join('; ') || '(none)'
  }
  if (value && typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
