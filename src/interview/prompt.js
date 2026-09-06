/**
 * Prompt adapters.
 *
 * The interview's logic must be testable without a TTY, so asking is an
 * injected capability rather than something the runner does itself. That
 * requirement also buys zero dependencies: a readline implementation is a
 * hundred lines, and `npx` cold start is a product feature for a tool whose
 * pitch is discipline.
 *
 * Every adapter implements the same four methods and honours one universal
 * escape: `?` means "I don't know", which is recorded as an explicit hole
 * rather than guessed at.
 */

import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { SKIPPED } from '../core/answers.js'

export const DONT_KNOW = '?'

/** Scripted adapter for tests: answers are consumed in order. */
export function scriptedPrompt(script = []) {
  const queue = [...script]
  const asked = []
  const api = {
    asked,
    remaining: () => queue.length,
    async text(q) { return take(q) },
    async number(q) { return take(q) },
    async select(q) { return take(q) },
    async multiselect(q) { return take(q) },
    async confirm(q) { return take(q) },
    note() {},
    async close() {},
  }
  function take(q) {
    asked.push(q.id || q.prompt)
    if (queue.length === 0) {
      throw new Error(`scriptedPrompt ran out of answers at "${q.id || q.prompt}"`)
    }
    const v = queue.shift()
    return v === DONT_KNOW ? SKIPPED : v
  }
  return api
}

/**
 * A line reader that survives piped input.
 *
 * `rl.question()` only captures a line that arrives AFTER it is called. At a
 * terminal that is fine, because the human types on demand. With a pipe,
 * readline drains the whole stream immediately and fires every line event at
 * once, so every answer after the first is dropped on the floor and the next
 * question rejects with "readline was closed". Buffering the lines ourselves
 * makes the same adapter work for a human, a pipe, and a test.
 */
function lineReader(input, output) {
  const rl = createInterface({ input, output })
  const buffered = []
  const waiting = []
  let closed = false

  rl.on('line', (line) => {
    const w = waiting.shift()
    if (w) w(line)
    else buffered.push(line)
  })
  rl.on('close', () => {
    closed = true
    while (waiting.length) waiting.shift()(null)
  })

  return {
    /** Resolves to the next line, or null at end of input. Never rejects. */
    next() {
      if (buffered.length) return Promise.resolve(buffered.shift())
      if (closed) return Promise.resolve(null)
      return new Promise((resolve) => waiting.push(resolve))
    },
    close() {
      rl.close()
    },
  }
}

/** Readline adapter for a real terminal — and for anything piping into one. */
export function ttyPrompt({ input = stdin, output = stdout } = {}) {
  const reader = lineReader(input, output)

  const write = (s) => output.write(s + '\n')

  /**
   * End of input is treated as "I don't know" rather than as an error: a
   * non-interactive run that runs out of answers should leave visible holes,
   * not a stack trace and a half-written repo.
   */
  async function ask(question) {
    output.write(question)
    const line = await reader.next()
    if (line === null) return DONT_KNOW
    return line.trim()
  }

  return {
    note(message) {
      write('')
      write(message)
    },

    async text(q) {
      write('')
      write(bold(q.prompt))
      if (q.help) write(dim('  ' + q.help))
      if (q.placeholder) write(dim(`  ${q.placeholder}`))
      write(dim(`  [enter] to skip · ${DONT_KNOW} if you don't know`))
      const v = await ask('  > ')
      if (v === DONT_KNOW) return SKIPPED
      return v
    },

    async number(q) {
      write('')
      write(bold(q.prompt))
      const def = q.default ?? ''
      for (;;) {
        const v = await ask(`  > ${def !== '' ? `[${def}] ` : ''}`)
        if (v === DONT_KNOW) return SKIPPED
        if (v === '' && def === '') return SKIPPED
        if (v === '' && def !== '') return Number(def)
        const n = Number(v)
        if (Number.isFinite(n) && (q.min == null || n >= q.min) && (q.max == null || n <= q.max)) return n
        write(dim(`  Needs a number${q.min != null ? ` between ${q.min} and ${q.max}` : ''}.`))
      }
    },

    async select(q) {
      write('')
      write(bold(q.prompt))
      if (q.help) write(dim('  ' + q.help))
      q.options.forEach((o, i) => write(`  ${i + 1}) ${o.label}`))
      for (;;) {
        const v = await ask(`  > [1-${q.options.length}] `)
        if (v === DONT_KNOW) return SKIPPED
        if (v === '') return SKIPPED
        const byKey = q.options.find((o) => o.key && o.key === v.toLowerCase())
        if (byKey) return byKey.value
        const n = Number(v)
        if (Number.isInteger(n) && n >= 1 && n <= q.options.length) return q.options[n - 1].value
        write(dim('  Pick one of the numbers above.'))
      }
    },

    async multiselect(q) {
      write('')
      write(bold(q.prompt))
      if (q.help) write(dim('  ' + q.help))
      q.options.forEach((o, i) => write(`  ${String(i + 1).padStart(2)}) ${o.label}`))
      write(dim('  Comma-separated numbers, blank for none' + (q.allowOther ? ", or free text after a '+'" : '')))
      const v = await ask('  > ')
      if (v === DONT_KNOW) return SKIPPED
      if (v === '') return []

      // Numbers are comma-separated; free text runs from the first '+' to the
      // end of the line, commas included. Splitting the whole answer on ','
      // first truncated "pair the bridge, then confirm it responds" at the
      // comma and dropped the rest without a word.
      const plus = v.indexOf('+')
      const numbers = plus === -1 ? v : v.slice(0, plus)
      const extra = plus === -1 ? '' : v.slice(plus + 1).trim()
      const picked = []
      for (const partRaw of numbers.split(',')) {
        const part = partRaw.trim()
        if (!part) continue
        const n = Number(part)
        if (Number.isInteger(n) && n >= 1 && n <= q.options.length) picked.push(q.options[n - 1].value)
      }
      return extra ? [...picked, extra] : picked
    },

    async confirm(q) {
      write('')
      write(bold(q.prompt))
      const v = (await ask(`  > [${q.default === false ? 'y/N' : 'Y/n'}] `)).toLowerCase()
      if (v === DONT_KNOW) return SKIPPED
      if (v === '') return q.default !== false
      return v.startsWith('y')
    },

    async close() {
      reader.close()
    },
  }
}

const useColor = !process.env.NO_COLOR && stdout.isTTY
const bold = (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s)
const dim = (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s)

export { bold, dim }
