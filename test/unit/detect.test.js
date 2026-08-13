import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { detect } from '../../src/detect/index.js'
import { detectVcs, parseRemote } from '../../src/detect/vcs.js'
import { run } from '../../src/detect/exec.js'
import { detectStack, walk, languageOf } from '../../src/detect/stack.js'
import { detectCommands, makeTargets, justRecipes, taskfileTasks, tomlSections } from '../../src/detect/commands.js'
import { detectEnvironment, detectVisibility } from '../../src/detect/environment.js'

/**
 * A binary name that cannot exist. Used to force the ENOENT branch of every
 * shell-out on purpose — the point of a positive control is that the failure
 * path is exercised, not merely believed in.
 */
const MISSING_BIN = 'caselaw-nonexistent-binary-9f3a'

/** Never let a test reach the network or a real Xcode/gh install. */
const OFFLINE = { gh: false, xcode: false, timeoutMs: 8000 }

let root
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'caselaw-detect-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function put(rel, content = '') {
  const abs = join(root, rel)
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, content, 'utf8')
  return abs
}

async function dir(rel) {
  await mkdir(join(root, rel), { recursive: true })
}

/** A runnable stand-in for an external tool, so failure branches are really run. */
async function putExecutable(rel, content) {
  const abs = await put(rel, content)
  await chmod(abs, 0o755)
  return abs
}

/** Is git usable here at all? Everything git-dependent is skipped if not. */
let GIT_OK = true
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' })
} catch {
  GIT_OK = false
}

function gitInit(cwd = root, { commit = false } = {}) {
  const opts = {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], opts)
  execFileSync('git', ['config', 'user.name', 'Fixture'], opts)
  execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], opts)
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], opts)
  if (commit) {
    execFileSync('git', ['add', '-A'], opts)
    execFileSync('git', ['commit', '-q', '-m', 'fixture', '--no-verify'], opts)
  }
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async function nodeApp() {
  await put(
    'package.json',
    JSON.stringify({
      name: 'demo',
      scripts: { test: 'vitest run', lint: 'eslint .', format: 'prettier -w .', typecheck: 'tsc --noEmit', build: 'vite build' },
    }),
  )
  await put('package-lock.json', '{}')
  await put('src/index.js', 'export const a = 1\n')
  await put('src/util.js', 'export const b = 2\n')
  await put('src/app.ts', 'export const c: number = 3\n')
  await put('README.md', '# demo\n')
}

async function pythonProject() {
  await put(
    'pyproject.toml',
    [
      '[build-system]',
      'requires = ["setuptools"]',
      '',
      '[tool.pytest.ini_options]',
      'testpaths = ["tests"]',
      '',
      '[tool.ruff]',
      'line-length = 100',
      '',
      '[tool.black]',
      'line-length = 100',
      '',
      '[tool.mypy]',
      'strict = true',
      '',
    ].join('\n'),
  )
  await put('src/app.py', 'x = 1\n')
  await put('src/model.py', 'y = 2\n')
  await put('tests/test_app.py', 'def test_x(): pass\n')
}

async function swiftApp() {
  await dir('Demo.xcodeproj')
  await put('Demo.xcodeproj/project.pbxproj', '// fixture\n')
  await put('Demo/App.swift', 'struct App {}\n')
  await put('Demo/View.swift', 'struct V {}\n')
  await put('DemoTests/AppTests.swift', 'final class T {}\n')
}

// ---------------------------------------------------------------------------
// vcs
// ---------------------------------------------------------------------------

describe('detect/vcs', () => {
  test('POSITIVE CONTROL: a directory that is not a git repo reports isRepo:false and does not throw', async () => {
    const { vcs, warnings } = await detectVcs(root, OFFLINE)
    assert.equal(vcs.isRepo, false)
    assert.equal(vcs.branch, null)
    assert.equal(vcs.headSha, null)
    assert.deepEqual(vcs.dirtyPaths, [])
    // Not a repo is an ANSWER, not a degradation — nothing failed.
    assert.equal(vcs.degraded, undefined)
    assert.deepEqual(warnings, [])
  })

  test('POSITIVE CONTROL: a freshly init\'d repo with zero commits does not throw on the HEAD lookup', async (t) => {
    if (!GIT_OK) return t.skip('git not available')
    gitInit()
    await put('untracked.txt', 'hi\n')

    const { vcs } = await detectVcs(root, OFFLINE)
    assert.equal(vcs.isRepo, true)
    assert.equal(vcs.headSha, null, 'no commits means no HEAD, not an exception')
    assert.equal(vcs.branch, 'main', 'symbolic-ref answers where rev-parse --abbrev-ref cannot')
    assert.equal(vcs.authors90d, 0)
    assert.equal(vcs.dirty, true)
    assert.deepEqual(vcs.dirtyPaths, ['untracked.txt'])
  })

  test('POSITIVE CONTROL: a missing git binary degrades instead of throwing', async () => {
    const { vcs, warnings } = await detectVcs(root, { ...OFFLINE, gitBin: MISSING_BIN })
    assert.equal(vcs.degraded, true)
    assert.match(vcs.reason, /not installed/)
    assert.ok(vcs.hint)
    assert.equal(vcs.isRepo, false)
    assert.equal(warnings[0].code, 'git-unavailable')
  })

  test('a committed repo reports branch, head, cleanliness and author count', async (t) => {
    if (!GIT_OK) return t.skip('git not available')
    await nodeApp()
    gitInit(root, { commit: true })

    const { vcs } = await detectVcs(root, OFFLINE)
    assert.equal(vcs.isRepo, true)
    assert.equal(vcs.branch, 'main')
    assert.match(vcs.headSha, /^[0-9a-f]{40}$/)
    assert.equal(vcs.dirty, false)
    assert.equal(vcs.authors90d, 1, 'solo repo -> solo defaults in the interview')
    assert.equal(vcs.commits90d, 1)
  })

  test('no remote yields a null host rather than an error', async (t) => {
    if (!GIT_OK) return t.skip('git not available')
    gitInit()
    const { vcs } = await detectVcs(root, OFFLINE)
    assert.equal(vcs.remoteUrl, null)
    assert.equal(vcs.remoteHost, null)
  })

  test('an ssh remote is parsed for its host', async (t) => {
    if (!GIT_OK) return t.skip('git not available')
    gitInit()
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widget.git'], { cwd: root, stdio: 'ignore' })
    const { vcs } = await detectVcs(root, OFFLINE)
    assert.equal(vcs.remoteHost, 'github.com')
  })

  test('a non-origin remote is still found', async (t) => {
    if (!GIT_OK) return t.skip('git not available')
    gitInit()
    execFileSync('git', ['remote', 'add', 'upstream', 'https://gitlab.com/acme/widget.git'], { cwd: root, stdio: 'ignore' })
    const { vcs } = await detectVcs(root, OFFLINE)
    assert.equal(vcs.remoteHost, 'gitlab.com')
  })

  test('detached HEAD reports detached rather than a branch called "HEAD"', async (t) => {
    if (!GIT_OK) return t.skip('git not available')
    await put('a.txt', 'one\n')
    gitInit(root, { commit: true })
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    execFileSync('git', ['checkout', '-q', '--detach', sha], { cwd: root, stdio: 'ignore' })

    const { vcs } = await detectVcs(root, OFFLINE)
    assert.equal(vcs.branch, null)
    assert.equal(vcs.detached, true)
    assert.equal(vcs.headSha, sha)
  })

  test('a subdirectory of a repo is flagged, because governance installed there covers a subtree', async (t) => {
    if (!GIT_OK) return t.skip('git not available')
    gitInit()
    await dir('packages/inner')
    const { vcs, warnings } = await detectVcs(join(root, 'packages/inner'), OFFLINE)
    assert.equal(vcs.isRepo, true)
    assert.equal(warnings.find((w) => w.code === 'nested-repo') !== undefined, true)
  })
})

describe('detect/vcs — remote parsing', () => {
  test('both SSH and HTTPS spellings resolve to a host', () => {
    assert.equal(parseRemote('git@github.com:acme/widget.git').host, 'github.com')
    assert.equal(parseRemote('https://github.com/acme/widget.git').host, 'github.com')
    assert.equal(parseRemote('ssh://git@git.example.org:2222/acme/widget.git').host, 'git.example.org')
    assert.equal(parseRemote('git@gitlab.self.hosted:team/app.git').host, 'gitlab.self.hosted')
  })

  test('POSITIVE CONTROL: a token embedded in an https remote is redacted before it can reach a doc', () => {
    const r = parseRemote('https://holden:ghp_SUPERSECRETVALUE@github.com/acme/widget.git')
    assert.equal(r.host, 'github.com')
    assert.ok(!r.url.includes('ghp_SUPERSECRETVALUE'), 'the token must not survive into the report')
    assert.ok(!r.url.includes('holden'))
    assert.match(r.url, /\*\*\*@github\.com/)
  })

  test('a local path or empty remote yields a null host, not a crash', () => {
    assert.equal(parseRemote('/srv/git/widget.git').host, null)
    assert.equal(parseRemote('').host, null)
    assert.equal(parseRemote(undefined).host, null)
    assert.equal(parseRemote('C:\\src\\widget').host, null)
  })
})

describe('detect/vcs — run()', () => {
  test('POSITIVE CONTROL: run() on a missing binary resolves with ok:false instead of rejecting', async () => {
    const res = await run(MISSING_BIN, ['--version'], { timeoutMs: 2000 })
    assert.equal(res.ok, false)
    assert.equal(res.code, null, 'a spawn failure is ignorance, not an exit code')
    assert.match(res.reason, /not installed/)
  })

  test('a non-zero exit is reported as an answer, with its code', async () => {
    const res = await run(process.execPath, ['-e', 'process.exit(3)'], { timeoutMs: 5000 })
    assert.equal(res.ok, false)
    assert.equal(res.code, 3)
  })

  test('POSITIVE CONTROL: a hanging command is killed by the timeout, not waited on', async () => {
    const res = await run(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { timeoutMs: 300 })
    assert.equal(res.ok, false)
    assert.equal(res.timedOut, true)
    assert.match(res.reason, /timed out/)
  })
})

// ---------------------------------------------------------------------------
// stack
// ---------------------------------------------------------------------------

describe('detect/stack', () => {
  test('a node app censuses its languages and finds its build system and package manager', async () => {
    await nodeApp()
    const { stack } = await detectStack(root, OFFLINE)
    assert.equal(stack.buildSystem, 'node')
    assert.equal(stack.packageManager, 'npm')
    const js = stack.languages.find((l) => l.name === 'JavaScript')
    assert.equal(js.files, 2)
    assert.equal(stack.languages.find((l) => l.name === 'TypeScript').files, 1)
    assert.equal(js.pct, 66.7)
    assert.equal(
      stack.languages.find((l) => l.name === 'Markdown'),
      undefined,
      'documentation is walked but not counted as source',
    )
  })

  test('a python project is recognised', async () => {
    await pythonProject()
    const { stack } = await detectStack(root, OFFLINE)
    assert.equal(stack.buildSystem, 'python')
    assert.equal(stack.languages[0].name, 'Python')
    assert.equal(stack.languages[0].files, 3)
    assert.equal(stack.languages[0].pct, 100)
  })

  test('an Xcode project is recognised from the .xcodeproj bundle, which is a directory', async () => {
    await swiftApp()
    const { stack } = await detectStack(root, OFFLINE)
    assert.equal(stack.buildSystem, 'xcode')
    assert.equal(stack.languages[0].name, 'Swift')
    assert.equal(stack.languages[0].files, 3)
  })

  test('a Package.swift outranks a Makefile sitting beside it', async () => {
    await put('Package.swift', '// swift-tools-version:5.9\n')
    await put('Makefile', 'test:\n\tswift test\n')
    await put('Sources/main.swift', 'print(1)\n')
    const { stack } = await detectStack(root, OFFLINE)
    assert.equal(stack.buildSystem, 'swiftpm')
    assert.deepEqual(stack.buildSystems, ['swiftpm', 'make'])
  })

  test('pnpm is preferred over a stale npm lockfile, and the collision is warned about', async () => {
    await put('package.json', '{}')
    await put('pnpm-lock.yaml', '')
    await put('package-lock.json', '{}')
    const { stack, warnings } = await detectStack(root, OFFLINE)
    assert.equal(stack.packageManager, 'pnpm')
    assert.ok(warnings.some((w) => w.code === 'multiple-lockfiles'))
  })

  test('corepack\'s packageManager field is used when there is no lockfile yet', async () => {
    await put('package.json', JSON.stringify({ packageManager: 'yarn@4.1.0' }))
    const { stack } = await detectStack(root, OFFLINE)
    assert.equal(stack.packageManager, 'yarn')
  })

  test('an unparseable package.json does not crash the package-manager lookup', async () => {
    await put('package.json', '{ this is not json')
    const { stack } = await detectStack(root, OFFLINE)
    assert.equal(stack.buildSystem, 'node')
    assert.equal(stack.packageManager, null)
  })

  test('a manifest one level down is surfaced when the root has none — the parent-folder mistake', async () => {
    await put('TheApp/package.json', '{}')
    await put('TheApp/src/index.js', '')
    const { stack, warnings } = await detectStack(root, OFFLINE)
    assert.equal(stack.buildSystem, null)
    const w = warnings.find((x) => x.code === 'nested-manifest')
    assert.ok(w)
    assert.match(w.message, /TheApp\/package\.json/)
  })

  test('languageOf ignores dotfiles and extensionless files', () => {
    assert.equal(languageOf('.gitignore'), null)
    assert.equal(languageOf('Makefile'), null)
    assert.equal(languageOf('src/a.swift'), 'Swift')
    assert.equal(languageOf('src/A.PY'), 'Python')
  })
})

describe('detect/stack — the walk is bounded', () => {
  test('POSITIVE CONTROL: node_modules is walked past, not counted, no matter how many files it holds', async () => {
    await put('index.js', '')
    await put('lib/util.js', '')
    await dir('node_modules/pkg/deep/deeper')
    // Enough files that counting them would be unmistakable in the census.
    await Promise.all(
      Array.from({ length: 400 }, (_, i) => put(`node_modules/pkg/deep/deeper/m${i}.js`, 'x')),
    )

    const { stack } = await detectStack(root, OFFLINE)
    const js = stack.languages.find((l) => l.name === 'JavaScript')
    assert.equal(js.files, 2, 'dependency code is not this project\'s code')
    assert.equal(js.pct, 100)
    assert.ok(stack.filesScanned < 20, `walked ${stack.filesScanned} files; node_modules leaked into the walk`)
  })

  test('POSITIVE CONTROL: the file cap truncates with a warning instead of running forever', async () => {
    await Promise.all(Array.from({ length: 60 }, (_, i) => put(`f${i}.js`, 'x')))
    const { stack, warnings } = await detectStack(root, { maxFiles: 10 })
    const w = warnings.find((x) => x.code === 'walk-truncated')
    assert.ok(w, 'hitting the cap must be reported, never silent')
    assert.match(w.message, /file cap \(10\)/)
    assert.ok(stack.filesScanned <= 10)
  })

  test('POSITIVE CONTROL: the depth cap prunes without aborting the rest of the tree', async () => {
    await put('top.js', '')
    await put('a/b/c/d/deep.js', '')
    const w = await walk(root, { maxDepth: 2 })
    assert.equal(w.truncated, true)
    assert.match(w.reason, /depth cap/)
    assert.ok(w.files.includes('top.js'), 'shallow files still made it into the census')
    assert.ok(!w.files.includes('a/b/c/d/deep.js'))
  })

  test('POSITIVE CONTROL: a symlink loop is recorded but never followed', async () => {
    await put('real.js', '')
    await symlink(root, join(root, 'loop'), 'dir')
    const w = await walk(root, { maxFiles: 500 })
    assert.ok(w.files.includes('loop'), 'the link is a fact worth recording')
    assert.ok(!w.files.some((f) => f.startsWith('loop/')), 'but descending it never terminates')
  })

  test('a nonexistent root yields an empty walk rather than an exception', async () => {
    const w = await walk(join(root, 'does', 'not', 'exist'))
    assert.deepEqual(w.files, [])
    assert.deepEqual(w.unreadable, ['.'])
  })
})

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

describe('detect/commands', () => {
  test('all five slots come out of package.json scripts, each with its provenance', async () => {
    await nodeApp()
    const { commands } = await detectCommands(root, OFFLINE, { stack: { packageManager: 'npm' } })
    assert.deepEqual(commands.test, { cmd: 'npm run test', source: 'package.json:scripts.test' })
    assert.deepEqual(commands.lint, { cmd: 'npm run lint', source: 'package.json:scripts.lint' })
    assert.deepEqual(commands.format, { cmd: 'npm run format', source: 'package.json:scripts.format' })
    assert.deepEqual(commands.typecheck, { cmd: 'npm run typecheck', source: 'package.json:scripts.typecheck' })
    assert.deepEqual(commands.build, { cmd: 'npm run build', source: 'package.json:scripts.build' })
  })

  test('the detected package manager drives the runner in the command it prints', async () => {
    await put('package.json', JSON.stringify({ scripts: { test: 'vitest' } }))
    await put('pnpm-lock.yaml', '')
    const { commands } = await detectCommands(root, OFFLINE, { stack: { packageManager: 'pnpm' } })
    assert.equal(commands.test.cmd, 'pnpm run test')
  })

  test('aliases fill a slot when the canonical name is missing', async () => {
    await put('package.json', JSON.stringify({ scripts: { fmt: 'prettier -w .', 'type-check': 'tsc' } }))
    const { commands } = await detectCommands(root, OFFLINE, {})
    assert.equal(commands.format.cmd, 'npm run fmt')
    assert.equal(commands.format.source, 'package.json:scripts.fmt')
    assert.equal(commands.typecheck.cmd, 'npm run type-check')
  })

  test('POSITIVE CONTROL: the `npm init` placeholder test script is refused, not reported as a test command', async () => {
    await put(
      'package.json',
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', build: 'tsc' } }),
    )
    const { commands, warnings } = await detectCommands(root, OFFLINE, {})
    assert.equal(commands.test, null, 'a verification tier whose first step is `exit 1` is worse than none')
    assert.equal(commands.build.cmd, 'npm run build')
    assert.ok(warnings.some((w) => w.code === 'placeholder-test-script'))
  })

  test('POSITIVE CONTROL: an unparseable package.json warns and still lets other sources fill the slots', async () => {
    await put('package.json', '{ broken')
    await put('Makefile', 'test:\n\tpytest\n')
    const { commands, warnings } = await detectCommands(root, OFFLINE, {})
    assert.ok(warnings.some((w) => w.code === 'unparseable-package-json'))
    assert.deepEqual(commands.test, { cmd: 'make test', source: 'Makefile:test' })
  })

  test('pyproject tool sections fill the python slots', async () => {
    await pythonProject()
    const { commands } = await detectCommands(root, OFFLINE, {})
    assert.deepEqual(commands.test, { cmd: 'pytest', source: 'pyproject.toml:[tool.pytest.ini_options]' })
    assert.equal(commands.lint.cmd, 'ruff check .')
    assert.equal(commands.format.cmd, 'black .')
    assert.equal(commands.typecheck.cmd, 'mypy .')
    assert.equal(commands.build.cmd, 'python -m build')
  })

  test('package.json wins over a Makefile for the same slot, and the Makefile still fills the rest', async () => {
    await put('package.json', JSON.stringify({ scripts: { test: 'vitest' } }))
    await put('Makefile', '.PHONY: test lint\nVERSION := 1\ntest:\n\tvitest\nlint:\n\teslint .\n')
    const { commands } = await detectCommands(root, OFFLINE, {})
    assert.equal(commands.test.source, 'package.json:scripts.test')
    assert.equal(commands.lint.cmd, 'make lint')
  })

  test('cargo and go commands come from convention', async () => {
    await put('Cargo.toml', '[package]\nname = "x"\n')
    const cargo = await detectCommands(root, OFFLINE, {})
    assert.equal(cargo.commands.test.cmd, 'cargo test')
    assert.equal(cargo.commands.format.cmd, 'cargo fmt --check')

    await rm(join(root, 'Cargo.toml'))
    await put('go.mod', 'module example.com/x\n')
    const go = await detectCommands(root, OFFLINE, {})
    assert.equal(go.commands.test.cmd, 'go test ./...')
    assert.equal(go.commands.build.cmd, 'go build ./...')
  })

  test('POSITIVE CONTROL: a missing xcodebuild degrades to a warning, leaving every other slot intact', async () => {
    await swiftApp()
    await put('Makefile', 'lint:\n\tswiftlint\n')
    const { commands, warnings } = await detectCommands(
      root,
      { xcodebuildBin: MISSING_BIN, xcodeTimeoutMs: 3000 },
      {},
    )
    assert.equal(commands.test, null)
    assert.equal(commands.lint.cmd, 'make lint', 'one dead tool must not cost the other four slots')
    assert.ok(warnings.some((w) => w.code === 'xcodebuild-unavailable'))
  })

  test('opts.xcode:false skips the subprocess entirely', async () => {
    await swiftApp()
    const { commands, warnings } = await detectCommands(root, { xcode: false }, {})
    assert.equal(commands.test, null)
    assert.deepEqual(warnings, [])
  })

  test('no manifests at all yields five nulls and no warnings', async () => {
    await put('notes.txt', 'hello')
    const { commands, warnings } = await detectCommands(root, OFFLINE, {})
    assert.deepEqual(commands, { test: null, lint: null, format: null, typecheck: null, build: null })
    assert.deepEqual(warnings, [])
  })
})

describe('detect/commands — parsers', () => {
  test('POSITIVE CONTROL: Makefile parsing rejects assignments, recipe bodies and .PHONY', () => {
    const targets = makeTargets(
      ['.PHONY: test', 'VERSION := 1.0', 'CFLAGS = -O2', 'test: deps', '\techo not-a-target:', 'build:', ''].join('\n'),
    )
    assert.deepEqual(targets, ['test', 'build'])
  })

  test('justfile recipes and Taskfile tasks are read', () => {
    assert.deepEqual(justRecipes('set shell := ["bash"]\ntest:\n  cargo test\nlint arg="x":\n  clippy\n'), ['test', 'lint'])
    assert.deepEqual(
      taskfileTasks(['version: "3"', 'tasks:', '  test:', '    cmds: [go test]', '  build:', '    cmds: [go build]', 'env:', '  A: b'].join('\n')),
      ['test', 'build'],
    )
  })

  test('TOML section headers are read without a TOML parser', () => {
    assert.deepEqual(tomlSections('[tool.ruff]\nx=1\n[[tool.mypy.overrides]]\ny=2\n'), ['tool.ruff', 'tool.mypy.overrides'])
  })
})

// ---------------------------------------------------------------------------
// environment
// ---------------------------------------------------------------------------

describe('detect/environment', () => {
  test('a greenfield directory reports nothing present and never throws', async () => {
    const { environment, warnings } = await detectEnvironment(root, OFFLINE, {})
    assert.equal(environment.ci.present, false)
    assert.equal(environment.ci.provider, null)
    assert.equal(environment.hooks.framework, null)
    assert.equal(environment.agentConfig.existingHarness, false)
    assert.deepEqual(environment.deploySurface, [])
    assert.deepEqual(environment.secretSurface, [])
    assert.equal(environment.visibility, 'unknown')
    assert.deepEqual(warnings, [])
  })

  test('a brownfield repo with CLAUDE.md and GitHub Actions is recognised as such', async () => {
    await put('CLAUDE.md', '# house rules\n')
    await put('.github/workflows/ci.yml', 'name: ci\n')
    await put('.github/workflows/release.yaml', 'name: release\n')
    await put('.github/copilot-instructions.md', 'be nice\n')
    await put('.cursorrules', 'no any\n')
    await dir('.claude/skills')

    const { environment } = await detectEnvironment(root, OFFLINE, {})
    assert.equal(environment.ci.present, true)
    assert.equal(environment.ci.provider, 'github-actions')
    assert.deepEqual(environment.ci.files, ['.github/workflows/ci.yml', '.github/workflows/release.yaml'])
    assert.equal(environment.agentConfig.claudeMd, true)
    assert.equal(environment.agentConfig.claudeDir, true)
    assert.equal(environment.agentConfig.copilot, true)
    assert.equal(environment.agentConfig.cursorRules, true)
    assert.equal(environment.agentConfig.agentsMd, false)
    assert.equal(environment.agentConfig.existingHarness, false)
  })

  test('an existing .caselaw/manifest.json marks this an upgrade, not a fresh install', async () => {
    await put('.caselaw/manifest.json', '{"schemaVersion":1,"entries":{}}')
    const { environment } = await detectEnvironment(root, OFFLINE, {})
    assert.equal(environment.agentConfig.existingHarness, true)
    assert.ok(environment.agentConfig.files.includes('.caselaw/manifest.json'))
  })

  test('hook frameworks are told apart', async () => {
    await put('.pre-commit-config.yaml', 'repos: []\n')
    const pre = await detectEnvironment(root, OFFLINE, {})
    assert.equal(pre.environment.hooks.framework, 'pre-commit')

    await rm(join(root, '.pre-commit-config.yaml'))
    await put('.husky/pre-commit', 'npm test\n')
    const husky = await detectEnvironment(root, OFFLINE, {})
    assert.equal(husky.environment.hooks.framework, 'husky')
    assert.ok(husky.environment.hooks.files.includes('.husky/pre-commit'))

    await rm(join(root, '.husky'), { recursive: true })
    await put('lefthook.yml', 'pre-commit:\n')
    const left = await detectEnvironment(root, OFFLINE, {})
    assert.equal(left.environment.hooks.framework, 'lefthook')
  })

  test('a hand-written git hook is reported even though it belongs to no framework', async (t) => {
    if (!GIT_OK) return t.skip('git not available')
    gitInit()
    await put('.git/hooks/pre-commit', '#!/bin/sh\nexit 0\n')
    const { environment } = await detectEnvironment(root, OFFLINE, {})
    assert.equal(environment.hooks.framework, null)
    assert.ok(environment.hooks.files.includes('.git/hooks/pre-commit'))
  })

  test('the deploy surface is found at any depth and deduplicated by kind', async () => {
    await put('Dockerfile', 'FROM node\n')
    await put('docker-compose.yml', 'services: {}\n')
    await put('fly.toml', 'app = "x"\n')
    await put('infra/main.tf', 'resource "x" "y" {}\n')
    await put('infra/vars.tf', 'variable "z" {}\n')
    await put('k8s/deployment.yaml', 'apiVersion: apps/v1\n')
    await put('firebase.json', '{}')
    await put('Procfile', 'web: node .\n')

    const { environment } = await detectEnvironment(root, OFFLINE, {})
    const kinds = environment.deploySurface.map((d) => d.kind)
    assert.deepEqual(kinds, ['docker', 'docker-compose', 'firebase', 'fly', 'heroku', 'kubernetes', 'terraform'])
    const tf = environment.deploySurface.find((d) => d.kind === 'terraform')
    assert.equal(tf.evidence, 'infra/main.tf')
    assert.equal(tf.files.length, 2, 'one entry per kind, but the evidence list keeps every file')
  })

  test('POSITIVE CONTROL: a committed secret reads gitignored:false while an ignored one reads true', async (t) => {
    if (!GIT_OK) return t.skip('git not available')
    await put('.gitignore', '.env\n*.pem\n')
    await put('.env', 'API_KEY=abc\n')
    await put('config/prod.pem', 'x\n')
    await put('.env.example', 'API_KEY=\n')
    await put('committed.pem', 'x\n')
    gitInit()
    // Force-add one secret so it is TRACKED: git check-ignore must then call it
    // not-ignored, which is the finding that actually matters.
    execFileSync('git', ['add', '-f', 'committed.pem', '.gitignore'], { cwd: root, stdio: 'ignore' })

    const { environment } = await detectEnvironment(root, OFFLINE, {})
    const byPath = new Map(environment.secretSurface.map((s) => [s.path, s.gitignored]))
    assert.equal(byPath.get('.env'), true)
    assert.equal(byPath.get('config/prod.pem'), true)
    assert.equal(byPath.get('committed.pem'), false, 'a tracked key is exposed, whatever .gitignore says')
    assert.equal(byPath.has('.env.example'), false, 'templates are meant to be committed; flagging them trains dismissal')
  })

  test('POSITIVE CONTROL: with git unavailable, secrets report gitignored:null and a warning — never a false "safe"', async () => {
    await put('.env', 'API_KEY=abc\n')
    const { environment, warnings } = await detectEnvironment(root, { ...OFFLINE, gitBin: MISSING_BIN }, {})
    assert.deepEqual(environment.secretSurface, [{ path: '.env', gitignored: null }])
    assert.ok(warnings.some((w) => w.code === 'check-ignore-unavailable'))
  })
})

describe('detect/environment — visibility', () => {
  test('POSITIVE CONTROL: a missing gh CLI yields visibility "unknown" rather than an exception', async () => {
    const vcs = { isRepo: true, remoteHost: 'github.com' }
    const res = await detectVisibility(root, { ghBin: MISSING_BIN, ghTimeoutMs: 3000 }, vcs)
    assert.equal(res.visibility, 'unknown')
    assert.equal(res.warning.code, 'gh-unavailable')
    assert.match(res.warning.message, /not installed/)
  })

  test('POSITIVE CONTROL: gh returning non-JSON yields "unknown", not a parse crash', async (t) => {
    if (process.platform === 'win32') return t.skip('needs a POSIX shim script')
    const vcs = { isRepo: true, remoteHost: 'github.com' }
    // A real executable that exits 0 with garbage on stdout — the branch a
    // `ghBin: MISSING_BIN` test can never reach, because that one never runs.
    const shim = await putExecutable('fake-gh-garbage', '#!/bin/sh\necho "not json at all"\n')
    const res = await detectVisibility(root, { ghBin: shim, ghTimeoutMs: 4000 }, vcs)
    assert.equal(res.visibility, 'unknown')
    assert.equal(res.warning.code, 'gh-unparseable')
  })

  test('gh answers are mapped: PUBLIC, PRIVATE, and INTERNAL (which is not public)', async (t) => {
    if (process.platform === 'win32') return t.skip('needs a POSIX shim script')
    const vcs = { isRepo: true, remoteHost: 'github.com' }
    for (const [raw, expected] of [['PUBLIC', 'public'], ['PRIVATE', 'private'], ['INTERNAL', 'private']]) {
      const shim = await putExecutable(`fake-gh-${raw}`, `#!/bin/sh\necho '{"visibility":"${raw}"}'\n`)
      const res = await detectVisibility(root, { ghBin: shim, ghTimeoutMs: 4000 }, vcs)
      assert.equal(res.visibility, expected, `${raw} should read as ${expected}`)
    }
  })

  test('gh is not even spawned for a non-GitHub remote', async () => {
    const res = await detectVisibility(root, { ghBin: MISSING_BIN }, { isRepo: true, remoteHost: 'gitlab.com' })
    assert.equal(res.visibility, 'unknown')
    assert.equal(res.warning, null, 'skipping a guaranteed-useless network call is not a degradation')
  })

  test('gh is not spawned when there is no repo at all', async () => {
    const res = await detectVisibility(root, { ghBin: MISSING_BIN }, { isRepo: false, remoteHost: null })
    assert.equal(res.visibility, 'unknown')
    assert.equal(res.warning, null)
  })
})

// ---------------------------------------------------------------------------
// the whole report
// ---------------------------------------------------------------------------

describe('detect() — the full report', () => {
  test('POSITIVE CONTROL: an empty non-repo directory produces a complete, well-shaped report', async () => {
    const r = await detect(root, OFFLINE)
    for (const key of ['vcs', 'stack', 'commands', 'ci', 'hooks', 'agentConfig', 'deploySurface', 'secretSurface', 'visibility', 'warnings']) {
      assert.ok(key in r, `contract key ${key} is missing`)
    }
    assert.equal(r.vcs.isRepo, false)
    assert.deepEqual(r.stack.languages, [])
    assert.deepEqual(r.commands, { test: null, lint: null, format: null, typecheck: null, build: null })
    assert.equal(r.visibility, 'unknown')
    assert.ok(Array.isArray(r.warnings))
    assert.ok(typeof r.elapsedMs === 'number')
  })

  test('POSITIVE CONTROL: a nonexistent root still resolves to a report instead of rejecting', async () => {
    const r = await detect(join(root, 'no', 'such', 'place'), OFFLINE)
    assert.equal(r.vcs.isRepo, false)
    assert.deepEqual(r.deploySurface, [])
    assert.ok(Array.isArray(r.warnings))
  })

  test('POSITIVE CONTROL: with git AND gh AND xcodebuild all missing, every other fact still lands', async () => {
    await nodeApp()
    await put('Dockerfile', 'FROM node\n')
    const r = await detect(root, {
      gitBin: MISSING_BIN,
      ghBin: MISSING_BIN,
      xcodebuildBin: MISSING_BIN,
      timeoutMs: 3000,
    })
    assert.equal(r.vcs.degraded, true, 'the group that failed says so')
    assert.equal(r.stack.buildSystem, 'node', 'and the groups that did not, do not')
    assert.equal(r.commands.test.cmd, 'npm run test')
    assert.equal(r.deploySurface[0].kind, 'docker')
    assert.equal(r.visibility, 'unknown')
    assert.ok(r.warnings.some((w) => w.code === 'git-unavailable'))
  })

  test('a brownfield node repo: every group reports together', async (t) => {
    if (!GIT_OK) return t.skip('git not available')
    await nodeApp()
    await put('CLAUDE.md', '# rules\n')
    await put('.github/workflows/ci.yml', 'name: ci\n')
    await put('.husky/pre-commit', 'npm test\n')
    await put('Dockerfile', 'FROM node:20\n')
    await put('.gitignore', '.env\n')
    await put('.env', 'SECRET=1\n')
    gitInit(root, { commit: true })

    const r = await detect(root, OFFLINE)
    assert.equal(r.vcs.isRepo, true)
    assert.equal(r.vcs.branch, 'main')
    assert.equal(r.vcs.dirty, false)
    assert.equal(r.vcs.authors90d, 1)
    assert.equal(r.stack.buildSystem, 'node')
    assert.equal(r.commands.test.cmd, 'npm run test')
    assert.equal(r.ci.provider, 'github-actions')
    assert.equal(r.hooks.framework, 'husky')
    assert.equal(r.agentConfig.claudeMd, true)
    assert.equal(r.agentConfig.existingHarness, false)
    assert.equal(r.deploySurface[0].kind, 'docker')
    assert.deepEqual(r.secretSurface, [{ path: '.env', gitignored: true }])
  })

  test('a zero-commit repo reports through the whole pipeline without throwing', async (t) => {
    if (!GIT_OK) return t.skip('git not available')
    await pythonProject()
    gitInit()
    const r = await detect(root, OFFLINE)
    assert.equal(r.vcs.isRepo, true)
    assert.equal(r.vcs.headSha, null)
    assert.equal(r.vcs.authors90d, 0)
    assert.equal(r.vcs.dirty, true)
    assert.equal(r.stack.buildSystem, 'python')
    assert.equal(r.commands.test.cmd, 'pytest')
  })

  test('the upgrade path is distinguishable from a fresh install', async () => {
    await nodeApp()
    await put('.caselaw/manifest.json', '{"schemaVersion":1,"entries":{}}')
    const r = await detect(root, OFFLINE)
    assert.equal(r.agentConfig.existingHarness, true)
  })

  test('an Xcode project detects its stack with the xcodebuild call switched off', async () => {
    await swiftApp()
    const r = await detect(root, OFFLINE)
    assert.equal(r.stack.buildSystem, 'xcode')
    assert.equal(r.stack.languages[0].name, 'Swift')
    assert.equal(r.commands.test, null, 'no schemes were asked for, so nothing was invented')
  })
})
