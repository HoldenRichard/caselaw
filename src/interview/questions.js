/**
 * The question set — as DATA, not code.
 *
 * The interview is the product. Everything else in this tool renders what these
 * questions collect, so the constraints below are load-bearing rather than
 * stylistic:
 *
 *  - **Every question names what it generates.** A question that cannot point at
 *    an artifact section is a question that wastes the user's budget; there is a
 *    test that fails the build if `generates` is empty.
 *  - **≤ 5 questions per session, asked one at a time.** Borrowed from the most
 *    battle-tested interview in this category. Long interviews get abandoned
 *    around question nine, and an abandoned interview generates nothing.
 *  - **Forced answer shapes.** 2–5 mutually exclusive options, or a short free
 *    text. Anything answerable in one keystroke should be.
 *  - **Detection first.** If Stage 0 can read it, we confirm instead of asking.
 *    `when` is how a question removes itself.
 *  - **`since` on every question** so an upgrade asks only what is new.
 *
 * Session 1 is the whole reason this tool exists. Its seed question — what can
 * your agent physically not verify — produces the authority split, and the
 * follow-up triage (physical / chosen / untested) is the idea nothing else in
 * this category has. Protect both from scope cuts.
 */

/** @typedef {'multiselect'|'triage'|'select'|'text'|'confirm'|'number'} QuestionType */

export const SESSIONS = [
  { n: 1, key: 'authority', title: 'The authority split', budget: 5, minutes: 4 },
  { n: 2, key: 'verification', title: 'Verification cadence', budget: 5, minutes: 3 },
  { n: 3, key: 'boundaries', title: 'Boundaries and escalation', budget: 4, minutes: 2 },
  { n: 4, key: 'gates', title: 'Invariants worth machine-checking', budget: 3, minutes: 3 },
  { n: 5, key: 'modules', title: 'Modules and adapters', budget: 3, minutes: 1 },
]

/**
 * Candidate boundaries, tailored by what Stage 0 found. The `when` on each
 * keeps the list short: showing a stranger fourteen irrelevant checkboxes is
 * how you lose them before the first real answer.
 */
export function boundaryCandidates(detected = {}) {
  const deploy = new Set((detected.deploySurface || []).map((d) => d.kind))
  const langs = new Set((detected.stack?.languages || []).map((l) => l.name.toLowerCase()))
  const has = (k) => deploy.has(k)

  const all = [
    { value: 'device', label: 'run it on real hardware / a physical device',
      when: () => langs.has('swift') || langs.has('kotlin') || langs.has('objective-c') },
    { value: 'rendered-ui', label: 'see what the UI actually renders',
      when: () => langs.has('swift') || langs.has('typescript') || langs.has('javascript') || langs.has('kotlin') },
    { value: 'prod-data', label: 'read production database / datastore state',
      when: () => has('firebase') || has('terraform') || has('k8s') || has('serverless') || true },
    { value: 'prod-logs', label: 'read production logs',
      when: () => deploy.size > 0 },
    { value: 'deploy', label: 'deploy',
      when: () => deploy.size > 0 },
    { value: 'migrations', label: 'run database migrations',
      when: () => true },
    { value: 'secrets', label: 'read secrets / API keys',
      when: (d) => (d.secretSurface || []).length > 0 },
    { value: 'paid-apis', label: 'call paid or rate-limited third-party APIs',
      when: () => true },
    { value: 'full-suite', label: 'run the full test suite (too slow, or needs credentials)',
      when: () => true },
    { value: 'real-user-data', label: 'reproduce anything with real customer data',
      when: () => true },
    { value: 'release-console', label: 'reach the release / app-store / registry console',
      when: () => langs.has('swift') || langs.has('kotlin') || has('vercel') || has('fly') },
    { value: 'delivery', label: 'confirm an email / SMS / push actually arrived',
      when: () => true },
    { value: 'human-login', label: 'log into anything as a human',
      when: () => true },
  ]
  return all.filter((o) => o.when(detected)).map(({ value, label }) => ({ value, label }))
}

export const TRIAGE_OPTIONS = [
  { value: 'physical', key: 'p', label: 'physical — no process could do it from here' },
  { value: 'chosen', key: 'c', label: 'chosen — possible, but the agent must not' },
  { value: 'untested', key: 'u', label: 'untested — assumed, never actually checked' },
]

/** @type {Array<object>} */
export const QUESTIONS = [
  // ── Session 1 — the authority split ──────────────────────────────────────
  {
    id: 'authority.cannot',
    session: 1,
    since: '1.0',
    type: 'multiselect',
    impact: 5,
    prompt:
      'Right now, today, what can your coding agent NOT do or observe in this project without you?',
    help:
      'This is the question the whole harness is built around. Everything the agent cannot check itself is work that has to come back to you — naming it is what makes the handoff explicit instead of assumed.',
    options: (ctx) => boundaryCandidates(ctx.detected),
    allowOther: true,
    generates: ['docs/authority-split.md#cannot', 'docs/verification-tiers.md#tier3'],
  },
  {
    id: 'authority.triage',
    session: 1,
    since: '1.0',
    type: 'triage',
    impact: 5,
    over: 'authority.cannot',
    prompt: 'For each of those — is the boundary physical, chosen, or untested?',
    help:
      'A silent misconfiguration reads exactly like a permanent boundary, and boundaries do not get re-tested. Anything you mark untested gets written down with a one-command way to settle it, and a date.',
    options: TRIAGE_OPTIONS,
    when: (a) => (a['authority.cannot'] || []).length > 0,
    generates: ['docs/authority-split.md#physical', 'docs/authority-split.md#chosen', 'docs/authority-split.md#unverified'],
  },
  {
    id: 'authority.human_proof',
    session: 1,
    since: '1.0',
    type: 'text',
    impact: 4,
    multiline: true,
    prompt: 'What does a human have to DO to prove a change actually works here?',
    help: 'Specific enough that a stranger could follow it. This becomes the handover section of every close-out.',
    placeholder: 'e.g. build to a real iPhone, tap through onboarding, confirm the badge appears',
    when: (a) => (a['authority.cannot'] || []).length > 0,
    generates: ['docs/verification-tiers.md#tier3', 'docs/close-out.md#handed-over'],
  },
  {
    id: 'authority.agent_reach',
    session: 1,
    since: '1.0',
    type: 'text',
    impact: 4,
    multiline: true,
    prompt: 'What are you checking by hand that the agent could check itself if told to?',
    help:
      'Screenshots, a local run, a read-only query, a staging call. This tier is where the leverage is — it moves work off you, not onto you.',
    placeholder: 'e.g. it could boot the simulator and screenshot both colour schemes',
    generates: ['docs/verification-tiers.md#tier2'],
  },
  {
    id: 'authority.retest_days',
    session: 1,
    since: '1.0',
    type: 'number',
    impact: 2,
    default: 30,
    min: 7,
    max: 365,
    prompt: 'How many days before the boundary list should be re-checked for staleness?',
    when: (a) => Object.values(a['authority.triage'] || {}).includes('untested'),
    generates: ['docs/authority-split.md#unverified'],
  },
]

/** Questions belonging to a session, in ask order, filtered by `when`. */
export function questionsFor(session, answers = {}, detected = {}) {
  return QUESTIONS.filter((q) => q.session === session).filter((q) =>
    typeof q.when === 'function' ? q.when(answers, detected) : true,
  )
}

/**
 * Rank by (impact × uncertainty), where uncertainty is 1 for unanswered and 0
 * for anything detection already settled. With a hard per-session budget, the
 * budget should be spent where it buys the most.
 */
export function rank(questions, answers = {}) {
  return [...questions].sort((a, b) => {
    const ua = answers[a.id] === undefined ? 1 : 0
    const ub = answers[b.id] === undefined ? 1 : 0
    return (b.impact || 1) * ub - (a.impact || 1) * ua
  })
}

/** Resolve dynamic options against the detection report. */
export function optionsFor(question, ctx = {}) {
  const o = question.options
  return typeof o === 'function' ? o(ctx) : o || []
}

export function sessionMeta(n) {
  return SESSIONS.find((s) => s.n === n) || null
}
