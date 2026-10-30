/**
 * What a push publishes (the DEF-274 re-score, 2026-10-30): on all three
 * repositories, git started the release, and the generated docs said only
 * "release console: chosen". These are the three real shapes.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectPublishing, workflowTriggers, workflowEvents, publishSteps, jobsOf, whenStepRuns } from '../../src/detect/publishing.js'
import { generate as generateAuthoritySplit } from '../../src/generate/authority-split.js'

// As pyvisa has it: the workflow starts three ways, but only a push reaches
// the publish job, and the release job needs that one (round 2 of the re-score).
const PYVISA = `name: Build and publish
on:
  workflow_dispatch:
  schedule:
    - cron: "0 0 * * 3"
  push:
    tags:
      - "*"

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: python -m build
  publish:
    if: github.event_name == 'push'
    needs: [build]
    steps:
      # npm publish is not used here
      - uses: pypa/gh-action-pypi-publish@release/v1
  github-release:
    needs:
      - publish
    steps:
      - run: |
          gh release create
`

const HOMEBRIDGE = `on:
  release:
    types: [released]
  push:
    branches:
      - beta-*.*.*
      - alpha-*.*.*

jobs:
  publish:
    steps:
      - run: npm publish --tag beta --provenance --access public
`

const NTFY = `name: release
on:
  push:
    tags:
      - 'v[0-9]+.[0-9]+.[0-9]+'
jobs:
  release:
    steps:
      - name: Build and publish
        run: make release
`

describe('which events start a workflow', () => {
  test('pyvisa: by hand, on a schedule, or on any tag', () => {
    assert.deepEqual(workflowTriggers(PYVISA), ['running the workflow by hand', 'a schedule', 'pushing a tag matching `*`'])
  })

  test('homebridge: a published release, or a push to a beta or alpha branch', () => {
    assert.deepEqual(workflowTriggers(HOMEBRIDGE), [
      'publishing a GitHub release (released)', 'pushing to a branch matching `beta-*.*.*`', 'pushing to a branch matching `alpha-*.*.*`',
    ])
  })

  test('inline forms, an unfiltered push, and an unreadable file', () => {
    assert.deepEqual(workflowTriggers('on: [push, workflow_dispatch]\njobs: {}\n'), ['any push', 'running the workflow by hand'])
    assert.deepEqual(workflowTriggers('on: push\n'), ['any push'])
    assert.equal(workflowTriggers('jobs:\n  a: {}\n'), null, 'unknown is said, never guessed')
  })
})

describe('which steps publish', () => {
  test('each destination once, at its first line; commented lines do not count', () => {
    assert.deepEqual(publishSteps(PYVISA), [{ what: 'PyPI', line: 20 }, { what: 'a GitHub release', line: 26 }])
    assert.deepEqual(publishSteps(NTFY), [{ what: 'the Makefile\'s release target', line: 10 }])
  })

  test('a workflow that publishes nothing is not reported', () => {
    assert.deepEqual(publishSteps('on: push\njobs:\n  t:\n    steps:\n      - run: npm test\n'), [])
  })
})

describe('the authority split says what a push publishes', () => {
  let root
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'caselaw-publish-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  test('POSITIVE CONTROL: PyPI is published only on a tag push, and the scheduled and manual runs are said not to reach it', async () => {
    await mkdir(join(root, '.github/workflows'), { recursive: true })
    await writeFile(join(root, '.github/workflows/release.yml'), PYVISA)
    await writeFile(join(root, '.github/workflows/ci.yml'), 'on: push\njobs:\n  t:\n    steps:\n      - run: pytest\n')
    const { publishing } = await detectPublishing(root, { files: ['.github/workflows/ci.yml', '.github/workflows/release.yml'] })
    assert.equal(publishing.length, 1, 'only the workflow that publishes')
    const { content } = await generateAuthoritySplit({ answers: {}, detected: { publishing }, projectName: 'P', now: new Date('2026-10-30') })
    assert.match(content, /## What a push can publish/)
    assert.match(content, /- \*\*PyPI\*\* \(`\.github\/workflows\/release\.yml:20`\): when pushing a tag matching `\*`\. The workflow also starts on running the workflow by hand, a schedule; those runs do not reach this step\./)
    assert.match(content, /- \*\*a GitHub release\*\* \(`\.github\/workflows\/release\.yml:26`\): when pushing a tag matching `\*`\./, 'the release job needs the publish job, and inherits its condition')
    assert.match(content, /the agent may prepare it, and a human does it/)
  })

  test('a condition that is not an event is quoted back, never interpreted', () => {
    const wf = `on:\n  push:\n    branches: [beta-*]\njobs:\n  tag:\n    if: \${{ github.repository == 'org/repo' }}\n    steps: []\n  publish:\n    needs: tag\n    if: |\n      always() &&\n      needs.tag.outputs.t != 'none'\n    steps:\n      - run: npm publish\n`
    const r = whenStepRuns(workflowEvents(wf), jobsOf(wf), 14)
    assert.deepEqual(r.when, ['pushing to a branch matching `beta-*`'])
    assert.deepEqual(r.conditions, ["`always() && needs.tag.outputs.t != 'none'` (line 10)", "`github.repository == 'org/repo'` (line 6)"])
  })

  test('nothing publishes, no section', async () => {
    const { content } = await generateAuthoritySplit({ answers: {}, detected: { publishing: [] }, projectName: 'P', now: new Date('2026-10-30') })
    assert.doesNotMatch(content, /What a push can publish/)
  })
})
