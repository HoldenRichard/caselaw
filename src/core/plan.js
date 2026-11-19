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
import { merge as mergeJson, parseSettings, extractOurs, hashOurs } from './jsonmerge.js'
import { kindAt, refusal } from './fsguard.js'
import { toPosix } from './manifest.js'

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
    // Real files only. A symlink here used to hash by its target and be
    // rewritten through; a directory used to vanish from every plan.
    const kind = await kindAt(abs)
    const refused = refusal(kind)
    if (refused) {
      entries.push({ ...a, action: SKIP, reason: `${a.path} ${refused}`, nextText: null })
      continue
    }
    const existing = kind === 'missing' ? null : await readFile(abs, 'utf8')

    if (a.kind === 'file') {
      if (existing === null) {
        entries.push({ ...a, action: NEW, nextText: a.body, bytes: a.body.length })
        continue
      }
      if (hash(existing) === hash(a.body)) {
        entries.push({ ...a, action: UNCHANGED, nextText: existing, interiorHash: hash(existing) })
        continue
      }
      // A whole-file artifact that already exists and differs: only ours to
      // rewrite if the manifest says we wrote it and the user has not touched
      // it since. Otherwise it is someone else's file with our name.
      const owned = opts.manifest?.entries?.[toPosix(a.path)]
      // A caselaw command's own edit (a gate in gates.json, a first-catch
      // Origin) is kept, not regenerated over and not called a hand edit.
      if (!force && owned?.toolHash && owned.toolHash === hash(existing)) {
        entries.push({ ...a, action: UNCHANGED, nextText: existing, interiorHash: hash(existing), keptToolEdit: true })
        continue
      }
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

    if (a.kind === 'json-merge') {
      // Our content is a set of entries inside a file the project owns. The
      // file is merged into, never skipped for existing and never replaced —
      // with --force or without — beyond those entries.
      const owned = opts.manifest?.entries?.[toPosix(a.path)]
      // A 0.1.x install recorded this file whole (kind 'file'); its content was
      // ours alone, so merging is exactly right and needs no --force. Only an
      // entry already recorded as a merge can have had OUR entries edited.
      if (existing !== null && owned?.kind === 'json-merge' && !force) {
        const p = parseSettings(existing)
        if (p.ok && hashOurs(extractOurs(p.settings)) !== owned.hash) {
          entries.push({ ...a, action: SKIP, reason: 'you edited the caselaw hook entries since they were written', nextText: existing })
          continue
        }
      }
      const r = mergeJson(existing, a.merge)
      if (!r.ok) {
        entries.push({ ...a, action: SKIP, reason: `${r.reason} — fix it; nothing in it was touched`, nextText: existing })
        continue
      }
      if (r.action === 'unchanged') {
        entries.push({ ...a, action: UNCHANGED, nextText: existing, interiorHash: hashOurs(r.ours) })
        continue
      }
      entries.push({
        ...a,
        action: existing === null ? NEW : MERGE,
        nextText: r.text,
        interiorHash: hashOurs(r.ours),
        bytes: r.text.length,
      })
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
        entries.push({ ...a, action: UNCHANGED, nextText: result.text, interiorHash: result.hash })
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
  // A NEW entry that replaces a file already on disk is an update; calling it
  // new made an upgrade's plan look like a fresh install (0.5.0 field test).
  const updated = entries.filter((e) => e.action === NEW && e.replacing).length
  const parts = []
  if (summary.NEW - updated) parts.push(`${summary.NEW - updated} new`)
  if (updated) parts.push(`${updated} updated`)
  if (summary.MERGE) parts.push(`${summary.MERGE} merged`)
  if (summary.PATCH) parts.push(`${summary.PATCH} patched`)
  const rest = []
  if (summary.UNCHANGED) rest.push(`${summary.UNCHANGED} already correct`)
  if (summary.SKIP) rest.push(`${summary.SKIP} skipped`)
  lines.push(summary.willWrite === 0
    ? `Nothing to write${rest.length ? ` (${rest.join(', ')})` : ''}`
    : `Plan: write ${summary.willWrite} file(s) (${parts.join(', ')})${rest.length ? `; ${rest.join(', ')}` : ''}`)
  lines.push('')

  const width = Math.max(...entries.map((e) => e.path.length), 10)
  for (const e of entries) {
    const label = e.action === NEW && e.replacing ? 'UPDATE' : e.action
    const note =
      e.action === SKIP ? `  ← ${e.reason}`
      : e.action === MERGE && e.kind === 'json-merge' ? '  adds the caselaw hook entries, nothing else touched'
      : e.action === MERGE ? `  managed block "${e.blockId}", nothing else touched`
      : e.action === PATCH ? `  appends a managed block, nothing removed`
      : e.action === UNCHANGED && e.keptToolEdit ? '  kept: a caselaw command wrote into it'
      : e.action === UNCHANGED ? '  already correct'
      : e.replacing ? '  regenerated from your answers' : ''
    lines.push(`  ${label.padEnd(9)} ${e.path.padEnd(width)}${note}`)
  }
  if (summary.willWrite) lines.push(`  ALSO      .caselaw/answers.json, .caselaw/manifest.json, the rules INDEX.md  your answers, caselaw's record of what it wrote, and the rule index`)

  if (summary.SKIP) {
    lines.push('')
    lines.push('  Skipped files were left exactly as they are. Re-run with --force to overwrite,')
    lines.push('  but read the diff first — that content is yours, not ours.')
  }
  return lines.join('\n')
}

