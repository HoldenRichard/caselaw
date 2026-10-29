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

/**
 * Sessions that exist. Others were designed — verification cadence, invariants
 * worth machine-checking, modules and adapters — and are not declared here on
 * purpose: a declared-but-empty session printed "Session 1/5" to every user,
 * and the README promised a fifteen-minute interview that took four. The list
 * grows when a session's questions exist, not before. Session 2 joined in 0.3:
 * who outside the repository can rule on it, and where it makes public claims.
 */
export const SESSIONS = [
  { n: 1, key: 'authority', title: 'The authority split', budget: 5, minutes: 4 },
  { n: 2, key: 'outside', title: 'Outside authority', budget: 2, minutes: 1 },
]

/**
 * Who outside the repository can rule on it. An app reviewer's ruling sits
 * outside anything the repository controls and need not state its basis; in
 * the study behind this tool, only rulings that named their basis became
 * standing rules, and the rest reached a local patch at most. Naming the
 * gatekeeper is what lets the authority split say so before the first ruling.
 */
export function gatekeeperCandidates(detected = {}) {
  const langs = new Set((detected.stack?.languages || []).map((l) => l.name.toLowerCase()))
  const kinds = (k) => new Set((detected.signals?.[k] || []).map((s) => s.kind))
  const stores = kinds('stores')
  const registries = [...kinds('registries')].filter((k) => k !== 'goreleaser')
  const all = [
    { value: 'app-review', label: 'an app store\'s review (Apple App Review, Google Play)',
      when: () => langs.has('swift') || langs.has('kotlin') || langs.has('objective-c') },
    { value: 'extension-store', label: 'a browser extension store\'s review', when: () => stores.has('extension-store') },
    { value: 'vscode-marketplace', label: 'the VS Code Marketplace', when: () => stores.has('vscode-marketplace') },
    { value: 'registry-policy', label: 'the package registry\'s policies', when: () => registries.length > 0 },
    { value: 'hosting-policy', label: 'the hosting platform\'s terms and abuse review', when: () => (detected.deploySurface || []).length > 0 },
    { value: 'external-reviewer', label: 'a person outside the team who approves it (a client, judges, a grader, a security or compliance review)',
      when: () => true },
  ]
  return all.filter((o) => o.when()).map(({ value, label }) => ({ value, label }))
}

/** Where the project makes claims about itself in public, from the files that hold them. */
export function claimCandidates(detected = {}) {
  const langs = new Set((detected.stack?.languages || []).map((l) => l.name.toLowerCase()))
  const claims = new Set((detected.signals?.claims || []).map((c) => c.kind))
  const stores = (detected.signals?.stores || []).length > 0
  const registries = (detected.signals?.registries || []).some((r) => r.kind !== 'goreleaser')
  const all = [
    { value: 'readme', label: 'the README', when: () => claims.has('readme') },
    { value: 'privacy-policy', label: 'a privacy policy', when: () => claims.has('privacy-policy') },
    { value: 'terms', label: 'terms of service', when: () => claims.has('terms') },
    { value: 'store-listing', label: 'a store listing (description, screenshots, privacy answers)',
      when: () => claims.has('store-listing') || stores || langs.has('swift') || langs.has('kotlin') },
    { value: 'package-listing', label: 'the package listing (description, keywords)', when: () => registries },
    { value: 'website', label: 'a website or landing page', when: () => (detected.deploySurface || []).length > 0 },
    { value: 'docs-site', label: 'a documentation site',
      when: () => claims.has('docs-site') || (detected.stack?.generatedDocs || []).length > 0 },
  ]
  return all.filter((o) => o.when()).map(({ value, label }) => ({ value, label }))
}

/**
 * Candidate boundaries, tailored by what Stage 0 found. The `when` on each
 * keeps the list short: showing a stranger fourteen irrelevant checkboxes is
 * how you lose them before the first real answer.
 *
 * DEF-274: the datastore, customer-data and delivery options used to be shown
 * to every repository, and hardware only to mobile ones, so a library for lab
 * instruments was asked about production databases and never about hardware.
 * They now follow what the manifests declare (`detected.signals`). Anything
 * missed can still be typed in: the question allows other answers.
 */
export function boundaryCandidates(detected = {}) {
  const deploy = new Set((detected.deploySurface || []).map((d) => d.kind))
  const langs = new Set((detected.stack?.languages || []).map((l) => l.name.toLowerCase()))
  const has = (k) => deploy.has(k)
  const signal = (k) => (detected.signals?.[k] || []).length > 0
  const keepsData = () => deploy.size > 0 || signal('datastore')

  const all = [
    { value: 'device', label: 'run it on real hardware / a physical device',
      when: () => langs.has('swift') || langs.has('kotlin') || langs.has('objective-c') },
    { value: 'hardware', label: 'drive or observe the real hardware it talks to (instruments, accessories, boards)',
      when: () => signal('hardware') },
    { value: 'pair-controller', label: 'pair it with a real smart-home controller (the Home app, a Matter controller) and watch it respond',
      when: () => signal('pairing') },
    { value: 'rendered-ui', label: 'see what the UI actually renders',
      when: () => langs.has('swift') || langs.has('typescript') || langs.has('javascript') || langs.has('kotlin') },
    { value: 'prod-data', label: 'read production database / datastore state',
      when: keepsData },
    { value: 'prod-logs', label: 'read production logs',
      when: () => deploy.size > 0 },
    { value: 'deploy', label: 'deploy',
      when: () => deploy.size > 0 },
    { value: 'migrations', label: 'run database migrations',
      when: () => signal('datastore') },
    { value: 'secrets', label: 'read secrets / API keys',
      when: (d) => (d.secretSurface || []).length > 0 },
    { value: 'paid-apis', label: 'call paid or rate-limited third-party APIs',
      when: () => true },
    { value: 'full-suite', label: 'run the full test suite (too slow, or needs credentials)',
      when: () => true },
    { value: 'real-user-data', label: 'reproduce anything with real customer data',
      when: keepsData },
    { value: 'release-console', label: 'reach the release / app-store / registry console',
      when: () => langs.has('swift') || langs.has('kotlin') || has('vercel') || has('fly') || signal('registries') },
    { value: 'delivery', label: 'confirm an email / SMS / push actually arrived',
      when: () => deploy.size > 0 || signal('messaging') },
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
    generates: ['docs/authority-split.md#the-agent-cannot-physical', 'docs/authority-split.md#the-agent-cannot-chosen', 'docs/close-out.md#not-verified-over-to-you'],
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
    generates: ['docs/authority-split.md#the-agent-cannot-physical', 'docs/authority-split.md#the-agent-cannot-chosen', 'docs/authority-split.md#unverified-boundaries'],
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
    generates: ['docs/authority-split.md#what-a-human-still-has-to-do'],
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
    generates: ['docs/authority-split.md#the-agent-can'],
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
    generates: ['docs/authority-split.md#unverified-boundaries'],
  },

  // ── Session 2 — outside authority ────────────────────────────────────────
  {
    id: 'outside.authority',
    session: 2,
    since: '1.1',
    type: 'multiselect',
    impact: 4,
    prompt: 'Who outside this repository can rule on whether it ships, or on what it may do?',
    help:
      'Their rulings sit outside anything this repository controls and need not explain themselves. Only a ruling whose basis is known can become a rule here; naming them now is what makes that limit visible before the first one arrives.',
    options: (ctx) => gatekeeperCandidates(ctx.detected),
    allowOther: true,
    generates: ['docs/authority-split.md#outside-authority'],
  },
  {
    id: 'outside.claims',
    session: 2,
    since: '1.1',
    type: 'multiselect',
    impact: 4,
    prompt: 'Where does this project make claims about itself in public?',
    help:
      'A README\'s numbers, a privacy policy, a store listing, a website. Each is a promise that drifts while the code moves, and nothing in the build fails when it does.',
    options: (ctx) => claimCandidates(ctx.detected),
    allowOther: true,
    generates: ['docs/declarations.md#the-register'],
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
