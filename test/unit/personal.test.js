/**
 * 0.3's personal layer: an owner's rules that caught failures in two or more
 * of their repositories are offered on their next install. Kept on their
 * machine; shared only by a manual export with no paths in it.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { recordPersonalCatch, loadPersonal, personalDefaults, exportPersonal, personalRuleBody } from '../../src/core/personal.js'
import { QUESTIONS, optionsFor } from '../../src/interview/questions.js'
import { buildArtifacts } from '../../src/generate/artifacts.js'
import { emptyAnswers } from '../../src/core/answers.js'
import { parseRule, validateRule } from '../../src/core/rules.js'

let home, repoA, repoB
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'caselaw-personal-home-'))
  repoA = await mkdtemp(join(tmpdir(), 'caselaw-personal-a-'))
  repoB = await mkdtemp(join(tmpdir(), 'caselaw-personal-b-'))
})
afterEach(async () => { for (const d of [home, repoA, repoB]) await rm(d, { recursive: true, force: true }) })

const RULE = { name: 'migrations-have-a-down', trigger: 'editing a database migration', rule: 'Write the down migration in the same change.' }

describe('what the owner\'s record offers', () => {
  test('POSITIVE CONTROL: a rule that caught in two repositories is offered; two catches in one are not; a shipped rule never is', async () => {
    await recordPersonalCatch({ root: repoA, rule: RULE, at: '2026-10-01', home })
    await recordPersonalCatch({ root: repoA, rule: RULE, at: '2026-10-02', home })
    assert.deepEqual(personalDefaults(await loadPersonal(home)), [], 'one repository, however many catches')
    await recordPersonalCatch({ root: repoB, rule: RULE, at: '2026-10-09', home })
    assert.deepEqual(personalDefaults(await loadPersonal(home)).map((p) => [p.id, p.repos, p.last]), [['P:migrations-have-a-down', 2, '2026-10-09']])

    for (const root of [repoA, repoB]) await recordPersonalCatch({ root, rule: { ...RULE, name: 're-derive-claims' }, at: '2026-10-10', home })
    assert.ok(!personalDefaults(await loadPersonal(home)).some((p) => p.name === 're-derive-claims'), 'already a shipped default')
  })

  test('POSITIVE CONTROL: CASELAW_PERSONAL=off keeps no record at all', async () => {
    const was = process.env.CASELAW_PERSONAL
    process.env.CASELAW_PERSONAL = 'off'
    try {
      assert.equal(await recordPersonalCatch({ root: repoA, rule: RULE, at: '2026-10-01', home }), null)
      assert.deepEqual((await loadPersonal(home)).rules, {})
    } finally {
      if (was === undefined) delete process.env.CASELAW_PERSONAL
      else process.env.CASELAW_PERSONAL = was
    }
  })

  test('POSITIVE CONTROL: the export carries the rules and their counts, and no path or repository name', async () => {
    for (const root of [repoA, repoB]) await recordPersonalCatch({ root, rule: RULE, at: '2026-10-01', home })
    const text = JSON.stringify(exportPersonal(await loadPersonal(home)))
    assert.match(text, /migrations-have-a-down/)
    assert.match(text, /"repos":2/)
    for (const leak of [repoA, repoB, 'caselaw-personal-a', tmpdir()]) assert.ok(!text.includes(leak), `leaks ${leak}`)
  })
})

describe('on the next install', () => {
  const P = { id: 'P:migrations-have-a-down', ...RULE, repos: 2, last: '2026-10-09' }

  test('POSITIVE CONTROL: the defaults screen lists it after the six; accepted, it is built from the snapshot in the answers, not from the owner\'s home', async () => {
    const q = QUESTIONS.find((x) => x.id === 'harness.defaults')
    const options = optionsFor(q, { detected: { personal: [P] }, answers: {} })
    assert.deepEqual(options.map((o) => o.value).slice(-2), ['D6', 'P:migrations-have-a-down'])
    assert.match(options.at(-1).label, /yours, caught in 2 of your repositories/)

    const doc = emptyAnswers({ templateVersion: '1.2', project: { name: 'P' } })
    doc.answers['harness.defaults'] = ['D1', P.id]
    doc.harness = { since: '2026-10-31', personal: { [P.name]: { name: P.name, trigger: P.trigger, rule: P.rule, repos: 2, last: P.last } } }
    const artifacts = await buildArtifacts({ doc, detected: { agentConfig: { claudeMd: true }, commands: {}, deploySurface: [] } })
    const body = artifacts.find((a) => a.path === 'docs/rules/active/migrations-have-a-down.md')?.body
    assert.ok(body, 'installed into active/')
    assert.match(body, /\*\*Precedent:\*\* it caught failures in 2 of this owner's other repositories, recorded on their machine by caselaw, the last on 2026-10-09/)
    assert.match(body, /\*\*Enforcement:\*\* memory/)
    assert.match(body, /\*\*Default:\*\* personal, active since 2026-10-31/)
    assert.deepEqual(validateRule(parseRule(body), { filename: 'migrations-have-a-down.md', resolveRef: false }).problems, [])

    const lost = { ...doc, harness: { since: '2026-10-31' } }
    assert.ok(!(await buildArtifacts({ doc: lost, detected: {} })).some((a) => a.path.endsWith('migrations-have-a-down.md')), 'no snapshot, no file: the build never reads the home folder')
  })

  test('a personal default names no other repository', () => {
    const body = personalRuleBody({ ...P }, { since: '2026-10-31', days: 60 })
    assert.doesNotMatch(body, /caselaw-personal-|\/tmp|\/Users\//)
  })
})

describe('at the command line', () => {
  const CLI = fileURLToPath(new URL('../../bin/cli.mjs', import.meta.url))
  const run = (args, cwd) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, CASELAW_HOME: home, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ code, out }))
    child.stdin.end('')
  })

  test('POSITIVE CONTROL: `rule catch` in two repositories records it, says so, and `personal list` shows it offered', async () => {
    for (const root of [repoA, repoB]) {
      await mkdir(join(root, 'docs/rules/active'), { recursive: true })
      await mkdir(join(root, '.caselaw'), { recursive: true })
      await writeFile(join(root, '.caselaw/answers.json'), JSON.stringify(emptyAnswers({ templateVersion: '1.2', project: { name: 'P' } })))
      await writeFile(join(root, 'docs/rules/active/migrations-have-a-down.md'), `# migrations-have-a-down\n\n**Trigger:** ${RULE.trigger}\n\n**Rule:** ${RULE.rule}\n\n**Origin:** commit abc1234\n\n**Enforcement:** memory\n`)
    }
    const first = await run(['rule', 'catch', 'migrations-have-a-down', '--what', 'commit def5678: a migration with no down'], repoA)
    assert.equal(first.code, 0, first.out)
    assert.doesNotMatch(first.out, /personal default/)
    const second = await run(['rule', 'catch', 'migrations-have-a-down', '--what', 'issue #3: the same, elsewhere'], repoB)
    assert.match(second.out, /caught failures in 2 of your repositories: your next `caselaw init` offers it as a personal default/)
    const list = await run(['personal', 'list'], repoA)
    assert.match(list.out, /migrations-have-a-down: 2 catch\(es\) in 2 repositories .* offered as a personal default/)
    assert.match(await readFile(join(home, 'personal.json'), 'utf8'), /"version": 1/)
  })
})
