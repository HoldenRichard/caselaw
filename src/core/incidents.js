/**
 * Contrastive Incident Fixtures (0.4 / SkillOpt):
 *
 * CaseLaw rules in docs/rules/active/ usually have only N=1 to N=3 incidents
 * before promotion. Training or optimizing on failure snapshots alone risks
 * severe overfitting (making rules overly broad or aggressive).
 *
 * Every incident fixture (.caselaw/incidents/<id>.json) is stored as a
 * Contrastive Pair:
 *   (a) Positive Control: the broken diff/context from the incident that MUST
 *       be caught (expected: FAIL).
 *   (b) Negative Control: the clean fix commit touching the same files that
 *       MUST pass without a false positive (expected: PASS).
 *
 * Zero external dependencies: pure Node.js built-ins.
 */

import { readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { normalize, hash } from './text.js'

export const INCIDENTS_DIR = '.caselaw/incidents'
export const SAFE_INCIDENT_ID = /^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/

export class IncidentError extends Error {
  /**
   * @param {string} message
   * @param {{code: string, field?: string}} [opts]
   */
  constructor(message, opts = {}) {
    super(message)
    this.name = 'IncidentError'
    this.code = opts.code || 'INVALID_INCIDENT'
    this.field = opts.field
  }
}

/**
 * Validate the structure of a contrastive incident fixture.
 *
 * @param {object} inc
 * @returns {object} validated incident
 */
export function validateIncident(inc) {
  if (!inc || typeof inc !== 'object') {
    throw new IncidentError('Incident must be an object', { code: 'INVALID_TYPE' })
  }

  if (!inc.id || typeof inc.id !== 'string' || !SAFE_INCIDENT_ID.test(inc.id)) {
    throw new IncidentError(`Incident id "${inc.id}" must be alphanumeric kebab-case`, { code: 'INVALID_ID', field: 'id' })
  }

  if (!inc.rule || typeof inc.rule !== 'string' || !inc.rule.trim()) {
    throw new IncidentError('Incident must name a target rule', { code: 'MISSING_RULE', field: 'rule' })
  }

  const pos = inc.positiveControl
  if (!pos || typeof pos !== 'object') {
    throw new IncidentError('Incident must include a positiveControl (bad diff that must fail)', { code: 'MISSING_POSITIVE', field: 'positiveControl' })
  }
  if (!pos.diff || typeof pos.diff !== 'string' || !pos.diff.trim()) {
    throw new IncidentError('positiveControl.diff must be a non-empty string', { code: 'EMPTY_POSITIVE_DIFF', field: 'positiveControl.diff' })
  }
  if (pos.expected && pos.expected !== 'FAIL') {
    throw new IncidentError('positiveControl.expected must be "FAIL"', { code: 'INVALID_POSITIVE_EXPECTED', field: 'positiveControl.expected' })
  }

  const neg = inc.negativeControl
  if (!neg || typeof neg !== 'object') {
    throw new IncidentError('Incident must include a negativeControl (clean fix that must pass)', { code: 'MISSING_NEGATIVE', field: 'negativeControl' })
  }
  if (!neg.diff || typeof neg.diff !== 'string' || !neg.diff.trim()) {
    throw new IncidentError('negativeControl.diff must be a non-empty string', { code: 'EMPTY_NEGATIVE_DIFF', field: 'negativeControl.diff' })
  }
  if (neg.expected && neg.expected !== 'PASS') {
    throw new IncidentError('negativeControl.expected must be "PASS"', { code: 'INVALID_NEGATIVE_EXPECTED', field: 'negativeControl.expected' })
  }

  if (normalize(pos.diff) === normalize(neg.diff)) {
    throw new IncidentError('Positive and negative controls cannot have identical diffs', { code: 'IDENTICAL_CONTROLS', field: 'diff' })
  }

  return {
    $schema: inc.$schema || 'https://caselaw.dev/schemas/incident-v1.json',
    id: inc.id,
    rule: inc.rule.trim(),
    createdAt: inc.createdAt || new Date().toISOString(),
    positiveControl: {
      commit: pos.commit ? String(pos.commit).trim() : null,
      diff: normalize(pos.diff),
      description: pos.description ? String(pos.description).trim() : '',
      expected: 'FAIL',
      task: pos.task ? String(pos.task).trim() : null,
    },
    negativeControl: {
      commit: neg.commit ? String(neg.commit).trim() : null,
      diff: normalize(neg.diff),
      description: neg.description ? String(neg.description).trim() : '',
      expected: 'PASS',
      task: neg.task ? String(neg.task).trim() : null,
    },
    metadata: {
      author: inc.metadata?.author ?? null,
      pr: inc.metadata?.pr ?? null,
      tags: Array.isArray(inc.metadata?.tags) ? inc.metadata.tags.map(String) : [],
    },
  }
}

/**
 * Save an incident fixture into .caselaw/incidents/<id>.json
 *
 * @param {string} root
 * @param {object} incident
 * @returns {Promise<string>} path written
 */
export async function saveIncident(root, incident) {
  const validated = validateIncident(incident)
  const dir = join(root, INCIDENTS_DIR)
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${validated.id}.json`)
  await writeFile(file, JSON.stringify(validated, null, 2) + '\n', 'utf8')
  return file
}

/**
 * Read and validate an incident fixture by ID.
 *
 * @param {string} root
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function readIncident(root, id) {
  if (!id || !SAFE_INCIDENT_ID.test(id)) {
    throw new IncidentError(`Invalid incident id "${id}"`, { code: 'INVALID_ID' })
  }
  const file = join(root, INCIDENTS_DIR, `${id}.json`)
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new IncidentError(`Incident "${id}" does not exist at ${INCIDENTS_DIR}/${id}.json`, { code: 'NOT_FOUND' })
    }
    throw err
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new IncidentError(`Incident file "${id}.json" is malformed JSON: ${err.message}`, { code: 'MALFORMED_JSON' })
  }
  return validateIncident(parsed)
}

/**
 * List all incident fixtures in the repository, optionally filtered by rule.
 *
 * @param {string} root
 * @param {{rule?: string}} [opts]
 * @returns {Promise<object[]>}
 */
export async function listIncidents(root, opts = {}) {
  const dir = join(root, INCIDENTS_DIR)
  let entries = []
  try {
    entries = await readdir(dir)
  } catch (err) {
    if (err?.code === 'ENOENT') return []
    throw err
  }
  const out = []
  for (const f of entries) {
    if (!f.endsWith('.json')) continue
    const id = basename(f, '.json')
    try {
      const inc = await readIncident(root, id)
      if (!opts.rule || inc.rule === opts.rule) {
        out.push(inc)
      }
    } catch {
      // Malformed incident files in directory are skipped in listing
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Extract diff text from git using `git show <commit>`.
 * Returns null if commit cannot be resolved or git fails.
 *
 * @param {string} root
 * @param {string} commitRef
 * @returns {string|null}
 */
export function gitDiffOfCommit(root, commitRef) {
  if (!commitRef || typeof commitRef !== 'string') return null
  const ref = commitRef.trim()
  if (!/^[a-zA-Z0-9_./~^-]+$/.test(ref)) return null
  const res = spawnSync('git', ['show', '--format=', '--unified=3', ref], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  if (res.status !== 0 || !res.stdout) return null
  return res.stdout
}

/**
 * Create a contrastive incident pair from git commits.
 *
 * @param {string} root
 * @param {{id: string, rule: string, positiveCommit: string, negativeCommit: string,
 *          positiveDesc?: string, negativeDesc?: string, metadata?: object}} opts
 * @returns {object}
 */
export function createIncidentFromGit(root, opts) {
  const { id, rule, positiveCommit, negativeCommit, positiveDesc, negativeDesc, metadata } = opts
  const posDiff = gitDiffOfCommit(root, positiveCommit)
  if (!posDiff) {
    throw new IncidentError(`Could not extract git diff for positive control commit "${positiveCommit}"`, { code: 'GIT_DIFF_FAILED', field: 'positiveCommit' })
  }
  const negDiff = gitDiffOfCommit(root, negativeCommit)
  if (!negDiff) {
    throw new IncidentError(`Could not extract git diff for negative control commit "${negativeCommit}"`, { code: 'GIT_DIFF_FAILED', field: 'negativeCommit' })
  }

  return validateIncident({
    id,
    rule,
    positiveControl: {
      commit: positiveCommit,
      diff: posDiff,
      description: positiveDesc || `Failure snapshot from commit ${positiveCommit}`,
      expected: 'FAIL',
    },
    negativeControl: {
      commit: negativeCommit,
      diff: negDiff,
      description: negativeDesc || `Clean fix snapshot from commit ${negativeCommit}`,
      expected: 'PASS',
    },
    metadata,
  })
}
