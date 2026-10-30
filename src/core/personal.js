/**
 * The personal layer (0.3): what one owner's harnesses learned, across their
 * repositories, kept in their own home folder.
 *
 * Every `caselaw rule catch` also records, locally, which rule caught
 * something in which of the owner's repositories. A rule of their own that
 * has caught failures in two or more of them is offered as a personal default
 * on their next install, next to the shipped six. Nothing leaves the machine:
 * no telemetry, and sharing is a manual `caselaw personal export`, which
 * drops every local path. Set CASELAW_PERSONAL=off to keep no record at all.
 */

import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { DEFAULTS } from './defaults.js'
import { TRIGGERS } from './triggers.js'

export const PERSONAL_FILE = 'personal.json'
/** Repositories a rule must have caught failures in before it is offered as a personal default. */
export const PERSONAL_REPOS = 2

export const personalHome = () => process.env.CASELAW_HOME || join(homedir(), '.caselaw')
export const personalOff = () => process.env.CASELAW_PERSONAL === 'off'

const empty = () => ({ version: 1, repos: {}, rules: {} })
// Read when asked, not at load: defaults.js imports this module too.
const shipped = () => new Set([...DEFAULTS.map((d) => d.name), ...TRIGGERS.map((t) => t.rule)])

export async function loadPersonal(home = personalHome()) {
  try {
    const data = JSON.parse(await readFile(join(home, PERSONAL_FILE), 'utf8'))
    return data && data.version === 1 ? { repos: {}, rules: {}, ...data } : empty()
  } catch { return empty() }
}

async function save(home, data) {
  await mkdir(home, { recursive: true })
  await writeFile(join(home, PERSONAL_FILE), JSON.stringify(data, null, 2) + '\n', 'utf8')
}

/** A repository's id: a hash of its real path, so the store never needs the path to tell two apart. */
async function repoId(root) {
  const real = await realpath(root).catch(() => root)
  return { id: createHash('sha256').update(real).digest('hex').slice(0, 12), path: real }
}

/**
 * Record a catch in the owner's store, with the rule's text as it stands now
 * (the latest text wins; the catches only accumulate).
 */
export async function recordPersonalCatch({ root, rule, at, home = personalHome() }) {
  if (personalOff()) return null
  const data = await loadPersonal(home)
  const { id, path } = await repoId(root)
  data.repos[id] = { name: basename(path), path, seen: at }
  const prev = data.rules[rule.name] || { catches: [] }
  data.rules[rule.name] = {
    trigger: rule.trigger, rule: rule.rule, snapshotAt: at,
    catches: [...prev.catches, { repo: id, at }],
  }
  await save(home, data)
  return data.rules[rule.name]
}

/** The owner's rules that have earned a place on their next install: caught in two or more repositories, and not already shipped. */
export function personalDefaults(data) {
  return Object.entries(data?.rules || {})
    .filter(([name, r]) => !shipped().has(name) && new Set((r.catches || []).map((c) => c.repo)).size >= PERSONAL_REPOS)
    .map(([name, r]) => {
      const repos = new Set(r.catches.map((c) => c.repo)).size
      const last = r.catches.map((c) => c.at).sort().at(-1)
      return { id: `P:${name}`, name, trigger: r.trigger, rule: r.rule, repos, last }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** For sharing by hand: the rules and how many repositories each caught in. No paths, no repository names. */
export function exportPersonal(data) {
  return {
    version: 1,
    exportedFrom: 'caselaw personal export',
    rules: Object.fromEntries(Object.entries(data?.rules || {}).map(([name, r]) => [name, {
      trigger: r.trigger, rule: r.rule,
      repos: new Set((r.catches || []).map((c) => c.repo)).size,
      catches: (r.catches || []).length,
    }])),
  }
}

/**
 * A personal default as a rule file. Its precedent is the owner's own record,
 * said without naming the other repositories: a rule in a public repository
 * must not leak a private one's name or what went wrong there.
 */
export function personalRuleBody(p, { since, days }) {
  return [
    `# ${p.name}`,
    `**Trigger:** ${p.trigger}`,
    `**Rule:** ${p.rule}`,
    `**Precedent:** it caught failures in ${p.repos} of this owner's other repositories, recorded on their machine by caselaw, the last on ${p.last.slice(0, 10)}; \`caselaw personal list\` there shows where.`,
    '**Enforcement:** memory',
    `**Default:** personal, active since ${since} (caselaw 0.3)`,
    `---\n_A personal default: one of this owner's own rules, offered at install because it caught failures in ${p.repos} of their repositories. A gate does not travel with it; it starts at memory. Its first catch here becomes this project's own Origin: \`caselaw rule catch ${p.name} --what "<what it caught>"\`. If it has caught nothing after ${days} days of commits, \`caselaw audit\` asks whether this project needs it._`,
  ].join('\n\n') + '\n'
}
