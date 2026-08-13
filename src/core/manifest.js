/**
 * The install manifest — what we generated, and what it hashed to at the time.
 *
 * Three of the largest tools in this space (spec-kit's manifest.py, ECC's
 * install-state.json, BMAD's files-manifest.csv) independently converged on
 * this same primitive, which is a strong signal it is the right one.
 *
 * It answers three questions that are otherwise guesswork:
 *   - "Did the user edit our output?"  -> hash lookup, not a diff heuristic
 *   - "What should upgrade touch?"     -> only files still matching their hash
 *   - "What does eject remove?"        -> exactly what we own and nothing else
 *
 * Two ownership kinds, because they eject differently:
 *   'file'  — we created the whole file; eject deletes it
 *   'block' — we own a managed block inside a file the user also owns;
 *             eject strips the block and leaves the file
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { hash } from './text.js'

export const MANIFEST_PATH = '.harness/manifest.json'
export const SCHEMA_VERSION = 1

export function emptyManifest({ cliVersion = '0.0.0', templateVersion = '0' } = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    cliVersion,
    templateVersion,
    generatedAt: null,
    entries: {},
  }
}

export async function load(root) {
  const p = join(root, MANIFEST_PATH)
  try {
    const raw = await readFile(p, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      throw new ManifestError(
        `Manifest schema v${parsed.schemaVersion} is not v${SCHEMA_VERSION}. ` +
          `Run \`harness upgrade\` — refusing to act on a manifest shape I do not understand.`,
        { code: 'SCHEMA_MISMATCH', found: parsed.schemaVersion },
      )
    }
    return parsed
  } catch (err) {
    if (err.code === 'ENOENT') return null
    if (err instanceof ManifestError) throw err
    throw new ManifestError(`Manifest at ${MANIFEST_PATH} is unreadable: ${err.message}`, {
      code: 'UNREADABLE',
    })
  }
}

export async function save(root, manifest, { now = new Date().toISOString() } = {}) {
  const p = join(root, MANIFEST_PATH)
  await mkdir(dirname(p), { recursive: true })
  const out = { ...manifest, generatedAt: now }
  await writeFile(p, JSON.stringify(out, null, 2) + '\n', 'utf8')
  return out
}

/**
 * Record one artifact we just wrote.
 * `contentHash` is the hash of the whole file for kind 'file', or of the
 * block interior for kind 'block'.
 */
export function record(manifest, { path, kind, contentHash, blockId, templateId }) {
  if (kind !== 'file' && kind !== 'block') {
    throw new ManifestError(`Unknown ownership kind "${kind}"`, { code: 'BAD_KIND' })
  }
  if (kind === 'block' && !blockId) {
    throw new ManifestError(`A 'block' entry for ${path} must name its blockId`, {
      code: 'MISSING_BLOCK_ID',
    })
  }
  const key = toPosix(path)
  manifest.entries[key] = {
    kind,
    hash: contentHash,
    ...(blockId ? { blockId } : {}),
    ...(templateId ? { templateId } : {}),
  }
  return manifest
}

export function forget(manifest, path) {
  delete manifest.entries[toPosix(path)]
  return manifest
}

/**
 * Compare the manifest against what is actually on disk.
 *
 * @returns {Promise<{clean: string[], modified: string[], missing: string[],
 *                    unreadable: {path: string, reason: string}[]}>}
 *
 * 'modified' means the user edited content we own — upgrade must not touch
 * those without --force, and the audit reports them.
 */
export async function reconcile(root, manifest, { locate } = {}) {
  const clean = []
  const modified = []
  const missing = []
  const unreadable = []

  for (const [path, entry] of Object.entries(manifest.entries)) {
    const abs = join(root, path)
    let text
    try {
      text = await readFile(abs, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') missing.push(path)
      else unreadable.push({ path, reason: err.code || err.message })
      continue
    }

    if (entry.kind === 'file') {
      ;(hash(text) === entry.hash ? clean : modified).push(path)
      continue
    }

    // kind === 'block'
    if (!locate) {
      throw new ManifestError(
        'reconcile() needs a `locate` implementation to check block entries',
        { code: 'NO_LOCATOR' },
      )
    }
    let found
    try {
      found = locate(text, entry.blockId)
    } catch (err) {
      unreadable.push({ path, reason: err.message })
      continue
    }
    if (!found.present) missing.push(path)
    else if (hash(found.interior) === entry.hash) clean.push(path)
    else modified.push(path)
  }

  return { clean, modified, missing, unreadable }
}

/**
 * Files the manifest claims but that no longer appear in the current write
 * plan — i.e. artifacts a config change orphaned. Reported as drift too,
 * because a stale generated file is a doctrine file that lies.
 */
export function orphans(manifest, plannedPaths) {
  const planned = new Set(plannedPaths.map(toPosix))
  return Object.keys(manifest.entries).filter((p) => !planned.has(p))
}

/** Everything eject would touch, split by how it must be removed. */
export function ejectPlan(manifest, reconciliation) {
  const modified = new Set(reconciliation.modified)
  const deleteFiles = []
  const stripBlocks = []
  const leaveAlone = []

  for (const [path, entry] of Object.entries(manifest.entries)) {
    if (modified.has(path)) {
      leaveAlone.push({ path, reason: 'you edited it' })
      continue
    }
    if (entry.kind === 'file') deleteFiles.push(path)
    else stripBlocks.push({ path, blockId: entry.blockId })
  }
  return { deleteFiles, stripBlocks, leaveAlone }
}

function toPosix(p) {
  return p.split(sep).join('/')
}

export { toPosix, relative, stat }

export class ManifestError extends Error {
  constructor(message, meta = {}) {
    super(message)
    this.name = 'ManifestError'
    Object.assign(this, meta)
  }
}
