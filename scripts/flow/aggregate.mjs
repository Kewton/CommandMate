/**
 * Pure functions of flow PR1a (Issue #4367, docs/design/flow-metrics-4367.md §2.3・§6.1):
 * the shape check of a `gh pr list` answer, the window arithmetic and the hourly split of
 * `reconstruct`. Nothing here reads a clock, a file or a process.
 */

export const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** The default wait after the window's end before it is observed (R7 disposition: a guess, not a guarantee). */
export const TICK_GRACE_MS = 10 * MINUTE_MS;
export const TICK_WINDOW_MS = DAY_MS;
export const MAX_WINDOW_MS = 31 * DAY_MS;

/** A finite epoch ms of an ISO time with an explicit zone, or null. */
export function parseIsoTime(value) {
  if (typeof value !== 'string' || !ISO_TIME.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Checks the whole answer of one search (§2.3). One bad element fails the whole answer.
 * @param {string} stdout
 * @param {{ field: 'createdAt' | 'mergedAt', base: string, limit: number }} options
 * @returns {{ ok: true, times: number[] } | { ok: false, why: 'schema' | 'truncated' | 'conflict' }}
 */
export function validatePrList(stdout, { field, base, limit }) {
  let doc;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return { ok: false, why: 'schema' };
  }
  if (!Array.isArray(doc)) return { ok: false, why: 'schema' };
  if (doc.length >= limit) return { ok: false, why: 'truncated' };
  /** @type {Map<number, number>} */
  const byNumber = new Map();
  for (const item of doc) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return { ok: false, why: 'schema' };
    const { number } = item;
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return { ok: false, why: 'schema' };
    if (item.baseRefName !== base) return { ok: false, why: 'schema' };
    const at = parseIsoTime(item[field]);
    if (at === null) return { ok: false, why: 'schema' };
    const seen = byNumber.get(number);
    if (seen !== undefined && seen !== at) return { ok: false, why: 'conflict' };
    byNumber.set(number, at);
  }
  return { ok: true, times: [...byNumber.values()] };
}

/** How many of `times` fall in `[from, to)`. */
export function countInWindow(times, { from, to }) {
  return times.filter((t) => t >= from && t < to).length;
}

/** The UTC date `YYYY-MM-DD` of an epoch ms. */
export function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The date range of the search for `[from, to)`: the UTC dates of `from` and of `to − 1 ms`
 * (a `to` at 00:00 UTC is the day before). The answer is narrowed to `[from, to)` afterwards.
 */
export function searchDateRange({ from, to }) {
  return `${utcDate(from)}..${utcDate(to - 1)}`;
}

/**
 * The default tick window (R7 disposition): `to` is `at` floored to the minute minus the grace,
 * `from` is 24 hours before. The grace is a guess at the search index's delay, not a guarantee.
 */
export function tickWindow(atMs) {
  const to = Math.floor(atMs / MINUTE_MS) * MINUTE_MS - TICK_GRACE_MS;
  return { from: to - TICK_WINDOW_MS, to };
}

const formatterCache = new Map();
function partsFormatter(tz) {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'longOffset',
    });
    formatterCache.set(tz, f);
  }
  return f;
}

/** The wall-clock parts of `ms` in `tz`, with its offset (`+09:00`). */
export function zonedParts(ms, tz) {
  const parts = Object.fromEntries(partsFormatter(tz).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const name = String(parts.timeZoneName ?? 'GMT');
  const offset = name === 'GMT' ? '+00:00' : name.replace(/^GMT/, '');
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    offset,
  };
}

/** The `tz` date of `ms` (the record file's name). */
export function zonedDate(ms, tz) {
  return zonedParts(ms, tz).date;
}

function offsetMs(ms, tz) {
  const { offset } = zonedParts(ms, tz);
  const m = offset.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3])) * MINUTE_MS;
}

/** The epoch ms of 00:00 of `date` (`YYYY-MM-DD`) in `tz`, or null for a date not on the calendar. */
export function zonedMidnight(date, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const guess = Date.UTC(y, mo - 1, d);
  const check = new Date(guess);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  let t = guess - offsetMs(guess, tz);
  t = guess - offsetMs(t, tz);
  return t;
}

/** `[from, to)` of one `tz` calendar day (23 or 25 hours on a DST change). */
export function dayWindow(date, tz) {
  const from = zonedMidnight(date, tz);
  if (from === null) return null;
  const next = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + 1));
  const to = zonedMidnight(next.toISOString().slice(0, 10), tz);
  if (to === null) return null;
  return { from, to };
}

/** The hour key of `ms` in `tz`: `YYYY-MM-DDTHH±hh:mm` (the offset keeps a repeated DST hour apart). */
export function hourKey(ms, tz) {
  const p = zonedParts(ms, tz);
  return `${p.date}T${p.hour}${p.offset}`;
}

/**
 * The hourly split of `reconstruct` (§2.5): one row per `tz` hour that `[from, to)` touches,
 * in order. A column whose times are null (the search failed) is null in every row.
 * @param {{ prCreated: number[] | null, prMerged: number[] | null }} events
 * @param {{ from: number, to: number, tz: string }} window
 */
export function hourlyPrCounts(events, { from, to, tz }) {
  /** @type {string[]} */
  const keys = [];
  const seen = new Set();
  // 15-minute steps reach every local hour, also in zones offset by 30 or 45 minutes.
  for (let t = from; t < to; t += 15 * MINUTE_MS) {
    const key = hourKey(t, tz);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  const column = (times) => {
    if (times === null) return null;
    const counts = new Map(keys.map((k) => [k, 0]));
    for (const t of times) {
      if (t < from || t >= to) continue;
      const key = hourKey(t, tz);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const created = column(events.prCreated);
  const merged = column(events.prMerged);
  const hours = keys.map((hour) => ({
    hour,
    prCreated: created ? created.get(hour) ?? 0 : null,
    prMerged: merged ? merged.get(hour) ?? 0 : null,
  }));
  const total = (col) => (col ? [...col.values()].reduce((a, b) => a + b, 0) : null);
  return { hours, totals: { prCreated: total(created), prMerged: total(merged) } };
}
