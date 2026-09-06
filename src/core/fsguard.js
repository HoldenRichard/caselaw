/**
 * What is actually at a path, before anything reads or writes it.
 *
 * `readFile` and `writeFile` follow symlinks. A managed path replaced by a
 * symlink pointing out of the repository therefore hashed by its TARGET,
 * reconciled as "pristine content we own", and `upgrade` — without --force —
 * overwrote a file outside the repository through it; `eject` then stripped
 * a block from the outside file too. A managed path replaced by a directory
 * read as "unreadable" and vanished from the eject plan altogether.
 * src/core/rules.js already refused symlinked rule files for this reason;
 * this makes the rule general: the tool touches real files, and reports
 * everything else.
 */

import { lstat } from 'node:fs/promises'

/** @returns {Promise<'missing'|'file'|'dir'|'symlink'|'other'>} */
export async function kindAt(abs) {
  try {
    const st = await lstat(abs)
    if (st.isSymbolicLink()) return 'symlink'
    if (st.isDirectory()) return 'dir'
    if (st.isFile()) return 'file'
    return 'other'
  } catch (err) {
    if (err?.code === 'ENOENT') return 'missing'
    throw err
  }
}

/** A reason the tool will not read or write here, or null when it may. */
export function refusal(kind) {
  switch (kind) {
    case 'symlink': return 'is a symlink; caselaw touches real files only, never what a link points at'
    case 'dir': return 'is a directory, not the file that was generated here'
    case 'other': return 'is not a regular file'
    default: return null
  }
}
