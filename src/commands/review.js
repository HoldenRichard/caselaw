/**
 * `caselaw review` — a review prompt for a DIFFERENT model.
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
import { doctrineDirAt } from '../core/doctrine.js'

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
export async function readDoctrine(root, paths = [`${doctrineDirAt(root)}/authority-split.md`, `${doctrineDirAt(root)}/rules/README.md`]) {
  const out = {}
  for (const p of paths) {
    try { out[p] = await readFile(join(root, p), 'utf8') } catch { /* absent is fine */ }
  }
  return out
}

// ---------------------------------------------------------------------------
// Review roles (0.3): refuter, verifier, judge
// ---------------------------------------------------------------------------

export const ROLES = ['refuter', 'verifier', 'judge']
/** A claim is what the change should do, in a sentence or two. Longer is an argument, and arguments are the builder's reasoning. */
export const MAX_CLAIM = 300
export const MAX_DIFF = 60_000

const ROLE_BRIEF = {
  refuter: {
    who: 'a model from a different family than the one that built the change, if you have one',
    job: `Try to show the claim is false. Find the input, state or sequence for which this change does not do
what it claims, or does something it should not. Read the code it touches, not just the diff. You are
done when you have a concrete failing case, or when you have honestly tried the obvious ways to break
it and say which.`,
    contract: `VERDICT: PASS   (you could not refute it; list what you tried)
VERDICT: FAIL   (you refuted it; give the failing case: inputs or state -> what happens instead)`,
  },
  verifier: {
    who: 'any model that can read this repository and run its commands; not the one that built the change',
    job: `Check the claim against the change. Run what would show it holds (the tests it touches, the
command it changes, the file it writes) and report each as a verification line: what ran, who ran it,
what it showed. Then say what you did not cover: the cases you could not run here, the files you did
not open, anything the project marks as something an agent cannot verify.`,
    contract: `VERDICT: PASS   (every verification line supports the claim)
VERDICT: FAIL   (one does not; quote it)`,
  },
  judge: {
    who: 'a third model, or the human',
    job: `You have the change, its claim, and two reviews of it. Decide whether the claim holds. Weigh each
finding on its evidence: a refutation with a concrete failing case outweighs a pass, and a verification
line that did not run is not a pass. You may decide that neither review is good enough to decide on.`,
    contract: `VERDICT: PASS       (the claim holds on the evidence)
VERDICT: FAIL       (it does not; name the finding that decides it)
VERDICT: ESCALATE   (a human has to look; say at what)`,
  },
}

/**
 * The verdict a reviewer returned, from its first non-empty line. A review
 * without an explicit verdict is not a review: a judge is not built on one.
 *
 * @returns {{verdict: 'PASS'|'FAIL'|'ESCALATE'|null, body: string}}
 */
export function parseVerdict(text = '') {
  const lines = String(text).split(/\r?\n/)
  const at = lines.findIndex((l) => l.trim())
  const m = at === -1 ? null : /^\s*VERDICT:\s*(PASS|FAIL|ESCALATE)\b/i.exec(lines[at])
  return { verdict: m ? m[1].toUpperCase() : null, body: lines.slice(at + 1).join('\n').trim() }
}

/**
 * A role's prompt: the change and what it claims, the project's boundaries,
 * and the output contract. Never the builder's reasoning: no commit message
 * body, no plan, no transcript, only the claim.
 */
export function buildRolePrompt({ role, claim, diff, truncated = false, answers = null, rules = { active: [] }, builder = null, reviews = {} }) {
  if (!ROLES.includes(role)) throw new Error(`--role is one of ${ROLES.join(', ')}`)
  const c = String(claim || '').replace(/\s+/g, ' ').trim()
  if (!c) throw new Error('--claim "<what the change should do>" is required: a reviewer checks a claim, not a mood.')
  if (c.length > MAX_CLAIM) throw new Error(`The claim is ${c.length} characters; keep it to ${MAX_CLAIM}. A claim says what the change does; why the builder believes it is exactly what a reviewer must not be given.`)
  if (!String(diff || '').trim()) throw new Error('There is no change to review: the diff is empty.')
  const brief = ROLE_BRIEF[role]
  let given = ''
  if (role === 'judge') {
    for (const r of ['refuter', 'verifier']) {
      const v = parseVerdict(reviews[r])
      if (!v.verdict) throw new Error(`The ${r}'s review has no VERDICT line first. Ask for one; a review without an explicit pass or fail is not something to judge.`)
      given += `\n## The ${r}'s review (VERDICT: ${v.verdict})\n\n${v.body || '(no findings given)'}\n`
    }
  }
  const rulesInPlay = rules.active.length
    ? rules.active.map((r) => `- ${r.name}: when ${r.trigger || '(no trigger)'}`).join('\n')
    : '(none)'
  return `You are the ${role.toUpperCase()} for one change to a software project. Run this as ${brief.who}${builder ? `; the change was built by ${builder}` : ''}.
You are given the change and what it claims. You are not given why its author believed it works, on purpose:
judge the change, not the argument for it.

## The claim

${c}

## What this project says an agent cannot verify here

${summariseBoundaries(answers)}

## The project's rules (each applies only when its trigger matches)

${rulesInPlay}

## Your job

${brief.job}
${given}
## The change${truncated ? ` (cut at ${MAX_DIFF} characters: say that you did not see the rest)` : ''}

\`\`\`diff
${String(diff).slice(0, MAX_DIFF)}
\`\`\`

## Output contract

The first line of your answer is the verdict, exactly one of:

${brief.contract}

Then the findings, each with a file and a line. Do not soften the verdict, and do not invent a finding:
each one becomes work for a human who trusts you did not.`
}
