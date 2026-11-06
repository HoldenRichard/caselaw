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

// Reject case-folded, HFS-ignorable and Windows/NTFS spellings of Git metadata.
// Colons (including alternate data streams) are rejected by the path validator.
function isGitMetadataComponent(component) {
  const folded = component.replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, '').replace(/[ .]+$/, '').toLowerCase()
  return folded === '.git' || /^git~[0-9]+$/.test(folded)
}

/** Complete file snapshots are optional for legacy fixtures, required for synthesis. */
export function validateSnapshotFiles(files) {
  if (files === undefined) return undefined
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new IncidentError('Snapshot files must be a path-to-content object', { code: 'INVALID_SNAPSHOT' })
  const out = Object.create(null)
  for (const [path, content] of Object.entries(files)) {
    if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.includes(':') || path.split('/').some(p => !p || p === '.' || p === '..' || isGitMetadataComponent(p)) || !(content === null || typeof content === 'string') || content?.includes('\0')) {
      throw new IncidentError(`Unsafe or unsupported snapshot path/content: ${path}`, { code: 'INVALID_SNAPSHOT' })
    }
    out[path] = content
  }
  return out
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
      ...(pos.files !== undefined ? { files: validateSnapshotFiles(pos.files) } : {}),
    },
    negativeControl: {
      commit: neg.commit ? String(neg.commit).trim() : null,
      diff: normalize(neg.diff),
      description: neg.description ? String(neg.description).trim() : '',
      expected: 'PASS',
      task: neg.task ? String(neg.task).trim() : null,
      ...(neg.files !== undefined ? { files: validateSnapshotFiles(neg.files) } : {}),
    },
    metadata: {
      author: inc.metadata?.author ?? null,
      pr: inc.metadata?.pr ?? null,
      tags: Array.isArray(inc.metadata?.tags) ? inc.metadata.tags.map(String) : [],
    },
  }
}

/**
 * Save an incident fixture into .caselaw/incidents/<id>.json.
 * Incident fixtures are append-only evidence under Constitution Axiom A2;
 * existing fixtures cannot be overwritten unless content is byte-identical.
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
  const newContent = JSON.stringify(validated, null, 2) + '\n'

  try {
    const existing = await readFile(file, 'utf8')
    if (existing === newContent) return file // Idempotent identical write
    throw new IncidentError(
      `Incident fixture "${validated.id}" already exists. Incidents are append-only evidence (A2) and cannot be overwritten.`,
      { code: 'INCIDENT_EXISTS' }
    )
  } catch (err) {
    if (err?.code === 'INCIDENT_EXISTS') throw err
  }

  await writeFile(file, newContent, { encoding: 'utf8', flag: 'wx' })
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
    } catch (err) {
      throw new IncidentError(
        `Corrupted incident fixture "${f}": ${err?.message || 'invalid JSON'}. Malformed evidence must be fixed or removed; it cannot be silently dropped.`,
        { code: 'MALFORMED_INCIDENT' }
      )
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
  if (!/^[a-zA-Z0-9_./~^-]+$/.test(ref) || ref.startsWith('-')) return null
  let res = spawnSync('git', ['show', '--no-ext-diff', '--no-textconv', '--format=', '--unified=3', '-m', ref], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  if (res.status === 0 && res.stdout && res.stdout.trim().length > 0) {
    return res.stdout
  }
  // Fallback to git diff ref~1..ref
  res = spawnSync('git', ['diff', '--no-ext-diff', '--no-textconv', `${ref}~1..${ref}`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  if (res.status === 0 && res.stdout && res.stdout.trim().length > 0) {
    return res.stdout
  }
  return null
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
  const { id, rule, positiveDesc, negativeDesc, metadata } = opts
  const pin = (ref) => {
    if (typeof ref !== 'string' || !/^[a-zA-Z0-9_./~^-]+$/.test(ref) || ref.startsWith('-')) throw new IncidentError('Invalid commit reference', { code: 'GIT_DIFF_FAILED' })
    const res = spawnSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' })
    if (res.status !== 0) throw new IncidentError('Commit could not be resolved', { code: 'GIT_DIFF_FAILED' })
    return res.stdout.trim()
  }
  const positiveCommit = pin(opts.positiveCommit)
  const negativeCommit = pin(opts.negativeCommit)
  const paths = new Set()
  for (const ref of [positiveCommit, negativeCommit]) {
    const names = spawnSync('git', ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-m', '-z', ref], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
    if (names.status !== 0) throw new IncidentError('Changed paths could not be read', { code: 'GIT_DIFF_FAILED' })
    for (const path of names.stdout.split('\0').filter(Boolean)) paths.add(path)
  }
  const snapshot = (ref) => Object.fromEntries([...paths].map(path => {
    const tree = spawnSync('git', ['ls-tree', '-z', ref, '--', path], { cwd: root, encoding: 'utf8' })
    if (tree.status !== 0) throw new IncidentError('Snapshot tree could not be read', { code: 'GIT_DIFF_FAILED' })
    if (!tree.stdout) return [path, null]
    if (!/^100(?:644|755) blob /.test(tree.stdout)) throw new IncidentError('Only regular text files can be snapshot fixtures', { code: 'INVALID_SNAPSHOT' })
    const blob = spawnSync('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
    if (blob.status !== 0 || blob.stdout.includes('\0')) throw new IncidentError('Snapshot content could not be read as text', { code: 'INVALID_SNAPSHOT' })
    return [path, blob.stdout]
  }))
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
      files: snapshot(positiveCommit),
      diff: posDiff,
      description: positiveDesc || `Failure snapshot from commit ${positiveCommit}`,
      expected: 'FAIL',
    },
    negativeControl: {
      commit: negativeCommit,
      files: snapshot(negativeCommit),
      diff: negDiff,
      description: negativeDesc || `Clean fix snapshot from commit ${negativeCommit}`,
      expected: 'PASS',
    },
    metadata,
  })
}
