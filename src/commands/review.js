/**
 * `caselaw review --emit` — a review prompt for a DIFFERENT model.
 *
 * The source methodology runs one review deliberately on another model family,
 * on the reasoning that same-model review shares the same blind spots: the
 * model that wrote a thing is the model least likely to notice what it assumed.
 *
 * So this command emits rather than executes. It prints a self-contained
 * prompt — repo facts, the checklist, and the output contract — to paste into
 * whatever other CLI you have. Nothing here calls an API, which also means it
 * costs nothing, needs no key, and works with a tool that does not exist yet.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * @param {{root: string, detected: object, answers: object|null,
 *          rules: object, gatesConfig: object, scope?: string}} ctx
 */
export function buildReviewPrompt(ctx) {
  const { detected = {}, answers = null, rules = { active: [] }, gatesConfig = { gates: [] }, scope = 'doctrine' } = ctx

  const langs = (detected.stack?.languages || []).slice(0, 3).map((l) => `${l.name} ${l.pct}%`).join(', ') || 'unknown'
  const cmds = Object.entries(detected.commands || {})
    .filter(([, v]) => v?.cmd)
    .map(([k, v]) => `${k}: ${v.cmd}`)
    .join('; ') || 'none detected'

  const boundaries = summariseBoundaries(answers)
  const ruleList = rules.active.length
    ? rules.active.map((r) => `- ${r.name} — Trigger: ${r.trigger || '(none)'} — Enforcement: ${enforcementOf(r)}`).join('\n')
    : '(none yet)'
  const gateList = (gatesConfig.gates || []).length
    ? gatesConfig.gates.map((g) => `- ${g.id} (${g.kind}, ${g.severity}) → ${g.origin ?? 'no origin'}`).join('\n')
    : '(none yet)'

  return `You are reviewing the ENGINEERING GOVERNANCE of a software project.
You did not write any of it. You are a second opinion from a different model,
and you were asked precisely because the model that wrote this shares its own
blind spots.

## The project

Languages: ${langs}
Commands:  ${cmds}
Deploys to: ${(detected.deploySurface || []).map((d) => d.kind).join(', ') || 'nothing detected'}

## What the project says its agent CANNOT verify

${boundaries}

## Active rules

${ruleList}

## Gates

${gateList}

## What to look for

Answer these four, briefly. Cite a file and a line for every claim; a finding
without a citation is not a finding.

1. **Contradiction.** Do any two rules, or a rule and the authority split, tell
   an agent to do incompatible things? Quote both sides.

2. **Unenforceable prose.** Is any rule written so vaguely that two competent
   agents would behave differently and both believe they complied? Name the
   specific ambiguous phrase, not a general impression.

3. **Missing coverage.** The authority split names things a human must verify.
   Is there anything on that list that no rule, gate, or checklist actually
   routes to a human? That gap is where "the agent said it worked" becomes the
   only evidence.

4. **Over-claiming.** Does any rule claim machine enforcement it does not have,
   or does any gate claim to cover more than its scope really does?

## Output contract

For each finding:
  SEVERITY (high | medium | low)
  WHAT — one sentence
  WHERE — file:line
  WHY IT MATTERS — the concrete failure it permits
  FIX — the smallest change that closes it

If you find nothing in a category, write "nothing found" for it and move on.
Do not pad. A fabricated finding costs more than a missed one, because every
finding here becomes work for a human who trusts you did not invent it.`
}

function enforcementOf(rule) {
  const mode = rule.enforcement?.mode ?? rule.enforcement ?? 'memory'
  const gate = rule.enforcement?.gateId
  return gate ? `${mode}:${gate}` : String(mode)
}

function summariseBoundaries(answers) {
  if (!answers?.answers) return '(no authority split recorded)'
  const selected = answers.answers['authority.cannot'] || []
  const triage = answers.answers['authority.triage'] || {}
  if (!selected.length) return '(none recorded)'
  return selected
    .map((b) => `- ${b} (${triage[b] || 'unclassified'})`)
    .join('\n')
}

/** Read the doctrine files a reviewer would want inlined, if they exist. */
export async function readDoctrine(root, paths = ['docs/authority-split.md', 'docs/rules/README.md']) {
  const out = {}
  for (const p of paths) {
    try { out[p] = await readFile(join(root, p), 'utf8') } catch { /* absent is fine */ }
  }
  return out
}
