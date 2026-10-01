/**
 * Issue #3054: performance metrics from the production log and the server
 * process. The aggregation is pure; what may be published (the repository is
 * public) is `<tag> <event>` names, counts, durations and breakdown field
 * names only — never a value from a log line's JSON.
 */

import { describe, expect, it } from 'vitest';
import {
  addLogLine,
  createLogAggregate,
  findServerPid,
  logCoverageProblem,
  logName,
  measureApiLatency,
  measureErrorRate,
  measureLogVolume,
  measureServerProcess,
  parseLogLine,
  parsePsSample,
  parsePsTable,
  percentile,
  probeFailureReason,
  type LogAggregate,
} from '@/lib/agent-health/metrics-perf';

const NOW = new Date('2026-10-01T21:30:00.000Z');
const HOUR = 60 * 60 * 1000;

/** ISO time `hoursAgo` before NOW. */
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();

function line(hoursAgo: number, level: string, tag: string, event: string, data?: unknown): string {
  return `[${at(hoursAgo)}] [${level}] [${tag}] ${event}${data === undefined ? '' : ` ${JSON.stringify(data)}`}`;
}

function aggregate(lines: readonly string[]): LogAggregate {
  const agg = createLogAggregate(NOW);
  // a line older than the window, so the log "reaches back" 24 hours
  addLogLine(agg, line(30, 'INFO', 'boot', 'ready'));
  for (const raw of lines) addLogLine(agg, raw);
  return agg;
}

describe('parseLogLine', () => {
  it('reads the text format, skipping the worktree context and request id', () => {
    const parsed = parseLogLine(
      `[${at(1)}] [WARN] [api/worktrees] [wt-secret:claude] (abcdef12) list:slow {"totalMs":10}`
    );
    expect(parsed).toMatchObject({ level: 'WARN', name: 'api/worktrees list:slow', data: '{"totalMs":10}' });
  });

  it('reads the JSON format', () => {
    const parsed = parseLogLine(JSON.stringify({ timestamp: at(1), level: 'error', module: 'git-exec', action: 'git:command-failed', data: { a: 1 } }));
    expect(parsed).toMatchObject({ level: 'ERROR', name: 'git-exec git:command-failed' });
  });

  it('ignores lines the logger did not write', () => {
    expect(parseLogLine('> commandmate@0.42.2 start')).toBeNull();
    expect(parseLogLine('    at Object.<anonymous> (/Users/x/file.js:1:1)')).toBeNull();
    expect(parseLogLine('')).toBeNull();
  });

  it('folds names that are not identifiers into (other) and drops a trailing colon', () => {
    expect(logName('slash-commands', 'error-parsing-skill-file-skillpath:')).toBe('slash-commands error-parsing-skill-file-skillpath');
    expect(logName('x', '/Users/someone/private/path')).toBe('x (other)');
    expect(logName('/Users/someone', 'ok')).toBe('(other) ok');
    expect(logName('a b', 'ok')).toBe('(other) ok');
  });
});

describe('percentile', () => {
  it('nearest rank', () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    expect(percentile(values, 50)).toBe(10);
    expect(percentile(values, 95)).toBe(19);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBe(0);
  });
});

describe('aggregation over the last 24 hours', () => {
  it('counts only lines inside the window, by <tag> <event>', () => {
    const agg = aggregate([
      line(25, 'ERROR', 'git-exec', 'git:command-failed'), // older than 24h: not counted
      line(23, 'ERROR', 'git-exec', 'git:command-failed'),
      line(2, 'INFO', 'response-poller', 'duplicate-response-skipped'),
      line(1, 'INFO', 'response-poller', 'duplicate-response-skipped'),
      'not a log line',
    ]);
    expect(agg.lines).toBe(3);
    expect(agg.byName).toEqual({ 'git-exec git:command-failed': 1, 'response-poller duplicate-response-skipped': 2 });
    expect(agg.errors).toEqual({ 'git-exec git:command-failed': 1 });
    expect(logCoverageProblem(agg)).toBeNull();
  });

  it('a log that does not reach back 24 hours, or has no line in the window, cannot stand for a day', () => {
    const short = createLogAggregate(NOW);
    addLogLine(short, line(3, 'INFO', 'a', 'b'));
    expect(logCoverageProblem(short)).toMatch(/満たない/);
    const old = createLogAggregate(NOW);
    addLogLine(old, line(30, 'INFO', 'a', 'b'));
    expect(logCoverageProblem(old)).toMatch(/行が無い/);
  });

  it('collects WARN lines with totalMs only (a WARN without totalMs, or an INFO with it, is not a latency)', () => {
    const agg = aggregate([
      line(1, 'WARN', 'api/worktrees', 'list:slow', { totalMs: 1000, probeMs: 900, dbMs: 50 }),
      line(1, 'WARN', 'api/worktrees', 'list:slow', { totalMs: 3000, probeMs: 2500, dbMs: 100 }),
      line(1, 'WARN', 'api/worktrees', 'list:slow', { count: 3 }),
      line(1, 'WARN', 'other', 'warned'),
      line(1, 'DEBUG', 'api/worktrees', 'list:timing', { totalMs: 99999 }),
      line(25, 'WARN', 'api/worktrees', 'list:slow', { totalMs: 99999 }),
    ]);
    expect(Object.keys(agg.latency)).toEqual(['api/worktrees list:slow']);
    expect(agg.latency['api/worktrees list:slow']).toEqual({ totals: [1000, 3000], breakdown: { probeMs: 3400, dbMs: 150 } });
  });
});

describe('measureApiLatency', () => {
  it('count, p50, p95, max and the largest breakdown field per <tag> <event>; value is list:slow p95', () => {
    const lines = Array.from({ length: 20 }, (_, i) =>
      line(1, 'WARN', 'api/worktrees', 'list:slow', { totalMs: (i + 1) * 1000, probeMs: (i + 1) * 900, dbMs: 10 })
    );
    const m = measureApiLatency(aggregate(lines));
    expect(m).toMatchObject({
      status: 'ok',
      value: 19000,
      items: { 'p95:api/worktrees:list:slow': 19000, 'count:api/worktrees:list:slow': 20 },
    });
    if (m.status !== 'ok') throw new Error('ok expected');
    expect(Object.keys(m.findings)).toEqual(['api/worktrees:list:slow']);
    expect(m.findings['api/worktrees:list:slow'].evidence).toBe(
      'api/worktrees list:slow（直近 24 時間の WARN）: 20 件 / p50 10,000ms / p95 19,000ms / 最大 20,000ms / 内訳の最大 probeMs（合計 189,000ms）'
    );
  });

  it('value 0 and no findings when there is no list:slow', () => {
    const m = measureApiLatency(aggregate([line(1, 'INFO', 'a', 'b')]));
    expect(m).toMatchObject({ status: 'ok', value: 0, items: {}, findings: {} });
  });

  it('a p95 just under 5,000ms is not a finding', () => {
    const m = measureApiLatency(aggregate([line(1, 'WARN', 'api/worktrees', 'list:slow', { totalMs: 4999 })]));
    expect(m).toMatchObject({ status: 'ok', findings: {} });
  });
});

describe('measureLogVolume / measureErrorRate', () => {
  it('lines per <tag> <event>; findings at the thresholds', () => {
    const lines = [
      ...Array.from({ length: 50 }, () => line(1, 'ERROR', 'slash-commands', 'error-parsing-skill-file-skillpath:', { error: 'x' })),
      ...Array.from({ length: 49 }, () => line(1, 'ERROR', 'git-exec', 'git:command-failed')),
    ];
    const errors = measureErrorRate(aggregate(lines));
    expect(errors).toMatchObject({
      status: 'ok',
      value: 99,
      items: { 'slash-commands:error-parsing-skill-file-skillpath': 50, 'git-exec:git:command-failed': 49 },
    });
    if (errors.status !== 'ok') throw new Error('ok expected');
    expect(Object.keys(errors.findings)).toEqual(['slash-commands:error-parsing-skill-file-skillpath']);

    const volume = measureLogVolume(aggregate(lines));
    expect(volume).toMatchObject({ status: 'ok', value: 99, findings: {} });
  });
});

describe('server-process', () => {
  it('reads ps output', () => {
    expect(parsePsSample('  461234   9.3\n')).toEqual({ rssKb: 461234, cpu: 9.3 });
    expect(parsePsSample('')).toBeNull();
    const table = parsePsTable(' 6060     1 npm start\n 6084  6060 node dist/server/server.js\n 7000  6060 sh -c x\n');
    expect(findServerPid(6060, table)).toBe(6084);
    expect(findServerPid(6084, table)).toBe(6084);
    expect(findServerPid(1234, table)).toBeNull();
  });

  it('RSS max (MB) as value, CPU average and the API median in details', () => {
    const m = measureServerProcess(
      [
        { rssKb: 400 * 1024, cpu: 10 },
        { rssKb: 1600 * 1024, cpu: 20 },
      ],
      [{ ok: true, ms: 300 }, { ok: true, ms: 100 }, { ok: true, ms: 200 }]
    );
    expect(m).toMatchObject({
      status: 'ok',
      value: 1600,
      items: { rssMaxMb: 1600, cpuAvgPct: 15 },
      details: { samples: 2, rssMaxMb: 1600, cpuAvgPct: 15, cpuMaxPct: 20, apiWorktreesMedianMs: 200, apiWorktreesCalls: 3 },
    });
    if (m.status !== 'ok') throw new Error('ok expected');
    expect(Object.keys(m.findings)).toEqual(['rss']);
  });

  it('an API that cannot be called leaves only the reason', () => {
    const m = measureServerProcess([{ rssKb: 1024, cpu: 1 }], [{ ok: false, reason: 'HTTP 401' }]);
    expect(m).toMatchObject({ status: 'ok', details: { apiWorktreesError: 'HTTP 401' } });
    expect(measureServerProcess([], [])).toMatchObject({ status: 'skip' });
  });

  it('failure reasons carry no message text', () => {
    expect(probeFailureReason(null, 401)).toBe('HTTP 401');
    expect(probeFailureReason(Object.assign(new TypeError('fetch failed /Users/x'), { cause: { code: 'ECONNREFUSED' } }))).toBe('ECONNREFUSED');
    expect(probeFailureReason(new Error('/Users/someone/secret'))).toBe('Error');
  });
});

describe('nothing from a log line JSON reaches the output', () => {
  it('worktree ids, paths and messages stay out of titles, evidence and details', () => {
    const secrets = ['wt-private-1234', '/Users/someone/secret-repo', 'ENOENT: no such file'];
    const lines = [
      ...Array.from({ length: 60 }, () =>
        line(1, 'ERROR', 'slash-commands', 'error-parsing-skill-file-skillpath:', { error: `${secrets[2]}, stat '${secrets[1]}/SKILL.md'` })
      ),
      ...Array.from({ length: 30 }, () =>
        `[${at(1)}] [WARN] [api/worktrees] [${secrets[0]}:claude] list:slow ${JSON.stringify({ totalMs: 9000, worktreeId: secrets[0], path: secrets[1] })}`
      ),
      ...Array.from({ length: 10 }, () => line(1, 'ERROR', 'x', `${secrets[1]}/failed`)),
    ];
    const agg = aggregate(lines);
    const text = JSON.stringify([measureApiLatency(agg), measureLogVolume(agg), measureErrorRate(agg)]);
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).not.toContain('/Users/');
    expect(text).toContain('x (other)');
  });
});
