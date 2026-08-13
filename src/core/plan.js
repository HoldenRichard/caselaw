/**
 * The write plan — show before write, applied to this tool itself.
 *
 * Nothing reaches disk until the whole change set has been described and
 * accepted. Writing into a stranger's repository is invasive; the plan is what
 * makes it legible instead of alarming.
 *
 * Every entry is classified by what it does to a file that may already exist:
 *   NEW    — a file we create; eject deletes it
 *   MERGE  — a managed block inside a file the user owns; eject strips the block
 *   PATCH  — an append-only edit to a shared file (.gitignore); eject strips it
 *   SKIP   — refused, with a reason (usually: the user edited our content)
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hash } from './text.js'
import { upsert, locate, BlockError } from './blocks.js'

export const NEW = 'NEW'
export const MERGE = 'MERGE'
export const PATCH = 'PATCH'
export const SKIP = 'SKIP'
export const UNCHANGED = 'UNCHANGED'

/**
 * Build the plan without touching disk.
 *
 * @param {string} root
 * @param {Array<{path:string, kind:'file'|'block', body:string, blockId?:string, version?:number}>} artifacts
 * @param {{manifest?: object, force?: boolean}} [opts]
 */
export async function buildPlan(root, artifacts, opts = {}) {
  const { force = false } = opts
  const entries = []

  for (const a of artifacts) {
    const abs = join(root, a.path)
    const existing = await readIfExists(abs)

    if (a.kind === 'file') {
      if (existing === null) {
        entries.push({ ...a, action: NEW, nextText: a.body, bytes: a.body.length })
        continue
      }
      if (hash(existing) === hash(a.body)) {
        entries.push({ ...a, action: UNCHANGED, nextText: existing })
        continue
      }
      // A whole-file artifact that already exists and differs: only ours to
      // rewrite if the manifest says we wrote it and the user has not touched
      // it since. Otherwise it is someone else's file with our name.
      const owned = opts.manifest?.entries?.[a.path]
      const untouched = owned && owned.hash === hash(existing)
      if (untouched || force) {
        entries.push({ ...a, action: NEW, nextText: a.body, replacing: true, bytes: a.body.length })
      } else {
        entries.push({
          ...a,
          action: SKIP,
          reason: owned ? 'you edited this file since it was generated' : 'a file already exists here and we did not create it',
          nextText: existing,
        })
      }
      continue
    }

    // kind === 'block'
    try {
      const result = upsert(existing ?? '', {
        id: a.blockId,
        body: a.body,
        version: a.version ?? 1,
        filePath: a.path,
        force,
      })
      if (result.blocked === 'user-modified') {
        entries.push({ ...a, action: SKIP, reason: 'you edited inside the managed block', nextText: existing })
      } else if (result.action === 'unchanged') {
        entries.push({ ...a, action: UNCHANGED, nextText: result.text })
      } else {
        const present = existing !== null && locate(existing, a.blockId).present
        entries.push({
          ...a,
          action: existing === null ? NEW : present ? MERGE : PATCH,
          nextText: result.text,
          interiorHash: result.hash,
          bytes: result.text.length,
        })
      }
    } catch (err) {
      if (err instanceof BlockError) {
        entries.push({ ...a, action: SKIP, reason: err.message, nextText: existing })
      } else throw err
    }
  }

  return { entries, summary: summarize(entries) }
}

export function summarize(entries) {
  const counts = { NEW: 0, MERGE: 0, PATCH: 0, SKIP: 0, UNCHANGED: 0 }
  for (const e of entries) counts[e.action]++
  return {
    ...counts,
    willWrite: entries.filter((e) => e.action !== SKIP && e.action !== UNCHANGED).length,
    total: entries.length,
  }
}

/** Human-readable plan. Kept plain so it reads the same piped to a file. */
export function formatPlan({ entries, summary }, { root = '.' } = {}) {
  const lines = []
  const verb = summary.willWrite === 0 ? 'Nothing to write' : `Plan — ${summary.willWrite} file(s)`
  const parts = []
  if (summary.NEW) parts.push(`${summary.NEW} new`)
  if (summary.MERGE) parts.push(`${summary.MERGE} merged`)
  if (summary.PATCH) parts.push(`${summary.PATCH} patched`)
  if (summary.UNCHANGED) parts.push(`${summary.UNCHANGED} unchanged`)
  if (summary.SKIP) parts.push(`${summary.SKIP} skipped`)
  lines.push(`${verb}${parts.length ? ` (${parts.join(', ')})` : ''}`)
  lines.push('')

  const width = Math.max(...entries.map((e) => e.path.length), 10)
  for (const e of entries) {
    const note =
      e.action === SKIP ? `  ← ${e.reason}`
      : e.action === MERGE ? `  managed block "${e.blockId}", nothing else touched`
      : e.action === PATCH ? `  appends a managed block, nothing removed`
      : e.action === UNCHANGED ? '  already correct'
      : e.replacing ? '  regenerated' : ''
    lines.push(`  ${e.action.padEnd(9)} ${e.path.padEnd(width)}${note}`)
  }

  if (summary.SKIP) {
    lines.push('')
    lines.push('  Skipped files were left exactly as they are. Re-run with --force to overwrite,')
    lines.push('  but read the diff first — that content is yours, not ours.')
  }
  return lines.join('\n')
}

async function readIfExists(abs) {
  try {
    return await readFile(abs, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}
