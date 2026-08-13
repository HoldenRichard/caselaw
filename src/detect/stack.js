/**
 * What is this project written in, and what builds it.
 *
 * Two decisions here are worth defending, because both look wrong until you
 * have watched the alternative fail:
 *
 * 1. THE WALK IS CAPPED, AND SHARED. A monorepo with a checked-in vendor tree
 *    can hold half a million files. An uncapped census turns a 15-minute
 *    interview into a coffee break, and the user kills the process rather than
 *    the walk. We stop at a file budget and set a warning; a partial census
 *    that arrives is worth more than a perfect one that does not. The walk is
 *    breadth-first so that when the budget runs out we have spent it on the
 *    shallow, high-signal part of the tree instead of one deep subdirectory.
 *    index.js walks ONCE and hands the result to everything that needs it.
 *
 * 2. THE CENSUS COUNTS CODE, NOT FILES. Markdown, JSON and YAML outnumber
 *    source in plenty of healthy repos, and "this project is 61% Markdown" is
 *    a true answer to a question nobody asked. The interview wants to know
 *    what the agent will be editing, so documentation and data are walked but
 *    not counted.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const DEFAULT_MAX_FILES = 20000
export const DEFAULT_MAX_DEPTH = 12

/**
 * Directories that are someone else's code, or build output. Counting them
 * answers a question about npm rather than about this project.
 */
export const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'Pods',
  '.build',
  'target',
  'venv',
  '.venv',
  '__pycache__',
  // Not in the required list, but the same category and just as large.
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.gradle',
  '.terraform',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.yarn',
  'DerivedData',
  'Carthage',
  'coverage',
  'bower_components',
])

/** Extension → language. Code only; see the header for why data files are out. */
const LANGUAGES = {
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript',
  ts: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', tsx: 'TypeScript',
  py: 'Python', pyi: 'Python',
  swift: 'Swift',
  go: 'Go',
  rs: 'Rust',
  rb: 'Ruby',
  java: 'Java',
  kt: 'Kotlin', kts: 'Kotlin',
  m: 'Objective-C', mm: 'Objective-C++',
  c: 'C', h: 'C',
  cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++', hh: 'C++',
  cs: 'C#',
  php: 'PHP',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell',
  sql: 'SQL',
  html: 'HTML', htm: 'HTML',
  css: 'CSS', scss: 'SCSS', sass: 'SCSS', less: 'Less',
  vue: 'Vue', svelte: 'Svelte',
  dart: 'Dart',
  ex: 'Elixir', exs: 'Elixir',
  scala: 'Scala',
  lua: 'Lua',
  r: 'R',
  pl: 'Perl',
  hs: 'Haskell',
  zig: 'Zig',
  tf: 'Terraform',
  proto: 'Protocol Buffers',
  gradle: 'Gradle',
}

/**
 * Manifest → build system, in the order a tie is broken. An ecosystem manifest
 * outranks a generic task runner: a repo with both package.json and a Makefile
 * is a node project that happens to have a Makefile, not a make project.
 */
const BUILD_SYSTEMS = [
  { file: 'package.json', name: 'node' },
  { file: 'Cargo.toml', name: 'cargo' },
  { file: 'go.mod', name: 'go' },
  { file: 'pyproject.toml', name: 'python' },
  { file: 'setup.py', name: 'python' },
  { file: 'Package.swift', name: 'swiftpm' },
  { dirExt: '.xcodeproj', name: 'xcode' },
  { dirExt: '.xcworkspace', name: 'xcode' },
  { file: 'Gemfile', name: 'bundler' },
  { file: 'pom.xml', name: 'maven' },
  { file: 'build.gradle', name: 'gradle' },
  { file: 'build.gradle.kts', name: 'gradle' },
  { file: 'Makefile', name: 'make' },
  { file: 'makefile', name: 'make' },
  { file: 'justfile', name: 'just' },
  { file: 'Justfile', name: 'just' },
  { file: 'Taskfile.yml', name: 'task' },
  { file: 'Taskfile.yaml', name: 'task' },
]

/** Lockfile → package manager, most specific first. */
const LOCKFILES = [
  { file: 'pnpm-lock.yaml', name: 'pnpm' },
  { file: 'yarn.lock', name: 'yarn' },
  { file: 'bun.lockb', name: 'bun' },
  { file: 'bun.lock', name: 'bun' },
  { file: 'package-lock.json', name: 'npm' },
  { file: 'npm-shrinkwrap.json', name: 'npm' },
]

/**
 * Breadth-first, symlink-refusing, budget-capped directory walk.
 *
 * Symlinks are recorded but never followed: one `ln -s .. loop` in a repo is
 * enough to walk forever, and the tool that hangs on it gets blamed.
 *
 * @returns {Promise<{files: string[], dirs: string[], truncated: boolean,
 *                    reason: string|null, unreadable: string[], scanned: number}>}
 */
export async function walk(root, opts = {}) {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH
  const excluded = opts.excludeDirs || EXCLUDED_DIRS

  const files = []
  const dirs = []
  const unreadable = []
  let truncated = false
  let reason = null
  let stop = false // only the FILE cap aborts the walk; the depth cap prunes one branch

  /** @type {{rel: string, depth: number}[]} */
  let queue = [{ rel: '', depth: 0 }]

  while (queue.length > 0 && !stop) {
    const next = []
    for (const { rel, depth } of queue) {
      let entries
      try {
        entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true })
      } catch {
        unreadable.push(rel || '.')
        continue
      }
      for (const e of entries) {
        const childRel = rel ? `${rel}/${e.name}` : e.name
        if (e.isSymbolicLink()) {
          files.push(childRel)
          continue
        }
        if (e.isDirectory()) {
          dirs.push(childRel)
          if (excluded.has(e.name)) continue
          if (depth + 1 > maxDepth) {
            truncated = true
            reason = reason || `directory depth cap (${maxDepth}) reached at ${childRel}`
            continue
          }
          next.push({ rel: childRel, depth: depth + 1 })
          continue
        }
        files.push(childRel)
        if (files.length >= maxFiles) {
          truncated = true
          stop = true
          reason = `file cap (${maxFiles}) reached`
          break
        }
      }
      if (stop) break
    }
    queue = next
  }

  return { files, dirs, truncated, reason, unreadable, scanned: files.length }
}

export function emptyStack() {
  return {
    languages: [],
    buildSystem: null,
    packageManager: null,
    // Extras: a monorepo genuinely has more than one of each, and collapsing
    // that to a single string loses the fact the interview cares about.
    buildSystems: [],
    filesScanned: 0,
    codeFiles: 0,
  }
}

/**
 * @param {string} root
 * @param {object} [opts]
 * @param {object} [walked] result of walk(), to avoid a second traversal
 * @returns {Promise<{stack: object, walked: object, warnings: object[]}>}
 */
export async function detectStack(root, opts = {}, walked = null) {
  const warnings = []
  const w = walked || (await walk(root, opts))
  const stack = emptyStack()
  stack.filesScanned = w.files.length

  if (w.truncated) {
    warnings.push({
      code: 'walk-truncated',
      message: `Stopped scanning the tree early: ${w.reason}.`,
      hint: 'The language census and deploy surface are a sample, not a complete list. Review them before accepting.',
    })
  }
  if (w.unreadable.length > 0) {
    warnings.push({
      code: 'unreadable-dirs',
      message: `${w.unreadable.length} director${w.unreadable.length === 1 ? 'y' : 'ies'} could not be read (e.g. ${w.unreadable[0]}).`,
      hint: 'Permissions, most likely. Anything inside them is missing from the census.',
    })
  }

  // --- language census ---------------------------------------------------
  const counts = new Map()
  let codeFiles = 0
  for (const rel of w.files) {
    const lang = languageOf(rel)
    if (!lang) continue
    counts.set(lang, (counts.get(lang) || 0) + 1)
    codeFiles += 1
  }
  stack.codeFiles = codeFiles
  stack.languages = [...counts.entries()]
    .map(([name, files]) => ({ name, files, pct: codeFiles ? round1((files / codeFiles) * 100) : 0 }))
    .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name))
    .slice(0, 20)

  if (codeFiles === 0 && w.files.length > 0) {
    warnings.push({
      code: 'no-source-files',
      message: 'No recognised source files found — this looks like a docs or data repository.',
      hint: 'Confirm the language during the interview; the verification tiers depend on it.',
    })
  }

  // --- build system ------------------------------------------------------
  const rootFiles = new Set(w.files.filter((f) => !f.includes('/')))
  const rootDirs = w.dirs.filter((d) => !d.includes('/'))

  for (const bs of BUILD_SYSTEMS) {
    if (bs.file && rootFiles.has(bs.file)) pushUnique(stack.buildSystems, bs.name)
    if (bs.dirExt && rootDirs.some((d) => d.endsWith(bs.dirExt))) pushUnique(stack.buildSystems, bs.name)
  }
  stack.buildSystem = stack.buildSystems[0] ?? null

  if (!stack.buildSystem) {
    // The Kabu-shaped case: the directory you opened is a parent folder and the
    // real project is one level down. Saying "no build system" would be true
    // and useless; naming the nested one lets the interview ask the right thing.
    const nested = findNestedManifest(w)
    if (nested) {
      warnings.push({
        code: 'nested-manifest',
        message: `No build manifest at the root; found ${nested.path} (${nested.name}) below it.`,
        hint: 'You may have pointed harness at a parent folder rather than at the project.',
      })
    }
  }

  // --- package manager ---------------------------------------------------
  const found = LOCKFILES.filter((l) => rootFiles.has(l.file))
  if (found.length > 0) {
    stack.packageManager = found[0].name
    const distinct = [...new Set(found.map((f) => f.name))]
    if (distinct.length > 1) {
      warnings.push({
        code: 'multiple-lockfiles',
        message: `More than one lockfile at the root (${distinct.join(', ')}).`,
        hint: `Assuming ${stack.packageManager}. A stale lockfile is worth deleting before it picks the wrong CI path.`,
      })
    }
  } else if (rootFiles.has('package.json')) {
    // Corepack's `packageManager` field is a declaration, which beats a guess.
    const declared = await readPackageManagerField(root)
    if (declared) stack.packageManager = declared
  }

  return { stack, walked: w, warnings }
}

/** @returns {string|null} */
export function languageOf(relPath) {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null // no extension, or a dotfile like `.gitignore`
  return LANGUAGES[base.slice(dot + 1).toLowerCase()] || null
}

function findNestedManifest(w) {
  const named = new Map(BUILD_SYSTEMS.filter((b) => b.file).map((b) => [b.file, b.name]))
  let best = null
  for (const f of w.files) {
    const depth = f.split('/').length - 1
    if (depth === 0 || depth > 2) continue
    const base = f.slice(f.lastIndexOf('/') + 1)
    const name = named.get(base)
    if (!name) continue
    if (!best || depth < best.depth) best = { path: f, name, depth }
  }
  return best
}

async function readPackageManagerField(root) {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const decl = typeof pkg.packageManager === 'string' ? pkg.packageManager : ''
    const name = decl.split('@')[0].trim()
    return LOCKFILES.some((l) => l.name === name) ? name : null
  } catch {
    return null // an unparseable package.json is the caller's problem, not a crash
  }
}

function pushUnique(arr, v) {
  if (!arr.includes(v)) arr.push(v)
}

function round1(n) {
  return Math.round(n * 10) / 10
}
