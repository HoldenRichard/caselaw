import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { isoDate, addDays, daysBetween, isOverdue } from '../../src/core/dates.js'

describe('dates — UTC always', () => {
  test('adds days without drifting', () => {
    assert.equal(isoDate(addDays(new Date('2026-08-13T00:00:00Z'), 90)), '2026-11-11')
    assert.equal(isoDate(addDays(new Date('2026-08-13T00:00:00Z'), 30)), '2026-09-12')
  })

  test('crosses a month and a year boundary correctly', () => {
    assert.equal(isoDate(addDays(new Date('2026-12-20T00:00:00Z'), 30)), '2027-01-19')
    assert.equal(isoDate(addDays(new Date('2028-02-28T00:00:00Z'), 1)), '2028-02-29', 'leap year')
  })

  test('daysBetween is symmetric and signed', () => {
    const a = new Date('2026-08-13T00:00:00Z')
    const b = new Date('2026-08-20T00:00:00Z')
    assert.equal(daysBetween(a, b), 7)
    assert.equal(daysBetween(b, a), -7)
  })

  test('isOverdue compares calendar days, not instants', () => {
    const deadline = '2026-08-13'
    assert.equal(isOverdue(deadline, new Date('2026-08-13T23:59:00Z')), false, 'still the due day')
    assert.equal(isOverdue(deadline, new Date('2026-08-14T00:01:00Z')), true)
    assert.equal(isOverdue(null), false)
  })
})

describe('dates — POSITIVE CONTROL: the timezone trap', () => {
  // The bug this module exists to prevent: arithmetic done in LOCAL time and
  // then serialized as UTC shifts the answer by a day depending on where the
  // developer is sitting. A re-test deadline that differs between two people
  // running the same command is a governance artifact nobody can rely on.
  const tzs = ['UTC', 'Pacific/Auckland', 'America/New_York', 'Asia/Kolkata', 'Pacific/Kiritimati']

  test('the same input yields the same date in every timezone', () => {
    const results = tzs.map((tz) =>
      execFileSync(
        process.execPath,
        ['-e', "import('./src/core/dates.js').then(m=>process.stdout.write(m.isoDate(m.addDays(new Date('2026-08-13T00:00:00Z'),90))))"],
        { cwd: new URL('../..', import.meta.url).pathname, env: { ...process.env, TZ: tz }, encoding: 'utf8' },
      ),
    )
    assert.deepEqual(
      [...new Set(results)], ['2026-11-11'],
      `a deadline must not depend on the runner's timezone; got ${JSON.stringify(Object.fromEntries(tzs.map((t, i) => [t, results[i]])))}`,
    )
  })

  test('the naive local-time approach really does drift — proving the control has teeth', () => {
    // Not a plain offset problem: local arithmetic preserves the instant, so
    // fixed-offset zones agree. It breaks only when the UTC offset CHANGES
    // across the window. Auckland is UTC+12 in August and UTC+13 in November,
    // and that hour puts the preserved instant on the other side of midnight.
    const naive = (tz) =>
      execFileSync(
        process.execPath,
        ['-e', "const d=new Date('2026-08-13T00:00:00Z');d.setDate(d.getDate()+90);process.stdout.write(d.toISOString().slice(0,10))"],
        { env: { ...process.env, TZ: tz }, encoding: 'utf8' },
      )
    assert.equal(naive('UTC'), '2026-11-11')
    assert.equal(naive('Pacific/Auckland'), '2026-11-10', 'the DST zone is the one that slips')
    assert.notEqual(
      naive('Pacific/Auckland'), naive('UTC'),
      'if this ever stops differing, the control above is no longer testing anything',
    )
  })
})
