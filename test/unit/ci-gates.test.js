/**
 * The gates CI runs on a change (the DEF-274 re-score, 2026-10-30): ntfy's
 * inferred `go test ./...` failed on a fresh checkout while its CI built the
 * docs and web app first; pyvisa's CI checks the package directory, not the
 * tree; homebridge's gates live in another repository.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { runSteps, runsOnChange, sharedWorkflows } from '../../src/detect/ci-gates.js'
import { generate as generateAuthoritySplit } from '../../src/generate/authority-split.js'

const PYVISA_CI = `name: Continuous Integration
on:
  schedule:
    - cron: "0 0 * * 2"
  push:
    branches:
      - main
  pull_request:
jobs:
  formatting:
    steps:
      - uses: actions/checkout@v6
      - name: Install tools
        run: |
          python -m pip install --upgrade pip
          pip install ruff mypy pytest numpy
      - name: Formatting
        run: |
          ruff format pyvisa --check;
      - name: typing
        if: always()
        run: |
          mypy pyvisa;
  tests:
    steps:
      - name: Test with pytest
        run: |
          pip install pytest-cov
          python -X dev -m pytest --pyargs pyvisa --cov --cov-report xml -v
`

const NTFY_TEST = `name: test
on: [ push, pull_request ]
jobs:
  test:
    steps:
      - name: Install dependencies
        run: make build-deps-ubuntu
      - name: Build docs (required for tests)
        run: make docs
      - name: Run tests, formatting, vetting and linting
        run: make checkv
`

const HOMEBRIDGE_BUILD = `on:
  push:
    branches: [latest]
  pull_request:
jobs:
  build_and_test:
    uses: homebridge/.github/.github/workflows/nodejs-build-and-test.yml@latest
  labeler:
    uses: homebridge/.github/.github/workflows/labeler.yml@latest
`

describe('the gates CI runs', () => {
  test('pyvisa: the format, type and test gates in order, with their steps; installs are setup, not gates', () => {
    assert.deepEqual(runSteps(PYVISA_CI).map(({ cmd, step }) => [cmd, step]), [
      ['ruff format pyvisa --check', 'Formatting'],
      ['mypy pyvisa', 'typing'],
      ['python -X dev -m pytest --pyargs pyvisa --cov --cov-report xml -v', 'Test with pytest'],
    ])
  })

  test('ntfy: a step named for installing is setup, whatever it runs', () => {
    assert.deepEqual(runSteps(NTFY_TEST).map((g) => g.cmd), ['make docs', 'make checkv'])
  })

  test('a workflow that runs only on tags is a release, not a gate; one on pull requests is', () => {
    assert.equal(runsOnChange('on:\n  push:\n    tags:\n      - "v*"\n'), false)
    assert.equal(runsOnChange(PYVISA_CI), true)
    assert.equal(runsOnChange(NTFY_TEST), true)
  })

  test('homebridge: a gate kept in another repository is named; a labeler is not a gate', () => {
    assert.deepEqual(sharedWorkflows(HOMEBRIDGE_BUILD).map((s) => s.uses), ['homebridge/.github/.github/workflows/nodejs-build-and-test.yml@latest'])
  })
})

describe('the authority split lists the gates, not a guess', () => {
  const gates = runSteps(NTFY_TEST).map((g) => ({ file: '.github/workflows/test.yaml', ...g }))
  const inferred = { test: { cmd: 'go test ./...' }, lint: { cmd: 'go vet ./...' } }

  test('POSITIVE CONTROL: with CI gates found, the inferred `go test ./...` is not offered', async () => {
    const { content } = await generateAuthoritySplit({ answers: {}, detected: { ciGates: { gates, shared: [] }, commands: inferred }, projectName: 'P', now: new Date('2026-10-30') })
    assert.match(content, /Run what CI runs on a change, in its order \(`\.github\/workflows\/test\.yaml`\): `make docs` \(Build docs \(required for tests\)\); `make checkv`/)
    assert.doesNotMatch(content, /go test \.\/\.\.\./)
  })

  test('with no CI, the inferred commands remain, marked unverified', async () => {
    const { content } = await generateAuthoritySplit({ answers: {}, detected: { ciGates: { gates: [], shared: [] }, commands: inferred }, projectName: 'P', now: new Date('2026-10-30') })
    assert.match(content, /test \(`go test \.\/\.\.\.`, unverified\)/)
  })

  test('shared workflows are said to be invisible from here', async () => {
    const { content } = await generateAuthoritySplit({ answers: {}, detected: { ciGates: { gates: [], shared: [{ uses: 'org/.github/.github/workflows/test.yml@v1' }] } }, projectName: 'P', now: new Date('2026-10-30') })
    assert.match(content, /kept in another repository, whose steps are not visible here: `org\/\.github\/\.github\/workflows\/test\.yml@v1`/)
  })
})
