/**
 * What a project's own manifests say it reaches beyond the repository: the
 * hardware it drives, the datastore it keeps, the messages it delivers, and
 * the registry it publishes to.
 *
 * DEF-274: on three outside repositories the interview offered everyone the
 * same generic boundaries. pyvisa, a library for driving lab instruments, was
 * asked about production databases and never about hardware; homebridge, which
 * exists to talk to smart-home accessories, had no hardware option either.
 * Their manifests already said which boundaries were real.
 *
 * Every signal keeps the manifest and field it came from, so a boundary the
 * interview offers on its strength can be traced rather than taken on trust.
 * Manifests at the root and up to two levels down are read (a monorepo keeps
 * its packages there); sample and test trees are skipped, because an example
 * app's dependencies describe the example. Nothing is executed.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tomlTable, tomlString, tomlStrings, tomlKeys } from './toml.js'

const MAX_MANIFESTS = 30
const MAX_EVIDENCE = 5
const SKIP_DIRS = new Set(['example', 'examples', 'sample', 'samples', 'test', 'tests', 'fixtures', '__fixtures__', 'docs'])

/**
 * Dependency names that only make sense next to the thing they name. An entry
 * ending in `/` is a prefix (an npm scope, a Go module path); Go entries are
 * always prefixes, because a module path carries its major version.
 */
const DEPS = {
  hardware: {
    npm: ['serialport', '@serialport/', 'node-hid', 'usb', 'noble', '@abandonware/noble', '@abandonware/bleno',
      'johnny-five', 'onoff', 'rpio', 'i2c-bus', 'spi-device'],
    python: ['pyserial', 'pyusb', 'pyvisa', 'pyvisa-py', 'gpib-ctypes', 'bleak', 'pybluez', 'rpi-gpio', 'gpiozero',
      'smbus2', 'spidev', 'adafruit-blinka', 'hidapi', 'nidaqmx', 'pymodbus', 'pyftdi'],
    cargo: ['serialport', 'rusb', 'btleplug', 'embedded-hal', 'rppal', 'hidapi', 'probe-rs'],
    go: ['go.bug.st/serial', 'github.com/tarm/serial', 'periph.io/x/', 'tinygo.org/x/', 'github.com/google/gousb',
      'github.com/stianeikeland/go-rpio'],
  },
  datastore: {
    npm: ['pg', 'mysql', 'mysql2', 'mongodb', 'mongoose', 'redis', 'ioredis', 'sqlite3', 'better-sqlite3', 'prisma',
      '@prisma/client', 'typeorm', 'sequelize', 'knex', 'drizzle-orm', 'firebase-admin', '@supabase/supabase-js',
      '@planetscale/database', '@neondatabase/serverless', '@aws-sdk/client-dynamodb'],
    python: ['psycopg2', 'psycopg2-binary', 'psycopg', 'sqlalchemy', 'django', 'pymongo', 'motor', 'redis', 'alembic',
      'peewee', 'asyncpg', 'aiosqlite', 'tortoise-orm', 'firebase-admin', 'supabase'],
    cargo: ['sqlx', 'diesel', 'postgres', 'tokio-postgres', 'rusqlite', 'mongodb', 'redis', 'sea-orm'],
    go: ['github.com/lib/pq', 'github.com/jackc/pgx', 'github.com/mattn/go-sqlite3', 'gorm.io/',
      'go.mongodb.org/mongo-driver', 'github.com/redis/go-redis', 'github.com/go-redis/redis',
      'github.com/go-sql-driver/mysql', 'modernc.org/sqlite', 'go.etcd.io/bbolt'],
  },
  messaging: {
    npm: ['nodemailer', 'twilio', '@sendgrid/mail', 'web-push', 'apn', '@parse/node-apn', 'firebase-admin',
      'mailgun.js', 'postmark', 'resend', 'expo-server-sdk', 'node-pushnotifications'],
    python: ['twilio', 'sendgrid', 'aiosmtplib', 'firebase-admin', 'pywebpush', 'apns2', 'exponent-server-sdk',
      'resend', 'postmarker', 'django-anymail'],
    cargo: ['lettre', 'web-push', 'a2', 'fcm'],
    go: ['firebase.google.com/go', 'github.com/emersion/go-smtp', 'github.com/SherClockHolmes/webpush-go',
      'github.com/sideshow/apns2', 'github.com/twilio/twilio-go', 'github.com/sendgrid/sendgrid-go',
      'gopkg.in/gomail', 'github.com/wneessen/go-mail'],
  },
  // Smart-home protocols. These were counted as hardware until the DEF-274
  // re-score: homebridge's core talks to controllers (Apple Home, a Matter
  // controller), not to devices, and its real boundary is pairing with one.
  pairing: {
    npm: ['hap-nodejs', '@homebridge/hap-nodejs', '@matter/', '@project-chip/', 'homebridge'],
    python: ['hap-python', 'python-matter-server', 'homeassistant'],
    cargo: ['rs-matter', 'hap'],
    go: ['github.com/brutella/hap', 'github.com/brutella/hc'],
  },
}

/** Words a project uses about itself that mean it pairs with a smart-home controller. */
const PAIRING_WORDS = new Set(['homekit', 'homebridge-plugin', 'homebridge', 'matter', 'home-assistant', 'homeassistant'])

/**
 * Words a project uses about itself that mean hardware. Deliberately narrow:
 * "serial" also means serialization and "visa" also means payments, so both
 * are out; pyvisa is still caught by GPIB, USB and RS232.
 */
const HARDWARE_WORDS = new Set(['hardware', 'instrument', 'instruments', 'instrumentation', 'gpib', 'rs232', 'usb',
  'gpio', 'bluetooth', 'iot', 'embedded', 'arduino', 'raspberry-pi', 'raspberrypi', 'firmware', 'microcontroller'])
const HARDWARE_CLASSIFIERS = ['Topic :: System :: Hardware', 'Topic :: Home Automation']
const HARDWARE_CATEGORIES = new Set(['embedded', 'hardware-support'])

export function emptySignals() {
  return { hardware: [], pairing: [], datastore: [], messaging: [], registries: [], stores: [], claims: [], manifests: [] }
}

/**
 * @param {string} root
 * @param {{files: string[]}} walked
 * @returns {Promise<{signals: object, warnings: object[]}>}
 */
export async function detectSignals(root, walked) {
  const signals = emptySignals()
  const read = async (f) => { try { return await readFile(join(root, f), 'utf8') } catch { return null } }
  const add = (kind, signal, source) => {
    const list = signals[kind]
    if (list.length < MAX_EVIDENCE && !list.some((e) => e.signal === signal && e.source === source)) list.push({ signal, source })
  }
  const deps = (eco, names, source) => {
    for (const raw of names) {
      const name = eco === 'python' ? raw.toLowerCase().replace(/[._]/g, '-') : raw
      for (const kind of Object.keys(DEPS)) if (matches(DEPS[kind][eco], name, eco)) add(kind, raw, source)
    }
  }
  const words = (list, source) => {
    for (const w of list) {
      const lw = String(w).toLowerCase()
      if (HARDWARE_WORDS.has(lw)) add('hardware', w, source)
      else if (PAIRING_WORDS.has(lw)) add('pairing', w, source)
    }
  }

  for (const path of manifestsIn(walked.files)) {
    const base = path.slice(path.lastIndexOf('/') + 1)
    const text = await read(path)
    if (text === null) continue
    signals.manifests.push(path)

    if (base === 'package.json') {
      let pkg
      try { pkg = JSON.parse(text) } catch { continue }
      if (!pkg || typeof pkg !== 'object') continue
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        deps('npm', Object.keys(pkg[field] || {}), `${path} ${field}`)
      }
      if (Array.isArray(pkg.keywords)) words(pkg.keywords, `${path} keywords`)
      if (pkg.engines && typeof pkg.engines === 'object' && pkg.engines.vscode) addKind(signals.stores, 'vscode-marketplace', `${path} engines.vscode`)
      // Published, not merely named: an app's package.json has a name too.
      if (pkg.private !== true && pkg.name && pkg.version && (pkg.bin || pkg.main || pkg.exports || pkg.files || pkg.publishConfig)) {
        addRegistry(signals, 'npm', path)
      }
    } else if (base === 'pyproject.toml') {
      const project = tomlTable(text, 'project')
      deps('python', tomlStrings(project, 'dependencies').map(pyName), `${path} [project] dependencies`)
      deps('python', tomlKeys(tomlTable(text, 'tool.poetry.dependencies')), `${path} [tool.poetry.dependencies]`)
      words(tomlStrings(project, 'keywords'), `${path} [project] keywords`)
      for (const c of tomlStrings(project, 'classifiers')) {
        if (HARDWARE_CLASSIFIERS.some((h) => c.startsWith(h))) add('hardware', c, `${path} [project] classifiers`)
      }
      if (tomlString(project, 'name')) addRegistry(signals, 'pypi', path)
    } else if (base === 'setup.py' || base === 'setup.cfg') {
      addRegistry(signals, 'pypi', path)
    } else if (base === 'requirements.txt') {
      deps('python', text.split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter((l) => l && !l.startsWith('-')).map(pyName), path)
    } else if (base === 'Cargo.toml') {
      deps('cargo', tomlKeys(tomlTable(text, 'dependencies')), `${path} [dependencies]`)
      const pkg = tomlTable(text, 'package')
      words(tomlStrings(pkg, 'keywords'), `${path} [package] keywords`)
      for (const c of tomlStrings(pkg, 'categories')) if (HARDWARE_CATEGORIES.has(c)) add('hardware', c, `${path} [package] categories`)
      if (tomlString(pkg, 'name') && !/^\s*publish\s*=\s*false/m.test(pkg)) addRegistry(signals, 'crates.io', path)
    } else if (base === 'go.mod') {
      deps('go', goRequires(text), `${path} require`)
    } else if (base === '.goreleaser.yml' || base === '.goreleaser.yaml') {
      addRegistry(signals, 'goreleaser', path)
    } else if (base === 'manifest.json') {
      // A browser extension's manifest; other manifest.json files (a PWA's) have no manifest_version.
      try { if (JSON.parse(text)?.manifest_version) addKind(signals.stores, 'extension-store', `${path} manifest_version`) } catch { /* not JSON */ }
    }
  }
  for (const c of claimSurfaces(walked.files)) addKind(signals.claims, c.kind, c.source)
  return { signals, warnings: [] }
}

/**
 * Where a project makes claims about itself that leave the repository. Each is
 * a promise that drifts while the code moves, and nothing in the build fails
 * when it does: a public README overstated a quiz count by 47% for two months
 * (DEF-217), and caselaw's own said its source app had shipped (DEF-748).
 */
export function claimSurfaces(files) {
  const out = []
  for (const f of files) {
    const parts = f.split('/')
    if (parts.length > 3 || parts.slice(0, -1).some((p) => SKIP_DIRS.has(p) && p !== 'docs')) continue
    const base = parts.at(-1).toLowerCase()
    const doc = /\.(md|mdx|rst|txt|html?)$/.test(base) || !base.includes('.')
    if (parts.length === 1 && /^readme(\.(md|rst|txt))?$/.test(base)) out.push({ kind: 'readme', source: f })
    else if (doc && /privacy/.test(base)) out.push({ kind: 'privacy-policy', source: f })
    else if (doc && /^(terms|tos)([-_. ]|$)|terms[-_]of[-_](service|use)/.test(base)) out.push({ kind: 'terms', source: f })
    else if (parts.length === 1 && /^(mkdocs\.ya?ml|docusaurus\.config\.(js|ts|mjs))$/.test(base)) out.push({ kind: 'docs-site', source: f })
  }
  if (files.some((f) => f.startsWith('fastlane/metadata/'))) out.push({ kind: 'store-listing', source: 'fastlane/metadata/' })
  return out
}

function addKind(list, kind, source) {
  if (!list.some((e) => e.kind === kind)) list.push({ kind, source })
}

const MANIFESTS = new Set(['package.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Cargo.toml',
  'go.mod', '.goreleaser.yml', '.goreleaser.yaml', 'manifest.json'])

/** Manifest paths at depth 0–2, shallowest first, outside sample and test trees. */
export function manifestsIn(files) {
  return files
    .filter((f) => {
      const parts = f.split('/')
      return parts.length <= 3 && MANIFESTS.has(parts.at(-1)) && !parts.slice(0, -1).some((p) => SKIP_DIRS.has(p))
    })
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    .slice(0, MAX_MANIFESTS)
}

function matches(list, name, eco) {
  return list.some((entry) => (eco === 'go' || entry.endsWith('/') ? name.startsWith(entry) : name === entry))
}

/** `pyserial>=3.5; python_version>"3"` → `pyserial`. */
function pyName(spec) {
  return String(spec).split(/[\s<>=!~;[(]/)[0]
}

/** Module paths from a go.mod's `require` lines and blocks. */
export function goRequires(text) {
  const out = []
  let inBlock = false
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*require\s*\(/.test(line)) { inBlock = true; continue }
    if (inBlock && /^\s*\)/.test(line)) { inBlock = false; continue }
    const m = (inBlock ? /^\s*([^\s/]+\.[^\s]+)\s+v\d/ : /^\s*require\s+([^\s]+)\s+v\d/).exec(line)
    if (m) out.push(m[1])
  }
  return out
}

function addRegistry(signals, kind, source) {
  if (!signals.registries.some((r) => r.kind === kind)) signals.registries.push({ kind, source })
}
