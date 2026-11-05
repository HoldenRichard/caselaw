/**
 * The optimizer (0.3): compaction and trimming together.
 *
 * A harness that only grows gets read less carefully every session, and the
 * study's agents lost what they carried at each context compaction (DEF-225).
 * So the governance a session loads is measured, and when a signal says it is
 * time, the optimizer proposes:
 *
 *   mechanize          a rule that keeps catching becomes a gate (the main compaction)
 *   archive-precedent  another project's incidents move out of a loaded rule, ids kept
 *   merge              two rules on the same kind of work become one, losslessly
 *   demote             a borrowed rule that has caught nothing goes back to candidates
 *   stale-reference    a pointer to something that no longer exists
 *
 * Everything is proposed; a human applies it (`caselaw optimize --apply`), and
 * `doctor` re-checks the wiring after. Nothing is ever deleted: demoted rules
 * go to candidates/, merged ones to archive/, precedent to precedent/.
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { listRules, readCatches, parseRule } from './rules.js'
import { doctrineDirOf, ruleDirsFor } from './doctrine.js'
import { DEFAULTS } from './defaults.js'
import { TRIGGERS } from './triggers.js'
import { archivePrecedent } from './precedent.js'
import { consolidateRules, optimizeRuleIterative, evaluateStage2, defaultVerifier } from './skillopt.js'
import { listIncidents } from './incidents.js'

/**
 * The session-start budget, in words: the pointer block, the authority split
 * and every active rule. Provisional: a fresh install with every default and
 * two triggered rules loads about 2,300; the field test (phase 9) sets the
 * real default. Change it with harness.load_budget in .caselaw/answers.json.
 */
export const LOAD_BUDGET_WORDS = 3000
export const RATIFIED_SINCE = 5
export const PASS_DAYS = 30
export const TROUBLE_CATCHES = 3
/** Context compactions, as Claude Code's PreCompact hook records them. */
export const COMPACTIONS = { count: 5, days: 14 }
export const COMPACTIONS_PATH = '.caselaw/compactions.jsonl'
/** Trigger overlap at which two rules are worth reading as one. */
export const MERGE_SIMILARITY = 0.5
/** A precedent longer than this is worth moving out of a loaded rule. */
export const PRECEDENT_WORDS = 40

const words = (t) => (String(t ?? '').match(/\S+/g) || []).length
const DAY = 86_400_000
const isoDay = (d) => d.toISOString().slice(0, 10)
const read = async (p) => { try { return await readFile(p, 'utf8') } catch { return null } }
const exists = async (p) => { try { await access(p); return true } catch { return false } }

/** The words a session loads at its start, file by file. */
export async function measureLoad(root, doc) {
  const dir = doctrineDirOf(doc)
  const files = []
  // One pointer block is read per tool; the larger stands for both.
  let pointer = null
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    const text = await read(join(root, f))
    const block = text && /<!-- caselaw:begin id=pointer[\s\S]*?caselaw:end id=pointer -->/.exec(text)
    if (block && (!pointer || words(block[0]) > pointer.words)) pointer = { path: `${f} (pointer block)`, words: words(block[0]) }
  }
  if (pointer) files.push(pointer)
  const split = await read(join(root, dir, 'authority-split.md'))
  if (split !== null) files.push({ path: `${dir}/authority-split.md`, words: words(split) })
  let listed = { active: [] }
  try { listed = await listRules(root) } catch { /* unreadable rules dir: measured as empty */ }
  for (const r of listed.active) files.push({ path: r.path, words: words(r.parsed?.raw) })
  return { words: files.reduce((n, f) => n + f.words, 0), files }
}

async function readCompactions(root) {
  const text = await read(join(root, COMPACTIONS_PATH))
  if (!text) return []
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter((c) => c && c.at)
}

/** What says it is time: each reason as a sentence, and the numbers behind them. */
export async function optimizerSignals({ root, doc, now = new Date() }) {
  const h = doc?.harness || {}
  const last = h.optimizedAt ? new Date(h.optimizedAt) : doc?.generatedAt ? new Date(doc.generatedAt) : null
  const budget = Number.isFinite(doc?.answers?.['harness.load_budget']) ? doc.answers['harness.load_budget'] : LOAD_BUDGET_WORDS
  const load = await measureLoad(root, doc)
  let listed = { active: [] }
  try { listed = await listRules(root) } catch { /* measured as empty */ }

  const ratifiedAt = (r) => (/\b(\d{4}-\d{2}-\d{2})\b/.exec(r.parsed?.ratified || '') || [])[1]
  const ratifiedSince = listed.active.filter((r) => ratifiedAt(r) && last && new Date(ratifiedAt(r)) > last).length
  const catches = (await readCatches(root)).filter((c) => !last || new Date(c.at) >= new Date(isoDay(last)))
  const byRule = new Map()
  for (const c of catches) byRule.set(c.rule, (byRule.get(c.rule) || 0) + 1)
  const trouble = listed.active
    .filter((r) => (byRule.get(r.name) || 0) >= TROUBLE_CATCHES && !/^machine:/i.test(r.parsed?.enforcement || ''))
    .map((r) => ({ name: r.name, catches: byRule.get(r.name) }))
  const compactions = (await readCompactions(root)).filter((c) => now - new Date(c.at) <= COMPACTIONS.days * DAY).length
  const sinceDays = last ? Math.floor((now - last) / DAY) : null

  const due = []
  if (load.words > budget) due.push(`a session loads ${load.words} words of governance, over the ${budget}-word budget`)
  if (ratifiedSince >= RATIFIED_SINCE) due.push(`${ratifiedSince} rules were ratified since the last pass`)
  if (sinceDays !== null && sinceDays >= PASS_DAYS) due.push(`the last pass was ${sinceDays} days ago`)
  for (const t of trouble) due.push(`"${t.name}" caught ${t.catches} things since the last pass, and is still enforced by memory`)
  if (compactions >= COMPACTIONS.count) due.push(`the agent's context was compacted ${compactions} times in ${COMPACTIONS.days} days`)
  return { load, budget, ratifiedSince, trouble, compactions, last, sinceDays, due }
}

const STOP = new Set(['any', 'that', 'this', 'with', 'from', 'into', 'when', 'where', 'what', 'which', 'work', 'change', 'changes', 'another', 'other', 'their', 'there', 'than', 'then', 'them', 'they', 'your', 'have', 'been', 'will', 'must', 'never', 'only'])
const terms = (t) => new Set((String(t ?? '').toLowerCase().match(/[a-z][a-z-]{3,}/g) || []).filter((w) => !STOP.has(w)))
export function triggerSimilarity(a, b) {
  const x = terms(a)
  const y = terms(b)
  if (!x.size || !y.size) return 0
  const both = [...x].filter((w) => y.has(w)).length
  return both / (x.size + y.size - both)
}

/** The rules generated from the answers (defaults and triggered rules), by name. */
const generatedNames = (doc) => new Set([
  ...DEFAULTS.filter((d) => (doc?.answers?.['harness.defaults'] || []).includes(d.id)).map((d) => d.name),
  ...TRIGGERS.filter((t) => (doc?.answers?.['harness.triggers'] || []).includes(t.id)).map((t) => t.rule),
])

/**
 * Every proposal, with why and how. `audit` findings come in for the two the
 * audit already knows how to find (a borrowed rule that has caught nothing;
 * a reference that resolves to nothing).
 */
export function optimizerProposals({ signals, listed, findings = [] }) {
  const out = []
  for (const t of signals.trouble) {
    out.push({ id: `mechanize:${t.name}`, action: 'mechanize', rules: [t.name],
      why: `it caught ${t.catches} things since the last pass; a rule that keeps being needed costs every session its words, and a gate costs none`,
      how: `caselaw rule promote ${t.name}` })
  }
  if (signals.load.words > signals.budget) {
    for (const r of listed.active) {
      const n = words(r.parsed?.precedent)
      if (n > PRECEDENT_WORDS && !/^archived in /.test(r.parsed?.precedent || '')) {
        out.push({ id: `archive-precedent:${r.name}`, action: 'archive-precedent', rules: [r.name],
          why: `its precedent is ${n} words every session reads; archived, the rule keeps the ids and a pointer`,
          how: `caselaw optimize --apply archive-precedent:${r.name}` })
      }
      const mutWords = words(r.parsed?.rule) + words(r.parsed?.trigger)
      if (mutWords > 15) {
        out.push({ id: `compress:${r.name}`, action: 'compress', rules: [r.name],
          why: `its mutable prose is ${mutWords} words; SkillOpt lossless compression can tighten it under the load budget`,
          how: `caselaw optimize --apply compress:${r.name}` })
      }
    }
  }
  const mergeable = listed.active.filter((r) => !/^machine:/i.test(r.parsed?.enforcement || ''))
  for (let i = 0; i < mergeable.length; i++) {
    for (let j = i + 1; j < mergeable.length; j++) {
      const [a, b] = [mergeable[i], mergeable[j]]
      const sim = triggerSimilarity(a.parsed?.trigger, b.parsed?.trigger)
      if (sim < MERGE_SIMILARITY) continue
      out.push({ id: `merge:${a.name}+${b.name}`, action: 'merge', rules: [a.name, b.name],
        why: `their triggers overlap (${Math.round(sim * 100)}% of the terms), so the same work loads both`,
        how: `caselaw optimize --apply merge:${a.name}+${b.name}` })
    }
  }
  for (const f of findings.filter((f) => f.code === 'borrowed-rules-earn')) {
    const name = /rule "([^"]+)"/.exec(f.message)?.[1]
    if (name) out.push({ id: `demote:${name}`, action: 'demote', rules: [name], why: f.message, how: `caselaw rule demote ${name}` })
  }
  for (const f of findings.filter((f) => f.code === 'refs-resolve')) {
    out.push({ id: `stale-reference:${f.path || 'unknown'}`, action: 'stale-reference', rules: [], why: f.message, how: `edit ${f.path || 'the file named'} and drop or fix the reference` })
  }
  return out
}

/**
 * Apply one proposal. Only the two that are mechanical are applied here; the
 * rest name the command a human runs. Returns what changed, and whether the
 * build has to re-render (a generated rule's precedent).
 *
 * @returns {Promise<{ok: boolean, message: string, rerender?: boolean, wrote?: string[]}>}
 */
export async function applyProposal({ root, doc, id, now = new Date(), name = null }) {
  const [action, rest = ''] = id.split(/:(.*)/s)
  const dir = doctrineDirOf(doc)
  const dirs = ruleDirsFor(dir)
  if (action === 'archive-precedent') {
    const rule = rest
    if (generatedNames(doc).has(rule)) {
      doc.harness = { ...(doc.harness || {}), precedentArchived: { ...(doc.harness?.precedentArchived || {}), [rule]: isoDay(now) } }
      return { ok: true, rerender: true, message: `${rule} is generated from your answers: its precedent is archived on the next render.` }
    }
    const path = join(root, dirs.active, `${rule}.md`)
    const text = await read(path)
    if (text === null) return { ok: false, message: `No active rule named "${rule}".` }
    const moved = archivePrecedent(text, { name: rule, dir, at: isoDay(now) })
    if (!moved) return { ok: false, message: `"${rule}" has no precedent to archive, or it is already archived.` }
    const archivePath = join(root, dirs.precedent, `${rule}.md`)
    await mkdir(dirname(archivePath), { recursive: true })
    await writeFile(archivePath, moved.archive, 'utf8')
    // Re-derived, not trusted: read both back before the rule loses its paragraph.
    const precedent = parseRule(text).precedent
    if (!(await read(archivePath)).includes(precedent)) return { ok: false, message: `The archive for "${rule}" did not read back verbatim; the rule was not changed.` }
    await writeFile(path, moved.rule, 'utf8')
    return { ok: true, message: `${dirs.active}/${rule}.md now points at ${dirs.precedent}/${rule}.md (${moved.words} words moved).`, wrote: [`${dirs.active}/${rule}.md`, `${dirs.precedent}/${rule}.md`] }
  }
  if (action === 'merge') {
    const [a, b] = rest.split('+')
    const into = name || `${a}-and-${b}`.slice(0, 100).replace(/-+$/, '')
    const text = (n) => read(join(root, dirs.active, `${n}.md`))
    const [ta, tb] = [await text(a), await text(b)]
    if (ta === null || tb === null) return { ok: false, message: `Both rules must be active: ${ta === null ? a : b} is not.` }
    const path = join(root, dirs.proposed, `${into}.md`)
    if (await exists(path)) return { ok: false, message: `${dirs.proposed}/${into}.md already exists.` }

    // Union contrastive incident fixtures: F_union = F_A U F_B
    const incidentsA = await listIncidents(root, { rule: a })
    const incidentsB = await listIncidents(root, { rule: b })
    const unionFixtures = [...incidentsA, ...incidentsB]

    const parsedA = parseRule(ta)
    const parsedB = parseRule(tb)
    const candidateMutable = {
      trigger: `${parsedA.trigger} Also: ${parsedB.trigger}`,
      rule: `${parsedA.rule}\n\n${parsedB.rule}`,
    }

    if (unionFixtures.length > 0) {
      const stage2 = await evaluateStage2(candidateMutable, unionFixtures, defaultVerifier)
      if (!stage2.pass) {
        return {
          ok: false,
          message: `Merge rejected: merged candidate regressed on incident fixtures (missed: ${stage2.missed.join(', ')}, false positives: ${stage2.falsePositivesList.join(', ')}).`,
        }
      }
    }

    await mkdir(dirname(path), { recursive: true })
    const consolidated = consolidateRules(ta, tb, candidateMutable, { originSep: ' And: ' })
    const proposalBody = `${consolidated.mergedRuleText.trim()}\n\n**Merges:** ${a}, ${b}\n---\n_Proposed by \`caselaw optimize\` on ${isoDay(now)}: \`${a}\` and \`${b}\` as one rule, built from both files verbatim. You may reword the Trigger and add to the Rule. Ratifying checks that each one's Rule, Origin and Precedent is still here word for word, then moves them to archive/._\n`
    await writeFile(path, proposalBody, 'utf8')
    return { ok: true, message: `Wrote ${dirs.proposed}/${into}.md. Ratifying it moves ${a} and ${b} to ${dirs.archive}/.`, wrote: [`${dirs.proposed}/${into}.md`] }
  }
  if (action === 'compress') {
    const rule = rest
    const path = join(root, dirs.active, `${rule}.md`)
    const text = await read(path)
    if (text === null) return { ok: false, message: `No active rule named "${rule}".` }
    const incidents = await listIncidents(root, { rule })
    if (incidents.length === 0) {
      return { ok: false, message: `Cannot compress "${rule}": no incident fixtures recorded. Record incident fixtures first to prove lossless compression.` }
    }
    const res = await optimizeRuleIterative({
      ruleText: text,
      incidentFixtures: incidents,
      isCompression: true,
    })
    if (res.success && res.savedWords > 0) {
      await writeFile(path, res.bestRuleText, 'utf8')
      return { ok: true, message: `Losslessly compressed ${dirs.active}/${rule}.md (${res.savedWords} words saved).`, wrote: [path] }
    }
    return { ok: false, message: `"${rule}" could not be further compressed without regressions.` }
  }
  const p = { mechanize: 'caselaw rule promote', demote: 'caselaw rule demote' }[action]
  return { ok: false, message: p ? `Run \`${p} ${rest}\` yourself; it is a human's step.` : `"${id}" is not applied by caselaw; edit the file it names.` }
}

/**
 * Two rules as one, built from both files verbatim: never paraphrased, because
 * a summary is where the study's carried figures came from (DEF-225).
 */
export function mergedProposal(name, rules, at) {
  const join2 = (key, sep) => rules.map((r) => r[key]).filter(Boolean).join(sep)
  const markers = rules.map((r) => r.default || r.triggered).filter(Boolean)
  const enforcement = rules.some((r) => /^checklist$/i.test(r.enforcement || '')) ? 'checklist' : 'memory'
  const parts = [
    `# ${name}`,
    `**Trigger:** ${join2('trigger', ' Also: ')}`,
    `**Rule:** ${join2('rule', '\n\n')}`,
    ...(join2('origin', '') ? [`**Origin:** ${join2('origin', ' And: ')}`] : []),
    ...(join2('precedent', '') ? [`**Precedent:** ${join2('precedent', ' And: ')}`] : []),
    `**Enforcement:** ${enforcement}`,
    ...(markers.length ? [`**Default:** merges ${markers.join('; ')}`] : []),
    `**Merges:** ${rules.map((r) => r.name).join(', ')}`,
    `---\n_Proposed by \`caselaw optimize\` on ${at}: ${rules.map((r) => `\`${r.name}\``).join(' and ')} as one rule, built from both files verbatim. You may reword the Trigger and add to the Rule. Ratifying checks that each one's Rule, Origin and Precedent is still here word for word, then moves them to archive/._`,
  ]
  return parts.join('\n\n') + '\n'
}
