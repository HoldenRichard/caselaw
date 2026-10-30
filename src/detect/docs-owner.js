/**
 * Is `docs/` already somebody's? caselaw writes its doctrine there, and on two
 * of the three dogfood repositories that was the wrong place: homebridge's
 * docs/ is committed typedoc OUTPUT (`typedoc.json: "out": "docs"`; a docs
 * build rm -rf's it, verified by running one), and ntfy's docs/ is the MkDocs
 * SOURCE tree that ships inside the binary. Writing governance into either is
 * destructive later, quietly. The install then writes to governance/ instead
 * and says why (src/core/doctrine.js).
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const exists = async (p) => { try { await stat(p); return true } catch { return false } }
const stripSlashes = (d) => String(d).replace(/^\.\//, '').replace(/\/+$/, '')

/** @returns {Promise<{tool: string, file: string, role: 'output'|'source', dir: string, consequence: string}|null>} */
export async function docsOwner(root) {
  // typedoc: `out` (default "docs") is deleted and regenerated on every build.
  for (const f of ['typedoc.json', 'typedoc.jsonc']) {
    if (!(await exists(join(root, f)))) continue
    let out = 'docs'
    try {
      const cfg = JSON.parse((await readFile(join(root, f), 'utf8')).replace(/^\uFEFF/, '').replace(/\/\/.*$/gm, ''))
      if (typeof cfg.out === 'string') out = cfg.out
    } catch { /* unreadable config: assume the default */ }
    if (stripSlashes(out) === 'docs') {
      return { tool: 'typedoc', file: f, role: 'output', dir: 'docs', consequence: 'the next docs build deletes the directory and everything caselaw wrote in it' }
    }
  }
  // mkdocs: `docs_dir` (default "docs") is the published source tree.
  for (const f of ['mkdocs.yml', 'mkdocs.yaml']) {
    if (!(await exists(join(root, f)))) continue
    let dir = 'docs'
    try {
      const m = (await readFile(join(root, f), 'utf8')).match(/^docs_dir:\s*['"]?([^'"\n#]+)/m)
      if (m) dir = m[1].trim()
    } catch { /* assume the default */ }
    if (stripSlashes(dir) === 'docs') {
      return { tool: 'mkdocs', file: f, role: 'source', dir: 'docs', consequence: 'every markdown file caselaw writes there is published as part of the project documentation' }
    }
  }
  // sphinx: a conf.py under docs/ makes docs/ the source tree, directly or in
  // docs/source/ (sphinx-quickstart's separate-source layout). pyvisa keeps its
  // conf.py in docs/source/, and the DEF-274 re-score's doctrine landed in a
  // directory whose every change starts a docs build.
  for (const f of ['docs/conf.py', 'docs/source/conf.py']) {
    if (await exists(join(root, f))) {
      return { tool: 'sphinx', file: f, role: 'source', dir: 'docs', consequence: 'every file caselaw writes there sits in the documentation source, and every change to it starts a docs build' }
    }
  }
  // docusaurus: docs/ is the default docs plugin source.
  for (const f of ['docusaurus.config.js', 'docusaurus.config.ts', 'docusaurus.config.mjs']) {
    if (await exists(join(root, f))) {
      return { tool: 'docusaurus', file: f, role: 'source', dir: 'docs', consequence: 'every markdown file caselaw writes there is published as part of the project documentation' }
    }
  }
  return null
}
