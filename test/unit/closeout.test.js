/**
 * Unit tests for Close-Out & Scope Completeness Verifier (0.4 / CaseLaw).
 *
 * Verifies that verifyCloseout catches:
 * 1. POSITIVE CONTROL: Modifying a src/ file while omitting it from What Changed (Silent Scope Drop).
 * 2. POSITIVE CONTROL: Claiming a file was modified when it has zero git changes (Fabrication).
 * 3. POSITIVE CONTROL: Placing a failing command (exit code 127) inside ## Verified (Attestation Drift).
 * 4. POSITIVE CONTROL: Checking off [x] a human-only authority boundary (Authority Breach).
 * 5. Clean, honest close-out report passes verification.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { verifyCloseout, parseCloseout, gitChangedFiles } from '../../src/core/closeout.js'

const VALID_CLOSEOUT = `# Session close-out — caselaw

## What Changed

- \`src/core/optimizer.js\`: wired SkillOpt compression
- \`src/core/skillopt.js\`: added iterative optimization loop

## Verified

- npm run test — agent — 782 passed, 0 failed

## Not Verified — over to you

- [ ] npm run typecheck — exited with code 127 (tsc not found)
- [ ] see what the UI actually renders
- [ ] read production datastore state

## Rule proposals

- none

## Still open

- none
`

describe('close-out verifier', () => {
  test('clean honest close-out report passes verification', () => {
    const res = verifyCloseout({
      text: VALID_CLOSEOUT,
      gitFiles: ['src/core/optimizer.js', 'src/core/skillopt.js'],
    })
    assert.equal(res.valid, true)
    assert.deepEqual(res.errors, [])
  })

  test('POSITIVE CONTROL: modifying a src/ file while omitting it from What Changed is rejected', () => {
    const res = verifyCloseout({
      text: VALID_CLOSEOUT,
      // git shows optimizer.js, skillopt.js, AND gates.js, but gates.js is omitted from report
      gitFiles: ['src/core/optimizer.js', 'src/core/skillopt.js', 'src/core/gates.js'],
    })
    assert.equal(res.valid, false)
    assert.ok(res.errors.some((e) => e.includes('Modified file "src/core/gates.js" is omitted from ## What Changed')))
  })

  test('POSITIVE CONTROL: modifying a test/ file while omitting it from What Changed is rejected', () => {
    const res = verifyCloseout({
      text: VALID_CLOSEOUT,
      gitFiles: ['src/core/optimizer.js', 'src/core/skillopt.js', 'test/unit/gates.test.js'],
    })
    assert.equal(res.valid, false)
    assert.ok(res.errors.some((e) => e.includes('Modified file "test/unit/gates.test.js" is omitted from ## What Changed')))
  })

  test('POSITIVE CONTROL: modifying a docs/rules/ file while omitting it from What Changed is rejected', () => {
    const res = verifyCloseout({
      text: VALID_CLOSEOUT,
      gitFiles: ['src/core/optimizer.js', 'src/core/skillopt.js', 'docs/rules/active/my-rule.md'],
    })
    assert.equal(res.valid, false)
    assert.ok(res.errors.some((e) => e.includes('Modified file "docs/rules/active/my-rule.md" is omitted from ## What Changed')))
  })

  test('clean tree post-commit verification matches files listed in HEAD', () => {
    const report = `# Session close-out — caselaw

## What Changed

- \`test/unit/gates.test.js\`: added tests
- \`docs/rules/active/my-rule.md\`: updated rule

## Verified

- npm run test — agent — 10 passed, 0 failed

## Not Verified — over to you

- [ ] none

## Rule proposals

- none

## Still open

- none
`
    const res = verifyCloseout({
      text: report,
      gitFiles: ['test/unit/gates.test.js', 'docs/rules/active/my-rule.md'],
    })
    assert.equal(res.valid, true)
    assert.deepEqual(res.errors, [])
  })

  test('POSITIVE CONTROL: claiming a file was modified when it has zero git changes is rejected', () => {
    const res = verifyCloseout({
      text: VALID_CLOSEOUT,
      // git only modified optimizer.js; skillopt.js was claimed but untouched
      gitFiles: ['src/core/optimizer.js'],
    })
    assert.equal(res.valid, false)
    assert.ok(res.errors.some((e) => e.includes('Claimed modification to "src/core/skillopt.js" in ## What Changed, but file has zero git changes')))
  })

  test('POSITIVE CONTROL: placing a failing command inside ## Verified is rejected', () => {
    const dishonorCloseout = VALID_CLOSEOUT.replace(
      '## Verified\n\n- npm run test — agent — 782 passed, 0 failed',
      '## Verified\n\n- npm run test — agent — 782 passed\n- npm run typecheck — agent — exited with code 127'
    )
    const res = verifyCloseout({
      text: dishonorCloseout,
      gitFiles: ['src/core/optimizer.js', 'src/core/skillopt.js'],
    })
    assert.equal(res.valid, false)
    assert.ok(res.errors.some((e) => e.includes('Failing command placed inside ## Verified')))
  })

  test('POSITIVE CONTROL: checking off [x] a human-only authority item is rejected', () => {
    const breachedCloseout = VALID_CLOSEOUT.replace(
      '- [ ] see what the UI actually renders',
      '- [x] see what the UI actually renders'
    )
    const res = verifyCloseout({
      text: breachedCloseout,
      gitFiles: ['src/core/optimizer.js', 'src/core/skillopt.js'],
    })
    assert.equal(res.valid, false)
    assert.ok(res.errors.some((e) => e.includes('Human-only authority boundary marked as verified with [x]')))
  })

  test('POSITIVE CONTROL: out-of-scope untracked files do not prevent HEAD fallback when verifying clean tree', () => {
    const files = gitChangedFiles(process.cwd())
    assert.ok(Array.isArray(files) && files.length > 0)
    assert.ok(files.some((f) => f.includes('advertise-only-what-dispatches') || f.includes('closeout')))
  })
})
