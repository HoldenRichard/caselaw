/**
 * Where the doctrine lives: `docs/` unless that directory is already someone
 * else's.
 *
 * On two of the three repositories of the DEF-274 re-score, docs/ belonged to
 * a documentation generator: homebridge's is TypeDoc's output (the next docs
 * build deletes it), ntfy's is MkDocs' source (everything in it is published).
 * `init` used to refuse there. It now writes to `governance/` instead and says
 * why (Holden's choice, 2026-10-30), and `--doctrine-dir` picks any other.
 * The choice is recorded in answers.json, so every later command — rule,
 * audit, upgrade, eject — reads the same directory.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_DOCTRINE_DIR = 'docs'
export const FALLBACK_DOCTRINE_DIR = 'governance'

const SAFE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/

/** A relative directory inside the project, or null. Never absolute, never `..`. */
export function cleanDoctrineDir(d) {
  if (typeof d !== 'string') return null
  const t = d.trim().replace(/\/+$/, '')
  if (!SAFE.test(t) || t.split('/').some((p) => p === '..' || p === '.')) return null
  return t
}

/** The doctrine directory an answers document records. */
export function doctrineDirOf(doc) {
  return cleanDoctrineDir(doc?.doctrineDir) || DEFAULT_DOCTRINE_DIR
}

/** The doctrine directory of the install at `root`, read from its answers.json. */
export function doctrineDirAt(root) {
  try {
    return doctrineDirOf(JSON.parse(readFileSync(join(root, '.caselaw/answers.json'), 'utf8').replace(/^﻿/, '')))
  } catch {
    return DEFAULT_DOCTRINE_DIR
  }
}

export function ruleDirsFor(dir = DEFAULT_DOCTRINE_DIR) {
  return { active: `${dir}/rules/active`, proposed: `${dir}/rules/proposed`, candidates: `${dir}/rules/candidates` }
}
