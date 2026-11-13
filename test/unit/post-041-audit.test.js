import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSteps, detectCiGates } from '../../src/detect/ci-gates.js'
import { stepContext, publishSteps } from '../../src/detect/publishing.js'
import { generate as authority } from '../../src/generate/authority-split.js'
import { docsOwner } from '../../src/detect/docs-owner.js'

test('POSITIVE CONTROL: F6 YAML quotes and quoted hashes survive command and condition extraction', () => {
  const text = `jobs:
  test:
    steps:
      - run: "pytest" "-k" "not slow"
        if: "contains(github.event.pull_request.body, 'Closes #123')" # real comment
      - run: 'pytest ''quoted'''
      - run: "pytest \\"quoted\\"" # comment
`
  assert.deepEqual(runSteps(text).map((g) => g.cmd), ['"pytest" "-k" "not slow"', "pytest 'quoted'", 'pytest "quoted"'])
  assert.equal(stepContext(text, 4).condition, "contains(github.event.pull_request.body, 'Closes #123')")
})

test('POSITIVE CONTROL: F3 relative YAML indentation retains folded conditions and run defaults', () => {
  for (const width of [2, 4]) for (const extra of [0, 2]) {
    const pad = (n) => ' '.repeat(n)
    const item = width * 2 + extra
    const lines = ['defaults:', `${pad(width)}run:`, `${pad(width * 2)}shell: bash`, 'jobs:',
      `${pad(width)}test: # commented job`, `${pad(width * 2)}defaults:`, `${pad(width * 3)}run:`,
      `${pad(width * 4)}working-directory: ./job`, `${pad(width * 2)}steps:`,
      `${pad(item)}- name: Test`, `${pad(item + 2)}if: >`,
      `${pad(item + 4)}matrix.os == 'ubuntu-latest' &&`, `${pad(item + 8)}github.ref == 'refs/heads/main'`,
      `${pad(item + 2)}continue-on-error: true`, `${pad(item + 2)}run: pytest`,
      `${pad(item)}- run: npm test`]
    const text = lines.join('\n')
    const ctx = stepContext(text, 15)
    assert.equal(ctx.workingDirectory, './job', text)
    assert.equal(ctx.shell, 'bash')
    assert.equal(ctx.condition, "matrix.os == 'ubuntu-latest' && github.ref == 'refs/heads/main'")
    assert.equal(ctx.continueOnError, 'true')
    assert.equal(stepContext(text, 16).condition, undefined)
  }
  const firstField = "jobs:\n  test:\n    steps:\n    - if: >\n        github.event_name == 'push' &&\n          github.ref == 'refs/heads/main'\n      run: pytest\n"
  assert.equal(stepContext(firstField, 7).condition, "github.event_name == 'push' && github.ref == 'refs/heads/main'")
})

test('POSITIVE CONTROL: F4 heredoc bodies and chained control flow never become standalone checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caselaw-shell-'))
  const file = '.github/workflows/ci.yml'
  try {
    await mkdir(join(root, '.github/workflows'), { recursive: true })
    for (const opener of ["python3 - <<'PY'", 'cat > config.json <<PY', 'bash -s <<PY', 'sudo tee /tmp/config <<PY',
      'CI=true if [ -f a ]; then pytest; fi', 'cd packages && for pkg in *; do npm test; done']) {
      const text = `on: push\njobs:\n  test:\n    steps:\n      - run: |\n          ${opener}\n          run: THIS_IS_BODY\n          PY\n      - run: pytest\n`
      await writeFile(join(root, file), text)
      const { ciGates, warnings } = await detectCiGates(root, { files: [file] })
      assert.deepEqual(ciGates.gates.map((g) => g.cmd), ['pytest'], opener)
      assert.ok(warnings.some((w) => w.code === 'ci-shell-unread'), opener)
    }
    const plain = 'jobs:\n  test:\n    steps:\n      - run: mask << 4\n      - run: python3 -c "mask << 4"\n      - run: pytest -k "if or for"\n'
    assert.deepEqual(runSteps(plain).map((g) => g.cmd), ['mask << 4', 'python3 -c "mask << 4"', 'pytest -k "if or for"'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('POSITIVE CONTROL: F5 publishing tools are detected without treating release-named tests as publishers', () => {
  const releases = ['pnpm changeset publish', 'yarn changeset publish', 'npx @changesets/cli publish', 'npx changeset publish',
    'npx semantic-release', 'bun publish', 'hatch publish', 'flit publish', 'maturin publish', 'gh release create v1']
  for (const command of releases) assert.ok(publishSteps(`- run: ${command}`).length > 0, command)
  const checks = ['npm run test:release-notes', 'pnpm verify:publish-types', 'yarn lint:deploy-config', 'bun run release:dry-run', 'npm run test:semantic-release', 'node test/semantic-release.test.js', 'echo semantic-release']
  for (const command of checks) assert.deepEqual(publishSteps(`- run: ${command}`), [], command)
  assert.equal(publishSteps('- run: bun run ci-publish')[0].unread, true)
  assert.ok(publishSteps(releases.slice(0, 1).concat(releases.slice(4, 6)).map((c) => `- run: ${c}`).join('\n')).length >= 3)
  assert.ok(publishSteps('- run: npm run test:release-notes && npm publish').some((p) => p.what === 'npm'))
  assert.deepEqual(publishSteps('- name: semantic-release tests'), [])
})

test('POSITIVE CONTROL: F7 runner expressions retain delimiters and are labeled as CI-resolved context', async () => {
  const text = 'jobs:\n  test:\n    steps:\n      - run: pytest\n        working-directory: ${{ runner.temp }}\n        shell: ${{ matrix.shell }}\n'
  const [gate] = runSteps(text)
  assert.equal(gate.workingDirectory, '${{ runner.temp }}')
  assert.equal(gate.shell, '${{ matrix.shell }}')
  const { content } = await authority({ detected: { ciGates: { gates: [{ file: 'ci.yml', ...gate }] } }, projectName: 'Fixture' })
  assert.match(content, /working directory expression `\$\{\{ runner.temp \}\}` \(resolved by CI runner\)/)
  assert.match(content, /shell expression `\$\{\{ matrix.shell \}\}` \(resolved by CI runner\)/)
})

test('POSITIVE CONTROL: F9 nested documentation configurations reserve docs for their site', async () => {
  const configs = ['docs/source/conf.py', 'docs/.vitepress/config.cjs',
    ...['js', 'ts', 'mjs', 'cjs'].map((ext) => `docs/docusaurus.config.${ext}`),
    ...['js', 'ts', 'mjs'].map((ext) => `docs/astro.config.${ext}`), 'docs/mint.json', 'docs/docs.json']
  const root = await mkdtemp(join(tmpdir(), 'caselaw-docs-owner-'))
  try {
    assert.equal(await docsOwner(root), null)
    for (const file of configs) {
      await mkdir(join(root, file, '..'), { recursive: true })
      await writeFile(join(root, file), '// source fixture, never executed')
      assert.equal((await docsOwner(root))?.file, file, file)
      await rm(join(root, file))
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
