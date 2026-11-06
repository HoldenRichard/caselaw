/**
 * Close-out & Scope Completeness Verifier (0.4 / CaseLaw).
 *
 * Enforces the CaseLaw close-out doctrine (docs/close-out.md, docs/authority-split.md):
 * 1. Git Diff vs. What Changed Parity: No silent scope drops (unreported modified code files)
 *    and no fabricated file modifications.
 * 2. Exit Code Honesty: A command that exits non-zero (e.g. code 127, FAIL) must NEVER
 *    be placed under ## Verified.
 * 3. Authority Split Enforcement: Human-only verification items must remain unchecked (- [ ]).
 *
 * Zero external dependencies: pure Node.js built-ins.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { doctrineDirAt } from './doctrine.js'
import { join } from 'node:path'

const HOMOGLYPH_MAP = {
  '\u0430': 'a', '\u0410': 'A',
  '\u0441': 'c', '\u0421': 'C',
  '\u0435': 'e', '\u0415': 'E',
  '\u043E': 'o', '\u041E': 'O',
  '\u0440': 'p', '\u0420': 'P',
  '\u0455': 's', '\u0405': 'S',
  '\u0445': 'x', '\u0425': 'X',
  '\u0443': 'y', '\u0423': 'Y',
  '\u0456': 'i', '\u0406': 'I',
  '\u0458': 'j', '\u0408': 'J',
}

function normalizeCloseoutText(str) {
  return String(str ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u0430\u0410\u0441\u0421\u0435\u0415\u043E\u041E\u0440\u0420\u0455\u0405\u0445\u0425\u0443\u0423\u0456\u0406\u0458\u0408]/g, (ch) => HOMOGLYPH_MAP[ch] || ch)
}

const HUMAN_AUTHORITY_REGEX = /\b(?:ui|render|rendering|frontend|front-end|gui|display|screen|ux|database|datastore|data-store|db|prod|production|hardware|physical)\b/i

function claimsHumanObservation(line, boundaries = []) {
  let prose = normalizeCloseoutText(line)
  // A command mentioning ui.test.js is a test result, not a claim to have
  // observed a screen. Only the command portion is excluded; any assertion
  // after the separator is still checked.
  const command = /^\s*(?:-\s*)?(?:`)?(?:node|npm|npx|pnpm|yarn|bun|python[0-9.]*|pytest|cargo|go|make|tsc)\s/i
  if (command.test(prose)) prose = prose.split(/\s+[—–]\s+/).slice(1).join(' ')
  return HUMAN_AUTHORITY_REGEX.test(prose) || boundaries.some(b => prose.toLowerCase().includes(b.toLowerCase()))
}

function humanBoundaries(root) {
  try {
    const text = readFileSync(join(root, doctrineDirAt(root), 'authority-split.md'), 'utf8')
    let human = false
    const out = []
    for (const line of text.split(/\r?\n/)) {
      if (/^## /.test(line)) human = /agent cannot|human still/i.test(line)
      if (human) {
        const m = /^-\s+\*\*(.+?)\*\*/.exec(line)
        if (m) out.push(normalizeCloseoutText(m[1]))
      }
    }
    return out
  } catch { return [] }
}

function reportsFailure(line) {
  const norm = normalizeCloseoutText(line).replace(/[`*]/g, '')
  const statuses = [...norm.matchAll(/\b(?:exit(?:ed)?(?:\s+with)?(?:\s+(?:code|status))?|status|code)\s*[:=]?\s*\(?\s*([+-]?\d+)/gi)]
  return statuses.some(m => Number(m[1]) !== 0) || /\b(?:command\s+not\s+found|FAIL|ERR_[A-Z0-9_]+|failed\s+with|SIG(?:TERM|KILL|ABRT|SEGV))\b/i.test(norm)
}

/**
 * Parse a markdown close-out report into structured sections.
 *
 * @param {string} text
 * @returns {object}
 */
export function parseCloseout(text) {
  const sections = {
    whatChanged: [],
    verified: [],
    notVerified: [],
    ruleProposals: [],
    stillOpen: [],
  }

  const lines = String(text ?? '').split(/\r?\n/)
  let currentSec = null

  for (const line of lines) {
    const trimmed = line.trim()
    const headerMatch = /^##\s+(.+)$/i.exec(trimmed)
    if (headerMatch) {
      const title = normalizeCloseoutText(headerMatch[1]).toLowerCase()
      if (title.includes('what changed')) currentSec = 'whatChanged'
      else if (title.includes('not verified')) currentSec = 'notVerified'
      else if (title.includes('verified')) currentSec = 'verified'
      else if (title.includes('rule proposal')) currentSec = 'ruleProposals'
      else if (title.includes('still open')) currentSec = 'stillOpen'
      else currentSec = null
      continue
    }

    if (currentSec && trimmed && !trimmed.startsWith('<!--')) {
      sections[currentSec].push(trimmed)
    }
  }

  return sections
}

/**
 * Paths that must be accounted for in ## What Changed:
 * Code (src, bin), tests, active governance doctrine (docs/rules), and gate configs (.caselaw).
 */
export function isScopeTrackedPath(p) {
  const clean = String(p ?? '').replace(/^\.\//, '')
  return (
    clean.startsWith('src/') ||
    clean.startsWith('bin/') ||
    clean.startsWith('test/') ||
    clean.startsWith('docs/rules/') ||
    clean.startsWith('.caselaw/')
  )
}

/**
 * Get changed files in git working tree.
 * When the working tree is clean (e.g. running verification post-commit),
 * falls back to the HEAD commit so post-commit verification does not falsely
 * flag every claimed change as a fabrication.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function gitChangedFiles(root) {
  const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '-uall'], { cwd: root, encoding: 'utf8' })
  if (status.status !== 0) throw new Error(status.stderr || 'git status failed')
  const entries = status.stdout.split('\0').filter(Boolean)
  const files = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    files.push(entry.slice(3))
    if (/^[RC]|^.[RC]/.test(entry.slice(0, 2))) {
      // Rename/copy records have a second NUL-delimited source path.
      if (entries[i + 1]) files.push(entries[++i])
    }
  }
  if (files.some(isScopeTrackedPath)) return [...new Set(files)]
  const head = spawnSync('git', ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD'], { cwd: root, encoding: 'utf8' })
  if (head.status !== 0) throw new Error(head.stderr || 'HEAD could not be read')
  return head.stdout.split('\0').filter(Boolean)
}

/**
 * Verify close-out report against git status and authority split.
 *
 * @param {object} opts
 * @param {string} opts.text - close-out markdown content
 * @param {string} [opts.root]
 * @param {string[]} [opts.gitFiles] - override for testing
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 */
export function verifyCloseout({ text, root = process.cwd(), gitFiles = null, observations = [] }) {
  const parsed = parseCloseout(text)
  const errors = []
  const warnings = []

  // 1. Git Diff vs What Changed Parity
  let actualChanged
  try { actualChanged = gitFiles !== null ? gitFiles : gitChangedFiles(root) }
  catch (error) { errors.push(`Git scope could not be verified: ${error.message}`); actualChanged = [] }
  const boundaries = humanBoundaries(root)
  for (const item of observations) {
    if (!Number.isInteger(item.exitCode) || item.exitCode !== 0 || item.humanOnly) {
      errors.push(`Unverified command observation: ${item.command || 'unknown'} (exit ${item.exitCode ?? 'unknown'}).`)
    }
  }
  const whatChangedText = parsed.whatChanged.join('\n')

  // Check: Every modified file in scope must be mentioned in What Changed by full relative path
  const trackedFiles = actualChanged.filter(isScopeTrackedPath)
  for (const cf of trackedFiles) {
    if (!whatChangedText.split(/[`\s,;:()]+/).includes(cf)) {
      errors.push(`Modified file "${cf}" is omitted from ## What Changed (Silent Scope Drop)`)
    }
  }

  // Check: Claiming a file was modified when it has no git changes
  const cleanWhatChanged = whatChangedText.replace(/[`*]/g, '')
  const claimedFileMatches =
    cleanWhatChanged.match(/(?:(?:\.caselaw|src|bin|docs\/rules|test)\/[a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)/g) || []
  for (const claimed of claimedFileMatches) {
    if (isScopeTrackedPath(claimed)) {
      if (!actualChanged.includes(claimed)) {
        errors.push(`Claimed modification to "${claimed}" in ## What Changed, but file has zero git changes`)
      }
    }
  }

  // 2. Verification Exit Code Honesty
  for (const line of parsed.verified) {
    const norm = normalizeCloseoutText(line)
    if (reportsFailure(norm)) {
      errors.push(`Failing command placed inside ## Verified: "${line}". Non-zero exits must be listed under ## Not Verified.`)
    }
  }

  // 3. Authority Split Enforcement: Human-only items must never be marked [x] or placed in ## Verified
  for (const line of parsed.verified) {
    const norm = normalizeCloseoutText(line)
    if (claimsHumanObservation(norm, boundaries)) {
      errors.push(`Human-only authority boundary marked as verified with [x]: "${line.trim()}". Only a human observation is authoritative.`)
    }
  }
  const allLines = String(text ?? '').split(/\r?\n/)
  for (const line of allLines) {
    const norm = normalizeCloseoutText(line)
    if (/\[x\]/i.test(line) || /\[x\]/i.test(norm)) {
      if (claimsHumanObservation(norm, boundaries)) {
        if (!errors.some((e) => e.includes(line.trim()))) {
          errors.push(`Human-only authority boundary marked as verified with [x]: "${line.trim()}". Only a human observation is authoritative.`)
        }
      }
    }
  }
  for (const line of parsed.notVerified) {
    const norm = normalizeCloseoutText(line)
    if (/\[x\]/i.test(line) || /\[x\]/i.test(norm)) {
      if (!errors.some((e) => e.includes(line.trim()))) {
        errors.push(`Human-only authority boundary marked as verified with [x]: "${line}". Only a human observation is authoritative.`)
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}
