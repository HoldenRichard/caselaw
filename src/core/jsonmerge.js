/**
 * Merging caselaw's hook entries into a .claude/settings.json the project owns.
 *
 * settings.json is the documented, committed home for a project's hooks, and
 * most projects that use Claude Code already have one — permissions, a model
 * pin, hooks of their own. It used to be generated as a WHOLE FILE: where one
 * existed the plan skipped it, no hook was installed, and `doctor` reported
 * the harness inert (seen on a retrofit); with --force it was REPLACED, which
 * destroyed a model pin, an env block and two hooks (the same retrofit). A
 * managed file is the wrong shape for a shared config.
 *
 * So this is a managed SET OF ENTRIES. Ours are the hook entries whose command
 * invokes the vendored runner; every other byte of the file belongs to the
 * project and is never read for meaning, only carried. The manifest records a
 * hash of our entries, so an edit to them is detected and an edit to anything
 * else is not our business.
 */

import { hash } from './text.js'

/** The substring that marks a hook entry as ours. */
export const HOOK_MARK = '.caselaw/bin/gate.mjs'
export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse']

const isOurs = (entry) =>
  Array.isArray(entry?.hooks) &&
  entry.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(HOOK_MARK))

/** @returns {{ok: true, settings: object} | {ok: false, reason: string}} */
export function parseSettings(text) {
  if (text == null || String(text).trim() === '') return { ok: true, settings: {} }
  try {
    const parsed = JSON.parse(String(text).replace(/^﻿/, ''))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'settings.json is not a JSON object' }
    }
    return { ok: true, settings: parsed }
  } catch (err) {
    return { ok: false, reason: `settings.json is not valid JSON (${err.message})` }
  }
}

/** Our hook entries as they stand in a settings object, keyed by event. */
export function extractOurs(settings) {
  const out = {}
  for (const event of HOOK_EVENTS) {
    const list = Array.isArray(settings?.hooks?.[event]) ? settings.hooks[event] : []
    out[event] = list.filter(isOurs)
  }
  return out
}

/** What the manifest records for a json-merge entry: a hash of OUR entries only. */
export function hashOurs(ours) {
  return hash(JSON.stringify(ours))
}

/**
 * Merge our entries into an existing file's text (null when absent).
 * Unchanged when ours are already exactly present — the project's own
 * formatting is then left alone. Otherwise the file is re-serialised with
 * two-space indentation, which is what Claude Code itself writes.
 *
 * @returns {{ok: false, reason: string} | {ok: true, action: 'unchanged'|'merged', text: string, ours: object}}
 */
export function merge(existingText, ourHooks) {
  const p = parseSettings(existingText)
  if (!p.ok) return { ok: false, reason: p.reason }
  const wanted = {}
  for (const event of HOOK_EVENTS) wanted[event] = Array.isArray(ourHooks?.[event]) ? ourHooks[event] : []
  const present = extractOurs(p.settings)
  if (existingText != null && JSON.stringify(present) === JSON.stringify(wanted)) {
    return { ok: true, action: 'unchanged', text: existingText, ours: present }
  }
  const settings = p.settings
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? { ...settings.hooks } : {}
  for (const event of HOOK_EVENTS) {
    const theirs = (Array.isArray(hooks[event]) ? hooks[event] : []).filter((e) => !isOurs(e))
    const combined = [...theirs, ...wanted[event]]
    if (combined.length) hooks[event] = combined
    else delete hooks[event]
  }
  const next = { ...settings }
  if (Object.keys(hooks).length) next.hooks = hooks
  else delete next.hooks
  return { ok: true, action: 'merged', text: JSON.stringify(next, null, 2) + '\n', ours: wanted }
}

/**
 * Remove our entries. `emptied` means nothing of the project's was in the
 * file, so the file itself was ours and should go.
 *
 * @returns {{ok: false, reason: string} | {ok: true, action: 'absent'|'stripped'|'emptied', text: string|null}}
 */
export function strip(existingText) {
  const r = merge(existingText, {})
  if (!r.ok) return r
  if (r.action === 'unchanged') return { ok: true, action: 'absent', text: existingText }
  const rest = JSON.parse(r.text)
  if (Object.keys(rest).length === 0) return { ok: true, action: 'emptied', text: null }
  return { ok: true, action: 'stripped', text: r.text }
}
