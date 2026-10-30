/**
 * What the repository already tells agents and contributors, before caselaw
 * says anything.
 *
 * Round 2 of the DEF-274 re-score: homebridge's own CLAUDE.md tells agents to
 * target `beta-*` branches, and a push to one publishes to npm; ntfy keeps an
 * AI policy in docs/ai-policy.md; pyvisa's pull-request template requires a
 * CHANGES entry. The generated docs ignored all three, so a maintainer read
 * them as written by something that had not read the repository.
 *
 * Found by path; read only to find pull-request checklist items and the lines
 * that name a branch which publishes. caselaw's own pointer blocks are not the
 * repository's instructions and are skipped.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const AGENT_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.github/copilot-instructions.md', '.cursorrules', '.windsurfrules']
const AI_POLICY = /(^|\/)(ai[-_ ]?(policy|usage|contributions?|guidelines)|ai_policy)\.(md|rst|txt)$/i
const PR_TEMPLATES = ['.github/PULL_REQUEST_TEMPLATE.md', '.github/pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md']
const MAX_MENTIONS = 3

export function emptyInstructions() {
  return { files: [], prChecklist: null, mentions: [] }
}

/**
 * @param {string} root
 * @param {{files: string[]}} walked
 * @param {object[]} publishing the publishing report, for branches that publish
 * @returns {Promise<{instructions: object, warnings: object[]}>}
 */
export async function detectInstructions(root, walked, publishing = []) {
  const out = emptyInstructions()
  const present = new Set(walked.files)
  const read = async (f) => { try { return await readFile(join(root, f), 'utf8') } catch { return null } }
  const texts = []

  for (const f of [...AGENT_FILES, ...walked.files.filter((f) => /^\.cursor\/rules\/.+\.mdc$/.test(f) && !f.endsWith('/caselaw.mdc'))]) {
    if (!present.has(f)) continue
    const text = withoutOurBlock(await read(f))
    if (!text || !text.trim()) continue
    out.files.push({ path: f, kind: 'agent instructions' })
    texts.push([f, text])
  }
  for (const f of walked.files.filter((f) => f.split('/').length <= 3 && AI_POLICY.test(f))) {
    out.files.push({ path: f, kind: 'AI policy' })
    const text = await read(f)
    if (text) texts.push([f, text])
  }

  const template = PR_TEMPLATES.find((f) => present.has(f))
  if (template) {
    const items = ((await read(template)) || '').split(/\r?\n/)
      .map((l) => /^\s*[-*]\s+\[ \]\s+(.+?)\s*$/.exec(l)?.[1]).filter(Boolean)
      .map((s) => s.replace(/``?([^`]+)``?/g, '`$1`').replace(/\s*\(insert[^)]*\)/i, ''))
    if (items.length) out.prChecklist = { path: template, items: items.slice(0, 12) }
  }

  // Lines in the repository's own instructions that name a branch which publishes.
  const branches = publishing.flatMap((p) => p.publishes.flatMap((s) =>
    (s.branches || []).map((pattern) => ({ pattern, what: s.what, at: `${p.file}:${s.line}` }))))
  for (const [path, text] of texts) {
    text.split(/\r?\n/).forEach((line, i) => {
      if (out.mentions.length >= MAX_MENTIONS) return
      for (const b of branches) {
        const m = globRegex(b.pattern).exec(line)
        if (m && !out.mentions.some((x) => x.path === path && x.pattern === b.pattern)) {
          out.mentions.push({ path, line: i + 1, said: m[0].replace(/[,.;:)]+$/, ''), pattern: b.pattern, what: b.what, at: b.at })
        }
      }
    })
  }
  return { instructions: out, warnings: [] }
}

/** A branch glob as a regex that also matches a template like `beta-{major}.{minor}.{patch}`. */
export function globRegex(glob) {
  const body = glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^\\s`\'"]*')
  return new RegExp(`(?<![\\w-])${body}`)
}

function withoutOurBlock(text) {
  return text ? text.replace(/<!-- caselaw:begin[\s\S]*?caselaw:end[^>]*-->/g, '') : text
}
