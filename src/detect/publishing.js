/**
 * What a push publishes.
 *
 * On all three repositories of the DEF-274 re-score, publishing was triggered
 * by git: any tag published pyvisa to PyPI, a `beta-*` branch published
 * homebridge to npm (and homebridge's own CLAUDE.md told agents to create such
 * branches), a `v*` tag released ntfy. The generated docs said "release
 * console: chosen" and gave false comfort, because the console was never the
 * door. A push is an outward-facing action; the authority split has to say
 * which pushes publish, and where.
 *
 * Read from GitHub Actions workflows only, line by line. YAML is not parsed in
 * general (zero dependencies); the `on:` block and the publishing steps have a
 * narrow, regular shape, and anything this cannot read is reported as unknown
 * rather than guessed.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Steps that publish, and what they publish to. First match per line wins. */
const PUBLISHERS = [
  [/\bnpm publish\b|\b(pnpm|yarn)( npm)? publish\b|JS-DevTools\/npm-publish/, 'npm'],
  [/pypa\/gh-action-pypi-publish|\btwine upload\b|\bpoetry publish\b|\buv publish\b/, 'PyPI'],
  [/\bcargo publish\b/, 'crates.io'],
  [/goreleaser\/goreleaser-action|\bgoreleaser release\b/, 'GoReleaser (a GitHub release and its configured targets)'],
  [/\bmake release\b/, 'the Makefile\'s release target'],
  [/docker\/build-push-action|\bdocker push\b/, 'a container registry'],
  [/\bvsce publish\b|\bovsx publish\b/, 'the VS Code Marketplace'],
  [/chrome-webstore-upload/, 'the Chrome Web Store'],
  [/\bfastlane\b.*\b(deliver|pilot|upload_to_app_store|upload_to_testflight)\b|\bxcrun altool\b/, 'App Store Connect'],
  [/softprops\/action-gh-release|\bgh release create\b/, 'a GitHub release'],
]

export function emptyPublishing() {
  return []
}

/**
 * @param {string} root
 * @param {{files: string[]}} walked
 * @returns {Promise<{publishing: object[], warnings: object[]}>}
 */
export async function detectPublishing(root, walked) {
  const out = []
  const workflows = walked.files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)).sort()
  for (const file of workflows) {
    let text
    try { text = await readFile(join(root, file), 'utf8') } catch { continue }
    const steps = publishSteps(text)
    if (!steps.length) continue
    out.push({ file, triggers: workflowTriggers(text), publishes: steps })
  }
  return { publishing: out, warnings: [] }
}

/** Each distinct destination a workflow publishes to, with the first line that does it. */
export function publishSteps(text) {
  const seen = new Map()
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*#/.test(line)) return
    for (const [re, what] of PUBLISHERS) {
      if (re.test(line)) { if (!seen.has(what)) seen.set(what, i + 1); break }
    }
  })
  return [...seen.entries()].map(([what, line]) => ({ what, line }))
}

/**
 * The events that start a workflow, as plain phrases ("pushing a tag matching
 * `v*`"). `null` when the `on:` block cannot be read; never a guess.
 */
export function workflowTriggers(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => /^["']?(on|true)["']?\s*:/.test(l))
  if (start === -1) return null
  const inline = lines[start].replace(/^["']?(on|true)["']?\s*:\s*/, '').replace(/\s+#.*$/, '').trim()
  if (inline) return list(inline).flatMap((e) => phrase(e, {}))

  const block = []
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break
    if (l.trim() && !/^\s*#/.test(l)) block.push(l)
  }
  if (!block.length) return null
  const indent = (l) => l.match(/^\s*/)[0].length
  const eventIndent = indent(block[0])
  const events = []
  for (let i = 0; i < block.length; i++) {
    if (indent(block[i]) !== eventIndent) continue
    const m = /^\s*([\w-]+)\s*:\s*(.*)$/.exec(block[i])
    if (!m) continue
    const filters = {}
    for (let j = i + 1; j < block.length && indent(block[j]) > eventIndent; j++) {
      const f = /^\s*([\w-]+)\s*:\s*(.*)$/.exec(block[j])
      if (!f) continue
      const values = f[2].trim() ? list(f[2]) : []
      for (let k = j + 1; k < block.length && indent(block[k]) > indent(block[j]); k++) {
        const item = /^\s*-\s*(.+)$/.exec(block[k])
        if (item) values.push(unquote(item[1]))
      }
      filters[f[1]] = values
    }
    events.push(phrase(m[1], filters))
  }
  return events.flat()
}

function phrase(event, f) {
  switch (event) {
    case 'push': {
      const out = [
        ...(f.tags || []).map((p) => `pushing a tag matching \`${p}\``),
        ...(f.branches || []).map((p) => `pushing to a branch matching \`${p}\``),
      ]
      return out.length ? out : ['any push']
    }
    case 'release': {
      const types = (f.types || []).filter((t) => t !== 'published')
      return [`publishing a GitHub release${types.length ? ` (${types.join(', ')})` : ''}`]
    }
    case 'workflow_dispatch': return ['running the workflow by hand']
    case 'schedule': return ['a schedule']
    case 'workflow_run': case 'workflow_call': return ['another workflow']
    default: return [`the \`${event}\` event`]
  }
}

function list(s) {
  const t = s.trim()
  if (t.startsWith('[')) return t.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean)
  return [unquote(t)]
}

function unquote(s) {
  return String(s).trim().replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '')
}
