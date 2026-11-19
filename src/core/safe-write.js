/** Small recoverable writes; no active rule is removed to make room for a new one. */
import { mkdir, writeFile, readFile, rename, rm, link } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { adoptEdit } from './manifest.js'

export async function writeExclusive(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.caselaw-write-${randomUUID()}`)
  try {
    // Only publish after writeFile has written and closed the complete file.
    // A hard link is atomic and refuses an existing destination, unlike rename.
    await writeFile(temp, text, { encoding: 'utf8', flag: 'wx' })
    try { await link(temp, path) }
    catch (error) {
      if (error.code === 'EEXIST' && await readFile(path, 'utf8') === text) return
      throw error
    }
  } finally { await rm(temp, { force: true }) }
}
export async function atomicWrite(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.caselaw-write-${randomUUID()}`)
  try {
    await writeFile(temp, text, { encoding: 'utf8', flag: 'wx' })
    await rename(temp, path)
  } finally { await rm(temp, { force: true }) }
}
/**
 * atomicWrite for a file the manifest may own. A caselaw command's own edit to
 * a generated file is recorded in the manifest (adoptEdit), so check, audit and
 * `check --strict` do not report the tool's work as someone's hand edit.
 */
export async function writeManaged(root, relPath, text) {
  const abs = join(root, relPath)
  let before = null
  try { before = await readFile(abs, 'utf8') } catch { /* a new file */ }
  await atomicWrite(abs, text)
  await adoptEdit(root, relPath, { before, after: text })
}
export async function withMutationLock(root, operation) {
  const lock = join(root, '.caselaw', 'mutation.lock')
  await mkdir(dirname(lock), { recursive: true })
  try { await mkdir(lock) }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another governance mutation is in progress (or interrupted); inspect .caselaw/mutation.lock before retrying.')
    throw error
  }
  try { return await operation() }
  finally { await rm(lock, { recursive: true, force: true }) }
}
