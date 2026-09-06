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
import { normalize } from './text.js'
import { dirname, join } from 'node:path'

export const GATES_PATH = '.caselaw/gates.json'
export const FIRES_PATH = '.caselaw/gate-fires.jsonl'
export const SCHEMA_VERSION = 1

/** Fires a gate must record before `promote` will let it block. */
export const PROMOTION_THRESHOLD = 3

/** The runner's modes, in one place here as in runtime/gate.mjs; a test keeps them equal. */
export const MODES = ['pre', 'post', 'staged', 'all']

/**
 * Only fires from these modes count as evidence for promotion. A fire from a
 * whole-tree `all` scan is a pre-existing violation being counted, not a
 * catch: one CI run over three old violations used to make a brand-new warn
 * gate promotable to block on the spot.
 */
export const EVIDENCE_MODES = ['pre', 'post', 'staged']

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
    const parsed = JSON.parse(normalize(raw))
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
  const add = (code, severity, message, hint) => problems.push(hint ? { code, severity, message, hint } : { code, severity, message })

  if (!gate || typeof gate !== 'object') {
    return [{ code: 'not-an-object', severity: 'error', message: `${at} is not an object` }]
  }
  if (!gate.id || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(gate.id)) {
    add('bad-id', 'error', `${at} needs a kebab-case id`)
  }
  if (!KINDS.includes(gate.kind)) {
    add('unknown-kind', 'error', `${at} has kind "${gate.kind}"; expected one of ${KINDS.join(', ')}`)
  }
  // A missing severity is the schema's default, warn: a new gate is born
  // warning. A present-but-wrong one is an error. This validator used to
  // reject the default the runtime applies, so a schema-legal hand-written
  // config failed `doctor` while the runner enforced it fine.
  if (gate.severity !== undefined && gate.severity !== 'warn' && gate.severity !== 'block') {
    add('bad-severity', 'error', `${at} severity must be "warn" or "block"`)
  }
  if (!gate.origin) {
    add('missing-origin', 'error', `${at} has no origin`,
      'Point it at the rule file it mechanises. Without that backlink an audit cannot tell an orphaned gate from a live one.')
  }

  const strList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0)
  const scoped = gate.paths !== undefined && gate.paths !== null
  if (scoped && !strList(gate.paths)) {
    add('bad-paths', 'error', `${at} \`paths\` must be an array of non-empty glob strings`)
  }
  const hasPaths = scoped && strList(gate.paths) && gate.paths.length > 0
  if (!hasPaths) {
    // The schema says omitted paths mean every candidate file, and the runtime
    // agrees. That is a warning, not an error — except where scope IS the gate.
    if (gate.kind === 'path-scope' || gate.kind === 'shell') {
      add('no-paths', 'error', `${at} has no paths`,
        gate.kind === 'shell'
          ? 'A shell gate with no scope runs its command against every changed file.'
          : 'path-scope needs the forbidden globs; without them there is nothing to forbid.')
    } else {
      add('no-paths', 'warn', `${at} has no paths, so it applies to every candidate file`,
        'Scope it. An unscoped gate fires on everything, which is how gates get disabled.')
    }
  }
  if (gate.exclude !== undefined && !strList(gate.exclude)) {
    add('bad-exclude', 'error', `${at} \`exclude\` must be an array of non-empty glob strings`)
  }
  if (gate.modes !== undefined) {
    if (!Array.isArray(gate.modes) || gate.modes.length === 0 || gate.modes.some((m) => !MODES.includes(m))) {
      add('bad-modes', 'error', `${at} \`modes\` must list one or more of ${MODES.join(', ')}`,
        'The runtime drops a gate whose modes it does not recognise.')
    }
  }
  if (!gate.message) {
    add('no-message', 'warn', `${at} has no message; the person it blocks will not know what to do`)
  }

  // Kind-specific fields: exactly what runtime/gate.mjs reads. A gate that
  // validated here, was written, and was then dropped by the runner at load
  // is a gate that checks nothing while looking configured — the failure this
  // whole tool is aimed at, and one it shipped: a shell command with
  // whitespace passed this function and was silently dropped by the runtime.
  const patternList = (v) =>
    Array.isArray(v) && v.length > 0 && v.every((p) =>
      typeof p === 'string'
        ? p.length > 0
        : p && typeof p === 'object' && ((typeof p.literal === 'string' && p.literal.length > 0) || typeof p.regex === 'string'))
  switch (gate.kind) {
    case 'banned-content':
      if (!patternList(gate.patterns)) add('no-patterns', 'error', `${at} needs a non-empty \`patterns\` array of {literal} or {regex}`)
      break
    case 'required-content':
      if (!patternList(gate.requires ?? gate.patterns)) add('no-requires', 'error', `${at} needs a non-empty \`requires\` array of {literal} or {regex}`)
      break
    case 'cross-file':
      if (!Array.isArray(gate.extract) || !gate.extract.length || !gate.extract.every((e) => e && typeof e.name === 'string' && typeof e.file === 'string')) {
        add('no-extract', 'error', `${at} needs \`extract\`: [{name, file, ...}]`)
      }
      if (!Array.isArray(gate.assert) || !gate.assert.length || !gate.assert.every((a) => a && typeof a.type === 'string')) {
        add('no-assert', 'error', `${at} needs \`assert\`: [{type, ...}]`)
      }
      break
    case 'file-invariant':
      if (gate.parses === undefined && gate.endsWithNewline === undefined && gate.maxBytes === undefined && gate.requiredFrontmatter === undefined) {
        add('no-assertion', 'error', `${at} asserts nothing; give it parses, endsWithNewline, maxBytes or requiredFrontmatter`)
      }
      break
    case 'paired-edit':
      if (!strList(gate.when) || !gate.when.length) add('no-when', 'error', `${at} needs \`when\`: the globs whose change triggers the pairing`)
      if (!strList(gate.require) || !gate.require.length) add('no-require', 'error', `${at} needs \`require\`: the globs that must change alongside`)
      break
    case 'shell': {
      const cmd = gate.command
      if (typeof cmd !== 'string' || !/^\S+$/.test(cmd)) {
        add('bad-command', 'error', `${at} \`command\` must be a single executable name or path with no whitespace; put arguments in \`args\``,
          typeof cmd === 'string' && /\s/.test(cmd) ? 'The runtime drops "npm run lint"-style commands at load: it never sees a shell.' : undefined)
      }
      if (gate.args !== undefined && !(Array.isArray(gate.args) && gate.args.every((a) => typeof a === 'string'))) {
        add('bad-args', 'error', `${at} \`args\` must be an array of strings`)
      }
      if (gate.cwd !== undefined) {
        const c = typeof gate.cwd === 'string' ? gate.cwd : ''
        if (!c || /^([a-zA-Z]:)?[\\/]/.test(c) || c.split(/[\\/]/).includes('..')) {
          add('bad-cwd', 'error', `${at} \`cwd\` must be a repo-relative path with no \`..\` segments`,
            'A cwd that resolves outside the repository runs the command somewhere the gate does not own.')
        }
      }
      break
    }
    default:
      break
  }

  for (const g of gate.grandfather || []) {
    if (!g || typeof g !== 'object') {
      add('grandfather-not-object', 'error', `${at} has a grandfather entry that is not an object`)
      continue
    }
    if (!g.context) {
      add('grandfather-no-context', 'error', `${at} has a grandfather entry with no context`,
        'Without `context` the runtime suppresses nothing — the entry is decoration.')
    }
    if (!g.reason) {
      add('grandfather-no-reason', 'error', `${at} has a grandfather entry with no reason`)
    }
    if (!g.expires) {
      add('grandfather-no-expiry', 'error', `${at} has a grandfather entry with no expiry`,
        'An exception without a date outlives the reason for it. That is how a gate quietly stops covering the thing it was written for.')
    } else if (Number.isNaN(new Date(g.expires).getTime())) {
      add('grandfather-bad-expiry', 'error', `${at} has a grandfather entry whose expires "${g.expires}" is not a date`)
    }
  }
  if (gate.grandfather !== undefined && KINDS.includes(gate.kind) && gate.kind !== 'banned-content') {
    add('grandfather-ignored', 'warn', `${at}: only banned-content gates honour \`grandfather\`; on a ${gate.kind} gate it suppresses nothing`)
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
  const fires = (await readFires(root)).filter((f) => f.gate === gateId && EVIDENCE_MODES.includes(f.mode))
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
  if (!config) throw new GateError('No .caselaw/gates.json in this project.', { code: 'NO_CONFIG' })

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
