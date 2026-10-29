/**
 * Just enough TOML to read a manifest's own table, and no more.
 *
 * Line-start regexes over the whole file were wrong twice in the same way:
 * pyvisa indents the keys under `[project]`, so `^name =` never matched and
 * the project was titled after its clone directory — the failure DEF-274
 * recorded for homebridge, back by a different road. These read one table's
 * body, allow indentation, and stop at the next header.
 */

/** The body of one table (`[project]`, `[package]`, …) as text, or null. */
export function tomlTable(text, name) {
  if (typeof text !== 'string') return null
  const out = []
  let inside = false
  let found = false
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line)
    if (header) {
      inside = header[1].replace(/["']/g, '') === name
      found = found || inside
      continue
    }
    if (inside) out.push(line)
  }
  return found ? out.join('\n') : null
}

/** A key's string value in a table body: `key = "value"`, indentation allowed. */
export function tomlString(body, key) {
  if (typeof body !== 'string') return null
  const m = new RegExp(`^\\s*${escape(key)}\\s*=\\s*["']([^"'\\n]*)["']`, 'm').exec(body)
  return m ? m[1] : null
}

/** A key's array of strings in a table body, single- or multi-line. */
export function tomlStrings(body, key) {
  if (typeof body !== 'string') return []
  const m = new RegExp(`^\\s*${escape(key)}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm').exec(body)
  if (!m) return []
  return [...m[1].matchAll(/["']([^"'\n]+)["']/g)].map((x) => x[1])
}

/** The keys a table body assigns, e.g. the crate names under `[dependencies]`. */
export function tomlKeys(body) {
  if (typeof body !== 'string') return []
  return [...body.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=/gm)].map((x) => x[1])
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
