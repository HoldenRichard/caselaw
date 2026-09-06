/**
 * Gather everything the audit needs, once.
 *
 * Reading the disk is separated from judging it so the checks stay pure and
 * testable, and so a hostile or half-installed repo cannot make the audit
 * throw. Anything unreadable becomes a recorded gap, never an exception:
 * an audit that dies on a weird repo is an audit nobody runs twice.
 */

import { readFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as answersStore from '../core/answers.js'
import * as manifestStore from '../core/manifest.js'
import * as gatesStore from '../core/gates.js'
import { locate } from '../core/blocks.js'
import { daysBetween } from '../core/dates.js'

const pExecFile = promisify(execFile)

/** Files whose pointers we follow and whose text we scan for hygiene. */
const DOC_FILES = [
  'docs/authority-split.md',
  'docs/close-out.md',
  'docs/rules/README.md',
  'CLAUDE.md',
  'AGENTS.md',
]

export async function gather(root, { now = new Date() } = {}) {
  const notes = []

  const [answers, manifest, gatesConfig] = await Promise.all([
    answersStore.load(root).catch((e) => (notes.push(`answers: ${e.message}`), null)),
    manifestStore.load(root).catch((e) => (notes.push(`manifest: ${e.message}`), null)),
    gatesStore.load(root).catch((e) => (notes.push(`gates: ${e.message}`), null)),
  ])

  const docTexts = {}
  for (const rel of DOC_FILES) {
    const text = await readIfExists(join(root, rel))
    if (text !== null) docTexts[rel] = text
  }

  const rules = await gatherRules(root, { now, notes })
  const docRefs = await gatherRefs(root, docTexts)
  const untracked = await gatherUntracked(root, [...Object.keys(docTexts), ...allRuleFiles(rules)], notes)
  const authority = parseAuthority(docTexts['docs/authority-split.md'], 'docs/authority-split.md')
  const staleCommands = await gatherStaleCommands(root, answers, docTexts)
  const fires = countFires(await gatesStore.readFires(root))
  const fireCounts = fires.all
  const earnedFires = fires.earned
  const drifted = await gatherDrift(root, manifest, notes)
  const installAgeDays = answers?.generatedAt ? daysBetween(new Date(answers.generatedAt), now) : null
  const adrs = await gatherAdrs(root)
  const gitignoreClaims = await gatherGitignoreClaims(root, docTexts)

  return {
    root, now, notes,
    answers, manifest,
    gatesConfig: gatesConfig ?? gatesStore.emptyConfig(),
    rules, docTexts, docRefs, untracked, authority, staleCommands, adrs, gitignoreClaims,
    fireCounts, earnedFires, drifted, installAgeDays,
    installed: Boolean(answers || manifest),
  }
}

async function gatherRules(root, { now, notes }) {
  const empty = { active: [], proposed: [], candidates: [] }
  let listed
  try {
    const rulesMod = await import('../core/rules.js')
    listed = await rulesMod.listRules(root)
  } catch (err) {
    notes.push(`rules: ${err.message}`)
    return empty
  }

  // listRules() keeps a rule's content under .parsed, its problems under
  // .validation, and .file as a bare basename. The checks read the content at
  // the top level and hand .file to git and stat(). For a whole release the
  // two shapes never met: every active rule audited as "has no Origin", the
  // mechanisation ratio always read 100% memory, and dead-rules,
  // proposed-backlog and enforcement-truth could not fire on real data —
  // while their tests, built by hand in the shape the checks expected, stayed
  // green. This is the one place the two shapes are reconciled, and
  // test/unit/audit-real.test.js pins the contract.
  const enrich = async (r) => {
    const parsed = r.parsed || {}
    const problems = r.validation?.problems || []
    const merged = {
      ...r,
      file: r.path, // repo-relative — what git and stat() need; the basename is kept alongside
      basename: r.file,
      trigger: parsed.trigger ?? null,
      rule: parsed.rule ?? null,
      origin: parsed.origin ?? null,
      ratified: parsed.ratified ?? null,
      enforcement: parseEnforcement(parsed.enforcement),
      problems,
      ageDays: await fileAgeDays(join(root, r.path || ''), now),
      unresolvedRefs: problems
        .filter((p) => p.code === 'origin-unresolvable')
        .map((p) => p.ref || p.message),
    }
    merged.missingSubjects = await missingSubjects(root, merged)
    return merged
  }

  return {
    active: await Promise.all((listed.active || []).map(enrich)),
    proposed: await Promise.all((listed.proposed || []).map(enrich)),
    candidates: await Promise.all((listed.candidates || []).map(enrich)),
  }
}

/**
 * `**Enforcement:** memory | checklist | machine:<gate-id>` as the checks and
 * the gates cross-check read it. Null when absent; the raw text travels along
 * so a report can quote what the file actually says.
 */
export function parseEnforcement(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (!raw) return null
  const [mode, ...rest] = raw.toLowerCase().split(':')
  return { mode, gateId: rest.length ? rest.join(':') : null, raw }
}

/**
 * Paths or tools a rule's Trigger names that no longer exist.
 *
 * Deliberately conservative: only a token that looks like a real path AND is
 * absent counts. Guessing wrong here tells someone to delete a rule that is
 * quietly working, which is the most expensive mistake this audit could make.
 */
async function missingSubjects(root, rule) {
  const text = `${rule.trigger || ''}`
  const candidates = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1])
  const out = []
  for (const c of candidates) {
    if (!/[/.]/.test(c) || /\s/.test(c)) continue // not path-shaped
    if (c.includes('*')) continue // a glob may legitimately match nothing today
    if (!(await exists(join(root, c)))) out.push(c)
  }
  return out
}

function allRuleFiles(rules) {
  return [...rules.active, ...rules.proposed].map((r) => r.file).filter(Boolean)
}

/** Markdown links and backticked paths inside doctrine, and whether they exist. */
async function gatherRefs(root, docTexts) {
  const refs = []
  for (const [from, text] of Object.entries(docTexts)) {
    const targets = new Set()
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) targets.add(m[1])
    for (const m of text.matchAll(/`([^`\s]+\/[^`\s]*)`/g)) targets.add(m[1])
    for (const t of targets) {
      if (/^[a-z]+:\/\//i.test(t) || t.startsWith('#')) continue
      const clean = t.split('#')[0].replace(/\/$/, '')
      if (!clean || !/[/.]/.test(clean)) continue
      if (clean.includes('*') || clean.includes('<')) continue // globs and placeholders
      if (clean.startsWith('~')) continue // home-relative, not a repo path
      // Two conventions live side by side in these documents: a markdown
      // link is relative to the file containing it, while a backticked path
      // like `.caselaw/answers.json` is written repo-root-relative. Resolving
      // only one way flags every instance of the other as broken. A reference
      // counts as resolved if EITHER reading finds a real file — a false
      // "broken link" teaches people to ignore this check, and an ignored
      // check is worse than no check.
      const candidates = clean.startsWith('/')
        ? [join(root, clean.slice(1))]
        : [join(root, dirname(from), clean), join(root, clean)]
      let found = false
      for (const abs of candidates) {
        if (await exists(abs)) { found = true; break }
      }
      refs.push({ from, target: t, exists: found })
    }
  }
  return refs
}

async function gatherUntracked(root, paths, notes) {
  const unique = [...new Set(paths.filter(Boolean))]
  if (unique.length === 0) return []
  try {
    const { stdout } = await pExecFile('git', ['ls-files', '--error-unmatch', '--', ...unique], {
      cwd: root, encoding: 'utf8',
    })
    const tracked = new Set(stdout.split('\n').map((s) => s.trim()).filter(Boolean))
    return unique.filter((p) => !tracked.has(p))
  } catch (err) {
    // git exits non-zero when ANY path is untracked and names them on stderr as
    //   error: pathspec 'docs/x.md' did not match any file(s) known to git
    // The path comes BEFORE the phrase. An earlier version captured what came
    // after, which yielded findings like "Did you forget to is not tracked by
    // git" — nonsense that still read as a real error to anyone skimming.
    const listed = String(err?.stderr || '').matchAll(/pathspec '([^']+)' did not match/g)
    const found = [...listed].map((m) => m[1].trim()).filter(Boolean)
    if (found.length) return found
    notes.push('could not determine which doctrine files are tracked')
    return []
  }
}

/** Pull the re-test date and any still-untested boundaries out of the doc. */
export function parseAuthority(text, file) {
  if (!text) return null
  const due = text.match(/re-check due \*\*(\d{4}-\d{2}-\d{2})\*\*/i)
    || text.match(/settle these by (\d{4}-\d{2}-\d{2})/i)

  const untested = []
  const table = text.match(/## Unverified boundaries[\s\S]*?\n\n([\s\S]*?)(\n\n>|\n## |$)/)
  if (table) {
    for (const line of table[1].split('\n')) {
      const cells = line.split('|').map((c) => c.trim())
      if (cells.length < 4 || /^-+$/.test(cells[1]) || cells[1] === 'Boundary') continue
      if (!cells[1]) continue
      untested.push({
        label: cells[1],
        assumedBecause: cells[2] || '',
        // The template prints an italic placeholder when it has no one-liner
        // to offer. Echoing that back as if it were a command to run is worse
        // than saying nothing.
        settleCommand: parseSettleCommand(cells[3]),
      })
    }
  }
  return { file, retestDue: due ? due[1] : null, untested }
}

/** Commands the docs promise, that the project no longer defines. */
async function gatherStaleCommands(root, answers, docTexts) {
  const declared = new Set()
  const pkgText = await readIfExists(join(root, 'package.json'))
  if (pkgText) {
    try {
      for (const s of Object.keys(JSON.parse(pkgText).scripts || {})) declared.add(`npm run ${s}`)
      declared.add('npm test')
    } catch { /* a broken package.json is not this check's business */ }
  }

  const out = []
  const recorded = answers?.detected?.commands || {}
  for (const [, entry] of Object.entries(recorded)) {
    if (!entry?.cmd) continue
    if (!entry.cmd.startsWith('npm ')) continue // only npm is cheaply verifiable
    if (!declared.has(entry.cmd)) {
      out.push({ cmd: entry.cmd, from: '.caselaw/answers.json' })
    }
  }
  return out
}

/**
 * Two counts. `all` answers "has this gate ever matched anything?" (the
 * dead-gates check). `earned` counts only fires from the hook and staged
 * modes — the ones that caught a change as it happened — and is what
 * promotion reads. A whole-tree scan over old violations is neither.
 */
function countFires(fires) {
  const all = {}
  const earned = {}
  for (const f of fires) {
    all[f.gate] = (all[f.gate] || 0) + 1
    if (gatesStore.EVIDENCE_MODES.includes(f.mode)) earned[f.gate] = (earned[f.gate] || 0) + 1
  }
  return { all, earned }
}

async function gatherDrift(root, manifest, notes) {
  if (!manifest) return []
  try {
    const r = await manifestStore.reconcile(root, manifest, { locate })
    return [
      ...r.modified.map((path) => ({ path, kind: 'modified' })),
      ...r.missing.map((path) => ({ path, kind: 'missing' })),
    ]
  } catch (err) {
    notes.push(`drift: ${err.message}`)
    return []
  }
}

function parseSettleCommand(cell) {
  const raw = (cell || '').trim()
  if (!raw || raw.startsWith('_')) return null
  const inBackticks = raw.match(/^`(.+)`$/)
  return inBackticks ? inBackticks[1] : null
}

/**
 * Decision records: their numbers, and whether the index lists them.
 *
 * Two failures, both observed in a real repo: the same number used twice
 * (so "see ADR 0010" is ambiguous forever), and a record present on disk but
 * absent from the index (so it is effectively invisible to anyone browsing).
 */
async function gatherAdrs(root) {
  const dirs = ['docs/adrs', 'docs/decisions', 'docs/adr']
  for (const dir of dirs) {
    let names
    try {
      const { readdir } = await import('node:fs/promises')
      names = (await readdir(join(root, dir))).filter((f) => /^\d{3,4}[-_]/.test(f) && f.endsWith('.md'))
    } catch { continue }
    if (!names.length) continue

    const indexText =
      (await readIfExists(join(root, dir, 'README.md'))) ??
      (await readIfExists(join(root, dir, 'index.md'))) ?? ''

    const records = names.map((file) => ({
      file: `${dir}/${file}`,
      number: (file.match(/^(\d{3,4})/) || [])[1],
      inIndex: indexText.includes(file),
    }))
    return { dir, records, hasIndex: Boolean(indexText) }
  }
  return null
}

/**
 * Claims of the form "X is gitignored" that git disagrees with.
 *
 * Narrow on purpose. A doc that tells you a file is machine-local when it is
 * actually committed sends the reader to recreate something that already
 * exists — and it is exactly the kind of statement that silently stops being
 * true when someone adds a negation to .gitignore.
 */
async function gatherGitignoreClaims(root, docTexts) {
  const claims = []
  for (const [from, text] of Object.entries(docTexts)) {
    // Walk each mention of "gitignored" and look at the backticked tokens
    // around it. An earlier version used a character class that excluded
    // periods and newlines, which cannot cross a filename or a wrapped line —
    // so it matched nothing in real prose and reported a clean result.
    for (const m of text.matchAll(/\bgitignored\b/g)) {
      const before = text.slice(Math.max(0, m.index - 240), m.index)
      const after = text.slice(m.index, m.index + 240)
      const tokens = [
        ...[...before.matchAll(/`([^`\n]+)`/g)].map((x) => x[1]).reverse(),
        ...[...after.matchAll(/`([^`\n]+)`/g)].map((x) => x[1]),
      ]
      const path = tokens.find((t) => /^[\w./-]+$/.test(t) && t.includes('/') && !t.includes('*'))
      if (path) claims.push({ from, path })
    }
  }

  const seen = new Set()
  const checked = []
  for (const c of claims) {
    const key = `${c.from}::${c.path}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!(await exists(join(root, c.path)))) continue
    try {
      await pExecFile('git', ['check-ignore', '-q', '--', c.path], { cwd: root })
      checked.push({ ...c, actuallyIgnored: true })
    } catch (err) {
      // exit 1 = a real "no, it is tracked"; anything else = git could not say
      if (err?.code === 1) checked.push({ ...c, actuallyIgnored: false })
    }
  }
  return checked
}

async function exists(p) {
  try { await stat(p); return true } catch { return false }
}

async function readIfExists(p) {
  try { return await readFile(p, 'utf8') } catch { return null }
}

async function fileAgeDays(p, now) {
  try {
    const s = await stat(p)
    return daysBetween(s.mtime, now)
  } catch { return null }
}
