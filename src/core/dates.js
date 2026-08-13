/**
 * Dates, in UTC, always.
 *
 * Every date this tool emits is a calendar date in a governance document — a
 * re-test deadline, a grandfather expiry, a ratification stamp. Those are read
 * by people and compared by an audit, so they must not depend on the timezone
 * of whoever ran the command.
 *
 * The trap this module exists to close: `Date.setDate()` and `getDate()` work
 * in LOCAL time while `toISOString()` renders UTC. Local arithmetic preserves
 * the instant, so most of the time this looks fine — which is exactly why it
 * survives review. It breaks when the UTC OFFSET CHANGES between the start
 * date and the end date, i.e. across a daylight-saving transition: the
 * preserved instant lands on the other side of midnight UTC and the rendered
 * calendar date slips by a day.
 *
 * Measured, not theorised. Adding 90 days to 2026-08-13:
 *
 *   UTC, America/New_York, Pacific/Kiritimati, Europe/London -> 2026-11-11
 *   Pacific/Auckland (UTC+12 in August, UTC+13 in November)  -> 2026-11-10
 *
 * So a re-test deadline would have been written one day early for anyone in a
 * DST zone whose transition fell inside the window, and correctly everywhere
 * else — the worst shape of bug, because it is invisible to whoever wrote it.
 */

/** YYYY-MM-DD for a Date, in UTC. */
export function isoDate(d = new Date()) {
  return new Date(d).toISOString().slice(0, 10)
}

/** Add whole days in UTC, never in local time. */
export function addDays(d, days) {
  const out = new Date(d)
  out.setUTCDate(out.getUTCDate() + Number(days))
  return out
}

/** Whole days between two dates, positive if `b` is later. */
export function daysBetween(a, b) {
  const MS = 86400000
  return Math.round((startOfUtcDay(b) - startOfUtcDay(a)) / MS)
}

/** True when `deadline` is strictly before `now`, compared by calendar day. */
export function isOverdue(deadline, now = new Date()) {
  if (!deadline) return false
  return startOfUtcDay(new Date(deadline)) < startOfUtcDay(now)
}

function startOfUtcDay(d) {
  const x = new Date(d)
  x.setUTCHours(0, 0, 0, 0)
  return x
}
