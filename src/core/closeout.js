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
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

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
      const title = headerMatch[1].toLowerCase()
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
  try {
    const res = spawnSync('git', ['status', '--porcelain', '-uall'], { cwd: root, encoding: 'utf8' })
    if (res.status === 0) {
      const files = []
      const lines = res.stdout.split('\n')
      for (const l of lines) {
        if (!l.trim()) continue
        // Porcelain format: XY PATH or XY ORIG -> PATH
        const pathPart = l.slice(3).trim()
        const realPath = pathPart.includes(' -> ') ? pathPart.split(' -> ')[1] : pathPart
        files.push(realPath)
      }
      if (files.length > 0) {
        const scopeTracked = files.filter(isScopeTrackedPath)
        if (scopeTracked.length > 0) return files
      }
    }

    // Clean working tree fallback (or working tree with no in-scope modifications):
    // inspect the most recent commit (HEAD)
    const headRes = spawnSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    })
    if (headRes.status === 0 && headRes.stdout.trim()) {
      return headRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    }

    return []
  } catch {
    return []
  }
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
export function verifyCloseout({ text, root = process.cwd(), gitFiles = null }) {
  const parsed = parseCloseout(text)
  const errors = []
  const warnings = []

  // 1. Git Diff vs What Changed Parity
  const actualChanged = gitFiles !== null ? gitFiles : gitChangedFiles(root)
  const whatChangedText = parsed.whatChanged.join('\n')

  // Check: Every modified file in scope must be mentioned in What Changed by full relative path
  const trackedFiles = actualChanged.filter(isScopeTrackedPath)
  for (const cf of trackedFiles) {
    if (!whatChangedText.includes(cf)) {
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
    if (/\b(?:exit(?:ed)?(?:\s+with)?(?:\s+code)?\s+[1-9]\d*|code\s+[1-9]\d*|command\s+not\s+found|FAIL)\b/i.test(line)) {
      errors.push(`Failing command placed inside ## Verified: "${line}". Non-zero exits must be listed under ## Not Verified.`)
    }
  }

  // 3. Authority Split Enforcement: Human-only items must never be marked [x] in ANY section
  const allLines = String(text ?? '').split(/\r?\n/)
  for (const line of allLines) {
    if (/-\s*\[x\]/i.test(line)) {
      if (/\b(?:ui|render|database|datastore|prod|production|hardware|physical)\b/i.test(line)) {
        errors.push(`Human-only authority boundary marked as verified with [x]: "${line.trim()}". Only a human observation is authoritative.`)
      }
    }
  }
  for (const line of parsed.notVerified) {
    if (/^-\s*\[x\]/i.test(line)) {
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
