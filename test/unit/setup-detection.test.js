/**
 * Detection an agent can set up from without asking (0.5.0). The 0.4.2 field
 * tests on itsdangerous (uv + tox + flit), pflag (Go), and reprompt (a Swift
 * app) each found commands the project does not run, a CI expression listed as
 * a command, a local gate missed, and a store reviewer named without a store.
 * These are the three real shapes.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detect } from '../../src/detect/index.js'
import { walk } from '../../src/detect/stack.js'
import { slotOfCommand, toxEnvs, noxSessions, pythonRunner, wrapRunner } from '../../src/detect/commands.js'
import { runSteps, isVersionProbe } from '../../src/detect/ci-gates.js'
import { detectLocalGates } from '../../src/detect/local-gates.js'
import { detectPublishing } from '../../src/detect/publishing.js'
import { storeDistribution } from '../../src/detect/signals.js'
import { gatekeeperCandidates } from '../../src/interview/questions.js'

const OFFLINE = { gh: false, xcode: false, timeoutMs: 8000 }

let root
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'caselaw-setup-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function put(rel, content = '') {
  const abs = join(root, rel)
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, content, 'utf8')
}

// itsdangerous: CI runs tox with an expression only the runner can fill in.
const ITSDANGEROUS_CI = `name: Tests
on:
  push:
    branches: [main]
  pull_request:
jobs:
  tests:
    name: \${{ matrix.name || matrix.python }}
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - {python: '3.14'}
          - {name: Typing, python: '3.14', tox: typing}
    steps:
      - uses: actions/checkout@v6
      - uses: astral-sh/setup-uv@v7
      - run: uv run --locked tox run -e \${{ matrix.tox || format('py{0}', matrix.python) }}
`
const ITSDANGEROUS_PYPROJECT = `[project]
name = "itsdangerous"
requires-python = ">=3.10"

[dependency-groups]
dev = ["ruff", "tox", "tox-uv"]
tests = [
    "freezegun",
    "pytest",
]
typing = ["mypy", "pyright", "pytest"]

[build-system]
requires = ["flit_core<4"]
build-backend = "flit_core.buildapi"

[tool.uv]
default-groups = ["dev"]
`
const ITSDANGEROUS_TOX = `[tox]
envlist =
    py3{14,13,12,11,10}
    pypy311
    style
    typing
    docs
[testenv]
dependency_groups = tests
commands = pytest -v {posargs}
[testenv:style]
commands = pre-commit run --all-files
[testenv:typing]
dependency_groups = typing
commands = mypy
[testenv:docs]
commands = sphinx-build docs docs/_build
`

describe('Python: the project\'s own runners outrank the language default', () => {
  test('POSITIVE CONTROL: uv + tox + flit gives tox\'s envs through uv, uv build, and no raw CI expression', async () => {
    await put('.github/workflows/tests.yaml', ITSDANGEROUS_CI)
    await put('pyproject.toml', ITSDANGEROUS_PYPROJECT)
    await put('tox.ini', ITSDANGEROUS_TOX)
    await put('uv.lock', 'version = 1\n')
    const r = await detect(root, OFFLINE)
    assert.equal(r.commands.typecheck.cmd, 'uv run --locked tox -e typing', 'not `mypy .`: the project types through tox')
    assert.equal(r.commands.test.cmd, 'uv run --locked tox -e py')
    assert.equal(r.commands.lint.cmd, 'uv run --locked tox -e style')
    assert.equal(r.commands.build.cmd, 'uv build', 'not `python -m build`: the lock says uv')
    assert.match(r.commands.typecheck.source, /^tox\.ini:/)
    for (const c of Object.values(r.commands)) assert.doesNotMatch(c?.cmd ?? '', /\$\{\{/)
  })

  test('POSITIVE CONTROL: a command holding an expression CI fills in is dropped from the gates, reported, and never listed', async () => {
    await put('.github/workflows/tests.yaml', ITSDANGEROUS_CI)
    const r = await detect(root, OFFLINE)
    assert.deepEqual(r.ciGates.gates, [])
    assert.equal(r.ciGates.unresolved.length, 1)
    assert.match(r.ciGates.unresolved[0].expressions[0], /matrix\.tox/)
    assert.ok(r.warnings.some((w) => w.code === 'ci-expression-unresolved'))
  })

  test('a matrix key with exactly one value is substituted, and the gate says so', () => {
    const text = `on: push
jobs:
  test:
    strategy:
      matrix:
        python: ["3.12"]
    steps:
      - run: tox run -e py\${{ matrix.python }}
      - run: pytest \${{ matrix.other }}
`
    const gates = runSteps(text)
    assert.deepEqual(gates.map((g) => g.cmd), ['tox run -e py3.12'])
    assert.match(gates[0].note, /matrix\.python is "3\.12"/)
  })

  test('POSITIVE CONTROL: a matrix with several values, or an include list, is not guessed at', () => {
    const several = 'on: push\njobs:\n  t:\n    strategy:\n      matrix:\n        python: ["3.11", "3.12"]\n    steps:\n      - run: pytest --python \${{ matrix.python }}\n'
    assert.deepEqual(runSteps(several), [])
    const include = 'on: push\njobs:\n  t:\n    strategy:\n      matrix:\n        python: ["3.12"]\n        include:\n          - python: "3.13"\n    steps:\n      - run: pytest --python \${{ matrix.python }}\n'
    assert.deepEqual(runSteps(include), [])
  })

  test('uv: a tool in a non-default dependency group is run with --group; one in a default group is not', () => {
    const py = pythonRunner(new Set(['uv.lock']), ITSDANGEROUS_PYPROJECT)
    assert.equal(wrapRunner(py, 'pytest'), 'uv run --locked --group tests pytest')
    assert.equal(wrapRunner(py, 'ruff', 'check .'), 'uv run --locked ruff check .')
    assert.equal(wrapRunner(py, 'sphinx-build'), 'sphinx-build', 'a tool no group installs is left bare')
  })

  test('poetry.lock runs through poetry; no lockfile leaves the bare tool', () => {
    assert.equal(wrapRunner(pythonRunner(new Set(['poetry.lock']), ''), 'mypy', '.'), 'poetry run mypy .')
    assert.equal(wrapRunner(pythonRunner(new Set(), ''), 'mypy', '.'), 'mypy .')
  })

  test('pyproject sections go through the lockfile runner when no CI or task runner decides', async () => {
    await put('pyproject.toml', '[project]\nname = "x"\n[dependency-groups]\ndev = ["pytest", "mypy"]\n[tool.pytest.ini_options]\naddopts = "-q"\n[tool.mypy]\nstrict = true\n')
    await put('poetry.lock', '')
    const r = await detect(root, OFFLINE)
    assert.equal(r.commands.test.cmd, 'poetry run pytest')
    assert.equal(r.commands.typecheck.cmd, 'poetry run mypy .')
  })

  test('tox envs and nox sessions are read by the names projects give them', () => {
    assert.deepEqual(toxEnvs(ITSDANGEROUS_TOX).map((e) => e.name), ['style', 'typing', 'docs', 'pypy311'])
    assert.deepEqual(noxSessions('@nox.session(name="types")\ndef mypy_run(session):\n    pass\n\n@nox.session\ndef tests(session):\n    pass\n').map((s) => s.name), ['types', 'tests'])
  })

  test('slotOfCommand: tox/nox by env, chains and version probes are no slot', () => {
    assert.equal(slotOfCommand('uv run --locked tox run -e typing'), 'typecheck')
    assert.equal(slotOfCommand('tox -e py312'), 'test')
    assert.equal(slotOfCommand('nox -s lint'), 'lint')
    assert.equal(slotOfCommand('tox -e docs'), null)
    assert.equal(slotOfCommand('pytest && mypy .'), null)
    assert.equal(slotOfCommand('swift --version'), null)
  })
})

describe('Go: the flags and linter CI uses beat the language default', () => {
  const GO_CI = `name: build
on: [push, pull_request]
jobs:
  test:
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
      - run: go test -race -v ./...
  lint:
    steps:
      - uses: actions/checkout@v4
      - run: golangci-lint run ./...
`
  test('POSITIVE CONTROL: -race stays on the test command, and golangci-lint replaces go vet', async () => {
    await put('go.mod', 'module example.com/pflag\n\ngo 1.22\n')
    await put('.github/workflows/build.yml', GO_CI)
    const r = await detect(root, OFFLINE)
    assert.equal(r.commands.test.cmd, 'go test -race -v ./...')
    assert.equal(r.commands.lint.cmd, 'golangci-lint run ./...')
    assert.match(r.commands.test.source, /^\.github\/workflows\/build\.yml:\d+$/)
  })

  test('without CI, a golangci-lint config names the linter; with neither, go vet', async () => {
    await put('go.mod', 'module example.com/x\n')
    assert.equal((await detect(root, OFFLINE)).commands.lint.cmd, 'go vet ./...')
    await put('.golangci.yml', 'linters:\n  enable: [govet]\n')
    assert.equal((await detect(root, OFFLINE)).commands.lint.cmd, 'golangci-lint run')
  })

  test('a CI step that runs in a subdirectory says nothing about the root', async () => {
    await put('go.mod', 'module example.com/x\n')
    await put('.github/workflows/ci.yml', 'on: push\njobs:\n  t:\n    steps:\n      - run: go test ./...\n        working-directory: sub\n')
    assert.equal((await detect(root, OFFLINE)).commands.test.source, 'go.mod')
  })
})

describe('version probes are not verification commands', () => {
  test('POSITIVE CONTROL: swift --version and xcodebuild -version are dropped from the gates; swift test stays', () => {
    const text = 'on: push\njobs:\n  t:\n    steps:\n      - run: swift --version\n      - run: xcodebuild -version\n      - run: swift test\n'
    assert.deepEqual(runSteps(text).map((g) => g.cmd), ['swift test'])
  })

  test('isVersionProbe names version probes only; -v is verbose, not a version', () => {
    for (const c of ['swift --version', 'xcodebuild -version', 'python -V', 'go version', 'uv run python --version']) assert.ok(isVersionProbe(c), c)
    for (const c of ['go test -v ./...', 'pytest -v', 'swift test', 'tox -e py']) assert.ok(!isVersionProbe(c), c)
  })
})

describe('local gates: a hooks directory the repository wires with core.hooksPath', () => {
  const README = '# App\n\n## Development\n\nEnable the hooks once per clone:\n\n    git config core.hooksPath scripts/hooks\n'

  test('POSITIVE CONTROL: the documented scripts/hooks/pre-push is reported with where it was documented', async () => {
    await put('README.md', README)
    await put('scripts/hooks/pre-push', '#!/bin/sh\nxcodebuild test\n')
    const r = await detect(root, OFFLINE)
    assert.deepEqual(r.hooks.localGates.map((g) => ({ dir: g.dir, hooks: g.hooks, documentedIn: g.documentedIn })),
      [{ dir: 'scripts/hooks', hooks: ['pre-push'], documentedIn: 'README.md:7' }])
    assert.equal(r.hooks.localGates[0].wiring, 'git config core.hooksPath scripts/hooks')
    assert.ok(r.hooks.files.includes('scripts/hooks/pre-push'))
    assert.equal(r.hooks.framework, 'core.hooksPath')
  })

  test('a conventional hooks directory counts without a document; a random directory does not', async () => {
    await put('.githooks/pre-commit', '#!/bin/sh\n')
    await put('tools/pre-push', '#!/bin/sh\n')
    const gates = await detectLocalGates(root, await walk(root))
    assert.deepEqual(gates.map((g) => g.dir), ['.githooks'])
    assert.equal(gates[0].documentedIn, null)
  })

  test('the clone\'s own .git/config says whether the wiring is on', async () => {
    await put('README.md', README)
    await put('scripts/hooks/pre-push', '#!/bin/sh\n')
    assert.equal((await detectLocalGates(root, await walk(root)))[0].wired, null, 'no .git/config to read')
    await put('.git/config', '[core]\n\trepositoryformatversion = 0\n')
    assert.equal((await detectLocalGates(root, await walk(root)))[0].wired, false)
    await put('.git/config', '[core]\n\thooksPath = scripts/hooks\n')
    assert.equal((await detectLocalGates(root, await walk(root)))[0].wired, true)
  })

  test('POSITIVE CONTROL: a documented path outside the repository, or one with no gating hook, is not a gate', async () => {
    await put('README.md', 'git config core.hooksPath /etc/hooks\ngit config core.hooksPath tools/hooks\n')
    await put('tools/hooks/post-checkout', '#!/bin/sh\n')
    assert.deepEqual(await detectLocalGates(root, await walk(root)), [])
  })
})

describe('publishing: tag-based releases the repository documents or configures', () => {
  test('POSITIVE CONTROL: RELEASING.md that says to push a tag is a publishing surface', async () => {
    await put('RELEASING.md', '# Releasing\n\n1. Update the changelog.\n2. `git tag v1.2.3 && git push origin v1.2.3`\n')
    const { publishing } = await detectPublishing(root, await walk(root))
    assert.equal(publishing.length, 1)
    assert.equal(publishing[0].file, 'RELEASING.md')
    assert.match(publishing[0].publishes[0].what, /tagged release/)
    assert.equal(publishing[0].publishes[0].line, 4)
  })

  test('a release document with no tag in it is not a publishing surface', async () => {
    await put('RELEASING.md', '# Releasing\n\nAsk the maintainer.\n')
    assert.deepEqual((await detectPublishing(root, await walk(root))).publishing, [])
  })

  test('a workflow that already publishes on a tag push is not doubled by the document', async () => {
    await put('RELEASING.md', 'Push a tag to release.\n')
    await put('.github/workflows/release.yml', 'on:\n  push:\n    tags: ["v*"]\njobs:\n  r:\n    steps:\n      - run: npm publish\n')
    const { publishing } = await detectPublishing(root, await walk(root))
    assert.deepEqual(publishing.map((p) => p.file), ['.github/workflows/release.yml'])
  })

  test('POSITIVE CONTROL: a release workflow on a tag push is reported even when its publisher is unknown', async () => {
    await put('.github/workflows/release.yml', 'name: Release\non:\n  push:\n    tags: ["v*"]\njobs:\n  r:\n    steps:\n      - run: ./scripts/ship.sh\n')
    const { publishing, warnings } = await detectPublishing(root, await walk(root))
    assert.equal(publishing.length, 1)
    assert.equal(publishing[0].publishes[0].unread, true)
    assert.ok(warnings.some((w) => w.code === 'release-workflow-unread'))
  })

  test('a tag-triggered workflow not named for releasing is left alone', async () => {
    await put('.github/workflows/docs.yml', 'name: Docs\non:\n  push:\n    tags: ["v*"]\njobs:\n  r:\n    steps:\n      - run: make html\n')
    assert.deepEqual((await detectPublishing(root, await walk(root))).publishing, [])
  })

  test('a GoReleaser config no workflow runs is still a release', async () => {
    await put('.goreleaser.yml', 'builds:\n  - main: .\n')
    const { publishing } = await detectPublishing(root, await walk(root))
    assert.equal(publishing[0].file, '.goreleaser.yml')
    assert.match(publishing[0].publishes[0].what, /^GoReleaser/)
  })
})

describe('outside authority: an app store only on store evidence', () => {
  const read = (files) => async (f) => files[f] ?? null

  test('POSITIVE CONTROL: a Swift app with no lane, export, workflow or listing link is not offered App Review', async () => {
    await put('Package.swift', '// swift-tools-version:5.9\n')
    await put('README.md', '# Reprompt\n\nA macOS app. It is not on the App Store; build it yourself.\n')
    const r = await detect(root, OFFLINE)
    assert.deepEqual(r.signals.stores, [])
    assert.ok(!gatekeeperCandidates(r).some((o) => o.value === 'app-review'))
  })

  test('a fastlane deliver lane, an app-store export, or a store link in the README is store evidence', async () => {
    const found = await storeDistribution(
      ['fastlane/Fastfile', 'ios/ExportOptions.plist', 'README.md'],
      read({ 'fastlane/Fastfile': 'lane :beta do\n  upload_to_testflight\nend\n', 'ios/ExportOptions.plist': '<string>app-store-connect</string>', 'README.md': 'Get it: https://apps.apple.com/app/id1\n' }),
    )
    assert.deepEqual(found.map((f) => f.kind), ['app-store'])
    for (const [file, text] of Object.entries({ 'fastlane/Fastfile': 'upload_to_testflight', 'ios/ExportOptions.plist': '<string>app-store-connect</string>', 'README.md': 'https://apps.apple.com/app/id1' })) {
      assert.equal((await storeDistribution([file], read({ [file]: text })))[0]?.source, file, `${file} alone is evidence`)
    }
    assert.ok(gatekeeperCandidates({ signals: { stores: found } }).some((o) => o.value === 'app-review'))
  })

  test('Google Play evidence offers it too; a workflow that says "deliver" in prose does not', async () => {
    const play = await storeDistribution(['fastlane/Fastfile'], read({ 'fastlane/Fastfile': 'upload_to_play_store(track: "beta")' }))
    assert.deepEqual(play.map((f) => f.kind), ['play-store'])
    assert.ok(gatekeeperCandidates({ signals: { stores: play } }).some((o) => o.value === 'app-review'))
    assert.deepEqual(await storeDistribution(['.github/workflows/ci.yml'], read({ '.github/workflows/ci.yml': 'name: deliver results to the team\n' })), [])
  })
})
