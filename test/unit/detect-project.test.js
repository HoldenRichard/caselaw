/**
 * Two detection facts the dogfood caught: the project was named after the
 * directory it was cloned into ("Authority split — repo" for homebridge), and
 * caselaw's own vendored runtime counted as project source, so a pure-Python
 * repository read as 98.1% Python on its second run.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectStack, EXCLUDED_DIRS } from '../../src/detect/stack.js'

async function repo(files) {
  const root = await mkdtemp(join(tmpdir(), 'caselaw-detect-'))
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(root, rel, '..'), { recursive: true })
    await writeFile(join(root, rel), content, 'utf8')
  }
  return root
}

describe('the project name', () => {
  test('POSITIVE CONTROL: comes from the manifest, whatever the directory is called', async () => {
    const cases = [
      [{ 'package.json': JSON.stringify({ name: '@acme/widget' }) }, 'widget'],
      [{ 'pyproject.toml': '[build-system]\nrequires = []\n\n[project]\nname = "PyVISA"\nversion = "1"\n' }, 'PyVISA'],
      [{ 'go.mod': 'module heckel.io/ntfy/v2\n\ngo 1.22\n' }, 'ntfy'],
      [{ 'Cargo.toml': '[package]\nname = "rmk"\nversion = "0.1.0"\n' }, 'rmk'],
    ]
    for (const [files, expected] of cases) {
      const root = await repo(files)
      try {
        const { stack } = await detectStack(root)
        assert.equal(stack.projectName, expected, JSON.stringify(files))
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  test('is null, never guessed, when no manifest names it', async () => {
    const root = await repo({ 'README.md': '# x\n' })
    try { assert.equal((await detectStack(root)).stack.projectName, null) } finally { await rm(root, { recursive: true, force: true }) }
  })
})

describe('the language census', () => {
  test('POSITIVE CONTROL: skips caselaw\'s own directories', async () => {
    assert.ok(EXCLUDED_DIRS.has('.caselaw') && EXCLUDED_DIRS.has('.claude'))
    const root = await repo({
      'src/a.py': 'x = 1\n', 'src/b.py': 'y = 2\n',
      '.caselaw/bin/gate.mjs': 'export const x = 1\n',
      '.claude/commands/close-out.md': '# close\n',
    })
    try {
      const { stack } = await detectStack(root)
      assert.deepEqual(stack.languages.map((l) => l.name), ['Python'], 'the vendored runtime is not project source')
      assert.equal(stack.languages[0].pct, 100)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
