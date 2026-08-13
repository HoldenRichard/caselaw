/**
 * Gate configuration: loading, validating, and the promotion ladder.
 *
 * The runner (runtime/gate.mjs) executes gates. This module owns everything
 * around them — the config file, the rules⇄gates graph, and the decision about
 * when a warning has earned the right to block.
 *
 * The promotion ladder is the point of the whole design:
 *
 *   memory  →  checklist  →  gate (warn)  →  gate (block)
 *
 * A new gate never starts blocking. It watches, records what it would have
 * caught, and earns `block` on evidence. That mirrors how the rules in the
 * source project actually matured — a brand rule shipped violations three
 * separate times before anyone accepted that model memory was the wrong place
 * to keep it.
 */

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const GATES_PATH = '.harness/gates.json'
export const FIRES_PATH = '.harness/gate-fires.jsonl'
export const SCHEMA_VERSION = 1

/** Fires a gate must record before `promote` will let it block. */
export const PROMOTION_THRESHOLD = 3

export const KINDS = [
  'banned-content',
  'required-content',
  'cross-file',
  'file-invariant',
  'path-scope',
  'paired-edit',
  'shell',
]

export function emptyConfig() {
  return { version: SCHEMA_VERSION, gates: [] }
}

export async function load(root) {
  try {
    const raw = await readFile(join(root, GATES_PATH), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed.version !== SCHEMA_VERSION) {
      throw new GateError(
        `gates.json is version ${parsed.version}, this CLI speaks ${SCHEMA_VERSION}.`,
        { code: 'SCHEMA_MISMATCH' },
      )
    }
    return parsed
  } catch (err) {
    if (err.code === 'ENOENT') return null
    if (err instanceof GateError) throw err
    throw new GateError(`${GATES_PATH} is unreadable: ${err.message}`, { code: 'UNREADABLE' })
  }
}

export async function save(root, config) {
  const p = join(root, GATES_PATH)
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify(config, null, 2) + '\n', 'utf8')
  return config
}

/**
 * Validate one gate definition.
 *
 * `origin` is required and it is not bureaucracy: it is the backlink that makes
 * rules and gates a single verifiable graph. Without it the audit cannot tell
 * an orphaned gate (its rule was deleted) from a live one, and cannot tell a
 * rule claiming `machine:x` from a rule that actually has a gate.
 */
export function validateGate(gate, { index = 0 } = {}) {
  const problems = []
  const at = gate?.id ? `gate "${gate.id}"` : `gate #${index + 1}`

  if (!gate || typeof gate !== 'object') {
    return [{ code: 'not-an-object', severity: 'error', message: `${at} is not an object` }]
  }
  if (!gate.id || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(gate.id)) {
    problems.push({ code: 'bad-id', severity: 'error', message: `${at} needs a kebab-case id` })
  }
  if (!KINDS.includes(gate.kind)) {
    problems.push({
      code: 'unknown-kind', severity: 'error',
      message: `${at} has kind "${gate.kind}"; expected one of ${KINDS.join(', ')}`,
    })
  }
  if (gate.severity !== 'warn' && gate.severity !== 'block') {
    problems.push({
      code: 'bad-severity', severity: 'error',
      message: `${at} severity must be "warn" or "block"`,
    })
  }
  if (!gate.origin) {
    problems.push({
      code: 'missing-origin', severity: 'error',
      message: `${at} has no origin`,
      hint: 'Point it at the rule file it mechanises. Without that backlink an audit cannot tell an orphaned gate from a live one.',
    })
  }
  if (!Array.isArray(gate.paths) || gate.paths.length === 0) {
    problems.push({
      code: 'no-paths', severity: 'error',
      message: `${at} has no paths`,
      hint: 'An unscoped gate fires on everything, which is how gates get disabled.',
    })
  }
  if (!gate.message) {
    problems.push({
      code: 'no-message', severity: 'warn',
      message: `${at} has no message; the person it blocks will not know what to do`,
    })
  }

  for (const g of gate.grandfather || []) {
    if (!g.reason) {
      problems.push({ code: 'grandfather-no-reason', severity: 'error', message: `${at} has a grandfather entry with no reason` })
    }
    if (!g.expires) {
      problems.push({
        code: 'grandfather-no-expiry', severity: 'error',
        message: `${at} has a grandfather entry with no expiry`,
        hint: 'An exception without a date outlives the reason for it. That is how a gate quietly stops covering the thing it was written for.',
      })
    }
  }

  return problems
}

export function validateConfig(config) {
  const problems = []
  const seen = new Set()
  for (const [i, gate] of (config.gates || []).entries()) {
    problems.push(...validateGate(gate, { index: i }))
    if (gate?.id) {
      if (seen.has(gate.id)) {
        problems.push({ code: 'duplicate-id', severity: 'error', message: `two gates share the id "${gate.id}"` })
      }
      seen.add(gate.id)
    }
  }
  return { ok: !problems.some((p) => p.severity === 'error'), problems }
}

/** Read the local fire log. Absent or corrupt lines are ignored, never fatal. */
export async function readFires(root) {
  try {
    const raw = await readFile(join(root, FIRES_PATH), 'utf8')
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line) } catch { return null }
      })
      .filter(Boolean)
  } catch (err) {
    if (err.code === 'ENOENT') return []
    return []
  }
}

export async function recordFire(root, entry) {
  // Telemetry must never be able to fail a run. A read-only checkout is a
  // no-op, not an error.
  try {
    const p = join(root, FIRES_PATH)
    await mkdir(dirname(p), { recursive: true })
    await appendFile(p, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8')
  } catch { /* intentionally ignored */ }
}

/**
 * Should this gate be promoted from warn to block?
 *
 * Evidence, not preference: a gate earns `block` by demonstrably catching real
 * violations. Promoting on a hunch is how a project ends up with blocking gates
 * nobody trusts, which get bypassed and then deleted.
 */
export async function promotionStatus(root, gateId, { threshold = PROMOTION_THRESHOLD } = {}) {
  const fires = (await readFires(root)).filter((f) => f.gate === gateId)
  return {
    gate: gateId,
    fires: fires.length,
    threshold,
    eligible: fires.length >= threshold,
    lastFired: fires.length ? fires[fires.length - 1].ts : null,
  }
}

export async function promote(root, gateId, { force = false, threshold = PROMOTION_THRESHOLD } = {}) {
  const config = await load(root)
  if (!config) throw new GateError('No .harness/gates.json in this project.', { code: 'NO_CONFIG' })

  const gate = config.gates.find((g) => g.id === gateId)
  if (!gate) throw new GateError(`No gate "${gateId}".`, { code: 'NO_SUCH_GATE' })
  if (gate.severity === 'block') return { gate: gateId, already: true, config }

  const status = await promotionStatus(root, gateId, { threshold })
  if (!status.eligible && !force) {
    throw new GateError(
      `"${gateId}" has fired ${status.fires} time(s); ${threshold} are needed before it blocks.`,
      {
        code: 'NOT_EARNED',
        status,
        hint: 'A gate that has never caught anything real is a guess. Leave it on warn, or use --force if you are certain.',
      },
    )
  }

  gate.severity = 'block'
  gate.promotedAt = new Date().toISOString().slice(0, 10)
  gate.promotedOn = force ? 'forced' : `${status.fires} recorded fires`
  await save(root, config)
  return { gate: gateId, status, config, forced: force }
}

/**
 * Cross-check the rules⇄gates graph.
 *
 * Two failures worth catching, both invisible without the backlink:
 *  - a rule claiming `machine:x` when no gate x exists — the rule advertises an
 *    enforcement it does not have, which is worse than claiming none;
 *  - a gate whose origin rule was deleted — an orphan still firing for a reason
 *    nobody can look up.
 */
export function crossCheck({ rules = [], config = emptyConfig() }) {
  const problems = []
  const gateIds = new Set(config.gates.map((g) => g.id))
  const rulePaths = new Set(rules.map((r) => r.file).filter(Boolean))
  const ruleNames = new Set(rules.map((r) => r.name).filter(Boolean))

  for (const rule of rules) {
    const mode = rule.enforcement?.mode ?? rule.enforcement
    const gateId = rule.enforcement?.gateId
    if (mode === 'machine' && gateId && !gateIds.has(gateId)) {
      problems.push({
        code: 'enforcement-unbacked', severity: 'error',
        message: `rule "${rule.name}" claims machine:${gateId} but no such gate exists`,
        hint: 'Either create the gate or drop the claim. A rule that advertises enforcement it does not have is worse than one claiming none.',
      })
    }
  }

  for (const gate of config.gates) {
    if (!gate.origin) continue
    const named = gate.origin.split('/').pop()?.replace(/\.md$/, '')
    if (!rulePaths.has(gate.origin) && !ruleNames.has(named)) {
      problems.push({
        code: 'gate-orphaned', severity: 'warn',
        message: `gate "${gate.id}" cites ${gate.origin}, which no longer exists`,
        hint: 'Either restore the rule or retire the gate. A gate nobody can trace is a gate nobody will trust.',
      })
    }
  }

  return problems
}

export class GateError extends Error {
  constructor(message, meta = {}) {
    super(message)
    this.name = 'GateError'
    Object.assign(this, meta)
  }
}
