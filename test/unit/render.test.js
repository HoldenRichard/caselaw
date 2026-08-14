import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { render, RenderError } from '../../src/render/engine.js'

describe('render — interpolation', () => {
  test('substitutes dotted paths', () => {
    assert.equal(render('Hi {{ name }} of {{ project.name }}', { name: 'H', project: { name: 'Northwind' } }), 'Hi H of Northwind')
  })
  test('renders null and empty string as empty, not as the word null', () => {
    assert.equal(render('[{{ a }}]', { a: null }), '[]')
    assert.equal(render('[{{ a }}]', { a: '' }), '[]')
  })
  test('renders 0 and false rather than swallowing them', () => {
    assert.equal(render('{{ n }}/{{ b }}', { n: 0, b: false }), '0/false')
  })
})

describe('render — conditionals', () => {
  test('if renders only when truthy; empty array is falsy', () => {
    const t = '{{# if items }}HAS{{/ if }}{{^ if items }}NONE{{/ if }}'
    assert.equal(render(t, { items: ['x'] }), 'HAS')
    assert.equal(render(t, { items: [] }), 'NONE')
    assert.equal(render(t, { items: null }), 'NONE')
  })
  test('blocks nest', () => {
    const t = '{{# if a }}A{{# if b }}B{{/ if }}{{/ if }}'
    assert.equal(render(t, { a: 1, b: 1 }), 'AB')
    assert.equal(render(t, { a: 1, b: 0 }), 'A')
  })
})

describe('render — each', () => {
  test('iterates objects and exposes item fields', () => {
    const t = '{{# each rows }}- {{ label }} ({{ kind }})\n{{/ each }}'
    const out = render(t, { rows: [{ label: 'device', kind: 'physical' }, { label: 'prod db', kind: 'chosen' }] })
    assert.equal(out, '- device (physical)\n- prod db (chosen)\n')
  })
  test('exposes @index/@number/@first/@last and bare . for scalars', () => {
    const t = '{{# each xs }}{{ @number }}:{{ . }}{{^ if @last }},{{/ if }}{{/ each }}'
    assert.equal(render(t, { xs: ['a', 'b', 'c'] }), '1:a,2:b,3:c')
  })
  test('outer scope stays reachable from inside each', () => {
    const t = '{{# each xs }}{{ project }}-{{ . }} {{/ each }}'
    assert.equal(render(t, { project: 'P', xs: [1, 2] }), 'P-1 P-2 ')
  })
  test('an empty array renders nothing', () => {
    assert.equal(render('{{# each xs }}X{{/ each }}', { xs: [] }), '')
  })
})

describe('render — POSITIVE CONTROLS (these must fail)', () => {
  test('a missing value throws in strict mode', () => {
    assert.throws(
      () => render('{{ nope }}', {}),
      (e) => e instanceof RenderError && e.code === 'MISSING_VALUE',
      'a doctrine file with a silently blank section is worse than a failed run',
    )
  })
  test('but renders empty in lenient mode, when the caller opts in', () => {
    assert.equal(render('[{{ nope }}]', {}, { strict: false }), '[]')
  })
  test('an unclosed block throws', () => {
    assert.throws(() => render('{{# if a }}x', { a: 1 }), RenderError)
  })
  test('a mismatched closing tag throws', () => {
    assert.throws(() => render('{{# if a }}x{{/ each }}', { a: 1 }), RenderError)
  })
  test('a stray closing tag throws', () => {
    assert.throws(() => render('x{{/ if }}', {}), RenderError)
  })
  test('an unknown block type throws', () => {
    assert.throws(() => render('{{# loop xs }}x{{/ loop }}', { xs: [] }), RenderError)
  })
  test('each over a non-array throws in strict mode', () => {
    assert.throws(() => render('{{# each a }}x{{/ each }}', { a: 'string' }), RenderError)
  })
})

describe('render — content safety', () => {
  test('does not interpret braces that appear in data', () => {
    const out = render('{{ body }}', { body: '{{ not_a_token }}' })
    assert.equal(out, '{{ not_a_token }}', 'data is never re-parsed as template')
  })
  test('preserves markdown and code fences untouched', () => {
    const t = '```json\n{ "a": 1 }\n```\n{{ note }}'
    assert.equal(render(t, { note: 'ok' }), '```json\n{ "a": 1 }\n```\nok')
  })
})

describe('render — standalone block tags do not leave blank lines', () => {
  test('a block tag alone on a line contributes no newline', () => {
    const t = 'A\n{{# if x }}\nB\n{{/ if }}\nC\n'
    assert.equal(render(t, { x: 1 }), 'A\nB\nC\n')
    assert.equal(render(t, { x: 0 }), 'A\nC\n')
  })

  test('an inline block tag keeps its surrounding text intact', () => {
    const t = '{{# each xs }}- {{ . }}\n{{/ each }}'
    assert.equal(render(t, { xs: ['a', 'b'] }), '- a\n- b\n')
  })

  test('POSITIVE CONTROL: generated markdown has no triple newlines', () => {
    const t = [
      '# Title', '',
      '{{# if a }}', '## A', '{{ a }}', '{{/ if }}',
      '{{# if b }}', '## B', '{{ b }}', '{{/ if }}',
      '## Always', 'end', '',
    ].join('\n')
    const out = render(t, { a: 'one', b: '' })
    assert.doesNotMatch(out, /\n{3,}/, `blank-line pileup:\n${JSON.stringify(out)}`)
    assert.match(out, /## A\none\n\n?## Always/)
  })
})
