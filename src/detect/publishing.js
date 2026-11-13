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
import { unquoteYamlScalar as unquote } from '../core/text.js'

/** Steps that publish, and what they publish to. First match per line wins. */
const PUBLISHERS = [
  [/(?:\bchangeset|@changesets\/cli)\s+publish\b/, 'the package registries configured for Changesets'],
  [/(?:^|[;&|])\s*(?:(?:npx|npm exec|(?:pnpm|yarn|bun)(?:\s+(?:dlx|exec|run))?)\s+)?semantic-release(?:@[\w.*+-]+)?(?=\s|$)/, 'semantic-release and its configured release targets'],
  [/\bbun publish\b/, 'the package registry configured for Bun'],
  [/\bnpm publish\b|\b(pnpm|yarn)( npm)? publish\b|JS-DevTools\/npm-publish/, 'npm'],
  [/\bpkg-pr-new(?:@[\w.*+-]+)?\s+publish\b/, 'a package preview (pkg-pr-new)'],
  [/pypa\/gh-action-pypi-publish|\btwine upload\b|\b(?:poetry|uv|hatch|flit|maturin) publish\b/, 'PyPI'],
  [/\bcargo publish\b/, 'crates.io'],
  [/goreleaser\/goreleaser-action|\bgoreleaser release\b/, 'GoReleaser (a GitHub release and its configured targets)'],
  [/\bmake release\b/, 'the Makefile\'s release target'],
  [/docker\/build-push-action|\bdocker push\b/, 'a container registry'],
  [/\bvsce publish\b|\bovsx publish\b/, 'the VS Code Marketplace'],
  [/chrome-webstore-upload/, 'the Chrome Web Store'],
  [/\bfastlane\b.*\b(deliver|pilot|upload_to_app_store|upload_to_testflight)\b|\bxcrun altool\b/, 'App Store Connect'],
  [/softprops\/action-gh-release|\bgh release create\b/, 'a GitHub release'],
  // CI that commits and pushes (ntfy's docs workflow pushes the built site to another repository).
  [/\bgit push\b/, 'a git push made by CI'],
  // Announcements: homebridge posts every npm publish to Discord (round 4 of the DEF-274 re-score).
  [/discord-webhooks?\b|DISCORD_WEBHOOK|discord(app)?\.com\/api\/webhooks|Ilshidur\/action-discord|sarisia\/actions-status-discord/i, 'a Discord channel (a webhook post)', { announce: true }],
  [/SLACK_WEBHOOK|slackapi\/slack-github-action|hooks\.slack\.com|rtCamp\/action-slack-notify|8398a7\/action-slack/i, 'a Slack channel (a webhook post)', { announce: true }],
]

/** Hosted builds configured outside the repository: the file says it builds, its settings say when. */
const HOSTED_DOCS = [
  [/^\.readthedocs\.ya?ml$|^readthedocs\.ya?ml$/, 'Read the Docs (the documentation site)',
    'the pushes its project settings on readthedocs.org select (they are not in this repository)'],
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
  const warnings = []
  const workflows = walked.files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)).sort()
  const goreleaser = await goreleaserTargets(root, walked.files)
  const makeRelease = await makeReleaseRuns(root)
  for (const file of workflows) {
    let text
    try { text = await readFile(join(root, file), 'utf8') } catch { continue }
    const steps = publishSteps(text)
    if (!steps.length) continue
    const events = workflowEvents(text)
    const jobs = jobsOf(text)
    for (const s of steps) {
      // When this step can actually run: the workflow's events, narrowed by its
      // job's `if:` and by every job it needs (round 2 of the DEF-274 re-score:
      // pyvisa's workflow starts by hand and on a schedule, but publishes only
      // on a push).
      const { when, conditions, branches } = whenStepRuns(events, jobs, s.line, stepContext(text, s.line))
      s.when = when
      s.conditions = conditions
      s.branches = branches
      s.what = name(s, { text, jobs, goreleaser, makeRelease })
      if (s.unread) warnings.push({ code: 'publishing-wrapper-unread', message: `${file}:${s.line} invokes a publishing wrapper whose destination and additional conditions need source review.` })
    }
    out.push({ file, triggers: workflowTriggers(text), publishes: steps })
  }
  // pyvisa's documentation is built and published by Read the Docs from
  // `.readthedocs.yaml`, with no workflow at all (round 4).
  for (const [re, what, when] of HOSTED_DOCS) {
    const file = walked.files.find((f) => re.test(f))
    if (file) out.push({ file, triggers: [when], publishes: [{ what, line: 1, when: [when], conditions: [], branches: [] }] })
  }
  return { publishing: out, warnings }
}

/** A destination named by where it actually goes, where the files say. */
function name(step, { text, jobs, goreleaser, makeRelease }) {
  if (step.what === 'a git push made by CI') {
    const job = jobAt(jobs, step.line)
    const lines = text.split(/\r?\n/).slice(job ? job.start : 0, job ? job.end : undefined)
    const repo = lines.map((l) => /^\s*repository:\s*["']?([\w.-]+\/[\w.-]+)/.exec(l)).find(Boolean)
    return repo ? `the repository ${repo[1]} (a git push made by CI)` : step.what
  }
  if (step.what === 'the Makefile\'s release target' && makeRelease.goreleaser) {
    return `GoReleaser, through the Makefile's release target (Makefile:${makeRelease.line})${goreleaser.length ? `: ${goreleaser.join(', ')}` : ''}`
  }
  if (step.what.startsWith('GoReleaser') && goreleaser.length) return `GoReleaser: ${goreleaser.join(', ')}`
  return step.what
}

/** What a GoReleaser config publishes, from its top-level sections. */
async function goreleaserTargets(root, files) {
  const file = files.find((f) => f === '.goreleaser.yml' || f === '.goreleaser.yaml')
  if (!file) return []
  let text
  try { text = await readFile(join(root, file), 'utf8') } catch { return [] }
  const keys = new Set([...text.matchAll(/^([a-z_]+):/gm)].map((m) => m[1]))
  const out = []
  if (keys.has('dockers') || keys.has('docker_manifests') || keys.has('dockers_v2')) out.push('Docker images')
  if (keys.has('nfpms')) out.push('Linux packages')
  if (keys.has('brews') || keys.has('homebrew_casks')) out.push('Homebrew')
  if (keys.has('scoops')) out.push('Scoop')
  if (keys.has('snapcrafts')) out.push('Snap')
  if (!/^release:\s*\n\s+disable:\s*true/m.test(text)) out.push('a GitHub release')
  return out
}

/** Whether the Makefile's `release:` recipe runs GoReleaser, and on which line. */
async function makeReleaseRuns(root) {
  let text
  try { text = await readFile(join(root, 'Makefile'), 'utf8') } catch { return {} }
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => /^release:/.test(l))
  if (start === -1) return {}
  for (let i = start + 1; i < lines.length && /^\t/.test(lines[i]); i++) {
    if (/\bgoreleaser\b/.test(lines[i])) return { goreleaser: true, line: i + 1 }
  }
  return {}
}

const lineIndent = (line) => line.search(/\S/)
const contentLine = (line) => line.trim() && !/^\s*#/.test(line)

function blockEnd(lines, start, end = lines.length) {
  const base = lineIndent(lines[start])
  let at = start + 1
  while (at < end && (!contentLine(lines[at]) || lineIndent(lines[at]) > base)) at++
  return at
}

/** Mapping children at their measured indentation, excluding nested descendants. */
function fields(lines, start, end) {
  const indexes = []
  for (let i = start + 1; i < end; i++) {
    if (contentLine(lines[i]) && /^\s*[\w-]+:/.test(lines[i])) indexes.push(i)
  }
  const indent = Math.min(...indexes.map((i) => lineIndent(lines[i])))
  return indexes.filter((i) => lineIndent(lines[i]) === indent)
}

function fieldValue(lines, at, end) {
  const value = lines[at].replace(/^\s*(?:-\s+)?[\w-]+:\s*/, '')
  if (!/^[|>][-+]?\s*(?:#.*)?$/.test(value)) return unquote(value)
  const parts = []
  const fieldIndent = lineIndent(lines[at]) + (/^\s*-\s+/.test(lines[at]) ? 2 : 0)
  for (let i = at + 1; i < end; i++) {
    if (!lines[i].trim()) continue
    if (lineIndent(lines[i]) <= fieldIndent) break
    parts.push(lines[i].trim())
  }
  return parts.join(' ')
}

/** The jobs of a workflow: where each starts and ends, its if and needs. */
export function jobsOf(text) {
  const lines = text.split(/\r?\n/)
  const top = lines.findIndex((l) => /^jobs:\s*(?:#.*)?$/.test(l))
  if (top === -1) return []
  const end = blockEnd(lines, top)
  const starts = fields(lines, top, end).filter((i) => /^\s*[\w-]+:\s*(?:#.*)?$/.test(lines[i]))
  return starts.map((start, k) => {
    const job = { name: lines[start].trim().split(':')[0], start, end: starts[k + 1] ?? end, if: null, ifLine: null, needs: [] }
    for (const at of fields(lines, start, job.end)) {
      const key = lines[at].trim().split(':')[0]
      if (key === 'if') {
        job.if = fieldValue(lines, at, job.end).replace(/^\$\{\{\s*|\s*\}\}$/g, '')
        job.ifLine = at + 1
      } else if (key === 'needs') {
        const value = fieldValue(lines, at, job.end)
        if (value) job.needs = list(value)
        else for (let i = at + 1; i < job.end; i++) {
          if (!contentLine(lines[i])) continue
          if (lineIndent(lines[i]) < lineIndent(lines[at]) || !/^\s*-\s+/.test(lines[i])) break
          job.needs.push(unquote(lines[i].replace(/^\s*-\s+/, '')))
        }
      }
    }
    return job
  })
}

function jobAt(jobs, line) {
  return jobs.find((j) => line - 1 > j.start && line - 1 < j.end) || null
}

/** Literal execution context, with relative YAML indentation and run-default precedence. */
export function stepContext(text, line) {
  const lines = text.split(/\r?\n/)
  const job = jobAt(jobsOf(text), line)
  if (!job) return {}
  const steps = fields(lines, job.start, job.end).find((i) => /^\s*steps:/.test(lines[i]))
  if (steps === undefined) return {}
  const starts = []
  for (let i = steps + 1; i < job.end; i++) {
    if (!contentLine(lines[i])) continue
    const indent = lineIndent(lines[i])
    if (indent < lineIndent(lines[steps]) || (indent === lineIndent(lines[steps]) && !/^\s*-\s+/.test(lines[i]))) break
    if (/^\s*-\s+[\w-]+:/.test(lines[i]) && (!starts.length || indent === lineIndent(lines[starts[0]]))) starts.push(i)
  }
  const start = starts.filter((i) => i <= line - 1).at(-1)
  if (start === undefined) return {}
  const end = starts.find((i) => i > start) ?? job.end
  const context = {}
  const defaults = (from, to) => {
    const at = fields(lines, from, to).find((i) => /^\s*defaults:/.test(lines[i]))
    if (at === undefined) return
    const limit = blockEnd(lines, at, to)
    const run = fields(lines, at, limit).find((i) => /^\s*run:/.test(lines[i]))
    if (run === undefined) return
    for (const i of fields(lines, run, blockEnd(lines, run, limit))) {
      const field = /^\s*(working-directory|shell):/.exec(lines[i])
      if (field) context[field[1] === 'shell' ? 'shell' : 'workingDirectory'] = fieldValue(lines, i, limit)
    }
  }
  defaults(-1, lines.findIndex((l) => /^jobs:/.test(l)))
  defaults(job.start, steps)
  const fieldIndent = lineIndent(lines[start]) + 2
  for (let i = start; i < end; i++) {
    const field = /^\s*(?:-\s+)?(if|working-directory|shell|continue-on-error):/.exec(lines[i])
    if (!field || (i !== start && lineIndent(lines[i]) !== fieldIndent)) continue
    const value = fieldValue(lines, i, end)
    if (field[1] === 'if') { context.condition = value.replace(/^\$\{\{\s*|\s*\}\}$/g, ''); context.conditionLine = i + 1 }
    else if (field[1] === 'working-directory') context.workingDirectory = value
    else if (field[1] === 'shell') context.shell = value
    else if (value !== 'false') context.continueOnError = value
  }
  if (job.if) context.jobCondition = job.if
  return context
}

/**
 * The events on which a step's job can run, as phrases, and any condition that
 * could not be read as an event. Only plain comparisons are understood
 * (`github.event_name == 'push'`, `startsWith(github.ref, 'refs/tags/')`);
 * anything else is quoted back, never interpreted.
 */
export function whenStepRuns(events, jobs, line, context = {}) {
  const stepConditions = context.condition ? [`\`${context.condition}\` (line ${context.conditionLine})`] : []
  if (!events) return { when: null, conditions: stepConditions, branches: [] }
  let allowed = events.map((e) => ({ event: e.event, filters: { ...e.filters } }))
  const conditions = []
  const seen = new Set()
  const visit = (job, own) => {
    if (!job || seen.has(job.name)) return
    seen.add(job.name)
    if (job.if) {
      const r = narrow(allowed, job.if)
      allowed = r.events
      // A needed job's condition on another job's outputs is already folded into
      // the publishing job's own `if:`; only its own repository, ref or event
      // conditions are added, or homebridge's chain lists five.
      const relevant = own || (/github\./.test(job.if) && !/needs\./.test(job.if))
      if (r.unread && relevant) conditions.push(`\`${job.if.length > 600 ? `${job.if.slice(0, 597)}…` : job.if}\` (line ${job.ifLine})`)
    }
    for (const n of job.needs) visit(jobs.find((j) => j.name === n), false)
  }
  visit(jobAt(jobs, line), true)
  conditions.push(...stepConditions)
  const branches = allowed.filter((e) => e.event === 'push').flatMap((e) => e.filters.branches || [])
  return { when: allowed.flatMap(({ event, filters }) => phrase(event, filters)), conditions, branches }
}

function narrow(events, expr) {
  let out = events
  const eq = [...expr.matchAll(/github\.event_name\s*==\s*['"]([\w-]+)['"]/g)].map((m) => m[1])
  const ne = [...expr.matchAll(/github\.event_name\s*!=\s*['"]([\w-]+)['"]/g)].map((m) => m[1])
  if (eq.length) out = out.filter((e) => eq.includes(e.event))
  if (ne.length) out = out.filter((e) => !ne.includes(e.event))
  if (/startsWith\(\s*github\.ref\s*,\s*['"]refs\/tags\//.test(expr)) {
    out = out.filter((e) => e.event !== 'push' || !e.filters.branches || e.filters.tags)
      .map((e) => (e.event === 'push' ? { event: 'push', filters: { tags: e.filters.tags || ['*'] } } : e))
  }
  const rest = expr
    .replace(/github\.event_name\s*[!=]=\s*['"][\w-]+['"]/g, '')
    .replace(/startsWith\(\s*github\.ref\s*,\s*['"]refs\/(tags|heads)\/['"]?\s*\)/g, '')
    .replace(/&&|\|\||[()\s]/g, '')
  return { events: out, unread: rest.length > 0 }
}

/** Each distinct destination a workflow publishes to, with the first line that does it. */
export function publishSteps(text) {
  const seen = new Map()
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*#|^\s*(?:-\s+)?(?:name|if|working-directory|shell):/.test(line)) return
    const run = /^\s*(?:-\s+)?run:\s*(.+)$/.exec(line)
    if (run) line = unquote(run[1])
    // Script names describe their verb; a test about releases is still a test.
    line = line.replace(/\b(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+([\w:.-]+)/g, (invocation, script) =>
      /^(?:test|lint|check|verify|build|typecheck|format|dry-run)[:_-]|[:_-](?:test|lint|check|verify|dry-run)$/.test(script) ? 'nonpublishing-check' : invocation)
    for (const [re, what, opts] of PUBLISHERS) {
      if (re.test(line)) { if (!seen.has(what)) seen.set(what, { line: i + 1, ...opts }); break }
    }
    const wrapper = /\b(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+([\w:.-]*(?:publish|release|deploy)[\w:.-]*)\b/.exec(line)
    if (wrapper && !PUBLISHERS.some(([re]) => re.test(line))) {
      const what = `publishing wrapper ${wrapper[1]} (destination unverified; review source)`
      if (!seen.has(what)) seen.set(what, { line: i + 1, unread: true })
    }
  })
  return [...seen.entries()].map(([what, { line, announce, unread }]) => ({ what, line, ...(announce ? { announce } : {}), ...(unread ? { unread } : {}) }))
}

/**
 * The events that start a workflow, as plain phrases ("pushing a tag matching
 * `v*`"). `null` when the `on:` block cannot be read; never a guess.
 */
export function workflowTriggers(text) {
  const events = workflowEvents(text)
  return events ? events.flatMap(({ event, filters }) => phrase(event, filters)) : null
}

/** The `on:` block as [{event, filters: {tags, branches, types, …}}], or null. */
export function workflowEvents(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => /^["']?(on|true)["']?\s*:/.test(l))
  if (start === -1) return null
  const inline = lines[start].replace(/^["']?(on|true)["']?\s*:\s*/, '').replace(/\s+#.*$/, '').trim()
  if (inline) return list(inline).map((event) => ({ event, filters: {} }))

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
    // An event alone on its line, or as a list item: homebridge's wiki
    // notification is `on:` then `gollum` (round 4 of the DEF-274 re-score).
    const bare = /^\s*(?:-\s*)?["']?([\w-]+)["']?\s*(?:#.*)?$/.exec(block[i])
    if (bare) { events.push({ event: bare[1], filters: {} }); continue }
    const m = /^\s*(?:-\s*)?([\w-]+)\s*:\s*(.*)$/.exec(block[i])
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
    events.push({ event: m[1], filters })
  }
  return events
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
    case 'gollum': return ['an edit to the repository\'s wiki']
    default: return [`the \`${event}\` event`]
  }
}

function list(s) {
  const t = s.trim()
  if (t.startsWith('[')) return t.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean)
  return [unquote(t)]
}
