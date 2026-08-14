import { test, describe, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  probeScanners,
  resetProbeCache,
  redact,
  scanWorkingTree,
  scanHistory,
  scanMachinePaths,
} from '../../src/core/secrets.js'

const exec = promisify(execFile)

/**
 * Fake credentials, planted on purpose and kept together here so the repo has
 * exactly one place where a secret-shaped literal lives.
 *
 * They are shaped like the real thing so the real gitleaks actually fires on
 * them — a positive control is worthless if the "known bad" input is not
 * recognised as bad. They are assembled at runtime rather than written as
 * literals, so the source itself carries nothing a scanner would flag.
 */
// Assembled at runtime, never written as a literal.
//
// A literal here is a real problem even though the value is fake: GitHub's
// push protection blocks the push, every fork inherits the block, and a
// security-adjacent repo that trips secret scanners teaches its users to
// click through those warnings. Joining the parts keeps the runtime value
// byte-identical — the scanner under test still sees a complete credential
// in the temp file — while the source contains nothing scanner-shaped.
//
// This also removes the need for `gitleaks:allow` pragmas. An exception is a
// weakened gate; not needing one is strictly better than being excused from it.
const PLANTED = ['ghp', 'A1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvWxYz'].join('_')
const PLANTED_STRIPE = ['sk', 'live', '51HxAbCdEfGhIjKlMnOpQrStU'].join('_')

let root
let scanners

before(async () => {
  scanners = await probeScanners()
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'caselaw-secrets-test-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function put(rel, content) {
  const abs = join(root, rel)
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, content, 'utf8')
  return abs
}

async function gitRepo(dir) {
  await exec('git', ['init', '-q', dir])
  await exec('git', ['-C', dir, 'config', 'user.email', 'test@example.invalid'])
  await exec('git', ['-C', dir, 'config', 'user.name', 'test'])
  await exec('git', ['-C', dir, 'config', 'commit.gpgsign', 'false'])
}

async function commitAll(dir, message) {
  await exec('git', ['-C', dir, 'add', '-A'])
  await exec('git', ['-C', dir, 'commit', '-q', '-m', message])
}

/**
 * The scanner stand-ins below are POSIX shell scripts, so they cannot run on
 * Windows. Those tests skip there rather than fail: a contributor whose test
 * suite is red on a clean checkout stops running the suite.
 */
const NEEDS_SHELL = { skip: process.platform === 'win32' ? 'needs a POSIX shell' : false }

/** Write an executable stand-in for a scanner. Lets us drive the parsing and
 *  exit-code paths deterministically on machines where the real tool is absent. */
async function fakeBin(name, script) {
  const p = join(root, name)
  await writeFile(p, script, 'utf8')
  await chmod(p, 0o755)
  return p
}

// ==========================================================================
// redact
// ==========================================================================

describe('redact', () => {
  test('keeps at most the last four characters', () => {
    assert.equal(redact('abcdefghijklmnop'), '****mnop')
    assert.equal(redact('abcde'), '****bcde')
  })

  test('POSITIVE CONTROL: the input never survives its own redaction', () => {
    for (const s of [PLANTED, PLANTED_STRIPE, 'hunter2hunter2']) {
      assert.ok(!redact(s).includes(s), `redact() leaked ${s.slice(0, 6)}…`)
    }
  })

  test('four characters or fewer are masked completely', () => {
    assert.equal(redact('abcd'), '****')
    assert.equal(redact('a'), '****')
  })

  test('the mask is fixed width, so the redaction does not leak the length', () => {
    const short = redact('abcdefgh')
    const long = redact('a'.repeat(4096) + 'efgh')
    assert.equal(short.length, long.length)
  })

  test('non-string input does not throw', () => {
    assert.equal(redact(null), '')
    assert.equal(redact(undefined), '')
    assert.equal(redact(12345678), '****5678')
  })
})

// ==========================================================================
// scanMachinePaths — home paths
// ==========================================================================

describe('scanMachinePaths — home paths', () => {
  test('POSITIVE CONTROL: a /Users/<name> path is flagged', () => {
    const hits = scanMachinePaths('see /Users/someone/Desktop/notes.md for details')
    assert.equal(hits.length, 1)
    assert.equal(hits[0].kind, 'home-path')
    assert.equal(hits[0].match, '/Users/someone')
  })

  test('POSITIVE CONTROL: a /home/<name> path is flagged', () => {
    const hits = scanMachinePaths('cwd=/home/someone/src')
    assert.deepEqual(hits.map((h) => h.match), ['/home/someone'])
  })

  test('POSITIVE CONTROL: Windows home paths are flagged in every slash flavour', () => {
    const cases = [
      ['C:\\Users\\someone\\Desktop', 'C:\\Users\\someone'],
      // What a Windows path looks like once it has been through a JS or JSON
      // string literal — the doubled backslash must not defeat the match.
      ['C:\\\\Users\\\\someone', 'C:\\\\Users\\\\someone'],
      ['D:/Users/someone/src', 'D:/Users/someone'],
    ]
    for (const [text, expected] of cases) {
      const hits = scanMachinePaths(text)
      assert.equal(hits.length, 1, `no hit for ${JSON.stringify(text)}`)
      assert.equal(hits[0].match, expected)
    }
  })

  test('the index points at the match in the ORIGINAL text', () => {
    const text = 'line one\r\nline two /Users/someone/x\r\nline three'
    const [hit] = scanMachinePaths(text)
    // Offsets must survive CRLF: normalizing first would shift every position
    // after the first line ending and point the caller at the wrong column.
    assert.equal(text.slice(hit.index, hit.index + hit.match.length), '/Users/someone')
    assert.equal(hit.line, 2)
  })

  test('the redaction keeps the structural prefix and masks the account name', () => {
    const [hit] = scanMachinePaths('/Users/someone/x')
    assert.equal(hit.redacted, '/Users/****eone')
    assert.ok(!hit.redacted.includes('someone'))
  })

  test('a short account name is masked entirely', () => {
    const [hit] = scanMachinePaths('/home/abc/x')
    assert.equal(hit.redacted, '/home/****')
  })

  test('paths that only look like home paths are left alone', () => {
    const clean = [
      '/usr/home/shared/data',
      'https://example.com/Users/someone',
      '/var/lib/thing',
      'no paths here at all',
    ]
    for (const text of clean) {
      assert.deepEqual(scanMachinePaths(text), [], `false positive on ${text}`)
    }
  })

  test('every home path in a multi-line document is reported, in order', () => {
    const text = ['a /Users/alpha/x', 'b', 'c /home/bravo/y'].join('\n')
    const hits = scanMachinePaths(text)
    assert.deepEqual(hits.map((h) => h.match), ['/Users/alpha', '/home/bravo'])
    assert.deepEqual(hits.map((h) => h.line), [1, 3])
  })
})

// ==========================================================================
// scanMachinePaths — private IPs
// ==========================================================================

describe('scanMachinePaths — private IPs', () => {
  test('POSITIVE CONTROL: every private range is flagged', () => {
    for (const ip of ['10.0.0.5', '10.255.255.254', '192.168.1.42', '172.16.0.1', '172.31.255.254']) {
      const hits = scanMachinePaths(`host = ${ip}`)
      assert.equal(hits.length, 1, `missed ${ip}`)
      assert.equal(hits[0].kind, 'private-ip')
      assert.equal(hits[0].match, ip)
    }
  })

  test('public, loopback, and near-miss addresses are not flagged', () => {
    const clean = [
      '8.8.8.8',
      '127.0.0.1', // loopback identifies nobody; flagging it would be noise
      '172.15.0.1',
      '172.32.0.1',
      '193.168.1.1',
      '1.2.3.4',
    ]
    for (const ip of clean) {
      assert.deepEqual(scanMachinePaths(`host = ${ip}`), [], `false positive on ${ip}`)
    }
  })

  test('version-like and over-long numbers are not mistaken for addresses', () => {
    assert.deepEqual(scanMachinePaths('v10.0.0.5 released'), [])
    assert.deepEqual(scanMachinePaths('10.999.1.2'), [], 'octet 999 is not an address')
    assert.deepEqual(scanMachinePaths('10.0.0.5.6'), [], 'five groups is not an address')
  })

  test('the redaction drops the host octets entirely', () => {
    const [hit] = scanMachinePaths('192.168.1.42')
    assert.equal(hit.redacted, '192.168.x.x')
    assert.ok(!hit.redacted.includes('42'))
  })

  test('an address in a URL with a port is still found', () => {
    const [hit] = scanMachinePaths('http://192.168.1.42:8080/health')
    assert.equal(hit.match, '192.168.1.42')
  })
})

// ==========================================================================
// scanMachinePaths — caller-supplied identifiers
// ==========================================================================

describe('scanMachinePaths — identifiers', () => {
  test('POSITIVE CONTROL: a supplied email is flagged wherever it appears', () => {
    const text = 'contact: dev@example.invalid\nand again DEV@EXAMPLE.INVALID'
    const hits = scanMachinePaths(text, { extraIdentifiers: ['dev@example.invalid'] })
    assert.equal(hits.length, 2)
    assert.ok(hits.every((h) => h.kind === 'identifier'))
    assert.deepEqual(hits.map((h) => h.line), [1, 2])
  })

  test('an identifier that is absent produces nothing', () => {
    assert.deepEqual(scanMachinePaths('nothing to see', { extraIdentifiers: ['dev@example.invalid'] }), [])
  })

  test('identifiers are matched literally, not as patterns', () => {
    // A dot in a username must not become "any character", or one identifier
    // starts matching a hundred unrelated strings.
    assert.deepEqual(scanMachinePaths('axb', { extraIdentifiers: ['a.b'] }), [])
    assert.equal(scanMachinePaths('a.b', { extraIdentifiers: ['a.b'] }).length, 1)
  })

  test('an unusable identifier list is ignored rather than fatal', () => {
    // An empty needle would compile to a regex that matches at every offset.
    assert.deepEqual(scanMachinePaths('some text', { extraIdentifiers: [''] }), [])
    assert.deepEqual(scanMachinePaths('some text', { extraIdentifiers: ['  '] }), [])
    assert.deepEqual(scanMachinePaths('some text', { extraIdentifiers: ['ab'] }), [])
    assert.deepEqual(scanMachinePaths('some text', { extraIdentifiers: [null, 42, {}] }), [])
    assert.deepEqual(scanMachinePaths('some text', { extraIdentifiers: 'not-an-array' }), [])
  })

  test('the redaction hides the identifier', () => {
    const [hit] = scanMachinePaths('user someone', { extraIdentifiers: ['someone'] })
    assert.equal(hit.redacted, '****eone')
  })

  test('an identifier overlapping a home path is reported as its own kind', () => {
    const hits = scanMachinePaths('/Users/someone/x', { extraIdentifiers: ['someone'] })
    assert.deepEqual(hits.map((h) => h.kind).sort(), ['home-path', 'identifier'])
  })
})

// ==========================================================================
// scanMachinePaths — robustness
// ==========================================================================

describe('scanMachinePaths — robustness', () => {
  test('junk input returns an empty array instead of throwing', () => {
    for (const bad of [undefined, null, 42, {}, [], '']) {
      assert.deepEqual(scanMachinePaths(bad), [])
    }
  })

  test('findings come back sorted by position', () => {
    const text = '10.0.0.1 then /Users/someone then 192.168.0.9'
    const hits = scanMachinePaths(text, { extraIdentifiers: ['someone'] })
    const positions = hits.map((h) => h.index)
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b))
  })

  test('the same needle supplied twice is not reported twice', () => {
    const hits = scanMachinePaths('someone', { extraIdentifiers: ['someone', 'someone'] })
    assert.equal(hits.length, 1)
  })

  test('repeated calls do not leak regex state between them', () => {
    // Module-level regexes carry lastIndex; forgetting to reset it makes the
    // second call silently miss everything before the previous match.
    const text = '/Users/someone/a /Users/other/b'
    assert.equal(scanMachinePaths(text).length, 2)
    assert.equal(scanMachinePaths(text).length, 2)
  })
})

// ==========================================================================
// probeScanners
// ==========================================================================

describe('probeScanners', () => {
  test('reports each scanner as null or an available version', async () => {
    const p = await probeScanners()
    for (const name of ['gitleaks', 'trufflehog']) {
      assert.ok(name in p)
      if (p[name] !== null) {
        assert.equal(p[name].available, true)
        assert.equal(typeof p[name].version, 'string')
      }
    }
  })

  test('POSITIVE CONTROL: a binary that does not exist probes as null', async () => {
    const p = await probeScanners({
      bins: { gitleaks: 'caselaw-no-such-gitleaks', trufflehog: 'caselaw-no-such-trufflehog' },
    })
    assert.equal(p.gitleaks, null)
    assert.equal(p.trufflehog, null)
  })

  test('results are cached per process, and force re-probes', async () => {
    const a = await probeScanners()
    const b = await probeScanners()
    assert.equal(a.gitleaks, b.gitleaks, 'cache should hand back the same resolved value')
    assert.equal(a.trufflehog, b.trufflehog)

    resetProbeCache()
    const c = await probeScanners({ force: true })
    assert.deepEqual(Object.keys(c).sort(), ['gitleaks', 'trufflehog'])
  })

  test('an injected fake binary is probed independently of the real one', NEEDS_SHELL, async () => {
    const bin = await fakeBin('fake-gitleaks', '#!/bin/sh\necho "8.1.2"\nexit 0\n')
    const p = await probeScanners({ bins: { gitleaks: bin } })
    assert.deepEqual(p.gitleaks, { available: true, version: '8.1.2' })
  })
})

// ==========================================================================
// scanWorkingTree — degradation
// ==========================================================================

describe('scanWorkingTree — degradation', () => {
  test('POSITIVE CONTROL: an unavailable tool degrades, succeeds, and does not throw', async () => {
    const r = await scanWorkingTree(root, { bin: 'caselaw-no-such-gitleaks' })
    assert.equal(r.ok, true, 'a missing tool must never block')
    assert.equal(r.degraded, true, 'a missing tool must never look like a clean scan')
    assert.deepEqual(r.findings, [])
    assert.match(r.reason, /not installed/)
    assert.ok(r.hint.length > 0, 'degradation must tell the user how to fix it')
    assert.equal(r.tool, 'gitleaks')
  })

  test('a missing root degrades rather than throwing', async () => {
    for (const bad of [undefined, '', null]) {
      const r = await scanWorkingTree(bad)
      assert.equal(r.ok, true)
      assert.equal(r.degraded, true)
    }
  })

  test('POSITIVE CONTROL: an unparseable report degrades instead of being guessed at', NEEDS_SHELL, async () => {
    const bin = await fakeBin(
      'gitleaks-garbage',
      [
        '#!/bin/sh',
        'if [ "$1" = "version" ]; then echo "9.9.9"; exit 0; fi',
        'prev=""',
        'for a in "$@"; do',
        '  if [ "$prev" = "--report-path" ]; then report="$a"; fi',
        '  prev="$a"',
        'done',
        'printf "this is not json {" > "$report"',
        'exit 2',
      ].join('\n') + '\n',
    )
    const r = await scanWorkingTree(root, { bin })
    assert.equal(r.ok, true)
    assert.equal(r.degraded, true)
    assert.match(r.reason, /not valid JSON/)
    assert.deepEqual(r.findings, [])
  })

  test('POSITIVE CONTROL: a malformed report cannot leak the secret through the error path', NEEDS_SHELL, async () => {
    // The subtle one. V8's JSON.parse quotes the first ten characters of bad
    // input into its message; if a report is corrupt AND begins with the
    // credential, passing err.message through to `reason` publishes it. Ten
    // characters is the entirety of a short credential.
    const bin = await fakeBin(
      'gitleaks-leaky',
      [
        '#!/bin/sh',
        'if [ "$1" = "version" ]; then echo "9.9.9"; exit 0; fi',
        'prev=""',
        'for a in "$@"; do',
        '  if [ "$prev" = "--report-path" ]; then report="$a"; fi',
        '  prev="$a"',
        'done',
        `printf '%s' '${PLANTED} truncated' > "$report"`,
        'exit 2',
      ].join('\n') + '\n',
    )
    const r = await scanWorkingTree(root, { bin })
    assert.equal(r.degraded, true)
    const serialized = JSON.stringify(r)
    assert.ok(!serialized.includes(PLANTED), 'the degraded result leaked the whole secret')
    assert.ok(
      !serialized.includes(PLANTED.slice(0, 10)),
      'the degraded result leaked a prefix of the secret through the parse error',
    )
  })

  test('POSITIVE CONTROL: a tool error (exit 1) is not mistaken for findings', NEEDS_SHELL, async () => {
    // gitleaks exits 1 for a fatal error AND, by default, for findings. We pass
    // --exit-code 2 precisely so the two can be told apart; this proves it.
    const bin = await fakeBin(
      'gitleaks-broken',
      '#!/bin/sh\nif [ "$1" = "version" ]; then echo "9.9.9"; exit 0; fi\necho "FTL config error" >&2\nexit 1\n',
    )
    const r = await scanWorkingTree(root, { bin })
    assert.equal(r.ok, true)
    assert.equal(r.degraded, true)
    assert.match(r.reason, /exited 1/)
    assert.match(r.reason, /config error/)
  })

  test('a hung tool is killed and degrades with a timeout reason', NEEDS_SHELL, async () => {
    const bin = await fakeBin(
      'gitleaks-hang',
      '#!/bin/sh\nif [ "$1" = "version" ]; then echo "9.9.9"; exit 0; fi\nsleep 30\n',
    )
    const r = await scanWorkingTree(root, { bin, timeoutMs: 300 })
    assert.equal(r.ok, true)
    assert.equal(r.degraded, true)
    assert.match(r.reason, /timed out/)
  })
})

// ==========================================================================
// scanWorkingTree — findings
// ==========================================================================

describe('scanWorkingTree — findings', () => {
  /** A stand-in emitting the real gitleaks JSON report shape, so the mapping
   *  and redaction paths are exercised on every machine, not just ours. */
  async function fakeReportingGitleaks() {
    return fakeBin(
      'gitleaks-finds',
      [
        '#!/bin/sh',
        'if [ "$1" = "version" ]; then echo "8.30.1"; exit 0; fi',
        'prev=""',
        'for a in "$@"; do',
        '  if [ "$prev" = "--report-path" ]; then report="$a"; fi',
        '  prev="$a"',
        '  last="$a"',
        'done',
        'cat > "$report" <<JSON',
        '[{"RuleID":"github-pat","StartLine":3,"Match":"token = \\"' + PLANTED + '\\"",',
        '  "Secret":"' + PLANTED + '","File":"$last/planted.env","Commit":"","Entropy":5.2}]',
        'JSON',
        'exit 2',
      ].join('\n') + '\n',
    )
  }

  test('a finding is mapped to the public shape with a repo-relative path', NEEDS_SHELL, async () => {
    const bin = await fakeReportingGitleaks()
    const r = await scanWorkingTree(root, { bin })
    assert.equal(r.degraded, false)
    assert.equal(r.ok, false, 'findings must not report ok')
    assert.equal(r.findings.length, 1)
    assert.deepEqual(r.findings[0], {
      rule: 'github-pat',
      path: 'planted.env',
      line: 3,
      redactedMatch: '****WxYz',
      tool: 'gitleaks',
    })
  })

  test('POSITIVE CONTROL: the planted secret never appears in the returned result', NEEDS_SHELL, async () => {
    const bin = await fakeReportingGitleaks()
    const r = await scanWorkingTree(root, { bin })
    const serialized = JSON.stringify(r)
    assert.ok(
      !serialized.includes(PLANTED),
      'a finding leaked the full secret into a value that gets printed and pasted',
    )
    assert.ok(serialized.includes('****WxYz'), 'and it should still be recognisable')
  })

  test('an empty report is a clean, non-degraded pass', NEEDS_SHELL, async () => {
    const bin = await fakeBin(
      'gitleaks-clean',
      [
        '#!/bin/sh',
        'if [ "$1" = "version" ]; then echo "8.30.1"; exit 0; fi',
        'prev=""',
        'for a in "$@"; do',
        '  if [ "$prev" = "--report-path" ]; then report="$a"; fi',
        '  prev="$a"',
        'done',
        'printf "[]" > "$report"',
        'exit 0',
      ].join('\n') + '\n',
    )
    const r = await scanWorkingTree(root, { bin })
    assert.equal(r.ok, true)
    assert.equal(r.degraded, false)
    assert.deepEqual(r.findings, [])
  })
})

// ==========================================================================
// scanWorkingTree — against the real gitleaks, when it is here
// ==========================================================================

describe('scanWorkingTree — real gitleaks', () => {
  test('POSITIVE CONTROL: a planted secret in the working tree IS found', async (t) => {
    if (!scanners.gitleaks) {
      const r = await scanWorkingTree(root)
      assert.equal(r.ok, true)
      assert.equal(r.degraded, true)
      assert.match(r.reason, /not installed/)
      return t.skip('gitleaks not installed — asserted the degraded contract instead')
    }
    await put('planted.env', `# config\nGITHUB_TOKEN = "${PLANTED}"\n`)
    const r = await scanWorkingTree(root)
    assert.equal(r.degraded, false)
    assert.equal(r.ok, false, 'gitleaks must fire on a planted GitHub PAT')
    assert.ok(r.findings.some((f) => f.path === 'planted.env'))
    assert.ok(!JSON.stringify(r).includes(PLANTED), 'the real scan must redact too')
  })

  test('a clean tree passes without degrading', async (t) => {
    if (!scanners.gitleaks) return t.skip('gitleaks not installed')
    await put('README.md', '# nothing to see here\n')
    const r = await scanWorkingTree(root)
    assert.equal(r.degraded, false)
    assert.equal(r.ok, true)
    assert.deepEqual(r.findings, [])
  })
})

// ==========================================================================
// scanHistory — degradation
// ==========================================================================

describe('scanHistory — degradation', () => {
  test('POSITIVE CONTROL: an unavailable tool degrades, succeeds, and does not throw', async () => {
    await gitRepo(root)
    const r = await scanHistory(root, { bin: 'caselaw-no-such-trufflehog' })
    assert.equal(r.ok, true)
    assert.equal(r.degraded, true)
    assert.deepEqual(r.findings, [])
    assert.match(r.reason, /not installed/)
    assert.ok(r.hint.length > 0)
    assert.equal(r.tool, 'trufflehog')
  })

  test('POSITIVE CONTROL: a directory with no history degrades instead of passing silently', async (t) => {
    if (!scanners.trufflehog) return t.skip('trufflehog not installed')
    const r = await scanHistory(root)
    assert.equal(r.ok, true)
    assert.equal(r.degraded, true)
    assert.match(r.reason, /not a git repository/)
  })

  test('POSITIVE CONTROL: an unparseable JSON line degrades instead of reporting a partial result', NEEDS_SHELL, async () => {
    await gitRepo(root)
    const bin = await fakeBin(
      'trufflehog-garbage',
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "trufflehog 9.9.9"; exit 0; fi',
        'echo "{\\"DetectorName\\": TRUNCATED"',
        'exit 183',
      ].join('\n') + '\n',
    )
    const r = await scanHistory(root, { bin })
    assert.equal(r.ok, true)
    assert.equal(r.degraded, true)
    assert.match(r.reason, /unparseable/)
    assert.deepEqual(r.findings, [])
  })

  test('a tool error is not mistaken for a clean history', NEEDS_SHELL, async () => {
    await gitRepo(root)
    const bin = await fakeBin(
      'trufflehog-broken',
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "trufflehog 9.9.9"; exit 0; fi\necho "bad uri" >&2\nexit 1\n',
    )
    const r = await scanHistory(root, { bin })
    assert.equal(r.degraded, true)
    assert.match(r.reason, /exited 1/)
  })
})

// ==========================================================================
// scanHistory — findings
// ==========================================================================

describe('scanHistory — findings', () => {
  async function fakeReportingTrufflehog(verified) {
    const record = JSON.stringify({
      SourceMetadata: { Data: { Git: { commit: 'deadbeef', file: 'planted.env', line: 2 } } },
      DetectorName: 'Github',
      Verified: verified,
      Raw: PLANTED,
      RawV2: '',
    })
    return fakeBin(
      'trufflehog-finds',
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "trufflehog 3.96.0"; exit 0; fi',
        `cat <<'JSON'`,
        record,
        'JSON',
        'exit 183',
      ].join('\n') + '\n',
    )
  }

  test('a verified finding is mapped to the public shape', NEEDS_SHELL, async () => {
    await gitRepo(root)
    const bin = await fakeReportingTrufflehog(true)
    const r = await scanHistory(root, { bin })
    assert.equal(r.degraded, false)
    assert.equal(r.ok, false)
    assert.deepEqual(r.findings, [
      {
        rule: 'Github',
        path: 'planted.env',
        line: 2,
        redactedMatch: '****WxYz',
        tool: 'trufflehog',
        verified: true,
        commit: 'deadbeef',
      },
    ])
  })

  test('POSITIVE CONTROL: the planted secret never appears in the returned result', NEEDS_SHELL, async () => {
    await gitRepo(root)
    const bin = await fakeReportingTrufflehog(true)
    const r = await scanHistory(root, { bin })
    assert.ok(!JSON.stringify(r).includes(PLANTED), 'a history finding leaked the full secret')
  })

  test('POSITIVE CONTROL: an unverified result is dropped from the publication gate', NEEDS_SHELL, async () => {
    // The gate exists to answer "is this key still live". A tool that ignored
    // --only-verified would otherwise turn every historical candidate into a
    // blocker, and the gate would be switched off within a day.
    await gitRepo(root)
    const bin = await fakeReportingTrufflehog(false)
    const r = await scanHistory(root, { bin })
    assert.equal(r.degraded, false)
    assert.equal(r.ok, true)
    assert.deepEqual(r.findings, [])

    const loose = await scanHistory(root, { bin, onlyVerified: false })
    assert.equal(loose.findings.length, 1, 'onlyVerified:false must still report it')
    assert.equal(loose.findings[0].verified, false)
  })
})

// ==========================================================================
// scanHistory — against the real trufflehog, when it is here
// ==========================================================================

describe('scanHistory — real trufflehog', () => {
  test('POSITIVE CONTROL: a secret only present in HISTORY is still found', async (t) => {
    if (!scanners.trufflehog) {
      await gitRepo(root)
      const r = await scanHistory(root)
      assert.equal(r.ok, true)
      assert.equal(r.degraded, true)
      return t.skip('trufflehog not installed — asserted the degraded contract instead')
    }
    await gitRepo(root)
    await put('planted.env', `GITHUB_TOKEN = "${PLANTED}"\n`)
    await commitAll(root, 'oops')
    await rm(join(root, 'planted.env'))
    await put('README.md', '# clean now\n')
    await commitAll(root, 'remove the secret (but not from history)')

    // --no-verification keeps this offline and deterministic. The point being
    // proved is that the scan reaches deleted content in past commits at all.
    const r = await scanHistory(root, { onlyVerified: false, timeoutMs: 120_000 })
    if (r.degraded) return t.skip(`trufflehog degraded: ${r.reason}`)
    assert.ok(r.findings.length > 0, 'a deleted-but-committed secret must still be found')
    assert.ok(r.findings.some((f) => f.path === 'planted.env'))
    assert.ok(!JSON.stringify(r).includes(PLANTED), 'the real scan must redact too')
  })

  test('a fake credential is not verified, so the publication gate passes', async (t) => {
    if (!scanners.trufflehog) return t.skip('trufflehog not installed')
    await gitRepo(root)
    await put('planted.env', `GITHUB_TOKEN = "${PLANTED}"\n`)
    await commitAll(root, 'planted')

    const r = await scanHistory(root, { timeoutMs: 120_000 })
    assert.equal(r.ok, true, 'a dead credential must not block publication')
    assert.ok(!JSON.stringify(r).includes(PLANTED))
  })

  test('POSITIVE CONTROL: a shallow clone is called out, not silently passed', async (t) => {
    if (!scanners.trufflehog) return t.skip('trufflehog not installed')
    const origin = join(root, 'origin')
    const shallow = join(root, 'shallow')
    await mkdir(origin, { recursive: true })
    await gitRepo(origin)
    await writeFile(join(origin, 'a.txt'), 'one\n', 'utf8')
    await commitAll(origin, 'one')
    await writeFile(join(origin, 'a.txt'), 'two\n', 'utf8')
    await commitAll(origin, 'two')
    // A local path clone ignores --depth; the file:// URL is what makes it
    // genuinely shallow, which is the same trap as a default CI checkout.
    await exec('git', ['clone', '-q', '--depth', '1', `file://${origin}`, shallow])

    const r = await scanHistory(shallow, { onlyVerified: false, timeoutMs: 120_000 })
    if (r.degraded) return t.skip(`trufflehog degraded: ${r.reason}`)
    assert.match(r.warning ?? '', /shallow/, 'a one-commit clone must not pass as "full history"')
    assert.match(r.warning ?? '', /fetch-depth/)
  })
})
