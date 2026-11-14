/**
 * The two searches of flow PR1a (Issue #4367, docs/design/flow-metrics-4367.md §2.3).
 *
 * What a value means (R7 disposition, prereview-4367-3): the number of PRs the GitHub
 * search **returned** for `[from, to)` — `coverage: "search-observed"`. A search that
 * answered normally does not show that every PR event of the repo/base is in it (the index
 * can lag), so `complete` is always false here: V1's completeness of the population is not
 * claimed by PR1a. A failed / truncated / malformed answer is `value: null` with `why`.
 *
 * Never throws: each metric fails on its own (T-P P14).
 */
import { PR_LIMIT, PR_QUERY_FIELDS } from './runner.mjs';
import { countInWindow, searchDateRange, validatePrList } from './aggregate.mjs';

export const GH_CAP_MS = 30_000;
export const COVERAGE = 'search-observed';
const DENIED = /\bHTTP 40[34]\b/;

/** The args of one search (also what `meta.json` of the fixture records). */
export function prSearchArgs(kind, { repo, base, window }) {
  return [
    'pr',
    'list',
    '--repo',
    repo,
    '--base',
    base,
    '--state',
    kind === 'created' ? 'all' : 'merged',
    '--search',
    `${kind}:${searchDateRange(window)}`,
    '--limit',
    String(PR_LIMIT),
    '--json',
    PR_QUERY_FIELDS[kind],
  ];
}

/** A metric that could not be observed. */
function unknownMetric(why, fetchedAt = null) {
  return { value: null, coverage: COVERAGE, complete: false, why, fetchedAt, limit: PR_LIMIT };
}

/**
 * One search: `{ metric, times }` where `times` (epoch ms in `[from, to)`) is null when the
 * metric is unknown.
 */
function observe(kind, runBounded, { repo, base, window, deadlineMono, now }) {
  let r;
  try {
    r = runBounded('gh', prSearchArgs(kind, { repo, base, window }), { deadlineMono, capMs: GH_CAP_MS });
  } catch {
    return { metric: unknownMetric('fail'), times: null };
  }
  const fetchedAt = new Date(now()).toISOString();
  if (r.status === 'timeout') return { metric: unknownMetric('timeout'), times: null };
  if (r.status !== 'ok') {
    const text = `${r.stderr ?? ''}\n${r.stdout ?? ''}`;
    return { metric: unknownMetric(DENIED.test(text) ? 'denied' : 'fail', fetchedAt), times: null };
  }
  const checked = validatePrList(String(r.stdout ?? ''), {
    field: kind === 'created' ? 'createdAt' : 'mergedAt',
    base,
    limit: PR_LIMIT,
  });
  if (!checked.ok) return { metric: unknownMetric(checked.why, fetchedAt), times: null };
  const times = checked.times.filter((t) => t >= window.from && t < window.to);
  return {
    metric: { value: countInWindow(times, window), coverage: COVERAGE, complete: false, fetchedAt, limit: PR_LIMIT },
    times,
  };
}

/**
 * `prCreated` then `prMerged`, each through `runBounded` against the same deadline (§3.2).
 * @param {Function} runBounded
 * @param {{ repo: string, base: string, window: { from: number, to: number }, deadlineMono: number, now?: () => number }} options
 * @returns {{ prCreated: object, prMerged: object, events: { prCreated: number[] | null, prMerged: number[] | null } }}
 */
export function readPrCounts(runBounded, options) {
  const opts = { ...options, now: options.now ?? (() => Date.now()) };
  const created = observe('created', runBounded, opts);
  const merged = observe('merged', runBounded, opts);
  return {
    prCreated: created.metric,
    prMerged: merged.metric,
    events: { prCreated: created.times, prMerged: merged.times },
  };
}
