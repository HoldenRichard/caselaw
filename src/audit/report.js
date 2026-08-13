/**
 * Rendering the audit.
 *
 * The headline is the mechanisation ratio, not the finding count. Findings go
 * up and down with how much you did this month; the ratio says whether the
 * governance is getting stronger or just getting longer.
 */

import { SEVERITY } from './checks.js'

const BAR_WIDTH = 20

export function formatReport(result, ctx, { color = false } = {}) {
  const lines = []
  const dim = (s) => (color ? `\x1b[2m${s}\x1b[0m` : s)
  const bold = (s) => (color ? `\x1b[1m${s}\x1b[0m` : s)

  lines.push(bold(`harness audit — ${ctx.projectName || ctx.root}`))
  lines.push('')
  if (!ctx.installed) {
    lines.push(dim('  No harness installed here — running only the checks that do not need one.'))
    lines.push(dim('  `harness init` to get the rest.'))
    lines.push('')
  }

  // --- the headline ---
  const ratio = result.findings.find((f) => f.code === 'mechanization-ratio')
  const d = ratio?.data
  if (d && d.total > 0) {
    lines.push('  ENFORCEMENT' + ' '.repeat(11) + `${d.total} active rule${d.total === 1 ? '' : 's'}`)
    for (const [label, n] of [['machine', d.machine], ['checklist', d.checklist], ['memory', d.memory]]) {
      const pct = Math.round((n / d.total) * 100)
      const filled = Math.round((n / d.total) * BAR_WIDTH)
      const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
      const tail = label === 'memory' && n > 0 ? dim('   ← degrades silently') : ''
      lines.push(`    ${label.padEnd(10)} ${String(n).padStart(2)}  ${bar}  ${String(pct).padStart(3)}%${tail}`)
    }
  } else {
    lines.push(dim('  ENFORCEMENT           no active rules yet'))
    lines.push(dim('    Expected on a young install. Watch one number: days to the first ratified rule.'))
  }
  lines.push('')

  // --- findings, worst first ---
  const order = { [SEVERITY.ERROR]: 0, [SEVERITY.WARN]: 1, [SEVERITY.INFO]: 2 }
  const shown = result.findings
    .filter((f) => f.code !== 'mechanization-ratio')
    .sort((a, b) => order[a.severity] - order[b.severity])

  if (shown.length === 0) {
    lines.push('  Nothing to report. Everything the audit can check is currently true.')
  }
  for (const f of shown) {
    const tag = f.severity.toUpperCase().padEnd(7)
    lines.push(`  ${tag} ${f.code.padEnd(20)} ${f.message}`)
    if (f.hint) lines.push(dim(`  ${' '.repeat(7)} ${' '.repeat(20)} ${f.hint}`))
  }

  if (result.failed.length) {
    lines.push('')
    for (const f of result.failed) {
      lines.push(`  BROKEN  ${f.id.padEnd(20)} this check itself failed: ${f.reason}`)
    }
    lines.push(dim('  A check that cannot run is not a check that passed.'))
  }

  if (ctx.notes?.length) {
    lines.push('')
    for (const n of ctx.notes) lines.push(dim(`  note: ${n}`));
  }

  lines.push('')
  // Count what was actually displayed. The mechanisation ratio is rendered as
  // the headline, so counting it again as a "note" makes the totals disagree
  // with the list directly above them.
  const error = shown.filter((f) => f.severity === SEVERITY.ERROR).length
  const warn = shown.filter((f) => f.severity === SEVERITY.WARN).length
  const info = shown.filter((f) => f.severity === SEVERITY.INFO).length
  const parts = []
  if (error) parts.push(`${error} error`)
  if (warn) parts.push(`${warn} warning`)
  if (info) parts.push(`${info} note`)
  lines.push(`  ${shown.length} finding${shown.length === 1 ? '' : 's'}${parts.length ? ` · ${parts.join(' · ')}` : ''}` +
    `   exit ${result.ok ? 0 : 1}`)

  return lines.join('\n')
}

/** Machine-readable, for CI. */
export function toJson(result, ctx) {
  return {
    ok: result.ok,
    root: ctx.root,
    installed: ctx.installed,
    counts: result.counts,
    findings: result.findings,
    checksRun: result.ran,
    checksFailed: result.failed,
    notes: ctx.notes ?? [],
  }
}

/**
 * A model-agnostic prompt for the optional adversarial pass.
 *
 * Emitted rather than executed: the deterministic audit above is a program,
 * and mixing a model's opinion into its counts would make the number mean
 * something different every run. This is a second opinion, clearly labelled,
 * and it is deliberately runnable on a DIFFERENT model family — same-model
 * review shares the same blind spots.
 */
export function agentPrompt(result, ctx) {
  const rules = ctx.rules.active.map((r) => `- ${r.name}: ${r.trigger}`).join('\n') || '(none)'
  return `You are auditing the GOVERNANCE of a software project, not its code.

The deterministic audit has already run and found ${result.counts.error} error(s) and
${result.counts.warn} warning(s). Do not repeat it. Look for what a program cannot see.

Active rules and their triggers:
${rules}

Answer three questions, briefly, and cite a file for every claim:

1. CONTRADICTION — do any two rules, or a rule and the authority split, tell an
   agent to do incompatible things? Quote both.
2. UNENFORCEABLE PROSE — is any rule written so vaguely that two reasonable
   agents would behave differently? Name the ambiguity, not the vibe.
3. MISSING COVERAGE — does the authority split claim a boundary the rest of the
   doctrine quietly ignores?

If you find nothing, say so. A fabricated finding costs more than a missed one,
because every finding here becomes work for a human.`
}
