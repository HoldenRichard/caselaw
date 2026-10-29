import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detect } from '../../src/detect/index.js'
import { detectStack, generatedDocRoots } from '../../src/detect/stack.js'
import { detectSignals, manifestsIn, goRequires } from '../../src/detect/signals.js'
import { tomlTable, tomlString, tomlStrings } from '../../src/detect/toml.js'
import { boundaryCandidates } from '../../src/interview/questions.js'
import { BOUNDARY_LABELS } from '../../src/generate/authority-split.js'

/**
 * DEF-274: on ntfy, homebridge and pyvisa the generated docs scored 1/5 for
 * specificity. These fixtures carry the shape of each of those repositories
 * that the detection got wrong.
 */

const OFFLINE = { gh: false, xcode: false, timeoutMs: 8000 }

let root
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'caselaw-signals-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function put(rel, content = '') {
  const abs = join(root, rel)
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, content, 'utf8')
}

const PYVISA_PYPROJECT = `[project]
  name = "PyVISA"
  description = "Python VISA bindings for GPIB, RS232, TCPIP and USB instruments"
  keywords = ["VISA", "GPIB", "USB", "serial", "RS232", "measurement", "acquisition"]
  classifiers = [
    "Topic :: Scientific/Engineering :: Interface Engine/Protocol Translator",
    "Topic :: Software Development :: Libraries :: Python Modules",
  ]
  dependencies = ["typing_extensions>=4.0.0"]

[tool.other]
name = "not-the-project"
`

const HOMEBRIDGE_PACKAGE = JSON.stringify({
  name: 'homebridge', version: '2.0.0', main: 'lib/index.js', bin: { homebridge: 'bin/homebridge.js' },
  dependencies: { '@homebridge/hap-nodejs': '^2.0.0', '@matter/main': '^0.15.0', chalk: '^5.0.0' },
})

const NTFY_GOMOD = `module heckel.io/ntfy/v2

go 1.24

require (
\tfirebase.google.com/go/v4 v4.22.0
\tgithub.com/emersion/go-smtp v0.25.0
\tgithub.com/jackc/pgx/v5 v5.11.0
\tgithub.com/mattn/go-sqlite3 v1.14.52
\tgithub.com/urfave/cli/v2 v2.27.7
)

replace github.com/emersion/go-smtp => github.com/emersion/go-smtp v0.17.0
`

describe('toml: a manifest table is read by its body, not by line starts', () => {
  test('POSITIVE CONTROL: an indented `name` under [project] is found (pyvisa was titled after its directory)', async () => {
    await put('pyproject.toml', PYVISA_PYPROJECT)
    await put('pyvisa/__init__.py', '')
    const { stack } = await detectStack(root, OFFLINE)
    assert.equal(stack.projectName, 'PyVISA')
  })

  test('a key in a later table is never read as the project\'s', () => {
    const body = tomlTable('[project]\nversion = "1"\n[tool.other]\nname = "wrong"\n', 'project')
    assert.equal(tomlString(body, 'name'), null)
  })

  test('a missing table is null, and multi-line arrays are read whole', () => {
    assert.equal(tomlTable('[package]\nname = "x"\n', 'project'), null)
    const kw = tomlStrings(tomlTable(PYVISA_PYPROJECT, 'project'), 'keywords')
    assert.deepEqual(kw, ['VISA', 'GPIB', 'USB', 'serial', 'RS232', 'measurement', 'acquisition'])
  })
})

describe('the census leaves generated documentation out', () => {
  async function homebridgeShape() {
    await put('package.json', HOMEBRIDGE_PACKAGE)
    for (const f of ['src/api.ts', 'src/server.ts', 'src/bridge.ts']) await put(f, '')
    await put('docs/.nojekyll', '')
    await put('docs/index.html', '<html></html>')
    for (const f of ['search.js', 'navigation.js', 'main.js', 'style.css']) await put(`docs/assets/${f}`, '')
    for (let i = 0; i < 8; i++) await put(`docs/types/T${i}.html`, '<html></html>')
  }

  test('POSITIVE CONTROL: TypeDoc output under docs/ does not make a TypeScript project read as HTML', async () => {
    await homebridgeShape()
    const { stack, warnings } = await detectStack(root, OFFLINE)
    assert.equal(stack.languages[0].name, 'TypeScript', JSON.stringify(stack.languages))
    assert.equal(stack.languages.find((l) => l.name === 'HTML'), undefined)
    assert.equal(stack.languages.find((l) => l.name === 'JavaScript'), undefined, 'the generator\'s own scripts are its output too')
    assert.deepEqual(stack.generatedDocs, [{ path: 'docs', generator: 'TypeDoc' }])
    assert.ok(warnings.some((w) => w.code === 'generated-docs'), 'leaving files out is said, not done silently')
  })

  test('hand-written HTML with no generator layout still counts', async () => {
    await put('web/index.html', '<html></html>')
    await put('web/app.js', '')
    const { stack } = await detectStack(root, OFFLINE)
    assert.ok(stack.languages.some((l) => l.name === 'HTML'))
    assert.deepEqual(stack.generatedDocs, [])
  })

  test('the repository root is never excluded, even when it is itself a generated site', () => {
    assert.deepEqual(generatedDocRoots(['assets/search.js', 'assets/navigation.js', 'index.html']), [])
  })

  test('only the outermost generated root is reported', () => {
    const files = ['site/assets/search.js', 'site/assets/navigation.js', 'site/v1/assets/search.js', 'site/v1/assets/navigation.js']
    assert.deepEqual(generatedDocRoots(files), [{ path: 'site', generator: 'TypeDoc' }])
  })
})

describe('signals: what the manifests declare', () => {
  test('pyvisa: hardware from its own keywords, and a PyPI registry', async () => {
    await put('pyproject.toml', PYVISA_PYPROJECT)
    const { signals } = await detectSignals(root, { files: ['pyproject.toml'] })
    assert.deepEqual(signals.hardware.map((s) => s.signal), ['GPIB', 'USB', 'RS232'])
    assert.ok(signals.hardware.every((s) => s.source === 'pyproject.toml [project] keywords'), 'every signal names where it came from')
    assert.deepEqual(signals.registries, [{ kind: 'pypi', source: 'pyproject.toml' }])
    assert.deepEqual(signals.datastore, [])
  })

  test('homebridge: pairing with a controller, not hardware, from the HomeKit and Matter libraries; and an npm registry', async () => {
    // These were counted as hardware until the DEF-274 reviewer pointed out that
    // homebridge's core talks to controllers (Apple Home, a Matter controller).
    await put('package.json', HOMEBRIDGE_PACKAGE)
    const { signals } = await detectSignals(root, { files: ['package.json'] })
    assert.deepEqual(signals.pairing.map((s) => s.signal), ['@homebridge/hap-nodejs', '@matter/main'])
    assert.deepEqual(signals.hardware, [])
    assert.deepEqual(signals.registries.map((r) => r.kind), ['npm'])
    assert.ok(boundaryCandidates({ signals }).some((o) => o.value === 'pair-controller'))
    assert.ok(!boundaryCandidates({ signals }).some((o) => o.value === 'hardware'))
  })

  test('ntfy: a datastore, message delivery, and a release pipeline', async () => {
    await put('go.mod', NTFY_GOMOD)
    await put('.goreleaser.yml', 'builds: []\n')
    const { signals } = await detectSignals(root, { files: ['go.mod', '.goreleaser.yml'] })
    assert.deepEqual(signals.datastore.map((s) => s.signal), ['github.com/jackc/pgx/v5', 'github.com/mattn/go-sqlite3'])
    assert.deepEqual(signals.messaging.map((s) => s.signal), ['firebase.google.com/go/v4', 'github.com/emersion/go-smtp'])
    assert.deepEqual(signals.registries.map((r) => r.kind), ['goreleaser'])
    assert.deepEqual(signals.hardware, [])
  })

  test('an app is not a published package: private, or nothing to import or run', async () => {
    await put('package.json', JSON.stringify({ name: 'web', version: '1.0.0', private: true, main: 'x.js' }))
    await put('app/package.json', JSON.stringify({ name: 'app', version: '1.0.0' }))
    const { signals } = await detectSignals(root, { files: ['package.json', 'app/package.json'] })
    assert.deepEqual(signals.registries, [])
  })

  test('a crate marked publish = false is not a registry; embedded categories are hardware', async () => {
    await put('Cargo.toml', '[package]\nname = "fw"\npublish = false\ncategories = ["embedded", "no-std"]\n[dependencies]\nembedded-hal = "1"\n')
    const { signals } = await detectSignals(root, { files: ['Cargo.toml'] })
    assert.deepEqual(signals.registries, [])
    assert.deepEqual(signals.hardware.map((s) => s.signal).sort(), ['embedded', 'embedded-hal'])
  })

  test('requirements.txt names are normalized before matching (RPi.GPIO, pyserial)', async () => {
    await put('requirements.txt', 'RPi.GPIO==0.7.1\npyserial>=3.5  # the port\n-r other.txt\n')
    const { signals } = await detectSignals(root, { files: ['requirements.txt'] })
    assert.deepEqual(signals.hardware.map((s) => s.signal), ['RPi.GPIO', 'pyserial'])
  })

  test('manifests in example and test trees describe the example, and are not read', () => {
    assert.deepEqual(manifestsIn(['package.json', 'examples/web/package.json', 'test/fixtures/go.mod', 'packages/a/package.json']),
      ['package.json', 'packages/a/package.json'])
  })

  test('go.mod require lines and blocks are read; replace and module lines are not', () => {
    assert.deepEqual(goRequires(NTFY_GOMOD), [
      'firebase.google.com/go/v4', 'github.com/emersion/go-smtp', 'github.com/jackc/pgx/v5',
      'github.com/mattn/go-sqlite3', 'github.com/urfave/cli/v2',
    ])
    assert.deepEqual(goRequires('module x\nrequire github.com/a/b v1.2.3\n'), ['github.com/a/b'])
  })
})

describe('boundary options follow the signals', () => {
  const lib = { stack: { languages: [{ name: 'Python' }] }, deploySurface: [] }

  test('POSITIVE CONTROL: a hardware library is offered the hardware boundary', () => {
    const values = boundaryCandidates({ ...lib, signals: { hardware: [{ signal: 'GPIB', source: 'x' }] } }).map((o) => o.value)
    assert.ok(values.includes('hardware'))
  })

  test('POSITIVE CONTROL: a library with no datastore is not asked about production data, migrations, customer data or delivery', () => {
    const values = boundaryCandidates(lib).map((o) => o.value)
    for (const v of ['prod-data', 'migrations', 'real-user-data', 'delivery', 'hardware']) assert.ok(!values.includes(v), v)
  })

  test('a datastore brings the data questions back; message delivery brings delivery', () => {
    const values = boundaryCandidates({ ...lib, signals: { datastore: [{}], messaging: [{}] } }).map((o) => o.value)
    for (const v of ['prod-data', 'migrations', 'real-user-data', 'delivery']) assert.ok(values.includes(v), v)
  })

  test('a published package is asked about its registry console', () => {
    const values = boundaryCandidates({ ...lib, signals: { registries: [{ kind: 'pypi' }] } }).map((o) => o.value)
    assert.ok(values.includes('release-console'))
  })

  test('every boundary any signal can offer has a label to render', () => {
    const all = boundaryCandidates({
      stack: { languages: [{ name: 'Swift' }] },
      deploySurface: [{ kind: 'fly' }],
      secretSurface: [{ path: '.env' }],
      signals: { hardware: [{}], datastore: [{}], messaging: [{}], registries: [{}] },
    })
    for (const o of all) assert.ok(BOUNDARY_LABELS[o.value], `"${o.value}" has no label`)
  })
})

describe('detect() carries the signals', () => {
  test('the full report has a signals group, empty but present for an empty tree', async () => {
    const report = await detect(root, OFFLINE)
    assert.deepEqual(report.signals, { hardware: [], pairing: [], datastore: [], messaging: [], registries: [], stores: [], claims: [], manifests: [] })
  })

  test('end to end: pyvisa is offered hardware and a registry console, and no production database', async () => {
    await put('pyproject.toml', PYVISA_PYPROJECT)
    await put('pyvisa/highlevel.py', '')
    const report = await detect(root, OFFLINE)
    const values = boundaryCandidates(report).map((o) => o.value)
    assert.ok(values.includes('hardware'))
    assert.ok(values.includes('release-console'))
    assert.ok(!values.includes('prod-data'))
  })
})
