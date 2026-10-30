/**
 * Round 2 of the DEF-274 re-score: the repository's own instructions, the
 * conditions CI runs its gates under, and the project's pull-request checklist.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectInstructions, globRegex } from '../../src/detect/instructions.js'
import { runContext } from '../../src/detect/ci-gates.js'
import { generate as generateAuthoritySplit } from '../../src/generate/authority-split.js'
import { generate as generateCloseOut } from '../../src/generate/close-out.js'

let root
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'caselaw-instr-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function put(rel, content) {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}

const NOW = new Date('2026-10-31')
const HOMEBRIDGE_PUBLISHING = [{
  file: '.github/workflows/release.yml', triggers: ['pushing to a branch matching `beta-*.*.*`'],
  publishes: [{ what: 'npm', line: 121, when: ['pushing to a branch matching `beta-*.*.*`'], conditions: [], branches: ['beta-*.*.*'] }],
}]

describe('the repository\'s own instructions', () => {
  test('POSITIVE CONTROL: homebridge\'s CLAUDE.md names a beta branch, and a push there publishes to npm; the authority split says so', async () => {
    await put('CLAUDE.md', '# Homebridge\n\n- PRs target the lowest existing `beta-{major}.{minor}.{patch}` branch matching the bump.\n')
    await put('.github/copilot-instructions.md', 'New beta branches are named beta-1.11.1 or beta-2.0.0, and so on.\n')
    const { instructions } = await detectInstructions(root, { files: ['CLAUDE.md', '.github/copilot-instructions.md'] }, HOMEBRIDGE_PUBLISHING)
    assert.deepEqual(instructions.files.map((f) => f.path), ['CLAUDE.md', '.github/copilot-instructions.md'])
    assert.deepEqual(instructions.mentions.map((m) => [m.path, m.line, m.said]), [
      ['CLAUDE.md', 3, 'beta-{major}.{minor}.{patch}'], ['.github/copilot-instructions.md', 1, 'beta-1.11.1'],
    ])
    const { content } = await generateAuthoritySplit({ answers: {}, detected: { instructions, publishing: HOMEBRIDGE_PUBLISHING }, projectName: 'P', now: NOW })
    assert.match(content, /This repository already tells agents how to work here, in `CLAUDE\.md`, `\.github\/copilot-instructions\.md`\. Read those first/)
    assert.match(content, /- `CLAUDE\.md:3` names `beta-\{major\}\.\{minor\}\.\{patch\}`: a push to that branch publishes to npm \(`\.github\/workflows\/release\.yml:121`\)\./)
  })

  test('caselaw\'s own pointer block is not the repository\'s instructions', async () => {
    await put('CLAUDE.md', '<!-- caselaw:begin id=pointer v=1 hash=x -->\n## How work is done here\n<!-- caselaw:end id=pointer -->\n')
    const { instructions } = await detectInstructions(root, { files: ['CLAUDE.md'] }, [])
    assert.deepEqual(instructions.files, [])
  })

  test('an AI policy is named as one', async () => {
    await put('docs/ai-policy.md', '# AI policy\n')
    const { instructions } = await detectInstructions(root, { files: ['docs/ai-policy.md'] }, [])
    assert.deepEqual(instructions.files, [{ path: 'docs/ai-policy.md', kind: 'AI policy' }])
  })

  test('a branch glob matches real names and templates, not inside other words', () => {
    const re = globRegex('beta-*.*.*')
    assert.ok(re.test('target beta-1.11.1 first'))
    assert.ok(re.test('`beta-{major}.{minor}.{patch}`'))
    assert.ok(!re.test('alphabeta-1.2.3'))
  })
})

describe('the conditions CI runs its gates under', () => {
  test('POSITIVE CONTROL: ntfy\'s Postgres service and S3 secret, and pyvisa\'s matrix, become caveats on the gates', async () => {
    const ntfy = runContext('jobs:\n  test:\n    services:\n      postgres:\n        image: postgres:17\n    env:\n      S3: ${{ secrets.NTFY_TEST_S3_URL }}\n      CC: ${{ secrets.CODECOV_TOKEN }}\n')
    assert.deepEqual(ntfy, { services: ['postgres'], secrets: ['NTFY_TEST_S3_URL'], matrix: [] }, 'a coverage token is not a test secret')
    const pyvisa = runContext('jobs:\n  tests:\n    strategy:\n      matrix:\n        os: [ubuntu-latest, windows-latest, macos-latest]\n        python-version: ["3.10", "3.11", "3.12", "3.13", "3.14"]\n')
    assert.deepEqual(pyvisa.matrix, [{ key: 'os', count: 3 }, { key: 'python-version', count: 5 }])
    const gates = [{ file: '.github/workflows/test.yaml', cmd: 'make checkv', line: 47 }]
    const { content } = await generateAuthoritySplit({ answers: {}, detected: { ciGates: { gates, shared: [], contexts: [{ file: '.github/workflows/test.yaml', ...ntfy }, ] } }, projectName: 'P', now: NOW })
    assert.match(content, /CI runs them with a postgres service and the secret `NTFY_TEST_S3_URL`; a test that needs one may skip itself here, so a pass here is not CI's pass\./)
    const py = await generateAuthoritySplit({ answers: {}, detected: { ciGates: { gates: [{ file: 'ci.yml', cmd: 'pytest', line: 1 }], shared: [], contexts: [{ file: 'ci.yml', ...pyvisa }] } }, projectName: 'P', now: NOW })
    assert.match(py.content, /CI runs them across 3 os × 5 python-version; a run here covers one combination\./)
  })
})

describe('the project\'s pull-request checklist', () => {
  test('POSITIVE CONTROL: pyvisa\'s template items, the CHANGES entry among them, are in the close-out', async () => {
    await put('.github/PULL_REQUEST_TEMPLATE.md', '- [ ] Closes # (insert issue number if relevant)\n- [ ] Executed ``ruff check . && ruff format -c . --check`` with no errors\n- [ ] Added an entry to the CHANGES file\n')
    const { instructions } = await detectInstructions(root, { files: ['.github/PULL_REQUEST_TEMPLATE.md'] }, [])
    assert.deepEqual(instructions.prChecklist.items, ['Closes #', 'Executed `ruff check . && ruff format -c . --check` with no errors', 'Added an entry to the CHANGES file'])
    const { content } = await generateCloseOut({ answers: {}, detected: { instructions }, projectName: 'P' })
    assert.match(content, /This project's own pull-request checklist \(`\.github\/PULL_REQUEST_TEMPLATE\.md`\):\n\n- \[ \] Closes #\n- \[ \] Executed `ruff check \. && ruff format -c \. --check` with no errors\n- \[ \] Added an entry to the CHANGES file/)
  })
})
