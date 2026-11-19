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

import { readFile, rm, access } from 'node:fs/promises'
import { dirname, join, normalize, isAbsolute } from 'node:path'
import { QUESTIONS, optionsFor, TRIAGE_OPTIONS, NONE_VALUE } from './questions.js'
import { SKIPPED } from '../core/answers.js'
import { DRAFTED_REACH_TAIL, settleProblem } from '../generate/authority-split.js'
import { kindAt, refusal } from '../core/fsguard.js'
import { atomicWrite, writeExclusive } from '../core/safe-write.js'
import { normalize as normalizeText } from '../core/text.js'
import { HOST_IDS, detectedHosts, cleanHosts } from '../adapters/index.js'

export const DRAFT_PATH = '.caselaw/draft.json'
export const DRAFT_VERSION = 1
export const UNKNOWN = '?'

/** What the agent is told, inside the file it fills in. */
export const HOW_TO_FILL = [
  'Run setup in chat. Read the repo instructions, README, manifests and CI. Fill in the answers those files establish. Detection already supplies build, test, CI, publishing and local git-hook gate facts (detected.localGates: a hooks directory the repo wires with core.hooksPath; read the script and treat it as the local verification gate); do not ask the user to repeat them. A declared command is not evidence that it ran. Carry scan-limit and unread-CI warnings into the setup summary; review omitted areas directly when they matter.',
  'Use the suggested answers as a starting point. Verify their sources, keep repository facts separate from local capabilities, and bundle the recommended rules and review cadence into the approval summary. Review triggered recommendations against the actual workflow. A changelog or a test credential fixture may not justify an extra operating rule. Do not ask separate questions about commands, defaults, or a review interval.',
  'Ask at most two short, project-specific questions in one chat message if needed. Lead with the boundary that matters here: name the actual device, service, data or release step and ask what only a human may do and how they verify it. Ask about an external decision-maker only if it changes the handoff and the repo does not settle it.',
  'Do not infer access or authorization from a dependency, language, README or CI workflow. Classify what is established as physical or chosen; mark assumptions untested and say why. Fold remaining low-impact choices into one short setup preview, using the ask-first preset unless the user requests otherwise. List any defaults or triggered rules you recommend enabling in that preview.',
  'For repo facts, set "answer" and "evidence". "evidence" is always an ARRAY of strings, never a bare string: each is "path:line" (for example "README.md:127"), a repo-relative path, or "command: <what you ran>". The cited line must say what the answer claims; a blank line or an unrelated one is flagged before the user confirms. An answer follows its question\'s type: text is a string, multiselect is an array of option values, triage is an object. For an answer the user actually gave in chat, set "source" to "human" and leave "evidence" empty. The user can approve preferences together in the preview.',
  `Under "hosts", list the agent tools to wire: ${HOST_IDS.join(', ')}. It is prefilled from what the repo shows; add the tool you are running in yourself (you know which it is), plus any other the repo uses. agents-md is always installed. Each listed tool gets its instruction bridge and live hooks; do not ask the user which tools they use.`,
  'Use option values as listed, with free text only where "allowOther" is true. If nothing applies to a list question that offers "none", answer ["none"] and cite what shows it. For triggered rules, consider outside-authority and public-claims answers first, then validate the selection with the dry run.',
  `If an applicable answer is unknown, set "answer" to "${UNKNOWN}". Leave inapplicable questions null. Never guess.`,
  'Keep answers marked "alreadyAnswered" unless the user requested reconfiguration.',
  'Under "declarations", record concrete public claims as an object keyed by surface (a value of outside.claims) whose value is an array: { "<surface>": [ { "claim": "<the claim as the file states it>", "evidence": ["README.md:127"], "truth": "<what is actually true>", "rederive": "<the command or file that re-checks it>", "checked": "" } ] }. "evidence" is an array of "path:line" strings; leave "checked" empty unless you re-derived the claim now (then YYYY-MM-DD).',
  'For untested boundaries, add "notes" entries shaped as { "<boundary>": { "reason": "<why it is assumed>", "evidence": ["path:line"], "settle": "<optional command>" } }, one per boundary named in authority.cannot. "settle" is optional: one single-line command a person can run to settle the boundary, without a backtick or a pipe. Offer one only if you know it is safe to run; it is shown in the boundary\'s row and in the audit.',
  'The "example" object in this file shows each shape filled in. Copy its structure, not its content.',
  'Run `caselaw init --from-draft --dry-run`. In chat, summarize what can be checked, what stays with the human, what is uncertain, and which rules and files will be installed. Keep the evidence in the draft and cite the key sources in the summary.',
  'After the user approves the setup in chat, run `caselaw init --from-draft --yes` yourself, then verify the generated setup. The user does not need to run any command.',
]

/**
 * Each shape the agent fills in, filled in. Shown in the draft file itself:
 * a contract that only describes its shapes in prose is how declarations
 * evidence ended up a string where an array was needed.
 */
export const DRAFT_EXAMPLE = {
  questions: [{ id: 'authority.human_proof', answer: 'Run the app on a device and tap through checkout.', evidence: ['README.md:40'] }],
  declarations: { readme: [{ claim: 'Requires macOS 14 or later', evidence: ['README.md:12'], truth: 'the deployment target', rederive: 'MACOSX_DEPLOYMENT_TARGET in the project file', checked: '' }] },
  notes: { device: { reason: 'No device is attached in this environment.', evidence: ['command: xcrun simctl list devices'] } },
}

/** The draft for this repository, carrying any answers already on file. */

/**
 * The agent tool this setup is running inside, when it says so in the
 * environment (Claude Code sets CLAUDECODE=1 for its shell). Field tests of
 * 0.5.0: agents left the prefill at agents-md alone and wired nothing for
 * themselves, although the instructions told them to add their own tool.
 */
function runningHost(env = process.env) {
  return env.CLAUDECODE === '1' ? ['claude-code'] : []
}

export function buildDraft({ doc, detected, previous = null }) {
  const suggested = {}
  const commands = Object.entries(detected.commands || {})
    .filter(([name, entry]) => name !== 'format' && entry?.cmd && entry.source && !entry.source.startsWith('xcodebuild'))
    .map(([, entry]) => entry)
  const gates = detected.ciGates?.gates || []
  const checks = gates.length ? gates : commands
  const evidence = [...new Set(gates.length ? gates.map((g) => g.file) : commands.map((c) => c.source.split(':')[0]))]
  // Hooks the repo ships and wires with core.hooksPath are its local gate.
  const local = detected.hooks?.localGates || []
  if (checks.length || local.length) {
    const parts = []
    if (checks.length) {
      const commandsText = [...new Set(checks.map((c) => c.cmd))].join('; ')
      const hasContext = checks.some((c) => c.workingDirectory || c.shell || c.condition || c.jobCondition || c.continueOnError)
      const description = commandsText.length <= 350 && !hasContext
        ? `these verification commands: ${commandsText}`
        : `${checks.length} verification steps in ${evidence.join(', ')}; consult those sources for the complete commands and job prerequisites`
      parts.push(`The repository declares ${description}.`)
    }
    if (local.length) {
      parts.push(`It ships local git hooks: ${local.map((g) => `${g.files.join(', ')} (enabled with \`${g.wiring}\`${g.wired === false ? '; not enabled in this clone' : ''})`).join('; ')}.`)
      evidence.push(...local.flatMap((g) => [g.documentedIn, g.files[0]].filter(Boolean)))
    }
    suggested['authority.agent_reach'] = {
      answer: `${parts.join(' ')} ${DRAFTED_REACH_TAIL}`,
      evidence: [...new Set(evidence)],
    }
  }
  const claims = detected.signals?.claims || []
  if (claims.length) {
    const available = new Set(optionsFor(QUESTIONS.find((q) => q.id === 'outside.claims'), { detected }).map((o) => o.value))
    suggested['outside.claims'] = {
      answer: [...new Set(claims.map((c) => c.kind).filter((kind) => available.has(kind)))],
      evidence: [...new Set(claims.map((c) => c.source))],
    }
  }
  const saved = new Map((previous?.questions || []).map((q) => [q.id, q]))
  const answers = { ...doc.answers }
  for (const q of QUESTIONS) {
    const carried = saved.get(q.id)
    const suggestion = suggested[q.id]
    if (hasAnswer(doc, q.id)) continue
    if (carried?.answer != null) answers[q.id] = carried.answer
    else if (suggestion) answers[q.id] = suggestion.answer
    else if (q.preference && q.default !== undefined) answers[q.id] = q.default
    else if (q.id === 'harness.defaults') answers[q.id] = optionsFor(q, { detected, answers }).map((o) => o.value)
    else if (q.id === 'authority.retest_days') answers[q.id] = q.default
  }
  const ctx = { detected, answers: Object.fromEntries(Object.entries(answers).filter(([, value]) => value !== UNKNOWN)) }
  const triggers = QUESTIONS.find((q) => q.id === 'harness.triggers')
  if (!hasAnswer(doc, triggers.id) && saved.get(triggers.id)?.answer == null) {
    answers[triggers.id] = optionsFor(triggers, ctx).map((o) => o.value)
  }
  return {
    draftVersion: DRAFT_VERSION,
    project: doc.project ?? {},
    ...(previous?.doctrineDir ? { doctrineDir: previous.doctrineDir } : {}),
    ...(previous?.modules ? { modules: previous.modules } : {}),
    // Not a question: which agent tools get bridges and hooks. A draft in
    // progress wins, then an earlier install's record, then what the repo shows.
    hosts: cleanHosts(previous?.hosts) ?? cleanHosts(doc.hosts) ?? cleanHosts([...detectedHosts(detected), ...runningHost()]),
    howToFill: HOW_TO_FILL,
    example: DRAFT_EXAMPLE,
    detected: {
      warnings: detected.warnings || [],
      languages: (detected.stack?.languages || []).slice(0, 5).map((l) => `${l.name} ${l.pct}%`),
      buildSystem: detected.stack?.buildSystem ?? null,
      commands: Object.fromEntries(Object.entries(detected.commands || {}).filter(([, v]) => v?.cmd).map(([k, v]) => [k, v.cmd])),
      deploySurface: (detected.deploySurface || []).map((d) => d.kind),
      signals: detected.signals ?? {},
      generatedDocs: detected.stack?.generatedDocs ?? [],
      publishing: detected.publishing ?? [],
      ciGates: detected.ciGates ?? { gates: [], setup: [], shared: [], contexts: [], unread: [], unresolved: [] },
      localGates: detected.hooks?.localGates ?? [],
      instructions: detected.instructions ?? { files: [], prChecklist: null, mentions: [] },
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
      ...(q.preference ? { preference: true } : {}),
      ...(q.type === 'select' && q.default !== undefined ? { default: q.default } : {}),
      ...(q.defaultAll ? { default: optionsFor(q, ctx).map((o) => o.value) } : {}),
      ...(q.type === 'number' ? { min: q.min, max: q.max, default: q.default } : {}),
      ...(hasAnswer(doc, q.id) ? { alreadyAnswered: true } : {}),
      answer: answers[q.id] ?? null,
      evidence: saved.get(q.id)?.answer != null ? saved.get(q.id).evidence || [] : suggested[q.id]?.evidence || [],
      ...(saved.get(q.id)?.source ? { source: saved.get(q.id).source } : {}),
    })),
    // Not a question: the claims themselves, which the register needs and a
    // short interview cannot ask for. Keyed by the surfaces in outside.claims.
    declarations: previous?.declarations ?? doc.answers?.declarations ?? {},
    // Why each untested boundary is assumed. Nothing collected this before, and
    // the authority split printed "not recorded" in its place (DEF-274 re-score).
    notes: previous?.notes ?? {},
  }
}

async function noteProblems(draft, { root }) {
  const errors = []
  const notes = draft.notes
  if (!notes || typeof notes !== 'object' || Array.isArray(notes)) return notes == null ? errors : ['notes: expected an object of boundary -> { reason, evidence }.']
  const named = new Set((draft.questions || []).find((q) => q.id === 'authority.cannot')?.answer || [])
  for (const [b, n] of Object.entries(notes)) {
    if (!named.has(b)) { errors.push(`notes.${b}: not one of the answers to authority.cannot.`); continue }
    if (!n || typeof n.reason !== 'string' || !n.reason.trim()) { errors.push(`notes.${b}: a note needs its reason.`); continue }
    if (n.evidence !== undefined && !Array.isArray(n.evidence)) { errors.push(`notes.${b}: ${EVIDENCE_SHAPE}`); continue }
    if (n.settle !== undefined) {
      const bad = settleProblem(n.settle)
      if (bad) errors.push(`notes.${b}.settle: ${bad}`)
    }
    for (const x of n.evidence ?? []) {
      const missing = await evidenceProblem(root, x)
      if (missing) errors.push(`notes.${b}: evidence "${x}" ${missing}.`)
    }
  }
  return errors
}

/** The drafted notes, applied on the same confirmation as everything else. */
export function applyNotes(draft, doc, { confirmed = null } = {}) {
  const entries = Object.entries(draft.notes || {}).filter(([, n]) => n && n.reason)
  if (!entries.length || !confirmed) return null
  doc.answers['authority.notes'] = { ...(doc.answers['authority.notes'] || {}), ...Object.fromEntries(entries.map(([b, n]) => [b, n.reason])) }
  // The command that would settle a boundary, when the note names one: the
  // authority split prints it in the boundary's row and the audit repeats it.
  const settle = entries.filter(([, n]) => n.settle !== undefined && !settleProblem(n.settle)).map(([b, n]) => [b, n.settle.trim()])
  if (settle.length) doc.answers['authority.settle'] = { ...(doc.answers['authority.settle'] || {}), ...Object.fromEntries(settle) }
  return { by: 'agent-draft', evidence: [...new Set(entries.flatMap(([, n]) => n.evidence || []))], confirmed }
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
      if (e.evidence !== undefined && e.evidence !== null && !Array.isArray(e.evidence)) { errors.push(`${at}: ${EVIDENCE_SHAPE}`); continue }
      const ev = (e.evidence ?? []).filter((x) => typeof x === 'string' && x.trim())
      if (!ev.length) { errors.push(`${at}: name the file and line that holds this claim, as "evidence": ["README.md:127"].`); continue }
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

const EVIDENCE_SHAPE = '"evidence" must be an array of strings, for example ["README.md:127"] or ["command: npm test"], not a single string or an object.'

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
    confirmed: confirmWith ? 'at a terminal' : 'with the setup summary (--yes)',
  }
}

const hasAnswer = (doc, id) => Object.prototype.hasOwnProperty.call(doc.answers || {}, id)

async function checkedDraftPath(root) {
  const p = join(root, DRAFT_PATH)
  const parent = await kindAt(dirname(p))
  if (parent !== 'missing' && parent !== 'dir') throw new Error('.caselaw must be a real directory.')
  const reason = refusal(await kindAt(p))
  if (reason) throw new Error(`${DRAFT_PATH} ${reason}.`)
  return p
}

export async function writeDraft(root, draft, { replace = false } = {}) {
  const p = await checkedDraftPath(root)
  const write = replace ? atomicWrite : writeExclusive
  await write(p, JSON.stringify(draft, null, 2) + '\n')
  return p
}

export async function loadDraft(root) {
  const p = await checkedDraftPath(root)
  try {
    return JSON.parse(normalizeText(await readFile(p, 'utf8')))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw new Error(`${DRAFT_PATH} is unreadable: ${err.message}`)
  }
}

export async function removeDraft(root) {
  await rm(await checkedDraftPath(root), { force: true })
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
  if (draft.hosts !== undefined && (!Array.isArray(draft.hosts) || draft.hosts.some((h) => !HOST_IDS.includes(h)))) {
    errors.push(`hosts: expected a list drawn from ${HOST_IDS.join(', ')}.`)
  }
  const known = new Map(QUESTIONS.map((q) => [q.id, q]))
  const answers = Object.fromEntries((draft.questions || []).filter((d) => d.answer != null && d.answer !== UNKNOWN).map((d) => [d.id, d.answer]))
  for (const d of draft.questions || []) {
    const q = known.get(d.id)
    if (!q) { errors.push(`${d.id}: no such question in this version of caselaw.`); continue }
    if (d.answer === null || d.answer === undefined || d.answer === UNKNOWN) continue
    // A human's earlier answer, carried through unchanged, needs no evidence.
    if (hasAnswer(doc, d.id) && JSON.stringify(doc.answers[d.id]) === JSON.stringify(d.answer)) continue
    const problem = shapeProblem(q, d.answer, { detected, answers })
    if (problem) errors.push(`${d.id}: ${problem}`)
    // Human answers and preferences are confirmed at review, without file citations.
    if (d.source === 'human') {
      if (d.evidence?.length) errors.push(`${d.id}: a human chat answer must leave evidence empty.`)
      continue
    }
    if (q.preference) continue
    if (d.evidence !== undefined && d.evidence !== null && !Array.isArray(d.evidence)) { errors.push(`${d.id}: ${EVIDENCE_SHAPE}`); continue }
    const ev = (d.evidence ?? []).filter((e) => typeof e === 'string' && e.trim())
    if (!ev.length) { errors.push(`${d.id}: an answer with no evidence. Set "evidence" to an array naming the file or command it rests on, such as ["README.md:12"] or ["command: npm test"], or answer "${UNKNOWN}".`); continue }
    for (const e of ev) {
      const missing = await evidenceProblem(root, e)
      if (missing) errors.push(`${d.id}: evidence "${e}" ${missing}.`)
    }
  }
  return [...errors, ...(await declarationProblems(draft, { root, doc })), ...(await noteProblems(draft, { root }))]
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
      if (value.includes(NONE_VALUE) && value.length > 1 && values.has(NONE_VALUE)) return `"${NONE_VALUE}" is an answer on its own; drop it or drop the others.`
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

/** A test runner, as CI invokes one. */
const TEST_RUNNER = /\b(pytest|go test|cargo test|(npm|yarn|pnpm)( run)? test|jest|vitest|mocha|tox|nox|swift test|dotnet test|rspec|mvn\b.*\b(test|verify)|gradlew?\b.*\b(test|check)|make (test|check)[\w-]*)\b/

/**
 * What a person should check before confirming a draft that holds up. Not
 * errors: the answer may be right, and the human decides. Round 4 of the
 * DEF-274 re-score: an agent drafted pyvisa's boundary as "run the full test
 * suite" while CI runs pytest on every change; only the Keysight-assisted
 * subset could not run.
 *
 * @returns {string[]}
 */
export function draftDoubts(draft, detected = {}) {
  const answers = Object.fromEntries((draft.questions || []).map((d) => [d.id, d.answer]))
  const cannot = Array.isArray(answers['authority.cannot']) ? answers['authority.cannot'] : []
  const out = []
  if (cannot.includes('full-suite')) {
    const runner = (detected.ciGates?.gates || []).find((g) => TEST_RUNNER.test(g.cmd))
    if (runner) out.push(`"run the full test suite" is drafted as something the agent cannot do, but CI runs \`${runner.cmd}\` on every change (\`${runner.file}:${runner.line}\`). If only part of the suite cannot run here, name that part as the boundary instead.`)
  }
  return out
}

/** The lines of a file, as an array without the empty one a trailing newline leaves; null for a directory or an unreadable file. */
async function fileLines(root, path) {
  try {
    const lines = (await readFile(join(root, path), 'utf8')).split(/\r?\n/)
    if (lines.at(-1) === '') lines.pop()
    return lines
  } catch {
    return null
  }
}

/** Null when the evidence holds up; otherwise what is wrong with it. A line that does not exist is an error. */
async function evidenceProblem(root, e) {
  if (/^command:\s*\S/.test(e)) return null
  const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(e)
  const path = m ? m[1] : e
  if (isAbsolute(path) || normalize(path).startsWith('..')) return 'points outside the repository'
  try { await access(join(root, path)) } catch { return 'names a file that does not exist here' }
  if (!m) return null
  const lines = await fileLines(root, path)
  if (lines === null) return 'cites a line in something that is not a readable file'
  const [from, to] = [Number(m[2]), Number(m[3] || m[2])]
  if (from < 1 || to < from) return 'names an impossible line range (lines start at 1)'
  if (to > lines.length) return `names line ${to}, but ${path} has ${lines.length} line${lines.length === 1 ? '' : 's'}`
  return null
}

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'not', 'you', 'your', 'its', 'all', 'any', 'can', 'has', 'have', 'will', 'our', 'more', 'than', 'into', 'use', 'uses', 'used', 'which', 'when', 'where', 'also', 'but', 'over'])

/** The words that could make one text support another: lowercased, plural-trimmed, no stopwords; numbers count. */
function meaningfulWords(text) {
  const out = new Set()
  for (const raw of String(text).toLowerCase().match(/[a-z0-9][a-z0-9.+_-]*/g) || []) {
    let w = raw.replace(/[.+_-]+$/, '')
    if (w.length > 3 && w.endsWith('s')) w = w.slice(0, -1)
    if ((w.length >= 3 || /^\d+$/.test(w)) && !STOPWORDS.has(w)) out.add(w)
  }
  return out
}

/**
 * What a person should look at in the drafted evidence, none of it an error:
 * a cited line that is blank (the 0.4.2 field test accepted `README.md:127`, a
 * blank line, as the evidence for "312 tests"), or one that shares no
 * meaningful word with the claim it is cited for. A line that exists is not a
 * line that supports; the person confirming decides.
 *
 * @returns {Promise<string[]>}
 */
export async function evidenceWarnings(draft, { root, doc = { answers: {} } } = {}) {
  const out = []
  const short = (t) => (String(t).length > 80 ? `${String(t).slice(0, 77)}...` : String(t))
  const look = async (label, evidence, claim) => {
    for (const e of Array.isArray(evidence) ? evidence : []) {
      if (typeof e !== 'string' || /^command:/.test(e) || await evidenceProblem(root, e)) continue
      const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(e)
      const lines = await fileLines(root, m ? m[1] : e)
      if (lines === null) continue
      const cited = m ? lines.slice(Number(m[2]) - 1, Math.min(Number(m[3] || m[2]), Number(m[2]) + 19)) : lines
      if (m && cited.every((l) => !l.trim())) {
        out.push(`${label}: evidence "${e}" is ${cited.length > 1 ? 'only blank lines' : 'a blank line'}, so it cannot support the claim. Cite the line that states it.`)
        continue
      }
      if (!claim) continue
      const have = meaningfulWords(cited.join(' '))
      if (![...meaningfulWords(claim)].some((w) => have.has(w))) {
        out.push(`${label}: evidence "${e}" shares no meaningful word with the claim "${short(claim)}"${m ? `; the cited line reads "${short(cited[0].trim())}"` : ''}. Cite the line that states it, or check the claim.`)
      }
    }
  }
  for (const d of draft?.questions || []) {
    if (d.answer == null || d.answer === UNKNOWN || d.source === 'human' || !Array.isArray(d.evidence)) continue
    if (hasAnswer(doc, d.id) && JSON.stringify(doc.answers[d.id]) === JSON.stringify(d.answer)) continue
    // A free-text answer is a claim like a declaration's: the cited line should
    // say it (0.5.0 field test: package.json's version line was accepted as
    // evidence for an answer about a release console). Option answers carry
    // only a value, so they keep the blank-line check alone.
    await look(d.id, d.evidence, typeof d.answer === 'string' ? d.answer : null)
  }
  const existing = doc.answers?.declarations || {}
  for (const [surface, entries] of Object.entries(draft?.declarations || {})) {
    for (const [i, e] of (Array.isArray(entries) ? entries : []).entries()) {
      if (!e || typeof e.claim !== 'string' || (existing[surface] || []).some((x) => JSON.stringify(stripEvidence(x)) === JSON.stringify(stripEvidence(e)))) continue
      await look(`declarations.${surface}[${i}]`, e.evidence, e.claim)
    }
  }
  for (const [b, n] of Object.entries(draft?.notes || {})) await look(`notes.${b}`, n?.evidence, null)
  return out
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
export function draftPrompt(draft, { confirmWith = null, accept = false, root = null } = {}) {
  const byId = new Map((draft.questions || []).map((d) => [d.id, d]))
  const provenance = {}

  const drafted = (id) => {
    const [base, item] = id.split(':')
    const d = byId.get(base)
    if (!d || d.answer === null || d.answer === undefined) return { has: false }
    if (item !== undefined) {
      if (d.answer === UNKNOWN) return { has: true, value: UNKNOWN, evidence: d.evidence || [] }
      const v = d.answer?.[item]
      return v === undefined ? { has: false } : { has: true, value: v, evidence: d.evidence || [], source: d.source }
    }
    return { has: true, value: d.answer, evidence: d.evidence || [], source: d.source }
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
      // The lines themselves, not just their paths: evidence that exists is not
      // evidence that supports (the study's DEF-238; three drafted claims in the
      // DEF-274 re-score cited real files that did not say what was claimed).
      const quoted = root ? await quoteEvidence(root, d.evidence) : d.evidence.map((e) => `    ${e}`)
      confirmWith.note(`${q.prompt}\n  Drafted: ${show(d.value, q)}\n  Resting on:\n${quoted.join('\n')}`)
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
    record(q.id, { by: d.source === 'human' ? 'human' : 'agent-draft', evidence: d.evidence, confirmed: d.source === 'human' ? 'in chat (--yes)' : 'with the setup summary (--yes)' })
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

/**
 * Each piece of evidence as the lines it names (up to three per citation), so
 * the person confirming reads what the answer rests on, not where.
 */
export async function quoteEvidence(root, evidence = []) {
  const out = []
  for (const e of evidence) {
    const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(e)
    if (/^command:/.test(e) || !m) { out.push(`    ${e}`); continue }
    const [path, from, to] = [m[1], Number(m[2]), Number(m[3] || m[2])]
    try {
      const lines = (await readFile(join(root, path), 'utf8')).split(/\r?\n/)
      for (let n = from; n <= Math.min(to, from + 2); n++) out.push(`    ${path}:${n}  ${(lines[n - 1] ?? '').trim().slice(0, 140)}`)
      if (to > from + 2) out.push(`    … to line ${to}`)
    } catch {
      out.push(`    ${e}  (could not be read)`)
    }
  }
  return out
}

/** The whole draft as a sheet a person can read in chat before `--yes`. */
export async function draftSheet(root, draft) {
  const out = []
  if (Array.isArray(draft.hosts)) out.push('', `  Agent tools to wire: ${draft.hosts.join(', ')}`)
  for (const q of draft.questions || []) {
    if (q.answer === null || q.answer === undefined || q.alreadyAnswered) continue
    out.push('', `  ${q.prompt}`, `    → ${q.answer === UNKNOWN ? 'not known (a visible gap)' : show(q.answer, q)}`)
    if (q.source === 'human') out.push('    Answer supplied in chat.')
    out.push(...(await quoteEvidence(root, q.evidence || [])))
  }
  for (const [surface, list] of Object.entries(draft.declarations || {})) {
    for (const e of list || []) {
      out.push('', `  Declaration (${surface}): "${e.claim}"`, ...(await quoteEvidence(root, e.evidence || [])))
    }
  }
  return out
}
