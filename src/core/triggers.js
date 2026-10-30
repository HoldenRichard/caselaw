/**
 * Environment triggers (0.3): a fact about this repository that proposes a
 * rule, with the fact shown.
 *
 * At install the human sees every trigger that fires and picks (the harness
 * session); the accepted ones are in force like the defaults, on the study's
 * precedent until their first catch here. A trigger that fires later, on an
 * upgrade, is applied or proposed by the autonomy preset: "Tune itself" (or a
 * Custom choice) applies it, because a rule that only adds enforcement may
 * apply on its own; otherwise it is written once into proposed/ for a human
 * to ratify. Offered triggers are remembered, so a proposal the human
 * ratified or rejected is never written again.
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { render } from '../render/engine.js'
import { DEMOTION_DAYS } from './defaults.js'
import { doctrineDirOf, ruleDirsFor } from './doctrine.js'
import * as gatesStore from './gates.js'
import { OUTSIDE_LABELS } from '../generate/authority-split.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const TRIGGERED_ROOT = join(HERE, '../../templates/triggered')

/**
 * T3's writer guard: a command gate on what the agent runs (Claude Code's
 * Bash). Born warning, like every gate. `git commit --amend` and a path that
 * merely starts with a dot are not sweeps, and do not match.
 */
export function writerGuard(dir = 'docs') {
  return {
    id: 'stage-explicit-paths',
    kind: 'command',
    severity: 'warn',
    origin: `${dir}/rules/active/stage-explicit-paths.md`,
    message: 'Stage the paths you changed, by name: another writer works in this tree (stage-explicit-paths).',
    patterns: [
      { regex: String.raw`\bgit\s+(?:-C\s+\S+\s+)?add\b[^;&|\n]*?\s(?:-A|--all|-u|--update|\.)(?=\s|$|[;&|])`, label: 'git add of the whole tree' },
      { regex: String.raw`\bgit\s+(?:-C\s+\S+\s+)?commit\b[^;&|\n]*?\s(?:-[a-zA-Z]*a[a-zA-Z]*|--all)(?=\s|$|[;&|])`, label: 'git commit -a' },
    ],
  }
}

const list = (items, n = 3) => {
  const xs = [...new Set(items.filter(Boolean))]
  return xs.length > n ? `${xs.slice(0, n).join(', ')} and ${xs.length - n} more` : xs.join(', ')
}

/** The agent tools this repository already instructs. */
function agentTools(detected = {}) {
  const ac = detected.agentConfig || {}
  return [
    (ac.claudeMd || ac.claudeDir) && 'Claude Code',
    ac.agentsMd && 'AGENTS.md',
    ac.cursorRules && 'Cursor',
    ac.copilot && 'Copilot',
    ac.windsurfRules && 'Windsurf',
  ].filter(Boolean)
}

export const TRIGGERS = [
  {
    id: 'T1', label: 'an outside gatekeeper', rule: 'retain-generation-records',
    fact: ({ answers }) => {
      const named = (answers['outside.authority'] || []).map((o) => OUTSIDE_LABELS[o] || o)
      return named.length ? `the interview names an outside authority (${list(named, 2)})` : null
    },
  },
  {
    id: 'T2', label: 'public claims', rule: 're-derive-declarations',
    fact: ({ answers }) => {
      const named = answers['outside.claims'] || []
      return named.length ? `the interview names where it makes public claims (${list(named)})` : null
    },
  },
  {
    id: 'T3', label: 'more than one agent tool', rule: 'stage-explicit-paths', gate: true,
    fact: ({ detected }) => {
      const tools = agentTools(detected)
      return tools.length >= 2 ? `this repository instructs ${tools.length} agent tools (${list(tools, 5)})` : null
    },
  },
  {
    id: 'T4', label: 'paid or metered APIs', rule: 'spend-protocol',
    fact: ({ detected, answers }) => {
      const metered = (detected.signals?.metered || []).map((s) => s.signal)
      if (metered.length) return `it uses a paid or metered API (${list(metered)})`
      return (answers['authority.cannot'] || []).includes('paid-apis') ? 'the interview names paid or rate-limited APIs' : null
    },
  },
  {
    id: 'T5', label: 'dated records', rule: 'times-come-from-the-clock',
    fact: ({ detected }) => {
      const dated = (detected.signals?.dated || []).map((s) => (s.source === s.signal ? s.source : `${s.signal} in ${s.source}`))
      return dated.length ? `it keeps dated records (${list(dated)})` : null
    },
  },
  {
    id: 'T6', label: 'secrets', rule: 'secrets-by-last-four',
    fact: ({ detected, answers }) => {
      const files = (detected.secretSurface || []).map((s) => s.path)
      const ci = (detected.ciGates?.contexts || []).flatMap((c) => c.secrets || [])
      if (files.length || ci.length) return `it handles secrets (${list([...files, ...ci.map((s) => `CI's ${s}`)])})`
      return (answers['authority.cannot'] || []).includes('secrets') ? 'the interview names secrets the agent cannot read' : null
    },
  },
  {
    id: 'T7', label: 'more than one config identity', rule: 'config-identity-gate',
    fact: ({ detected }) => {
      const ids = (detected.signals?.identities || []).map((s) => s.signal)
      return ids.length ? `it has more than one config identity (${list(ids)})` : null
    },
  },
]

/** Every trigger that fires on this repository, with the fact that fires it. */
export function firedTriggers({ detected = {}, answers = {} } = {}) {
  return TRIGGERS.map((t) => ({ ...t, factNow: t.fact({ detected, answers }) })).filter((t) => t.factNow)
}

/** The triggers whose rules are in force here: accepted at install, or applied since. */
export function acceptedTriggers(doc = {}) {
  const chosen = doc.answers?.['harness.triggers']
  return Array.isArray(chosen) ? TRIGGERS.filter((t) => chosen.includes(t.id)) : []
}

/** Whether a trigger that fires later may apply its rule without asking. */
export function appliesOnItsOwn(doc = {}, id) {
  const preset = doc.answers?.['harness.autonomy']
  if (preset === 'tune-itself') return true
  if (preset === 'custom') return (doc.answers?.['harness.auto_triggers'] || []).includes(id)
  return false
}

/** Whether the writer guard is on: T3 in force, or its proposal ratified since. */
export function writerGuardOn(doc = {}) {
  return acceptedTriggers(doc).some((t) => t.gate) || doc.harness?.writerGuard === true
}

/**
 * Record, once, which triggers the human has been shown. Called where the
 * harness session just ran (init), so a trigger on that screen is not
 * proposed again by the next upgrade.
 */
export function markOffered(doc, detected) {
  if (Array.isArray(doc.harness?.triggersOffered)) return
  const shown = 'harness.triggers' in (doc.answers || {}) ? firedTriggers({ detected, answers: doc.answers }).map((t) => t.id) : []
  doc.harness = { ...(doc.harness || {}), triggersOffered: shown }
}

const today = (now) => now.toISOString().slice(0, 10)

/**
 * The fact and the date, stamped when a trigger's rule comes into force. Both
 * are written into the rule, so they must not move on every build, and must
 * not change because the detection that fired it changed later.
 */
function stamp(doc, detected, now) {
  const harness = { ...(doc.harness || {}) }
  harness.facts = { ...(harness.facts || {}) }
  harness.triggerSince = { ...(harness.triggerSince || {}) }
  for (const t of acceptedTriggers(doc)) {
    harness.facts[t.id] ??= t.fact({ detected, answers: doc.answers || {} }) || 'what it looks for was found'
    harness.triggerSince[t.id] ??= today(now)
  }
  doc.harness = harness
  return harness
}

async function renderRule(t, { fact, status, days }) {
  const template = await readFile(join(TRIGGERED_ROOT, `${t.rule}.md`), 'utf8')
  return render(template, { id: t.id, name: t.rule, fact, status, days })
}

const demotionDays = (doc) => (Number.isFinite(doc.answers?.['harness.demotion_days']) ? doc.answers['harness.demotion_days'] : DEMOTION_DAYS)

/** The accepted triggers' rules as files in active/. */
export async function triggerArtifacts({ doc, detected, dir, now = new Date() }) {
  const accepted = acceptedTriggers(doc)
  if (!accepted.length) return []
  const harness = stamp(doc, detected, now)
  const out = []
  for (const t of accepted) {
    out.push({
      path: `${dir}/rules/active/${t.rule}.md`,
      kind: 'file',
      body: await renderRule(t, { fact: harness.facts[t.id], status: `active since ${harness.triggerSince[t.id]}`, days: demotionDays(doc) }),
    })
  }
  return out
}

const exists = async (p) => { try { await access(p); return true } catch { return false } }

/**
 * On an upgrade: triggers that fire now and were never offered are applied
 * (when the preset allows) or proposed, once. A ratified writer-guard
 * proposal turns the guard on. Returns what happened; with `dryRun`, what
 * would, and writes nothing.
 *
 * @returns {Promise<{applied: object[], proposed: object[], kept: object[], guard: boolean}>}
 */
export async function applyTriggers({ root, doc, detected, now = new Date(), dryRun = false }) {
  const report = { applied: [], proposed: [], kept: [], guard: false }
  const offered = Array.isArray(doc.harness?.triggersOffered)
    ? doc.harness.triggersOffered
    : ('harness.triggers' in (doc.answers || {}) ? firedTriggers({ detected, answers: doc.answers }).map((t) => t.id) : [])
  const accepted = new Set(acceptedTriggers(doc).map((t) => t.id))
  const dir = doctrineDirOf(doc)
  const dirs = ruleDirsFor(dir)
  const nextOffered = [...offered]
  const nextAccepted = [...accepted]

  for (const t of firedTriggers({ detected, answers: doc.answers || {} })) {
    if (offered.includes(t.id) || accepted.has(t.id)) continue
    nextOffered.push(t.id)
    if (appliesOnItsOwn(doc, t.id)) {
      nextAccepted.push(t.id)
      report.applied.push({ id: t.id, rule: t.rule, fact: t.factNow })
      continue
    }
    const path = `${dirs.proposed}/${t.rule}.md`
    if ((await exists(join(root, path))) || (await exists(join(root, dirs.active, `${t.rule}.md`)))) {
      report.kept.push({ id: t.id, rule: t.rule, path })
      continue
    }
    report.proposed.push({ id: t.id, rule: t.rule, fact: t.factNow, path })
    if (!dryRun) {
      const body = await renderRule(t, { fact: t.factNow, status: `proposed ${today(now)}`, days: demotionDays(doc) })
      await mkdir(dirname(join(root, path)), { recursive: true })
      // The same relocation every generated file gets (artifacts.js), imported
      // late because artifacts.js imports this module.
      const { relocate } = await import('../generate/artifacts.js')
      await writeFile(join(root, path), dir === 'docs' ? body : relocate(body, dir), 'utf8')
    }
  }

  // The writer guard's proposal, once ratified, is in active/: turn the guard on.
  const guardRatified = !accepted.has('T3') && (await exists(join(root, dirs.active, 'stage-explicit-paths.md')))
  const guardWanted = nextAccepted.includes('T3') || guardRatified || doc.harness?.writerGuard === true
  if (guardWanted) {
    report.guard = true
    // A gates.json the human has already filled is theirs, and the build
    // will not rewrite it: the guard is added to it directly.
    if (!dryRun) {
      const config = await gatesStore.load(root).catch(() => null)
      if (config && config.gates.length && !config.gates.some((g) => g.id === 'stage-explicit-paths')) {
        config.gates.push(writerGuard(dir))
        await gatesStore.save(root, config)
      }
    }
  }

  if (!dryRun) {
    doc.harness = { ...(doc.harness || {}), triggersOffered: nextOffered, ...(guardRatified ? { writerGuard: true } : {}) }
    if (nextAccepted.length !== accepted.size) doc.answers['harness.triggers'] = nextAccepted
  }
  return report
}
