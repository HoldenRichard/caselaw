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
  // CI that commits and pushes (ntfy's docs workflow pushes the built site to another repository).
  [/\bgit push\b/, 'a git push made by CI'],
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
      const { when, conditions, branches } = whenStepRuns(events, jobs, s.line)
      s.when = when
      s.conditions = conditions
      s.branches = branches
      s.what = name(s, { text, jobs, goreleaser, makeRelease })
    }
    out.push({ file, triggers: workflowTriggers(text), publishes: steps })
  }
  return { publishing: out, warnings: [] }
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

/** The jobs of a workflow: where each starts and ends, its `if:` and its `needs:`. */
export function jobsOf(text) {
  const lines = text.split(/\r?\n/)
  const top = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  if (top === -1) return []
  const jobs = []
  for (let i = top + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break
    const m = /^ {2}([\w-]+):\s*$/.exec(lines[i])
    if (m) jobs.push({ name: m[1], start: i, end: lines.length, if: null, ifLine: null, needs: [] })
  }
  for (const [k, job] of jobs.entries()) {
    job.end = jobs[k + 1]?.start ?? job.end
    for (let i = job.start + 1; i < job.end; i++) {
      const cond = /^ {4}if:\s*(.*)$/.exec(lines[i])
      if (cond) {
        let expr = cond[1].trim()
        if (/^[|>][-+]?$/.test(expr)) {
          const parts = []
          for (let j = i + 1; j < job.end && /^ {6,}\S/.test(lines[j]); j++) parts.push(lines[j].trim())
          expr = parts.join(' ')
        }
        job.if = expr.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
        job.ifLine = i + 1
      }
      const needs = /^ {4}needs:\s*(.*)$/.exec(lines[i])
      if (needs) {
        const v = needs[1].trim()
        if (v) job.needs = v.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
        else for (let j = i + 1; j < job.end && /^ {6}-\s/.test(lines[j]); j++) job.needs.push(lines[j].replace(/^ {6}-\s*/, '').trim())
      }
    }
  }
  return jobs
}

function jobAt(jobs, line) {
  return jobs.find((j) => line - 1 > j.start && line - 1 < j.end) || null
}

/**
 * The events on which a step's job can run, as phrases, and any condition that
 * could not be read as an event. Only plain comparisons are understood
 * (`github.event_name == 'push'`, `startsWith(github.ref, 'refs/tags/')`);
 * anything else is quoted back, never interpreted.
 */
export function whenStepRuns(events, jobs, line) {
  if (!events) return { when: null, conditions: [], branches: [] }
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
