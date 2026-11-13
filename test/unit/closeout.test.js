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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { verifyCloseout, parseCloseout, gitChangedFiles, isScopeTrackedPath } from '../../src/core/closeout.js'

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

test('POSITIVE CONTROL: F1 close-out rejects omitted runtime, templates, package and configured doctrine', () => {
  const root = mkdtempSync(join(tmpdir(), 'caselaw-scope-'))
  try {
    mkdirSync(join(root, '.caselaw'))
    writeFileSync(join(root, '.caselaw/answers.json'), JSON.stringify({ doctrineDir: 'policy/team' }))
    const paths = ['runtime/gate.mjs', 'templates/docs/close-out.md.tmpl', 'package.json', 'governance/rules/active/r.md', 'policy/team/rules/active/r.md']
    for (const path of paths) {
      assert.equal(isScopeTrackedPath(path, { doctrineDir: 'policy/team' }), true, path)
      const result = verifyCloseout({ root, text: '## What Changed\nNothing.', gitFiles: [path] })
      assert.ok(result.errors.some((e) => e.includes('Silent Scope Drop')), path)
    }
    rmSync(join(root, '.caselaw/answers.json'))
    writeFileSync(join(root, '.caselaw/manifest.json'), JSON.stringify({ entries: { 'policy/team/authority-split.md': { kind: 'file' } } }))
    assert.equal(verifyCloseout({ root, text: '## What Changed\nNothing.', gitFiles: ['policy/team/rules/active/r.md'] }).valid, false)
    assert.equal(isScopeTrackedPath('notes.txt'), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('POSITIVE CONTROL: F2 close-out canonicalizes formatted claims in both directions', () => {
  const text = '## What Changed\n- `./src/a.js`: fixed.\n- [`src/b.js`](file:///repo/src/b.js): checked.\n- **runtime/gate.mjs**: hardened.\nUpdated node.js notes for v0.4.\n'
  const files = ['src/a.js', 'src/b.js', 'runtime/gate.mjs']
  assert.equal(verifyCloseout({ text, gitFiles: files }).valid, true)
  const dropped = verifyCloseout({ text, gitFiles: [...files, 'templates/a.md.tmpl'] })
  assert.ok(dropped.errors.some((e) => e.includes('templates/a.md.tmpl') && e.includes('Silent Scope Drop')))
  const fabricated = verifyCloseout({ text: text + '- [fake](./governance/rules/active/fake.md): changed.\n', gitFiles: files })
  assert.ok(fabricated.errors.some((e) => e.includes('governance/rules/active/fake.md') && e.includes('zero git changes')))
  const special = ['src/hash#file.js', 'src/name:123', 'src/name*file.js', 'src/a file.js']
  assert.equal(verifyCloseout({ text: '## What Changed\n' + special.map((p) => `- \`${p}\`: changed.`).join('\n'), gitFiles: special }).valid, true)
  assert.equal(verifyCloseout({ text: '## What Changed\n- `src/hash`: changed.', gitFiles: ['src/hash#file.js'] }).valid, false)
})

test('POSITIVE CONTROL: F10 large dirty and committed path lists are complete and spawn errors surface', () => {
  const root = mkdtempSync(join(tmpdir(), 'caselaw-large-status-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  try {
    git('init', '-q')
    const prefix = `src/${'a'.repeat(120)}/${'b'.repeat(120)}`
    mkdirSync(join(root, prefix), { recursive: true })
    const paths = Array.from({ length: 4200 }, (_, i) => `${prefix}/file-${String(i).padStart(5, '0')}.js`)
    assert.ok(Buffer.byteLength(paths.join('\0')) > 1024 * 1024)
    for (const path of paths) writeFileSync(join(root, path), 'export {}\n')
    assert.deepEqual(gitChangedFiles(root).sort(), paths)
    execFileSync('git', ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd: root, input: paths.join('\0') + '\0' })
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'large initial snapshot')
    assert.deepEqual(gitChangedFiles(root).sort(), paths)
    const branch = git('branch', '--show-current').trim()
    git('switch', '-qc', 'side')
    writeFileSync(join(root, 'src/side.js'), 'side\n')
    git('add', '--', 'src/side.js')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'side')
    git('switch', '-q', branch)
    writeFileSync(join(root, 'src/main.js'), 'main\n')
    git('add', '--', 'src/main.js')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'main')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'merge', '--no-ff', 'side', '-qm', 'merge')
    assert.deepEqual(gitChangedFiles(root), ['src/side.js'], 'merge scope compares to the first parent, not unrelated history from both parents')
    assert.throws(() => gitChangedFiles(join(root, 'missing')), (err) => err.code === 'ENOENT')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

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
    const root = mkdtempSync(join(tmpdir(), 'caselaw-head-control-'))
    try {
      const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
      git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
      mkdirSync(join(root, 'src'))
      writeFileSync(join(root, 'src', 'example.js'), 'export const value = 1;\n')
      git('add', 'src/example.js'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')
      writeFileSync(join(root, 'unrelated.txt'), 'not tracked by the scope verifier')
      assert.deepEqual(gitChangedFiles(root), ['src/example.js'])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
