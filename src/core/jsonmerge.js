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
 *
 * 0.5 reuses this for every host that keeps hooks in a JSON file the project
 * owns: Claude Code (.claude/settings.json), Codex (.codex/hooks.json), Cursor
 * (.cursor/hooks.json, whose entries are flat `{command}` objects) and Gemini
 * CLI (.gemini/settings.json). The merge is the same; only the event names
 * differ.
 */

import { hash } from './text.js'

/** The substring that marks a hook entry as ours. */
export const HOOK_MARK = '.caselaw/bin/gate.mjs'
export const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PreCompact', 'SessionStart', // Claude Code, Codex
  'BeforeTool', // Gemini CLI (its SessionStart is the one above)
  'beforeShellExecution', 'afterFileEdit', 'sessionStart', // Cursor
]

const CURSOR_EVENTS = ['beforeShellExecution', 'afterFileEdit', 'sessionStart']

const ours = (c) => typeof c === 'string' && c.includes(HOOK_MARK)
const isOurs = (entry) =>
  ours(entry?.command) || (Array.isArray(entry?.hooks) && entry.hooks.some((h) => ours(h?.command)))

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
  return shape(out)
}

/** What the manifest records for a json-merge entry: a hash of OUR entries only. */
/**
 * Ours in one canonical shape. An event added later (0.3's PreCompact) with
 * none of ours is left out rather than listed empty, so an install that
 * predates it hashes as it did; otherwise every such install reads as
 * hand-edited and is skipped instead of upgraded.
 */
const ORIGINAL_EVENTS = new Set(['PreToolUse', 'PostToolUse'])
function shape(ours) {
  const out = {}
  for (const event of HOOK_EVENTS) {
    const list = Array.isArray(ours?.[event]) ? ours[event] : []
    if (list.length || ORIGINAL_EVENTS.has(event)) out[event] = list
  }
  return out
}

export function hashOurs(ours) {
  return hash(JSON.stringify(ours))
}

/**
 * How the file was written, so a rewrite looks like the project's own edit:
 * one-line files stay one line, tabs and four-space files keep their indent,
 * CRLF and a missing final newline are kept. A new file is two-space with a
 * final newline, which is what Claude Code itself writes.
 */
function formatOf(text) {
  if (text == null || String(text).trim() === '') return { indent: 2, eol: '\n', final: true }
  const t = String(text)
  const eol = t.includes('\r\n') ? '\r\n' : '\n'
  const body = t.replace(/^﻿/, '').trimEnd()
  const lead = /\n([ \t]+)\S/.exec(body)
  return { indent: body.includes('\n') ? (lead ? (lead[1][0] === '\t' ? '\t' : lead[1].length) : 2) : 0, eol, final: /\n\s*$/.test(t) }
}

function serialize(value, format) {
  let out = JSON.stringify(value, null, format.indent || undefined)
  if (format.eol !== '\n') out = out.replace(/\n/g, format.eol)
  return out + (format.final ? format.eol : '')
}

/**
 * Merge our entries into an existing file's text (null when absent).
 * Unchanged when ours are already exactly present — the project's own
 * formatting is then left alone. Otherwise the file is re-serialised in the
 * layout it already had (see formatOf). Cursor's hooks.json also needs a
 * top-level `version`, added when our entries are Cursor's and the file lacks it.
 *
 * @returns {{ok: false, reason: string} | {ok: true, action: 'unchanged'|'merged', text: string, ours: object}}
 */
export function merge(existingText, ourHooks) {
  const p = parseSettings(existingText)
  if (!p.ok) return { ok: false, reason: p.reason }
  const wanted = shape(ourHooks)
  const present = extractOurs(p.settings)
  if (existingText != null && JSON.stringify(present) === JSON.stringify(wanted)) {
    return { ok: true, action: 'unchanged', text: existingText, ours: present }
  }
  const settings = p.settings
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? { ...settings.hooks } : {}
  for (const event of HOOK_EVENTS) {
    const theirs = (Array.isArray(hooks[event]) ? hooks[event] : []).filter((e) => !isOurs(e))
    const combined = [...theirs, ...(wanted[event] || [])]
    if (combined.length) hooks[event] = combined
    else delete hooks[event]
  }
  const stamp = CURSOR_EVENTS.some((e) => wanted[e]?.length) ? { version: 1 } : {}
  const next = Object.keys(hooks).length ? { ...stamp, ...settings } : { ...settings }
  if (Object.keys(hooks).length) next.hooks = hooks
  else delete next.hooks
  return { ok: true, action: 'merged', text: serialize(next, formatOf(existingText)), ours: wanted }
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
  // Cursor's hooks.json carries a bare `version`; with it alone left, the file was ours.
  const keys = Object.keys(rest).filter((k) => k !== 'version')
  if (keys.length === 0) return { ok: true, action: 'emptied', text: null }
  return { ok: true, action: 'stripped', text: r.text }
}
