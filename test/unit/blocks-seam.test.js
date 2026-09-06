/**
 * Removing a managed block touches only the seam where the block was. The
 * file-wide collapse it replaced deleted a host .gitignore's own leading blank
 * line on eject — a diff in someone's next commit for no reason.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { upsert, remove } from '../../src/core/blocks.js'

const add = (text, filePath = '.gitignore') => upsert(text, { id: 'caselaw', body: 'x', version: 1, filePath }).text

describe('remove — the seam and nothing else', () => {
  test('POSITIVE CONTROL: a leading blank line elsewhere in the file survives', () => {
    const original = '\n# Mac\n.DS_Store\n'
    assert.equal(remove(add(original), 'caselaw').text, original)
  })

  test('a file that was our block alone comes back empty', () => {
    assert.equal(remove(add(''), 'caselaw').text, '')
  })

  test('a block in the middle leaves the spacing around it as it was', () => {
    const withBlock = add('A\n\n') + '\nB\n' // A, blank, block, blank, B
    assert.equal(remove(withBlock, 'caselaw').text, 'A\n\nB\n')
    const leftOnly = add('A\n\n').replace(/\n$/, '') + '\nB\n' // A, blank, block, B
    assert.equal(remove(leftOnly, 'caselaw').text, 'A\n\nB\n', 'the wider side wins, never more than one blank line')
    // upsert always sets a block off with a blank line; a hand-tightened file has none.
    const tight = withBlock.replace('A\n\n#', 'A\n#').replace(/\n\nB\n$/, '\nB\n')
    assert.match(tight, /A\n# caselaw:begin/)
    assert.equal(remove(tight, 'caselaw').text, 'A\nB\n')
  })

  test('a block at the head leaves what follows starting at column one', () => {
    const withBlock = add('') + '\nB\n'
    assert.equal(remove(withBlock, 'caselaw').text, 'B\n')
  })

  test('a file that ends with several blank lines after our block keeps its own text and one newline', () => {
    const original = '# Project\n\nMy own notes.\n'
    assert.equal(remove(add(original, 'CLAUDE.md'), 'caselaw').text, original)
  })
})
