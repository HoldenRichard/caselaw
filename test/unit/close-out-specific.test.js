/**
 * The close-out carries the project (the DEF-274 re-score found it identical
 * across ntfy, homebridge and pyvisa): the gates CI runs, how a human proves a
 * change here, and which pushes publish.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { generate as generateCloseOut } from '../../src/generate/close-out.js'

const PYVISA = {
  answers: { 'authority.human_proof': 'Query a real instrument over VISA with the change applied.' },
  detected: {
    ciGates: { gates: [{ file: '.github/workflows/ci.yml', line: 34, cmd: 'ruff format pyvisa --check' }, { file: '.github/workflows/ci.yml', line: 42, cmd: 'mypy pyvisa' }], shared: [] },
    publishing: [{ file: '.github/workflows/release.yml', triggers: ['pushing a tag matching `*`'], publishes: [{ what: 'PyPI', line: 84 }] }],
  },
  projectName: 'PyVISA',
}

describe('the close-out carries the project', () => {
  test('POSITIVE CONTROL: the gates CI runs, the human proof, and what a push publishes are all in it', async () => {
    const { content } = await generateCloseOut(PYVISA)
    assert.match(content, /The gates CI runs on a change, in its order[\s\S]*- \[ \] `ruff format pyvisa --check`\n- \[ \] `mypy pyvisa`/)
    assert.match(content, /How a human proves a change here: Query a real instrument over VISA with the change applied\./)
    assert.match(content, /## Published\?[\s\S]*- \[ \] pushing a tag matching `\*` — publishes to PyPI \(`\.github\/workflows\/release\.yml:84`\)/)
    assert.match(content, /"ruff format pyvisa --check — agent — 41 passed/, 'the worked example is the project\'s first gate')
  })

  test('with nothing detected or answered, none of the three sections appear', async () => {
    const { content } = await generateCloseOut({ answers: {}, detected: {}, projectName: 'P' })
    assert.doesNotMatch(content, /The gates CI runs|How a human proves|## Published\?/)
  })
})
