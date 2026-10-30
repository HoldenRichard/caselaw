/**
 * Self-update (0.3): the harness changing itself, under the constitution.
 *
 * Every change to the harness is a proposal with local evidence (an incident
 * someone can follow) and the signal it should improve, like a rule with an
 * Origin. Under "Tune itself", a change that tunes a parameter within 25%, or
 * only adds enforcement, or only narrows what the agent may do, applies on its
 * own, once a week per mechanism; everything else waits for a human, and what
 * the constitution forbids is refused. Each applied change records the value
 * of its signal; after its window the audit asks whether it helped, and a
 * change that did not is proposed for reverting (C1, applied to the harness).
 *
 * The log (.caselaw/harness-log.jsonl) is append-only and committed: it is
 * evidence, like the catches.
 */

import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { findReferences, demote, RuleError } from './rules.js'
import { DEFAULTS, DEMOTION_DAYS } from './defaults.js'
import { TRIGGERS } from './triggers.js'
import { measureLoad, optimizerSignals, LOAD_BUDGET_WORDS } from './optimizer.js'
import { constitutionLine } from './constitution.js'

export const HARNESS_LOG = '.caselaw/harness-log.jsonl'
export const TUNE_BOUND = 0.25
export const TUNE_EVERY_DAYS = 7
export const DEFAULT_WINDOW_DAYS = 30
const DAY = 86_400_000

/**
 * The parameters a change may set. `weaker(from, to)` says which direction
 * loosens enforcement: past the tuning bound, that direction needs a human.
 */
export const PARAMS = {
  'harness.load_budget': { default: LOAD_BUDGET_WORDS, min: 500, max: 20000, weaker: (from, to) => to > from, describe: 'the words a session may load before the optimizer is due' },
  'harness.demotion_days': { default: DEMOTION_DAYS, min: 14, max: 365, weaker: (from, to) => to < from, describe: 'the days a borrowed rule has to catch something' },
  'authority.retest_days': { default: 30, min: 7, max: 365, weaker: (from, to) => to > from, describe: 'the days before an untested boundary is due a re-test' },
}

/** The signals a change can name, each measured the same way before and after. */
export const SIGNALS = {
  'load-words': { better: 'lower', describe: 'the words of governance a session loads' },
  compactions: { better: 'lower', describe: 'automatic context compactions in the last 14 days' },
  'idle-borrowed': { better: 'lower', describe: 'borrowed rules that caught nothing in their window' },
}

const AUTONOMY_ORDER = ['ask-first', 'custom', 'tune-itself']

/** Free-text changes that would make an outward-facing action automatic (A4), erase evidence (A2, A3), or touch the constitution (A5). */
const FORBIDDEN_NOTES = [
  [/\b(auto(matic(ally)?)?|on its own|without (asking|a human|approval))\b[^.]{0,60}\b(push|publish|release|deploy|submit|send|email|message|pay|spend|purchase|delete)\b|\b(push|publish|release|deploy|submit|send|email|pay|spend|delete)\w*\b[^.]{0,60}\b(automatic(ally)?|on its own|without (asking|a human|approval))\b/i, 'A4'],
  [/\b(delete|remove|rewrite|erase|truncate|edit)\b[^.]{0,40}\b(catch(es)?|harness log|log entr(y|ies)|origins?|evidence|precedent)\b/i, 'A2'],
  [/\bconstitution\b/i, 'A5'],
]

const current = (doc, key) => (Number.isFinite(doc?.answers?.[key]) ? doc.answers[key] : PARAMS[key].default)
const mechanismOf = (change) => (change.op === 'set' ? change.key : change.op === 'autonomy' ? 'autonomy' : change.op === 'note' ? 'note' : 'rules')
const findDefault = (id) => DEFAULTS.find((d) => d.id === id) || TRIGGERS.find((t) => t.id === id)

export function describeChange(c) {
  switch (c.op) {
    case 'set': return `set ${c.key} from ${c.from} to ${c.value}`
    case 'enable': return `put ${c.id} in force`
    case 'disable': return `take ${c.id} out of force`
    case 'autonomy': return `move the autonomy preset from ${c.from} to ${c.value}`
    default: return `by hand: ${c.text}`
  }
}

/**
 * What kind of change this is, and which articles of the constitution it
 * touches. `forbidden` is refused outright; any article means a human.
 *
 * @returns {{kind: 'tune'|'strengthen'|'narrow'|'weaken'|'widen'|'other'|'forbidden'|'invalid', articles: string[], reason: string, change: object}}
 */
export function classify(change, doc = {}) {
  const c = { ...change }
  switch (c.op) {
    case 'set': {
      const p = PARAMS[c.key]
      if (!p) return { kind: 'invalid', articles: [], reason: `${c.key} is not a setting a change may make; settable: ${Object.keys(PARAMS).join(', ')}`, change: c }
      const to = Number(c.value)
      if (!Number.isFinite(to) || to < p.min || to > p.max) return { kind: 'invalid', articles: [], reason: `${c.key} takes a number from ${p.min} to ${p.max}`, change: c }
      c.from = current(doc, c.key)
      c.value = to
      const delta = Math.abs(to - c.from) / c.from
      if (delta === 0) return { kind: 'invalid', articles: [], reason: `${c.key} is already ${to}`, change: c }
      if (delta <= TUNE_BOUND) return { kind: 'tune', articles: [], reason: `a ${Math.round(delta * 100)}% change, within the ${TUNE_BOUND * 100}% tuning bound`, change: c }
      if (p.weaker(c.from, to)) return { kind: 'weaken', articles: ['A1'], reason: `${Math.round(delta * 100)}% in the direction that loosens it, past the tuning bound`, change: c }
      return { kind: 'other', articles: [], reason: `${Math.round(delta * 100)}%, past the tuning bound`, change: c }
    }
    case 'enable':
    case 'disable': {
      if (!findDefault(c.id)) return { kind: 'invalid', articles: [], reason: `${c.id} is not a default (D1-D6) or a trigger (T1-T7)`, change: c }
      const list = c.id.startsWith('D') ? doc.answers?.['harness.defaults'] : doc.answers?.['harness.triggers']
      const on = Array.isArray(list) && list.includes(c.id)
      if (c.op === 'enable') return on ? { kind: 'invalid', articles: [], reason: `${c.id} is already in force`, change: c } : { kind: 'strengthen', articles: [], reason: 'it only adds enforcement', change: c }
      return on ? { kind: 'weaken', articles: ['A1'], reason: 'it takes a rule out of force', change: c } : { kind: 'invalid', articles: [], reason: `${c.id} is not in force`, change: c }
    }
    case 'autonomy': {
      const to = AUTONOMY_ORDER.indexOf(c.value)
      if (to === -1) return { kind: 'invalid', articles: [], reason: `the presets are ${AUTONOMY_ORDER.join(', ')}`, change: c }
      c.from = doc.answers?.['harness.autonomy'] || 'ask-first'
      const from = AUTONOMY_ORDER.indexOf(c.from)
      if (to === from) return { kind: 'invalid', articles: [], reason: `the preset is already ${c.value}`, change: c }
      return to > from
        ? { kind: 'widen', articles: ['A1'], reason: 'it lets more change without a human', change: c }
        : { kind: 'narrow', articles: [], reason: 'it lets less change without a human', change: c }
    }
    case 'note': {
      const text = String(c.text || '').trim()
      if (!text) return { kind: 'invalid', articles: [], reason: 'say what should change', change: c }
      for (const [re, article] of FORBIDDEN_NOTES) if (re.test(text)) return { kind: 'forbidden', articles: [article], reason: constitutionLine(article), change: c }
      return { kind: 'other', articles: [], reason: 'a change made by hand, recorded here', change: c }
    }
    default:
      return { kind: 'invalid', articles: [], reason: 'a change sets, enables, disables, moves the autonomy preset, or is a note', change: c }
  }
}

export async function readLog(root) {
  let text
  try { text = await readFile(join(root, HARNESS_LOG), 'utf8') } catch { return [] }
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

/** Appended, never rewritten (A2). */
async function append(root, entry) {
  await mkdir(dirname(join(root, HARNESS_LOG)), { recursive: true })
  await appendFile(join(root, HARNESS_LOG), JSON.stringify(entry) + '\n', 'utf8')
}

/** Every change with its state: proposed, applied, rejected; reverted changes point to their revert. */
export function changes(log) {
  const byId = new Map()
  for (const e of log) {
    if (e.type === 'proposed') byId.set(e.id, { ...e, state: 'proposed' })
    const c = byId.get(e.id)
    if (!c) continue
    if (e.type === 'applied') Object.assign(c, { state: 'applied', appliedAt: e.at, appliedBy: e.by, baseline: e.baseline })
    if (e.type === 'rejected') Object.assign(c, { state: 'rejected', rejectedAt: e.at })
  }
  for (const c of byId.values()) if (c.reverts && byId.get(c.reverts) && c.state === 'applied') byId.get(c.reverts).revertedBy = c.id
  return [...byId.values()]
}

/** The value of each signal now. `borrowed` is the audit's borrowed-rule data, when the caller has it. */
export async function measureSignals({ root, doc, now = new Date(), borrowed = null }) {
  const opt = await optimizerSignals({ root, doc, now })
  let b = borrowed
  if (!b) b = (await (await import('../audit/gather.js')).gather(root, { now })).borrowed
  const window = b?.window ?? DEMOTION_DAYS
  const idle = (b?.rules || []).filter((r) => r.catches === 0 && Number.isFinite(r.days) && r.days >= window && r.commits > 0).length
  return { 'load-words': opt.load.words, compactions: opt.compactions, 'idle-borrowed': idle }
}

const allowsItself = (doc) => doc?.answers?.['harness.autonomy'] === 'tune-itself'

/**
 * Propose a change. Applied at once when the preset and the bounds allow it;
 * otherwise left for a human. A forbidden change is refused and recorded as
 * nothing at all.
 *
 * @returns {Promise<{id: string, kind: string, articles: string[], reason: string, applied: boolean, why: string}>}
 */
export async function proposeChange({ root, doc, change, evidence, signal, window = DEFAULT_WINDOW_DAYS, by = 'agent', now = new Date(), reverts = null }) {
  const cls = classify(change, doc)
  if (cls.kind === 'invalid') throw new RuleError(cls.reason, { code: 'INVALID_CHANGE' })
  if (cls.kind === 'forbidden') throw new RuleError(`Refused by the constitution (${cls.articles.join(', ')}): ${cls.reason}`, { code: 'FORBIDDEN' })
  const ev = String(evidence || '').replace(/\s+/g, ' ').trim()
  if (findReferences(ev).total === 0) throw new RuleError('A change to the harness needs local evidence someone can follow: a commit, an ISO date, an issue, or a URL.', { code: 'NO_EVIDENCE' })
  if (!SIGNALS[signal]) throw new RuleError(`Name the signal this change should improve: ${Object.keys(SIGNALS).join(', ')}.`, { code: 'NO_SIGNAL' })
  const days = Number(window)
  if (!Number.isFinite(days) || days < 7 || days > 365) throw new RuleError('The window is 7 to 365 days: long enough for the signal to move.', { code: 'BAD_WINDOW' })

  const log = await readLog(root)
  const id = `H-${String(log.filter((e) => e.type === 'proposed').length + 1).padStart(3, '0')}`
  await append(root, { type: 'proposed', id, at: now.toISOString(), by, change: cls.change, kind: cls.kind, articles: cls.articles, evidence: ev, signal, window: days, ...(reverts ? { reverts } : {}) })

  const mechanism = mechanismOf(cls.change)
  const recent = changes(log).some((c) => c.state === 'applied' && c.appliedBy === 'agent' && mechanismOf(c.change) === mechanism && now - new Date(c.appliedAt) < TUNE_EVERY_DAYS * DAY)
  const may = allowsItself(doc) && ['tune', 'strengthen', 'narrow'].includes(cls.kind) && !cls.articles.length && !recent
  const why = may
    ? `"Tune itself" lets a ${cls.kind} apply on its own (${cls.reason})`
    : cls.articles.length ? `needs a human: ${cls.articles.map(constitutionLine).join(' ')}`
      : recent ? `the ${mechanism} mechanism already changed on its own this week; once a week is the bound`
        : !allowsItself(doc) ? 'the preset is not "Tune itself", so it waits for a human' : `a change of kind "${cls.kind}" waits for a human`
  if (may) await applyChange({ root, doc, id, by: 'agent', now })
  return { id, change: cls.change, kind: cls.kind, articles: cls.articles, reason: cls.reason, applied: may, why }
}

/**
 * Apply a proposed change: its effect on the answers (or on active/), and a
 * log line with the signal's value now, so its window has something to beat.
 * A human applies what the bounds do not; the caller asserts which.
 */
export async function applyChange({ root, doc, id, by = 'human', now = new Date(), interactive = false }) {
  const all = changes(await readLog(root))
  const c = all.find((x) => x.id === id)
  if (!c) throw new RuleError(`No change ${id} in the harness log.`, { code: 'NO_CHANGE' })
  if (c.state !== 'proposed') throw new RuleError(`${id} is already ${c.state}.`, { code: 'NOT_PROPOSED' })
  if (by !== 'agent' && interactive !== true) throw new RuleError('Applying a change the bounds did not allow is a human\'s call: run it at a terminal.', { code: 'NOT_INTERACTIVE' })
  const fresh = classify(c.change, doc)
  if (fresh.kind === 'invalid') throw new RuleError(`${id} no longer applies: ${fresh.reason}.`, { code: 'STALE_CHANGE' })

  const baseline = { signal: c.signal, value: (await measureSignals({ root, doc, now }))[c.signal] }
  const ch = c.change
  if (ch.op === 'set') doc.answers[ch.key] = ch.value
  if (ch.op === 'autonomy') doc.answers['harness.autonomy'] = ch.value
  if (ch.op === 'enable' || ch.op === 'disable') {
    const key = ch.id.startsWith('D') ? 'harness.defaults' : 'harness.triggers'
    const list = Array.isArray(doc.answers[key]) ? doc.answers[key] : []
    doc.answers[key] = ch.op === 'enable' ? [...list, ch.id] : list.filter((x) => x !== ch.id)
    if (ch.op === 'enable' && key === 'harness.triggers') doc.harness = { ...(doc.harness || {}), triggersOffered: [...new Set([...(doc.harness?.triggersOffered || []), ch.id])] }
    // Out of force means moved, never deleted (A3): the rule goes to candidates/.
    if (ch.op === 'disable') {
      const name = (DEFAULTS.find((d) => d.id === ch.id) || {}).name || (TRIGGERS.find((t) => t.id === ch.id) || {}).rule
      await demote(root, name, { interactive: true, reason: `harness change ${id}`, now }).catch((err) => { if (err.code !== 'NOT_FOUND' && !/does not exist|No such/.test(err.message)) throw err })
    }
  }
  await append(root, { type: 'applied', id, at: now.toISOString(), by, baseline })
  return { id, change: ch, baseline, rerender: ch.op !== 'note' }
}

export async function rejectChange({ root, id, by = 'human', now = new Date(), interactive = false }) {
  if (interactive !== true) throw new RuleError('Rejecting a proposed change is a human\'s call: run it at a terminal.', { code: 'NOT_INTERACTIVE' })
  const c = changes(await readLog(root)).find((x) => x.id === id)
  if (!c || c.state !== 'proposed') throw new RuleError(`${id} is not a proposed change.`, { code: 'NOT_PROPOSED' })
  await append(root, { type: 'rejected', id, at: now.toISOString(), by })
  return { id }
}

/** The change that undoes an applied one, proposed like any other, and classified afresh. */
export function reverseOf(c) {
  const ch = c.change
  if (ch.op === 'set') return { op: 'set', key: ch.key, value: ch.from }
  if (ch.op === 'enable') return { op: 'disable', id: ch.id }
  if (ch.op === 'disable') return { op: 'enable', id: ch.id }
  if (ch.op === 'autonomy') return { op: 'autonomy', value: ch.from }
  return { op: 'note', text: `undo ${c.id}: ${ch.text}` }
}

/**
 * Whether each applied change improved its signal, once its window has
 * passed. A change that did not, and was not reverted since, is one to revert.
 */
export function evaluateChanges(log, measured, now = new Date()) {
  return changes(log)
    .filter((c) => c.state === 'applied' && c.baseline && Number.isFinite(c.baseline.value) && !c.reverts)
    .filter((c) => now - new Date(c.appliedAt) >= c.window * DAY)
    .map((c) => {
      const value = measured[c.signal]
      const better = SIGNALS[c.signal].better === 'lower' ? value < c.baseline.value : value > c.baseline.value
      return { id: c.id, change: c.change, signal: c.signal, before: c.baseline.value, after: value, helped: better, revertedBy: c.revertedBy || null }
    })
}
