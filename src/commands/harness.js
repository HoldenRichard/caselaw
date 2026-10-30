/**
 * `caselaw harness`: the harness's own changes (0.3's self-update).
 *
 *   propose   an agent may: a change with local evidence and the signal it should improve
 *   apply     a human, at a terminal: a proposal the bounds did not apply on their own
 *   reject    a human, at a terminal
 *   revert    proposes the change that undoes an applied one (classified afresh)
 *   log       every change, its state, and whether it helped once its window passed
 */

import * as answersStore from '../core/answers.js'
import { proposeChange, applyChange, rejectChange, readLog, changes, reverseOf, describeChange, evaluateChanges, measureSignals, SIGNALS } from '../core/harness.js'
import { CONSTITUTION } from '../core/constitution.js'

export const HARNESS_SUBCOMMANDS = ['propose', 'apply', 'reject', 'revert', 'log']

/** The change the flags describe, or null. */
export function changeFromFlags(opt = {}) {
  if (opt.set) {
    const [key, value] = String(opt.set).split('=')
    return { op: 'set', key: key.trim(), value: Number(value) }
  }
  if (opt.enable) return { op: 'enable', id: String(opt.enable).trim().toUpperCase() }
  if (opt.disable) return { op: 'disable', id: String(opt.disable).trim().toUpperCase() }
  if (opt.autonomy) return { op: 'autonomy', value: String(opt.autonomy).trim() }
  if (opt.note) return { op: 'note', text: String(opt.note) }
  return null
}

/**
 * @param {object} args parsed CLI args: { sub, name, opt, yes }
 * @param {{root: string, say: (s: string) => void, interactive: boolean, prompt: () => object, rerender: () => Promise<void>}} io
 */
export async function cmdHarness(args, io) {
  const { root, say } = io
  const doc = await answersStore.load(root)
  if (!doc) {
    say('  caselaw is not installed here. Run `caselaw init` first.')
    return 1
  }
  try {
    switch (args.sub) {
      case 'propose': return await propose(args, io, doc)
      case 'apply': return await apply(args, io, doc)
      case 'reject': {
        if (!io.interactive) { say('  Rejecting a proposed change is a human\'s call. Run this yourself at a terminal.'); return 1 }
        await rejectChange({ root, id: args.name, interactive: true })
        say(`  ${args.name} rejected. It stays in the log, as everything does.`)
        return 0
      }
      case 'revert': return await revert(args, io, doc)
      case 'log': return await showLog(io, doc)
      default:
        say(`  caselaw harness <${HARNESS_SUBCOMMANDS.join('|')}>`)
        return 2
    }
  } catch (err) {
    if (!err.code) throw err
    say(`  ${err.message}`)
    return 1
  }
}

async function propose(args, io, doc) {
  const { root, say } = io
  const change = changeFromFlags(args.opt)
  if (!change) {
    say('  Say what to change: --set <key>=<value>, --enable <D1-D6|T1-T7>, --disable <id>, --autonomy <preset>, or --note "<what>".')
    say(`  With --why "<the local evidence: a commit, a date, an issue>" and --signal <${Object.keys(SIGNALS).join('|')}>.`)
    return 2
  }
  const r = await proposeChange({ root, doc, change, evidence: args.opt.why, signal: args.opt.signal, window: args.opt.window ?? undefined, by: io.interactive ? 'human' : 'agent' })
  say(`  ${r.id}: ${describeChange(r.change)} — a ${r.kind} (${r.reason}).`)
  if (r.applied) {
    await answersStore.save(root, doc)
    say(`  Applied on its own: ${r.why}. The log records the signal's value now; after the window the audit asks whether it helped.`)
    await io.rerender()
  } else {
    say(`  Proposed, not applied: ${r.why}. A human applies it with \`caselaw harness apply ${r.id}\`.`)
  }
  return 0
}

async function apply(args, io, doc) {
  const { root, say } = io
  if (!io.interactive) {
    say('  Applying a change the bounds did not apply on their own is a human\'s call. Run this yourself at a terminal.')
    return 1
  }
  const c = changes(await readLog(root)).find((x) => x.id === args.name)
  if (c && !args.yes) {
    const p = io.prompt()
    try {
      if ((await p.confirm({ prompt: `Apply ${c.id}: ${describeChange(c.change)}?`, default: false })) !== true) { say('  Not applied.'); return 1 }
    } finally {
      await p.close()
    }
  }
  const r = await applyChange({ root, doc, id: args.name, by: 'human', interactive: true })
  await answersStore.save(root, doc)
  say(`  ${r.id} applied. ${r.baseline.signal} is ${r.baseline.value} now; its window starts today.`)
  if (r.rerender) await io.rerender()
  return 0
}

async function revert(args, io, doc) {
  const { root, say } = io
  const c = changes(await readLog(root)).find((x) => x.id === args.name)
  if (!c || c.state !== 'applied') {
    say(`  ${args.name} is not an applied change.`)
    return 1
  }
  const r = await proposeChange({
    root, doc, change: reverseOf(c), reverts: c.id, signal: c.signal, window: c.window,
    evidence: args.opt.why || `${c.id} did not improve ${c.signal} within its window (harness log, ${new Date().toISOString().slice(0, 10)})`,
    by: io.interactive ? 'human' : 'agent',
  })
  say(`  ${r.id} reverts ${c.id}: a ${r.kind}. ${r.applied ? `Applied on its own: ${r.why}.` : `Proposed: ${r.why}.`}`)
  if (r.applied) { await answersStore.save(root, doc); await io.rerender() }
  return 0
}

async function showLog({ root, say }, doc) {
  const log = await readLog(root)
  const all = changes(log)
  if (!all.length) say('  No changes to the harness yet.')
  const evals = new Map(evaluateChanges(log, await measureSignals({ root, doc })).map((e) => [e.id, e]))
  for (const c of all) {
    const e = evals.get(c.id)
    const verdict = e ? (e.helped ? `helped: ${c.signal} ${e.before} → ${e.after}` : `did not help: ${c.signal} ${e.before} → ${e.after}${e.revertedBy ? `; reverted by ${e.revertedBy}` : ''}`) : ''
    say(`  ${c.id}  ${c.state.padEnd(8)} ${describeChange(c.change)}${verdict ? `  (${verdict})` : ''}`)
  }
  say('\n  Whatever the preset, these always need a human:')
  for (const a of CONSTITUTION) say(`    ${a.id}. ${a.text}`)
  return 0
}
