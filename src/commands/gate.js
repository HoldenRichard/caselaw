/**
 * `caselaw gate …` — run gates by hand, and promote one that has earned it.
 *
 * `test` and `baseline` run the repo's OWN vendored runner (.caselaw/bin/gate.mjs),
 * never this package's copy: what matters is the code the hooks execute. Both
 * run with telemetry off — a hand-run is a look, not evidence, and evidence is
 * what `promote` counts.
 */

import { join } from 'node:path'
import { stat, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import * as gatesStore from '../core/gates.js'
import { parseRule, serializeRule } from '../core/rules.js'
import { ruleDirsFor, doctrineDirAt } from '../core/doctrine.js'
import { listIncidents } from '../core/incidents.js'

export const GATE_SUBCOMMANDS = ['test', 'baseline', 'promote', 'synthesize']

/**
 * @param {object} args parsed CLI args: { sub, name, force, json }
 * @param {{root: string, say: (s: string) => void}} io
 * @returns {Promise<number>} the exit code
 */
export async function cmdGate(args, { root, say }) {
  const sub = args.sub
  if (!GATE_SUBCOMMANDS.includes(sub)) {
    say(`  caselaw gate needs one of: ${GATE_SUBCOMMANDS.join(', ')}.`)
    return 2
  }
  try {
    switch (sub) {
      case 'test': return await testOne(args, { root, say })
      case 'baseline': return await baseline(args, { root, say })
      case 'promote': return await promote(args, { root, say })
      case 'synthesize': return await synthesize(args, { root, say })
    }
  } catch (err) {
    if (err instanceof gatesStore.GateError || err?.code) {
      say(`  ${err.message}`)
      if (err.hint) say(`  ${err.hint}`)
      return 1
    }
    throw err
  }
  return 2
}

async function testOne(args, { root, say }) {
  if (!args.name) {
    say('  caselaw gate test needs a gate id.')
    return 2
  }
  const config = await gatesStore.load(root)
  if (!config) {
    say(`  No ${gatesStore.GATES_PATH} here. Gates are created by \`caselaw rule promote <name>\`.`)
    return 1
  }
  const gate = config.gates.find((g) => g.id === args.name)
  if (!gate) {
    say(`  No gate "${args.name}". Known: ${config.gates.map((g) => g.id).join(', ') || '(none)'}.`)
    return 1
  }
  const runner = await loadRunner(root)
  const res = await runner.evaluate({ root, mode: 'all', config: { version: 1, gates: [gate] }, telemetry: false })
  say(args.json ? JSON.stringify(res, null, 2) : format(res))
  return 0
}

async function baseline(args, { root, say }) {
  const runner = await loadRunner(root)
  const res = await runner.evaluate({ root, mode: 'all', telemetry: false })
  say(args.json ? JSON.stringify(res, null, 2) : format(res))
  return 0
}

async function promote(args, { root, say }) {
  if (!args.name) {
    say('  caselaw gate promote needs a gate id.')
    return 2
  }
  const r = await gatesStore.promote(root, args.name, { force: Boolean(args.force) })
  if (r.already) {
    say(`  "${args.name}" already blocks.`)
    return 0
  }
  say(`  "${args.name}" now blocks (${r.forced ? 'forced' : `${r.status.fires} recorded fires`}).`)
  return 0
}

/** A compact report over an evaluate() result, without recording anything. */
export function format(res) {
  const lines = []
  const n = res.config.gateCount
  lines.push(`  gates — mode ${res.mode} — ${n} gate${n === 1 ? '' : 's'} — telemetry off (a hand-run is a look, not evidence)`)
  if (res.config.degraded) lines.push(`  CONFIG NOT USABLE: ${res.config.reason}`)
  for (const p of (res.config.problems ?? []).filter((x) => x.level !== 'defaulted')) {
    lines.push(`  config [${p.level}] ${p.gate ? `${p.gate}: ` : ''}${p.message}`)
  }
  for (const f of res.fires) {
    const tag = f.severity === 'block' ? 'BLOCK' : 'warn '
    lines.push(`  ${tag}  ${f.gate}  ${f.path ?? '(no path)'}${f.line ? `:${f.line}` : ''}`)
    lines.push(`         ${f.detail}`)
  }
  for (const r of res.degraded) for (const d of r.degradations) lines.push(`  degraded  ${r.gate}: ${d.reason}${d.hint ? ` (${d.hint})` : ''}`)
  for (const r of res.skipped) lines.push(`  skipped   ${r.gate}: ${r.skipReason}`)
  lines.push(`  ${res.fires.length} fire${res.fires.length === 1 ? '' : 's'} (${res.blocking.length} blocking, ${res.warnings.length} warn) · ${res.degraded.length} degraded · ${res.skipped.length} skipped`)
  return lines.join('\n')
}

async function loadRunner(root) {
  const p = join(root, '.caselaw/bin/gate.mjs')
  try {
    await stat(p)
  } catch {
    throw new gatesStore.GateError('No vendored runner at .caselaw/bin/gate.mjs. Run `caselaw upgrade` to restore it.', { code: 'NO_RUNNER' })
  }
  return import(pathToFileURL(p).href)
}

async function synthesize(args, { root, say }) {
  if (!args.name) {
    say('  caselaw gate synthesize needs a rule name.')
    return 2
  }
  const dir = doctrineDirAt(root)
  const dirs = ruleDirsFor(dir)
  const path = join(root, dirs.active, `${args.name}.md`)
  let text = null
  try {
    text = await readFile(path, 'utf8')
  } catch {
    say(`  No active rule named "${args.name}" at ${dirs.active}/${args.name}.md.`)
    return 1
  }

  const parsed = parseRule(text)
  const incidents = await listIncidents(root, { rule: args.name })
  if (!incidents.length) {
    say(`  No contrastive incidents recorded for "${args.name}".`)
    say('  Cannot synthesize machine gate without incident fixtures.')
    say(`  Run: caselaw rule incident ${args.name} --positive <bad-sha> --negative <good-sha>`)
    return 1
  }

  const res = gatesStore.synthesizeMachineGate({ rule: parsed, incidentFixtures: incidents, dir })
  if (!res.success) {
    say(`  Cannot synthesize machine gate for "${args.name}":`)
    say(`    ${res.reason}`)
    return 1
  }

  say(`  Synthesized machine gate for "${args.name}":`)
  say(`    Pattern: "${res.pattern}" (100% sensitivity, 100% specificity)`)
  say(`    Gate ID: ${res.gate.id}`)

  if (args.yes || args.opt.apply) {
    let config = await gatesStore.load(root)
    if (!config) config = gatesStore.emptyConfig()
    const existingIdx = config.gates.findIndex((g) => g.id === res.gate.id)
    if (existingIdx !== -1) {
      const existing = config.gates[existingIdx]
      const isForce = Boolean(args.force || args.opt?.force)
      if (!isForce) {
        say(`  Refusing to overwrite gate "${res.gate.id}": existing gate already registered. Overwriting an existing gate requires explicit human authorization with --force (Axiom A1).`)
        return 1
      }
      if (existing.severity === 'block' && res.gate.severity !== 'block') {
        say(`  Refusing to downgrade gate "${res.gate.id}": existing gate has severity "block". Synthesizing a warning gate cannot downgrade a blocking gate (Axiom A1).`)
        return 1
      }
      config.gates[existingIdx] = res.gate
    } else {
      config.gates.push(res.gate)
    }
    await gatesStore.save(root, config)

    const updatedRule = serializeRule({ ...parsed, enforcement: `machine:${res.gate.id}` })
    await writeFile(path, updatedRule, 'utf8')
    say(`  Registered in ${gatesStore.GATES_PATH} and updated enforcement to machine:${res.gate.id}.`)
  } else {
    say('  Pass --yes or --apply to register this gate and compact rule enforcement.')
  }

  return 0
}
