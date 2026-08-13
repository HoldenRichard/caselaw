/**
 * A deliberately small template renderer.
 *
 * Why not a dependency: this tool's pitch is discipline, and `npx` cold start
 * and supply-chain surface are both product features. A template engine is
 * ~150 lines of well-understood code; taking a dependency for it would cost
 * more than it saves.
 *
 * Supported, and nothing else:
 *   {{ path.to.value }}          interpolation (HTML-safe by default: off — we emit markdown)
 *   {{# if path }} … {{/ if }}   truthy block; non-empty arrays count as truthy
 *   {{^ if path }} … {{/ if }}   falsy block (the "unless" form)
 *   {{# each path }} … {{/ each }}
 *        inside: {{ . }} for the item, {{ @index }}, {{ @first }}, {{ @last }},
 *        and {{ field }} for a property of an object item
 *
 * Unknown paths render as '' rather than throwing, EXCEPT in strict mode, which
 * the generators use — a doctrine file with a silently blank section is worse
 * than a crash during generation.
 */

const TOKEN = /\{\{([#^/]?)\s*([^{}]+?)\s*\}\}/g

export class RenderError extends Error {
  constructor(message, meta = {}) {
    super(message)
    this.name = 'RenderError'
    Object.assign(this, meta)
  }
}

/** Resolve a dotted path against a scope chain (innermost first). */
function resolve(path, scopes) {
  const trimmed = path.trim()
  if (trimmed === '.') {
    // `each` stashes the raw item under @item so that scalars work: an object
    // item is also pushed as a scope, but a number or string cannot be.
    for (const s of scopes) {
      if (s && typeof s === 'object' && '@item' in s) return s['@item']
    }
    return scopes[0]
  }
  if (trimmed.startsWith('@')) {
    for (const s of scopes) {
      if (s && typeof s === 'object' && trimmed in s) return s[trimmed]
    }
    return undefined
  }
  const parts = trimmed.split('.')
  for (const scope of scopes) {
    let cur = scope
    let ok = true
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object' || !(p in cur)) {
        ok = false
        break
      }
      cur = cur[p]
    }
    if (ok) return cur
  }
  return undefined
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0
  if (v && typeof v === 'object') return Object.keys(v).length > 0
  return Boolean(v)
}

/**
 * A block tag alone on its own line is structural, not content — its newline
 * belongs to the template's readability, not to the output. Without this,
 * every `{{# if }}` / `{{/ if }}` pair leaves a blank line behind and generated
 * markdown ends up with three-line gaps between sections. Interpolation tags
 * are untouched; only #, ^ and / qualify.
 */
function stripStandaloneTagLines(template) {
  return template.replace(/^[ \t]*(\{\{[#^/][^{}]*?\}\})[ \t]*\r?\n/gm, '$1')
}

/** Tokenize into a flat list, then build a tree so blocks can nest. */
function parse(rawTemplate) {
  const template = stripStandaloneTagLines(rawTemplate)
  const root = { type: 'root', children: [] }
  const stack = [root]
  let last = 0
  let m

  TOKEN.lastIndex = 0
  while ((m = TOKEN.exec(template)) !== null) {
    const [raw, sigil, body] = m
    if (m.index > last) {
      stack[stack.length - 1].children.push({ type: 'text', value: template.slice(last, m.index) })
    }
    last = m.index + raw.length

    if (sigil === '#' || sigil === '^') {
      const [kind, ...rest] = body.split(/\s+/)
      if (kind !== 'if' && kind !== 'each') {
        throw new RenderError(`Unknown block "${kind}". Only if/each exist.`, { token: raw })
      }
      const node = {
        type: kind,
        negated: sigil === '^',
        path: rest.join(' '),
        children: [],
      }
      stack[stack.length - 1].children.push(node)
      stack.push(node)
    } else if (sigil === '/') {
      const kind = body.split(/\s+/)[0]
      const open = stack[stack.length - 1]
      if (stack.length === 1 || open.type !== kind) {
        throw new RenderError(
          `Closing {{/ ${kind} }} does not match the open block ${open.type === 'root' ? '(none)' : `{{# ${open.type} }}`}`,
          { token: raw },
        )
      }
      stack.pop()
    } else {
      stack[stack.length - 1].children.push({ type: 'var', path: body })
    }
  }

  if (last < template.length) {
    stack[stack.length - 1].children.push({ type: 'text', value: template.slice(last) })
  }
  if (stack.length !== 1) {
    throw new RenderError(`Unclosed {{# ${stack[stack.length - 1].type} }} block`, {
      path: stack[stack.length - 1].path,
    })
  }
  return root
}

function emit(node, scopes, strict, out) {
  for (const child of node.children) {
    switch (child.type) {
      case 'text':
        out.push(child.value)
        break

      case 'var': {
        const v = resolve(child.path, scopes)
        if (v === undefined && strict) {
          throw new RenderError(
            `Template referenced "${child.path}" but no value was supplied. ` +
              `A generated doctrine file with a silently blank section is worse than a failed run.`,
            { path: child.path, code: 'MISSING_VALUE' },
          )
        }
        out.push(v === undefined || v === null ? '' : String(v))
        break
      }

      case 'if': {
        const v = resolve(child.path, scopes)
        const show = child.negated ? !truthy(v) : truthy(v)
        if (show) emit(child, scopes, strict, out)
        break
      }

      case 'each': {
        const v = resolve(child.path, scopes)
        if (!Array.isArray(v)) {
          if (strict && v !== undefined) {
            throw new RenderError(`{{# each ${child.path} }} needs an array`, { path: child.path })
          }
          break
        }
        v.forEach((item, i) => {
          const meta = {
            '@index': i,
            '@first': i === 0,
            '@last': i === v.length - 1,
            '@number': i + 1,
            '@item': item,
          }
          const scope = item && typeof item === 'object' ? item : {}
          emit(child, [scope, meta, ...scopes], strict, out)
        })
        break
      }
    }
  }
}

/**
 * @param {string} template
 * @param {object} data
 * @param {{strict?: boolean}} [opts] strict (default true) throws on missing values
 */
export function render(template, data, opts = {}) {
  const strict = opts.strict !== false
  const ast = parse(template)
  const out = []
  emit(ast, [data], strict, out)
  return out.join('')
}

/** Expose for tests and for a `harness doctor` template lint. */
export { parse }
