/**
 * `caselaw personal`: the owner's own layer (0.3), on this machine only.
 *
 *   list            the rules that caught something, in how many of your repositories
 *   export <file>   the same, for sharing by hand: no paths, no repository names
 */

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadPersonal, exportPersonal, personalDefaults, personalHome, personalOff, PERSONAL_REPOS } from '../core/personal.js'

export const PERSONAL_SUBCOMMANDS = ['list', 'export']

export async function cmdPersonal(args, { say }) {
  if (personalOff()) say('  CASELAW_PERSONAL=off: nothing new is recorded.')
  const data = await loadPersonal()
  if (args.sub === 'export') {
    if (!args.name) { say('  caselaw personal export <file>'); return 2 }
    await writeFile(resolve(args.name), JSON.stringify(exportPersonal(data), null, 2) + '\n', 'utf8')
    say(`  Wrote ${args.name}: ${Object.keys(data.rules).length} rule(s), with no paths and no repository names.`)
    return 0
  }
  if (args.sub !== 'list') { say(`  caselaw personal <${PERSONAL_SUBCOMMANDS.join('|')}>`); return 2 }
  say(`  ${personalHome()}`)
  const offered = new Set(personalDefaults(data).map((p) => p.name))
  const names = Object.keys(data.rules).sort()
  if (!names.length) say('  Nothing recorded yet. Each `caselaw rule catch` adds to it.')
  for (const name of names) {
    const r = data.rules[name]
    const repos = [...new Set(r.catches.map((c) => c.repo))].map((id) => data.repos[id]?.name || id)
    say(`  ${name}: ${r.catches.length} catch(es) in ${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'} (${repos.join(', ')})${offered.has(name) ? ` — offered as a personal default (${PERSONAL_REPOS}+ repositories)` : ''}`)
  }
  return 0
}
