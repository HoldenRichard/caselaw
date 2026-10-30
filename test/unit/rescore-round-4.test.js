/**
 * Round 4 of the DEF-274 re-score: gates that run on a clean machine, a
 * checklist item read at a glance, the registry by name, the announcements a
 * publish makes, the builds and CI that live outside GitHub Actions, and a
 * drafted boundary that CI contradicts.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectCiGates, runSteps, setupSteps } from '../../src/detect/ci-gates.js'
import { detectPublishing, publishSteps } from '../../src/detect/publishing.js'
import { generate as generateAuthoritySplit, outsideLabel } from '../../src/generate/authority-split.js'
import { generate as generateCloseOut } from '../../src/generate/close-out.js'
import { draftDoubts } from '../../src/interview/draft.js'

let root
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'caselaw-r4-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function put(rel, content) {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}

const NOW = new Date('2026-10-30')

// ntfy's build.yaml, cut down: two jobs that run separately, each setting up first.
const NTFY_BUILD = `name: build
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install dependencies
        run: make build-deps-ubuntu
      - name: Build all the things
        run: make build
  docker-build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build Dockerfile-build
        run: docker build --file Dockerfile-build --tag ntfy-build .
`

describe('gates that run on a clean machine', () => {
  test('POSITIVE CONTROL: ntfy\'s setup is named, and its two jobs are not read as one sequence', async () => {
    assert.deepEqual(setupSteps(NTFY_BUILD).map((s) => [s.cmd, s.line]), [['make build-deps-ubuntu', 9]])
    assert.deepEqual(runSteps(NTFY_BUILD).map((g) => g.cmd), ['make build', 'docker build --file Dockerfile-build --tag ntfy-build .'], 'setup is still not a gate')

    await put('.github/workflows/build.yaml', NTFY_BUILD)
    const { ciGates } = await detectCiGates(root, { files: ['.github/workflows/build.yaml'] })
    assert.deepEqual(ciGates.setup.map((s) => [s.cmd, s.job]), [['make build-deps-ubuntu', 'build']])

    const { content } = await generateAuthoritySplit({ answers: {}, detected: { ciGates }, projectName: 'P', now: NOW })
    assert.match(content, /- Run what CI runs on a change, in its order \(`\.github\/workflows\/build\.yaml`, job `build`\): `make build` \(Build all the things\)\. CI sets up first with `make build-deps-ubuntu` \(line 9\); a clean machine needs that too\./)
    assert.match(content, /- Run what CI runs on a change, in its order \(`\.github\/workflows\/build\.yaml`, job `docker-build`\): `docker build/)
    assert.doesNotMatch(content, /job `docker-build`\):[^\n]*build-deps-ubuntu/, 'setup belongs to the job that runs it')

    const close = await generateCloseOut({ answers: {}, detected: { ciGates }, projectName: 'P' })
    assert.match(close.content, /The gates CI runs on a change, job by job, each job in its own order\./)
    assert.match(close.content, /CI sets up first with `make build-deps-ubuntu`; a clean machine needs\nthat too\./)
  })

  test('one job keeps the plain wording', async () => {
    const gates = [{ file: 'ci.yml', cmd: 'make test', line: 5, job: 'test' }, { file: 'ci.yml', cmd: 'make lint', line: 6, job: 'test' }]
    const { content } = await generateAuthoritySplit({ answers: {}, detected: { ciGates: { gates } }, projectName: 'P', now: NOW })
    assert.match(content, /in its order \(`ci\.yml`\): `make test`; `make lint`\./)
    const close = await generateCloseOut({ answers: {}, detected: { ciGates: { gates } }, projectName: 'P' })
    assert.match(close.content, /The gates CI runs on a change, in its order\./)
  })
})

describe('a Published? item read at a glance', () => {
  const publishing = (cond) => [{ file: '.github/workflows/release.yml', triggers: ['publishing a GitHub release'], publishes: [{ what: 'npm', line: 121, when: ['publishing a GitHub release'], conditions: [cond], branches: [] }] }]

  test('POSITIVE CONTROL: homebridge\'s long job condition is pointed to, not pasted; the split still quotes it', async () => {
    const long = `\`always() && ${'needs.x.result == \'success\' && '.repeat(12)}true\` (line 74)`
    const close = await generateCloseOut({ answers: {}, detected: { publishing: publishing(long) }, projectName: 'P' })
    assert.match(close.content, /publishes to npm \(`\.github\/workflows\/release\.yml:121`\), only under the conditions quoted in full in the authority split/)
    assert.doesNotMatch(close.content, /always\(\)/)
    const split = await generateAuthoritySplit({ answers: {}, detected: { publishing: publishing(long) }, projectName: 'P', now: NOW })
    assert.match(split.content, /always\(\) && needs\.x/)
  })

  test('a short condition stays inline', async () => {
    const close = await generateCloseOut({ answers: {}, detected: { publishing: publishing("`github.repository == 'o/r'` (line 28)") }, projectName: 'P' })
    assert.match(close.content, /, only if `github\.repository == 'o\/r'` \(line 28\)/)
  })
})

describe('the registry by name', () => {
  test('POSITIVE CONTROL: homebridge\'s registry policy names npm', async () => {
    const detected = { publishing: [{ file: 'r.yml', publishes: [{ what: 'npm', line: 1 }] }] }
    assert.equal(outsideLabel('registry-policy', detected), 'the package registry\'s policies (npm)')
    assert.equal(outsideLabel('registry-policy', { signals: { registries: [{ kind: 'pypi' }, { kind: 'goreleaser' }] } }), 'the package registry\'s policies (PyPI)')
    assert.equal(outsideLabel('registry-policy', {}), 'the package registry\'s policies', 'nothing named, nothing guessed')
    const { content } = await generateAuthoritySplit({ answers: { 'outside.authority': ['registry-policy'] }, detected, projectName: 'P', now: NOW })
    assert.match(content, /- \*\*the package registry's policies \(npm\)\*\*/)
  })
})

describe('the announcements a publish makes', () => {
  const HOMEBRIDGE_RELEASE = `on:
  release:
    types: [published]
jobs:
  publish-to-npm:
    runs-on: ubuntu-latest
    steps:
      - run: npm publish
  github-releases-to-discord:
    needs: [publish-to-npm]
    uses: homebridge/.github/.github/workflows/discord-webhooks.yml@latest
    secrets:
      DISCORD_WEBHOOK: \${{ secrets.DISCORD_WEBHOOK_URL_LATEST }}
`
  test('POSITIVE CONTROL: homebridge\'s Discord post is a publish', () => {
    assert.deepEqual(publishSteps(HOMEBRIDGE_RELEASE), [
      { what: 'npm', line: 8 },
      { what: 'a Discord channel (a webhook post)', line: 11, announce: true },
    ])
  })

  test('POSITIVE CONTROL: a test workflow that posts to Slack keeps its gates', async () => {
    await put('.github/workflows/test.yml', `on: [pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: make test
      - uses: slackapi/slack-github-action@v1
`)
    const { ciGates } = await detectCiGates(root, { files: ['.github/workflows/test.yml'] })
    assert.deepEqual(ciGates.gates.map((g) => g.cmd), ['make test'])
  })
})

describe('what lives outside GitHub Actions', () => {
  test('POSITIVE CONTROL: pyvisa\'s Read the Docs build is a publisher, and its Azure pipeline is said to be unread', async () => {
    await put('.readthedocs.yaml', 'version: 2\n')
    await put('azure-pipelines.yml', 'steps:\n  - script: conda create -n test_ python=3.9\n')
    const files = ['.readthedocs.yaml', 'azure-pipelines.yml']
    const { publishing } = await detectPublishing(root, { files })
    assert.deepEqual(publishing.map((p) => [p.file, p.publishes[0].what]), [['.readthedocs.yaml', 'Read the Docs (the documentation site)']])
    const { ciGates } = await detectCiGates(root, { files })
    assert.deepEqual(ciGates.unread, [{ file: 'azure-pipelines.yml', system: 'Azure Pipelines' }])

    const { content } = await generateAuthoritySplit({ answers: {}, detected: { publishing, ciGates }, projectName: 'P', now: NOW })
    assert.match(content, /\*\*Read the Docs \(the documentation site\)\*\* \(`\.readthedocs\.yaml:1`\): when the pushes its project settings on readthedocs\.org select \(they are not in this repository\)\./)
    assert.match(content, /CI also runs in Azure Pipelines \(`azure-pipelines\.yml`\), which caselaw does not read: its gates, and anything it publishes, are not listed in this file\./)
  })
})

describe('a drafted boundary that CI contradicts', () => {
  const draft = (cannot) => ({ questions: [{ id: 'authority.cannot', answer: cannot }] })
  const ciGates = { gates: [{ file: '.github/workflows/ci.yml', cmd: 'python -X dev -m pytest --pyargs pyvisa', line: 47, job: 'tests' }] }

  test('POSITIVE CONTROL: pyvisa\'s "full test suite" boundary is questioned, because CI runs pytest on every change', () => {
    const doubts = draftDoubts(draft(['hardware', 'full-suite']), { ciGates })
    assert.equal(doubts.length, 1)
    assert.match(doubts[0], /CI runs `python -X dev -m pytest --pyargs pyvisa` on every change \(`\.github\/workflows\/ci\.yml:47`\)\. If only part of the suite cannot run here, name that part/)
  })

  test('no doubt without the boundary, or without a test runner in CI', () => {
    assert.deepEqual(draftDoubts(draft(['hardware']), { ciGates }), [])
    assert.deepEqual(draftDoubts(draft(['full-suite']), { ciGates: { gates: [{ file: 'ci.yml', cmd: 'ruff check pyvisa', line: 3 }] } }), [])
  })
})

describe('round 4, from the regenerated documents', () => {
  test('POSITIVE CONTROL: a step after the job\'s first gate is not setup (ntfy\'s "Print build results")', async () => {
    await put('.github/workflows/build.yaml', `${NTFY_BUILD.split('  docker-build:')[0]}      - name: Print build results and checksums
        run: make cli-build-results
`)
    const { ciGates } = await detectCiGates(root, { files: ['.github/workflows/build.yaml'] })
    assert.deepEqual(ciGates.setup.map((s) => s.cmd), ['make build-deps-ubuntu'])
  })

  test('POSITIVE CONTROL: an event alone on its line is read (homebridge\'s wiki notification), and so is the list form', async () => {
    await put('.github/workflows/wiki.yml', 'on:\n  gollum\n\njobs:\n  notify:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: oznu/gh-wiki-edit-discord-notification@main\n        with:\n          discord-webhook-url: ${{ secrets.DISCORD_WEBHOOK_WIKI_EDIT }}\n')
    await put('.github/workflows/list.yml', 'on:\n  - push\n  - pull_request\njobs:\n  p:\n    steps:\n      - run: npm publish\n')
    const { publishing } = await detectPublishing(root, { files: ['.github/workflows/list.yml', '.github/workflows/wiki.yml'] })
    assert.deepEqual(publishing.map((p) => [p.file, p.publishes[0].what, p.publishes[0].when]), [
      ['.github/workflows/list.yml', 'npm', ['any push', 'the `pull_request` event']],
      ['.github/workflows/wiki.yml', 'a Discord channel (a webhook post)', ['an edit to the repository\'s wiki']],
    ])
  })
})
