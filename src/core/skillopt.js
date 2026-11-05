/**
 * SkillOpt Engine (0.4): Executive Strategy for Self-Evolving Agent Skills
 *
 * Implements Microsoft Research's SkillOpt (arXiv:2605.23904) adapted for CaseLaw:
 *
 * 1. Structural A2 Enforcement: isolates mutable sections (Trigger, Rule, Guidance)
 *    and programmatically re-stitches immutable evidence (Origin, Precedent, Catches).
 * 2. Lexicographic Pareto Gate: accepts capability improvements OR lossless
 *    compression when catch rate is 100%.
 * 3. Short-Rule Edit Budget Floor: per-step budget = Math.max(Math.ceil(words * 0.25), 15).
 * 4. Diagnostic RejectedEditBuffer: whitespace-normalized hashing + diagnostic failure
 *    reasons passed into optimizer prompts.
 * 5. Two-Stage Hybrid Funnel: fast deterministic git/regex/budget check (Stage 1)
 *    followed by pinned-temperature contrastive review (Stage 2).
 * 6. A2/A3 Union on Multi-Rule Merge: preserves both Origin trails chronologically.
 *
 * Zero external dependencies: pure Node.js built-ins.
 */

import { normalize, hash } from './text.js'
import { parseRule, serializeRule, isAmbientTrigger } from './rules.js'
import { LOAD_BUDGET_WORDS } from './optimizer.js'
import { buildRolePrompt, parseVerdict } from '../commands/review.js'

export const DEFAULT_EDIT_BUDGET_MIN = 15
export const DEFAULT_EDIT_BUDGET_RATIO = 0.25
export const REJECTED_BUFFER_MAX = 5

export const words = (t) => (String(t ?? '').match(/\S+/g) || []).length

export class ConstitutionError extends Error {
  /**
   * @param {string} message
   * @param {{article: string}} [opts]
   */
  constructor(message, opts = { article: 'A2' }) {
    super(message)
    this.name = 'ConstitutionError'
    this.article = opts.article
  }
}

// ---------------------------------------------------------------------------
// 1. Structural AST Splitting & Re-stitching (Constitution A2 & A3)
// ---------------------------------------------------------------------------

/**
 * Split a rule's Markdown text into mutable sections and immutable evidence sections.
 *
 * @param {string} text
 * @returns {object}
 */
export function splitRuleAST(text) {
  const parsed = parseRule(text)
  const mutable = {
    trigger: parsed.trigger ? parsed.trigger.trim() : '',
    rule: parsed.rule ? parsed.rule.trim() : '',
  }
  const immutable = {
    name: parsed.name,
    origin: parsed.origin,
    precedent: parsed.precedent,
    enforcement: parsed.enforcement,
    default: parsed.default,
    triggered: parsed.triggered,
    ratified: parsed.ratified,
    extras: parsed.extras || [],
    preamble: parsed.preamble || '',
    footer: parsed.footer || '',
  }

  return {
    name: parsed.name,
    mutable,
    immutable,
    mutableWords: words(mutable.trigger) + words(mutable.rule),
    totalWords: words(text),
    raw: text,
  }
}

/**
 * Reconstitute a rule Markdown document with new mutable sections, guaranteeing
 * that all immutable evidence sections remain byte-identical (A2).
 *
 * @param {object} ast from splitRuleAST
 * @param {{trigger?: string, rule?: string}} newMutable
 * @returns {string} serialized rule markdown
 */
export function reconstituteRuleAST(ast, newMutable) {
  if (!ast || !ast.immutable) {
    throw new ConstitutionError('Invalid rule AST provided', { article: 'A2' })
  }

  const trigger = typeof newMutable.trigger === 'string' ? newMutable.trigger.trim() : ast.mutable.trigger
  const rule = typeof newMutable.rule === 'string' ? newMutable.rule.trim() : ast.mutable.rule

  // Disallow injecting markdown section headers into mutable fields (F4)
  const headerRegex = /\*\*(?:Enforcement|Origin|Precedent|Ratified|Merges|Default):\*\*/i
  const cleanHomoglyphs = (s) =>
    String(s ?? '')
      .normalize('NFKC')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[\u0415\u0435]/g, 'e')
      .replace(/[\u041E\u043E]/g, 'o')
      .replace(/[\u0420\u0440]/g, 'p')
      .replace(/[\u0410\u0430]/g, 'a')
  if (headerRegex.test(cleanHomoglyphs(trigger)) || headerRegex.test(cleanHomoglyphs(rule))) {
    throw new ConstitutionError('A2: Section headers cannot be injected into mutable trigger or rule fields', {
      article: 'A2',
    })
  }

  // Assemble fields for serializeRule
  const fields = {
    name: ast.immutable.name,
    trigger,
    rule,
    origin: ast.immutable.origin,
    precedent: ast.immutable.precedent,
    enforcement: ast.immutable.enforcement,
    default: ast.immutable.default,
    triggered: ast.immutable.triggered,
    ratified: ast.immutable.ratified,
    extras: ast.immutable.extras,
    preamble: ast.immutable.preamble,
    footer: ast.immutable.footer,
  }

  const serialized = serializeRule(fields)

  // Verify byte-level invariance of immutable fields after serialization
  const verify = parseRule(serialized)
  if (normalize(verify.origin || '') !== normalize(ast.immutable.origin || '')) {
    throw new ConstitutionError('A2: Origin block was modified during reconstitution', { article: 'A2' })
  }
  if (normalize(verify.precedent || '') !== normalize(ast.immutable.precedent || '')) {
    throw new ConstitutionError('A2: Precedent block was modified during reconstitution', { article: 'A2' })
  }
  if (normalize(verify.ratified || '') !== normalize(ast.immutable.ratified || '')) {
    throw new ConstitutionError('A2: Ratified block was modified during reconstitution', { article: 'A2' })
  }
  if (normalize(verify.enforcement || '') !== normalize(ast.immutable.enforcement || '')) {
    throw new ConstitutionError('A2: Enforcement block was modified during reconstitution', { article: 'A2' })
  }

  return serialized
}

// ---------------------------------------------------------------------------
// 2. Short-Rule Edit Budget Floor
// ---------------------------------------------------------------------------

/**
 * Compute the Longest Common Subsequence (LCS) length between two token arrays.
 *
 * @param {string[]} tokensA
 * @param {string[]} tokensB
 * @returns {number}
 */
export function wordLCSLength(tokensA, tokensB) {
  const m = tokensA.length
  const n = tokensB.length
  if (m === 0 || n === 0) return 0
  let prev = new Array(n + 1).fill(0)
  let curr = new Array(n + 1).fill(0)

  for (let i = 1; i <= m; i++) {
    const tokenA = tokensA[i - 1]
    for (let j = 1; j <= n; j++) {
      if (tokenA === tokensB[j - 1]) {
        curr[j] = prev[j - 1] + 1
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1])
      }
    }
    const temp = prev
    prev = curr
    curr = temp
    curr.fill(0)
  }
  return prev[n]
}

/**
 * Calculate the allowed edit budget for a rule.
 *
 * @param {string|number} mutableContent - text or word count
 * @returns {number} max word change allowed per step
 */
export function calculateEditBudget(mutableContent) {
  const w = typeof mutableContent === 'number' ? mutableContent : words(mutableContent)
  return Math.max(Math.ceil(w * DEFAULT_EDIT_BUDGET_RATIO), DEFAULT_EDIT_BUDGET_MIN)
}

/**
 * Check if proposed edits stay within the learning-rate budget.
 * Lossless compression and multi-rule merges are exempt from the upper diff cap,
 * but compression exemption applies ONLY after Stage 2 verifies 100% catch rate and 0 false positives (F8).
 *
 * @param {object} oldMutable
 * @param {object} newMutable
 * @param {{isCompressionVerified?: boolean, isMerge?: boolean}} [opts]
 * @returns {{allowed: boolean, budget: number, delta: number, reason?: string}}
 */
export function checkEditBudget(oldMutable, newMutable, opts = {}) {
  const oldText = `${oldMutable.trigger || ''} ${oldMutable.rule || ''}`
  const newText = `${newMutable.trigger || ''} ${newMutable.rule || ''}`
  const oldWords = words(oldText)
  const budget = calculateEditBudget(oldWords)

  // Measure ordered word-level LCS diff distance (F8)
  const oldTokens = oldText.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const newTokens = newText.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const lcs = wordLCSLength(oldTokens, newTokens)
  const delta = oldTokens.length + newTokens.length - (2 * lcs)

  // Lossless compression (verified by Stage 2) and multi-rule merges are exempt from diff cap
  if (opts.isCompressionVerified || opts.isMerge) {
    return { allowed: true, budget, delta }
  }

  if (delta > budget) {
    return {
      allowed: false,
      budget,
      delta,
      reason: `Edit delta of ${delta} words exceeds the textual learning-rate budget of ${budget} words`,
    }
  }

  return { allowed: true, budget, delta }
}

// ---------------------------------------------------------------------------
// 3. Diagnostic RejectedEditBuffer
// ---------------------------------------------------------------------------

export class RejectedEditBuffer {
  /**
   * @param {number} [maxSize=REJECTED_BUFFER_MAX]
   */
  constructor(maxSize = REJECTED_BUFFER_MAX) {
    this.maxSize = maxSize
    /** @type {{hash: string, diff: string, stage: number, failureReason: string, timestamp: string}[]} */
    this.entries = []
  }

  /**
   * Normalize whitespace and hash diff text.
   *
   * @param {string} diff
   * @returns {string} sha256 hex
   */
  static hashDiff(diff) {
    const compact = String(diff ?? '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n')
      .replace(/[ \t]+/g, ' ')
    return hash(compact)
  }

  /**
   * Check if a proposed diff has already been rejected.
   *
   * @param {string} diff
   * @returns {boolean}
   */
  isRejected(diff) {
    const h = RejectedEditBuffer.hashDiff(diff)
    return this.entries.some((e) => e.hash === h)
  }

  /**
   * Record a rejected candidate with its failure stage and diagnostic reason.
   *
   * @param {{diff: string, stage: number, failureReason: string}} entry
   */
  record({ diff, stage, failureReason }) {
    const h = RejectedEditBuffer.hashDiff(diff)
    // Avoid duplicate entries
    if (this.entries.some((e) => e.hash === h)) return

    this.entries.unshift({
      hash: h,
      diff: String(diff ?? '').trim(),
      stage: Number(stage) || 1,
      failureReason: String(failureReason ?? 'unspecified failure').trim(),
      timestamp: new Date().toISOString(),
    })

    if (this.entries.length > this.maxSize) {
      this.entries.pop()
    }
  }

  /**
   * Format recent rejection diagnostics for injection into an optimizer prompt.
   *
   * @returns {string}
   */
  formatPromptContext() {
    if (this.entries.length === 0) return ''
    const lines = [
      '### Rejected Proposals in Recent Steps (Do NOT repeat these failure modes):',
    ]
    for (const [idx, e] of this.entries.entries()) {
      lines.push(`${idx + 1}. [Stage ${e.stage} Rejection]: ${e.failureReason}`)
    }
    return lines.join('\n')
  }

  clear() {
    this.entries = []
  }
}

// ---------------------------------------------------------------------------
// 4. Lexicographic Pareto Gate
// ---------------------------------------------------------------------------

/**
 * Evaluate candidate rule performance against baseline rule performance.
 *
 * @param {{catchRate: number, falsePositives: number, wordCount: number}} candidate
 * @param {{catchRate: number, falsePositives: number, wordCount: number}} baseline
 * @param {{budget?: number}} [opts]
 * @returns {{accepted: boolean, mode: 'capability'|'compression'|'rejected', reason: string}}
 */
export function evaluatePareto(candidate, baseline, opts = {}) {
  const budget = opts.budget ?? LOAD_BUDGET_WORDS

  if (candidate.falsePositives > 0) {
    return {
      accepted: false,
      mode: 'rejected',
      reason: `Candidate caused ${candidate.falsePositives} false positive(s) on negative controls`,
    }
  }

  if (candidate.wordCount > budget) {
    return {
      accepted: false,
      mode: 'rejected',
      reason: `Candidate rule word count (${candidate.wordCount}) exceeds load budget (${budget})`,
    }
  }

  // Branch A: Capability Improvement (strictly higher catch rate with 0 false positives)
  if (candidate.catchRate > baseline.catchRate) {
    return {
      accepted: true,
      mode: 'capability',
      reason: `Catch rate improved from ${(baseline.catchRate * 100).toFixed(1)}% to ${(candidate.catchRate * 100).toFixed(1)}% with zero false positives`,
    }
  }

  // Branch B: Lossless Compression (100% catch rate maintained, 0 false positives, strictly fewer words)
  if (candidate.catchRate >= 1.0 && candidate.wordCount < baseline.wordCount) {
    const saved = baseline.wordCount - candidate.wordCount
    return {
      accepted: true,
      mode: 'compression',
      reason: `Lossless compression: 100% catch rate maintained, reduced by ${saved} words (${baseline.wordCount} -> ${candidate.wordCount})`,
    }
  }

  return {
    accepted: false,
    mode: 'rejected',
    reason: `Candidate did not improve catch rate (${(candidate.catchRate * 100).toFixed(1)}% vs baseline ${(baseline.catchRate * 100).toFixed(1)}%) or reduce words (${candidate.wordCount} vs ${baseline.wordCount})`,
  }
}

// ---------------------------------------------------------------------------
// 5. Two-Stage Hybrid Evaluation Funnel
// ---------------------------------------------------------------------------

/**
 * Stage 1: Deterministic Trigger, Glob, and Word-Budget Gate (Zero LLM calls).
 *
 * @param {{trigger: string, rule: string, raw?: string}} candidateRule
 * @param {object[]} incidentFixtures
 * @param {{budget?: number}} [opts]
 * @returns {{pass: boolean, reason?: string}}
 */
export function evaluateStage1(candidateRule, incidentFixtures = [], opts = {}) {
  const budget = opts.budget ?? LOAD_BUDGET_WORDS
  const totalWords = words(candidateRule.raw || `${candidateRule.trigger} ${candidateRule.rule}`)

  if (totalWords > budget) {
    return {
      pass: false,
      reason: `Rule length (${totalWords} words) exceeds load budget (${budget} words)`,
    }
  }

  if (!candidateRule.trigger || isAmbientTrigger(candidateRule.trigger)) {
    return {
      pass: false,
      reason: `Trigger "${candidateRule.trigger}" is ambient or empty (violates trigger-scoped governance)`,
    }
  }

  // Fast path: if there are incident fixtures, check that candidate trigger
  // does not completely ignore the domains/files in the incidents.
  for (const inc of incidentFixtures) {
    const pos = inc.positiveControl
    if (!pos || !pos.diff) continue
    // Check if diff files or paths match trigger keywords if trigger names specific paths
    const diffPaths = extractPathsFromDiff(pos.diff)
    if (diffPaths.length > 0 && candidateRule.trigger.includes('/')) {
      const triggerWords = candidateRule.trigger.split(/\s+/)
      const pathTrigger = triggerWords.find((w) => w.includes('/'))
      if (pathTrigger) {
        const cleanPathTrigger = pathTrigger.replace(/[`"'*]/g, '')
        const matchesAny = diffPaths.some((p) => p.includes(cleanPathTrigger) || cleanPathTrigger.includes(p))
        if (!matchesAny) {
          return {
            pass: false,
            reason: `Trigger path "${cleanPathTrigger}" does not match files touched in incident ${inc.id} (${diffPaths.join(', ')})`,
          }
        }
      }
    }
  }

  return { pass: true }
}

/**
 * Extract file paths touched in a unified git diff.
 *
 * @param {string} diff
 * @returns {string[]}
 */
export function extractPathsFromDiff(diff) {
  const paths = new Set()
  const lines = String(diff ?? '').split('\n')
  for (const line of lines) {
    const match = /^(?:---|\+\+\+)\s+[ab]\/(.+)$/.exec(line)
    if (match && match[1] && match[1] !== '/dev/null') {
      paths.add(match[1])
    }
  }
  return [...paths]
}

/**
 * Stage 2: Pinned-Temperature Contrastive Reviewer Pass.
 *
 * Evaluates candidate rule against contrastive pairs.
 * verifierFn must return { verdict: 'PASS' | 'FAIL', reason?: string }
 *
 * @param {{trigger: string, rule: string}} candidateRule
 * @param {object[]} incidentFixtures
 * @param {(opts: {rule: object, fixture: object, control: 'positive'|'negative', diff: string}) => Promise<{verdict: 'PASS'|'FAIL', reason?: string}>} verifierFn
 * @returns {Promise<{pass: boolean, catchRate: number, falsePositives: number, caught: string[], missed: string[], falsePositivesList: string[], details: object[]}>}
 */
export async function evaluateStage2(candidateRule, incidentFixtures, verifierFn) {
  if (!Array.isArray(incidentFixtures) || incidentFixtures.length === 0) {
    return {
      pass: false,
      catchRate: 0,
      falsePositives: 0,
      caught: [],
      missed: [],
      falsePositivesList: [],
      details: [],
      reason: 'insufficient-evidence: no incident fixtures provided',
    }
  }

  const caught = []
  const missed = []
  const falsePositivesList = []
  const details = []

  for (const inc of incidentFixtures) {
    // 1. Positive Control: Must yield FAIL (rule caught the failure)
    const posRes = await verifierFn({
      rule: candidateRule,
      fixture: inc,
      control: 'positive',
      diff: inc.positiveControl.diff,
    })

    const caughtPositive = posRes.verdict === 'FAIL'
    if (caughtPositive) {
      caught.push(inc.id)
    } else {
      missed.push(inc.id)
    }

    // 2. Negative Control: Must yield PASS (rule did NOT falsely flag clean fix)
    const negRes = await verifierFn({
      rule: candidateRule,
      fixture: inc,
      control: 'negative',
      diff: inc.negativeControl.diff,
    })

    const cleanPass = negRes.verdict === 'PASS'
    if (!cleanPass) {
      falsePositivesList.push(inc.id)
    }

    details.push({
      incidentId: inc.id,
      positiveCaught: caughtPositive,
      positiveReason: posRes.reason,
      negativePassed: cleanPass,
      negativeReason: negRes.reason,
    })
  }

  const catchRate = caught.length / incidentFixtures.length
  const falsePositives = falsePositivesList.length
  const pass = missed.length === 0 && falsePositives === 0

  return {
    pass,
    catchRate,
    falsePositives,
    caught,
    missed,
    falsePositivesList,
    details,
  }
}

// ---------------------------------------------------------------------------
// 6. Cross-Rule Consolidation (Slow Update with A2/A3 Union)
// ---------------------------------------------------------------------------

/**
 * Union two rules' Origin and Catches metadata in chronological order,
 * ensuring no precedent is lost (A2, A3).
 *
 * @param {string} originA
 * @param {string} originB
 * @returns {string}
 */
export function unionOrigins(originA, originB, sep = '; ') {
  const cleanA = (originA || '').trim()
  const cleanB = (originB || '').trim()
  if (!cleanA) return cleanB
  if (!cleanB) return cleanA
  if (cleanA === cleanB) return cleanA

  // Sort chronologically if dates are present: earlier date first
  const dateRegex = /\b(\d{4}-\d{2}-\d{2})\b/
  const dateA = dateRegex.exec(cleanA)?.[1]
  const dateB = dateRegex.exec(cleanB)?.[1]

  if (dateA && dateB) {
    if (dateA <= dateB) {
      return `${cleanA}${sep}${cleanB}`
    } else {
      return `${cleanB}${sep}${cleanA}`
    }
  }

  const lines = [cleanA]
  if (!cleanA.includes(cleanB)) {
    lines.push(cleanB)
  }
  return lines.join(sep)
}

/**
 * Consolidate two overlapping rules into a single merged candidate rule,
 * preserving both Origin trails chronologically (A2/A3) and pointing the superseded rule.
 *
 * @param {string} ruleTextA - target rule (kept)
 * @param {string} ruleTextB - absorbed rule (archived)
 * @param {{trigger: string, rule: string}} mergedMutable
 * @param {object} [opts]
 * @returns {{mergedRuleText: string, archivedRuleText: string}}
 */
export function consolidateRules(ruleTextA, ruleTextB, mergedMutable, opts = {}) {
  const astA = splitRuleAST(ruleTextA)
  const astB = splitRuleAST(ruleTextB)
  const sep = opts.originSep || '; '

  const unionOrigin = unionOrigins(astA.immutable.origin, astB.immutable.origin, sep)
  const unionPrecedent = unionOrigins(astA.immutable.precedent, astB.immutable.precedent, sep)

  // Union extras from both rules (including Catches)
  const extrasA = astA.immutable.extras || []
  const extrasB = astB.immutable.extras || []
  const combinedExtras = [...extrasA]
  for (const eb of extrasB) {
    if (!combinedExtras.some((ea) => ea.name === eb.name && ea.body === eb.body)) {
      combinedExtras.push(eb)
    }
  }

  const mergedFields = {
    name: astA.immutable.name,
    trigger: mergedMutable.trigger.trim(),
    rule: mergedMutable.rule.trim(),
    origin: unionOrigin || null,
    precedent: unionPrecedent || null,
    enforcement: astA.immutable.enforcement || astB.immutable.enforcement || 'memory',
    default: astA.immutable.default || astB.immutable.default || null,
    triggered: astA.immutable.triggered || astB.immutable.triggered || null,
    ratified: astA.immutable.ratified || astB.immutable.ratified || null,
    extras: combinedExtras,
    preamble: astA.immutable.preamble || '',
    footer: astA.immutable.footer || '',
  }

  const mergedRuleText = serializeRule(mergedFields)

  // Build the archived version of rule B with Merged-Into pointer
  const parsedB = parseRule(ruleTextB)
  const archiveFooter = `_Merged into \`${astA.immutable.name}\` on ${new Date().toISOString().slice(0, 10)}._`
  const archivedExtras = [
    ...(parsedB.extras || []),
    { label: 'Merged-Into', key: 'merged-into', value: astA.immutable.name },
  ]
  const archivedFields = {
    ...parsedB,
    extras: archivedExtras,
    footer: parsedB.footer ? `${parsedB.footer}\n---\n${archiveFooter}` : `---\n${archiveFooter}`,
  }
  const archivedRuleText = serializeRule(archivedFields)

  return { mergedRuleText, archivedRuleText }
}

// ---------------------------------------------------------------------------
// 7. Active Iterative Optimization Loop (SkillOpt Rollout & Reflection)
// ---------------------------------------------------------------------------

/**
 * Built-in default verifier for contrastive incident fixtures.
 * Evaluates candidate rules completely blind to control labels (F1),
 * inspecting added lines against rule prohibitions without word blacklists.
 *
 * @param {object} opts
 * @returns {Promise<{verdict: 'PASS'|'FAIL', reason?: string}>}
 */
export function syncVerifier({ rule, fixture, diff }) {
  const r = (rule?.rule || '').toLowerCase()
  const d = String(diff ?? '')

  // Extract added lines from unified diff (lines starting with '+', excluding '+++')
  const addedLines = d
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1).trim())

  if (addedLines.length === 0) {
    return { verdict: 'PASS' }
  }

  // Check if rule expresses a prohibition regarding git sweep / staging.
  // Phrasing can be prohibitive: "never sweep", "do not use git add -A", "avoid git add .",
  // or restrictive imperative: "stage explicit paths by name", "only stage explicit paths".
  const prohibitsSweep = (
    /\b(?:never|must\s+not|do\s+not|cannot|prohibit|forbidden|avoid|refuse|prevent)\b/i.test(r) &&
    (r.includes('sweep') || r.includes('git add -a') || r.includes('git add .') || r.includes('stage') || r.includes('explicit'))
  ) || (
    /\b(?:stage\s+explicit|only\s+(?:allow|permit|stage)\s+explicit)\b/i.test(r)
  )

  // Check if rule prohibits console logging
  const prohibitsConsole = /\b(?:never|must\s+not|do\s+not|cannot|prohibit|avoid)\b/i.test(r) &&
    (r.includes('console.log') || r.includes('console'))

  // Check if rule prohibits committing secrets / .env
  const prohibitsSecrets = /\b(?:never|must\s+not|do\s+not|cannot|prohibit|avoid)\b/i.test(r) &&
    (r.includes('secret') || r.includes('.env'))

  // Check if rule prohibits migration edits
  const prohibitsMigration = /\b(?:never|must\s+not|do\s+not|cannot|prohibit|avoid)\b/i.test(r) &&
    r.includes('migration')

  // Check if rule prohibits access check removal
  const prohibitsAccessRemoval = /\b(?:never|must\s+not|do\s+not|cannot|prohibit|avoid)\b/i.test(r) &&
    (r.includes('access check') || r.includes('access'))

  // Check if diff adds swept secrets/.env files or sweeping git commands
  const hasSweptFiles = /(?:^\+\+\+\s+[ab]\/.*(?:\.env|secret)|^\+.*(?:\.env|secret))/im.test(d)

  // Inspect each added line for violations of what the rule prohibits
  for (const line of addedLines) {
    if (prohibitsSweep) {
      if (hasSweptFiles || /\bgit\s+add\s+(?:-A|--all|\.)(?=\s|$|[;&|\n])/.test(line)) {
        return { verdict: 'FAIL', reason: `Rule prohibits sweeping git add or swept configuration files: "${line}"` }
      }
    }

    if (prohibitsConsole) {
      if (/console\.log\b/i.test(line)) {
        return { verdict: 'FAIL', reason: `Rule prohibits console logging: "${line}"` }
      }
    }

    if (prohibitsSecrets) {
      if (/(?:secret|\.env)/i.test(line)) {
        return { verdict: 'FAIL', reason: `Rule prohibits secrets: "${line}"` }
      }
    }

    if (prohibitsMigration) {
      if (/migration/i.test(line)) {
        return { verdict: 'FAIL', reason: `Rule prohibits migration modifications: "${line}"` }
      }
    }

    if (prohibitsAccessRemoval) {
      if (/remove.*access/i.test(line) || /bypass.*access/i.test(line)) {
        return { verdict: 'FAIL', reason: `Rule prohibits access check removal: "${line}"` }
      }
    }
  }

  return { verdict: 'PASS' }
}

/**
 * Built-in default verifier (heuristics / fast path for local testing and CI).
 *
 * @param {object} opts
 * @returns {Promise<{verdict: 'PASS'|'FAIL', reason?: string}>}
 */
export async function defaultVerifier(opts) {
  return syncVerifier(opts)
}

/**
 * Built-in multi-step candidate proposer for iterative compression and rule tuning.
 *
 * @param {boolean} isCompression
 * @returns {function}
 */
export function createDefaultProposer(isCompression = false) {
  const TRANSFORMATIONS = [
    // Step 1: Strip conversational filler and lead-ins
    (mutable) => ({
      trigger: mutable.trigger,
      rule: mutable.rule
        .replace(/\b(?:please\s+(?:make\s+sure\s+to|ensure\s+that\s+you|be\s+sure\s+to)|make\s+sure\s+to|ensure\s+that\s+you|always\s+remember\s+to|it\s+is\s+(?:required|recommended|important)\s+(?:that|to))\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim(),
    }),
    // Step 2: Convert passive/wordy formulations to active imperative
    (mutable) => ({
      trigger: mutable.trigger,
      rule: mutable.rule
        .replace(/\bwhenever\s+(?:you\s+are\s+)?(editing|modifying|changing|running)\b/gi, '$1')
        .replace(/\bin\s+order\s+to\b/gi, 'to')
        .replace(/\bdo\s+not\s+ever\b/gi, 'never')
        .replace(/\byou\s+must\s+never\b/gi, 'never')
        .replace(/\s+/g, ' ')
        .trim(),
    }),
    // Step 3: Trigger phrase tightening
    (mutable) => {
      let t = mutable.trigger
        .replace(/\b(?:any|all|every)\s+(?:kind\s+of\s+)?work\s+(?:on|in|touching)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
      return { trigger: t, rule: mutable.rule }
    },
    // Step 4: Redundant clause compaction
    (mutable) => ({
      trigger: mutable.trigger,
      rule: mutable.rule
        .replace(/\b([A-Za-z0-9_-]+)\s+and\s+nothing\s+else\b/gi, 'only $1')
        .replace(/\s+/g, ' ')
        .trim(),
    }),
  ]

  return async ({ currentAST, step, rejectedBuffer }) => {
    const idx = (step - 1) % TRANSFORMATIONS.length
    const transform = TRANSFORMATIONS[idx]
    const mutated = transform(currentAST.mutable)

    // Check if mutation produced any change
    if (mutated.rule === currentAST.mutable.rule && mutated.trigger === currentAST.mutable.trigger) {
      // If no change, try next transformation
      for (let i = 0; i < TRANSFORMATIONS.length; i++) {
        const alt = TRANSFORMATIONS[i](currentAST.mutable)
        if (alt.rule !== currentAST.mutable.rule || alt.trigger !== currentAST.mutable.trigger) {
          return alt
        }
      }
      return null
    }

    return mutated
  }
}

/**
 * Create an LLM-backed candidate proposer for SkillOpt.
 * Injects RejectedEditBuffer failure diagnostics, mutable text, incident context,
 * and learning-rate budget constraints into the prompt.
 *
 * @param {function} llmRunner - async ({ prompt, role }) => string
 * @returns {function}
 */
export function createLLMProposer(llmRunner) {
  if (typeof llmRunner !== 'function') {
    throw new Error('createLLMProposer requires an async llmRunner function ({ prompt }) => string')
  }

  return async ({ currentAST, step, rejectedBuffer, incidentFixtures, isCompression }) => {
    const budget = calculateEditBudget(currentAST.mutableWords)
    const promptLines = [
      'You are an engineering governance optimizer implementing Microsoft SkillOpt for CaseLaw.',
      'Your task is to refine the mutable Trigger and Rule text to maximize incident catch rate and prevent false positives.',
      '',
      '## Current Mutable Rule State',
      `Trigger: ${currentAST.mutable.trigger}`,
      `Rule: ${currentAST.mutable.rule}`,
      `Word budget: edit at most ${budget} words${isCompression ? ' (lossless compression requested)' : ''}.`,
      '',
      '## Contrastive Incident Fixtures',
    ]

    for (const inc of incidentFixtures) {
      promptLines.push(`- Incident ${inc.id}:`)
      promptLines.push(`  Positive Control (MUST FAIL / CAUGHT): ${inc.positiveControl.description || ''}`)
      promptLines.push(`  Negative Control (MUST PASS / CLEAN): ${inc.negativeControl.description || ''}`)
    }

    const diagnostics = rejectedBuffer.formatPromptContext()
    if (diagnostics) {
      promptLines.push('')
      promptLines.push(diagnostics)
    }

    promptLines.push('')
    promptLines.push('## Output Format')
    promptLines.push('Respond with ONLY these two lines:')
    promptLines.push('TRIGGER: <tightened trigger phrase>')
    promptLines.push('RULE: <tightened imperative rule sentence>')

    const prompt = promptLines.join('\n')
    const response = await llmRunner({ prompt, role: 'proposer', step })

    const triggerMatch = /^TRIGGER:\s*(.+)$/im.exec(response)
    const ruleMatch = /^RULE:\s*(.+)$/im.exec(response)

    if (!ruleMatch) return null

    return {
      trigger: triggerMatch ? triggerMatch[1].trim() : currentAST.mutable.trigger,
      rule: ruleMatch[1].trim(),
      rawPrompt: prompt,
    }
  }
}

/**
 * Create an LLM-backed verifier using caselaw review's role prompt contract.
 * Blind to control labels (positive vs negative) to prevent evaluation bias (F2).
 *
 * @param {function} llmRunner - async ({ prompt, role, fixture, diff }) => string
 * @returns {function}
 */
export function createLLMVerifier(llmRunner) {
  if (typeof llmRunner !== 'function') {
    throw new Error('createLLMVerifier requires an async llmRunner function ({ prompt }) => string')
  }

  return async ({ rule, fixture, control, diff }) => {
    const claim = rule?.rule || ''
    const rolePrompt = buildRolePrompt({
      role: 'verifier',
      claim,
      diff,
    })

    const response = await llmRunner({ prompt: rolePrompt, role: 'verifier', fixture, control, diff })
    const { verdict, body } = parseVerdict(response)

    return {
      verdict: (verdict === 'PASS' || verdict === 'FAIL') ? verdict : 'UNVERIFIED',
      reason: body || 'LLM verifier verdict',
    }
  }
}

/**
 * Active iterative SkillOpt optimization loop.
 * Runs rollout -> reflection -> bounded edit -> Stage 1 & Stage 2 verification -> Pareto Gate.
 * Diagnostic failure reasons are stored in RejectedEditBuffer and fed into subsequent proposal steps.
 *
 * @param {object} opts
 * @param {string} opts.ruleText
 * @param {object[]} [opts.incidentFixtures=[]]
 * @param {number} [opts.maxSteps=4]
 * @param {boolean} [opts.isCompression=false]
 * @param {function} [opts.proposerFn]
 * @param {function} [opts.verifierFn]
 * @param {function} [opts.llmRunner]
 * @param {boolean} [opts.useLLM=false]
 * @returns {Promise<{success: boolean, bestRuleText: string, acceptedSteps: object[], rejectedBuffer: RejectedEditBuffer, savedWords: number, stats: object}>}
 */
export async function optimizeRuleIterative({
  ruleText,
  incidentFixtures = [],
  maxSteps = 4,
  isCompression = false,
  proposerFn = null,
  verifierFn = null,
  llmRunner = null,
  useLLM = false,
  opts = {},
}) {
  const buffer = new RejectedEditBuffer(opts.bufferSize || 5)
  const initialAST = splitRuleAST(ruleText)

  if (!Array.isArray(incidentFixtures) || incidentFixtures.length === 0) {
    return {
      success: false,
      reason: 'Cannot optimize or evolve rule without incident fixtures: zero fixtures provided.',
      savedWords: 0,
      initialWords: initialAST.totalWords,
      finalWords: initialAST.totalWords,
      bestRuleText: ruleText,
      acceptedSteps: [],
      rejectedBuffer: buffer,
      stats: {
        initialWords: initialAST.totalWords,
        finalWords: initialAST.totalWords,
        initialCatchRate: 0,
        finalCatchRate: 0,
      },
    }
  }

  let currentAST = initialAST
  let currentRuleText = ruleText

  const runner = llmRunner || (useLLM ? async ({ prompt }) => '' : null)
  const activeVerifier = verifierFn || (runner ? createLLMVerifier(runner) : defaultVerifier)
  const activeProposer = proposerFn || (runner ? createLLMProposer(runner) : createDefaultProposer(isCompression))

  // Baseline evaluation
  const baseStage2 = await evaluateStage2(initialAST.mutable, incidentFixtures, activeVerifier)
  let baselineStats = {
    catchRate: baseStage2.catchRate,
    falsePositives: baseStage2.falsePositives,
    wordCount: initialAST.totalWords,
  }

  const acceptedSteps = []

  for (let step = 1; step <= maxSteps; step++) {
    const proposed = await activeProposer({
      currentAST,
      step,
      rejectedBuffer: buffer,
      incidentFixtures,
      isCompression,
    })

    if (!proposed || (!proposed.rule && !proposed.trigger)) {
      break
    }

    const candidateMutable = {
      trigger: proposed.trigger ? proposed.trigger.trim() : currentAST.mutable.trigger,
      rule: proposed.rule ? proposed.rule.trim() : currentAST.mutable.rule,
    }

    // Skip if unchanged
    if (candidateMutable.trigger === currentAST.mutable.trigger && candidateMutable.rule === currentAST.mutable.rule) {
      continue
    }

    const diffRep = `TRIGGER: ${candidateMutable.trigger}\nRULE: ${candidateMutable.rule}`

    // 1. Rejected buffer check
    if (buffer.isRejected(diffRep)) {
      continue
    }

    // 2. Stage 1: Deterministic Trigger, Glob, and Budget check
    const stage1 = evaluateStage1({ ...candidateMutable, raw: candidateMutable.rule }, incidentFixtures, opts)
    if (!stage1.pass) {
      buffer.record({ diff: diffRep, stage: 1, failureReason: stage1.reason })
      continue
    }

    // 3. Learning-rate budget check (F8: compression exemption only after Stage 2 verification)
    let budgetRes = checkEditBudget(currentAST.mutable, candidateMutable)
    let stage2 = null

    const candidateWords = words(candidateMutable.trigger) + words(candidateMutable.rule)
    const isCompressAttempt = isCompression || candidateWords < currentAST.mutableWords

    if (!budgetRes.allowed) {
      if (isCompressAttempt) {
        stage2 = await evaluateStage2(candidateMutable, incidentFixtures, activeVerifier)
        if (stage2.catchRate === 1.0 && stage2.falsePositives === 0) {
          budgetRes = checkEditBudget(currentAST.mutable, candidateMutable, { isCompressionVerified: true })
        }
      }
      if (!budgetRes.allowed) {
        buffer.record({ diff: diffRep, stage: 1, failureReason: budgetRes.reason })
        continue
      }
    }

    // 4. Stage 2: Pinned contrastive verifier check
    if (!stage2) {
      stage2 = await evaluateStage2(candidateMutable, incidentFixtures, activeVerifier)
    }
    if (stage2.falsePositives > 0) {
      buffer.record({
        diff: diffRep,
        stage: 2,
        failureReason: `False positive on negative controls: ${stage2.falsePositivesList.join(', ')}`,
      })
      continue
    }

    // 5. Lexicographic Pareto Gate
    const wordDiff = (words(candidateMutable.trigger) + words(candidateMutable.rule)) - currentAST.mutableWords
    const candidateTotalWords = currentAST.totalWords + wordDiff
    const pareto = evaluatePareto(
      { catchRate: stage2.catchRate, falsePositives: stage2.falsePositives, wordCount: candidateTotalWords },
      baselineStats,
      opts
    )

    if (!pareto.accepted) {
      buffer.record({ diff: diffRep, stage: 2, failureReason: pareto.reason })
      continue
    }

    // Accepted! Reconstitute rule with structural A2 guarantee
    const newRuleText = reconstituteRuleAST(currentAST, candidateMutable)
    acceptedSteps.push({
      step,
      mode: pareto.mode,
      reason: pareto.reason,
      wordsBefore: baselineStats.wordCount,
      wordsAfter: candidateTotalWords,
      savedWords: baselineStats.wordCount - candidateTotalWords,
    })

    // Advance baseline
    currentAST = splitRuleAST(newRuleText)
    currentRuleText = newRuleText
    baselineStats = {
      catchRate: stage2.catchRate,
      falsePositives: stage2.falsePositives,
      wordCount: candidateTotalWords,
    }
  }

  return {
    success: acceptedSteps.length > 0,
    bestRuleText: currentRuleText,
    acceptedSteps,
    rejectedBuffer: buffer,
    savedWords: initialAST.totalWords - currentAST.totalWords,
    stats: {
      initialWords: initialAST.totalWords,
      finalWords: currentAST.totalWords,
      initialCatchRate: baseStage2.catchRate,
      finalCatchRate: baselineStats.catchRate,
    },
  }
}
