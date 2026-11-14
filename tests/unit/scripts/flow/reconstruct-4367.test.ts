/**
 * T-R (Issue #4367 PR1a, docs/design/flow-metrics-4367.md §7.7・§8): `reconstruct --date
 * 2026-11-13 --tz Asia/Tokyo` over the fixture reproduces the hourly table of §8.3, and the
 * hand-computed witnesses W1〜W8 of §8.4 hold.
 *
 * The expected table is written here from the design, not computed by the product
 * (§8.2-1). The fixture's provenance is in tests/fixtures/flow/2026-11-13/meta.json: it is a
 * local reconstruction (develop's squash commits and the orchestrate run-log), not yet the
 * answer of the two gh queries — the leader re-fetches it before acceptance 2.
 *
 * @vitest-environment node
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../../../scripts/flow/flow.mjs';
import { hourlyPrCounts } from '../../../../scripts/flow/aggregate.mjs';
import { TempDirs, fakeRun, io, ok, prList, type Call, type GhAnswer, type RunAnswer } from './flow-fakes';

const FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'flow', '2026-11-13');
const read = (name: string) => fs.readFileSync(path.join(FIXTURE, name), 'utf8');
const meta = JSON.parse(read('meta.json'));

/** §8.3, hours 0〜23 JST. */
const EXPECTED = {
  prCreated: [1, 3, 2, 0, 3, 0, 0, 1, 2, 4, 0, 0, 1, 2, 4, 2, 3, 1, 5, 0, 0, 0, 0, 0],
  prMerged: [1, 0, 1, 1, 1, 2, 2, 2, 1, 1, 2, 1, 1, 1, 1, 2, 1, 0, 0, 6, 2, 1, 3, 1],
};

const temps = new TempDirs();
afterEach(() => temps.cleanup());

interface Hour {
  hour: string;
  prCreated: number | null;
  prMerged: number | null;
}
interface Reconstructed {
  window: { from: string; to: string };
  hours: Hour[];
  totals: { prCreated: number | null; prMerged: number | null };
  metrics: Record<string, { value: number | null; why?: string; complete: boolean; coverage: string }>;
}

/** Answers each search from the fixture file `meta.json` binds it to. */
const fixtureGh = (merged: RunAnswer = ok(read(meta.queries.merged.file))): GhAnswer => (args) => {
  for (const kind of ['created', 'merged'] as const) {
    if (JSON.stringify(args) === JSON.stringify(meta.queries[kind].args)) return kind === 'created' ? ok(read(meta.queries.created.file)) : merged;
  }
  return { status: 1, stdout: '', stderr: `no fixture for ${args.join(' ')}` };
};

function reconstruct(gh: GhAnswer = fixtureGh(), argv = ['--date', '2026-11-13', '--tz', 'Asia/Tokyo']) {
  const calls: Call[] = [];
  const out = io();
  const root = temps.make();
  const code = main(['reconstruct', ...argv, '--json'], {
    run: fakeRun({}, gh, calls),
    monoNow: () => 0,
    now: () => Date.parse('2026-11-14T00:00:00Z'),
    env: { CM_FLOW_DIR: path.join(root, 'flow'), CM_VERIFY_LOCK_ROOT: path.join(root, 'locks') },
    home: root,
    cwd: root,
    stdout: out.stdout,
    stderr: out.stderr,
  });
  expect(code).toBe(0);
  expect(fs.readdirSync(root)).toEqual([]);
  return { result: JSON.parse(out.out[0]) as Reconstructed, calls };
}

const hourOf = (result: Reconstructed, h: number) => result.hours[h];

describe('T-R: 2026-11-13 reproduced (§7.7・§8)', () => {
  it('R1 every cell of the two columns × 24 hours, and the totals (34 / 34)', () => {
    const { result } = reconstruct();
    expect(result.window).toEqual({ from: '2026-11-12T15:00:00.000Z', to: '2026-11-13T15:00:00.000Z' });
    expect(result.hours.map((h) => h.hour)).toEqual(Array.from({ length: 24 }, (_, h) => `2026-11-13T${String(h).padStart(2, '0')}+09:00`));
    expect(result.hours.map((h) => h.prCreated)).toEqual(EXPECTED.prCreated);
    expect(result.hours.map((h) => h.prMerged)).toEqual(EXPECTED.prMerged);
    expect(result.totals).toEqual({ prCreated: 34, prMerged: 34 });
    expect(result.metrics.prCreated).toMatchObject({ value: 34, coverage: 'search-observed', complete: false });
  });

  it('R3 the searches reconstruct sends are the ones meta.json binds the fixture to', () => {
    const { calls } = reconstruct();
    const gh = calls.filter((c) => c.cmd === 'gh').map((c) => ({ cmd: c.cmd, args: c.args }));
    expect(gh).toEqual([
      { cmd: meta.queries.created.cmd, args: meta.queries.created.args },
      { cmd: meta.queries.merged.cmd, args: meta.queries.merged.args },
    ]);
  });

  it('R3 meta.json names the files it binds: count and the sha256 of the numbers', () => {
    for (const kind of ['created', 'merged'] as const) {
      const items = JSON.parse(read(meta.queries[kind].file)) as Array<{ number: number }>;
      expect(items).toHaveLength(meta.queries[kind].count);
      const numbers = items.map((i) => i.number).join(',');
      expect(crypto.createHash('sha256').update(numbers).digest('hex')).toBe(meta.queries[kind].numbersSha256);
      for (const item of items) expect(Object.keys(item).sort()).toEqual(['baseRefName', kind === 'created' ? 'createdAt' : 'mergedAt', 'number'].sort());
    }
  });

  it('R4 (negative) the merged search fails: that column is null every hour, the created column is unchanged', () => {
    const { result } = reconstruct(fixtureGh({ status: 1, stdout: '', stderr: 'HTTP 502' }));
    expect(result.hours.every((h) => h.prMerged === null)).toBe(true);
    expect(result.totals.prMerged).toBeNull();
    expect(result.metrics.prMerged).toMatchObject({ value: null, why: 'fail' });
    expect(result.hours.map((h) => h.prCreated)).toEqual(EXPECTED.prCreated);
  });
});

describe('R2: the witnesses of §8.4', () => {
  const real = () => reconstruct().result;
  const mergedTimes = new Map((JSON.parse(read('merged.json')) as Array<{ number: number; mergedAt: string }>).map((p) => [p.number, p.mergedAt]));
  const jst = (n: number) => new Date(Date.parse(String(mergedTimes.get(n))) + 9 * 3_600_000).toISOString().slice(11, 16);

  it('W1 #4342 merged 13:05 JST: hour 13', () => {
    expect(jst(4342)).toBe('13:05');
    expect(hourOf(real(), 13).prMerged).toBe(1);
  });

  it('W2 #4340 merged 10:59 JST: hour 10, not 11', () => {
    expect(jst(4340)).toBe('10:59');
    const r = real();
    expect(hourOf(r, 10).prMerged).toBe(2);
    expect(hourOf(r, 11).prMerged).toBe(1);
  });

  it('W3 #4361 merged 22:00 JST: hour 22, not 21', () => {
    expect(jst(4361)).toBe('22:00');
    const r = real();
    expect(hourOf(r, 22).prMerged).toBe(3);
    expect(hourOf(r, 21).prMerged).toBe(1);
  });

  it('W4 #4349 16:40, then #4358 19:02: hours 17 and 18 have no merge', () => {
    expect([jst(4349), jst(4358)]).toEqual(['16:40', '19:02']);
    const r = real();
    expect([hourOf(r, 17).prMerged, hourOf(r, 18).prMerged]).toEqual([0, 0]);
  });

  it('W5 the six of hour 19 (#4358 #4359 #4356 #4360 #4362 #4352)', () => {
    expect([4358, 4359, 4356, 4360, 4362, 4352].map(jst)).toEqual(['19:02', '19:03', '19:06', '19:06', '19:08', '19:10']);
    expect(hourOf(real(), 19).prMerged).toBe(6);
  });

  const synthetic = (created: Array<[number, string]>, merged: Array<[number, string]>) =>
    reconstruct((args) => (args[9].startsWith('created') ? ok(prList('createdAt', created)) : ok(prList('mergedAt', merged)))).result;

  it('W6 merges at 18:59:59.999 and 19:00:00.000 JST: one in 18, one in 19', () => {
    const r = synthetic([], [[1, '2026-11-13T09:59:59.999Z'], [2, '2026-11-13T10:00:00.000Z']]);
    expect([hourOf(r, 18).prMerged, hourOf(r, 19).prMerged]).toEqual([1, 1]);
  });

  it('W7 created before the window (11-12 23:50 JST), merged 11-13 00:10: merged in hour 0, created not counted', () => {
    const r = synthetic([[1, '2026-11-12T14:50:00Z']], [[1, '2026-11-12T15:10:00Z']]);
    expect(hourOf(r, 0).prMerged).toBe(1);
    expect(r.totals).toEqual({ prCreated: 0, prMerged: 1 });
  });

  it('W8 a merge at exactly 11-14 00:00:00.000 JST: not in the 11-13 window', () => {
    const r = synthetic([], [[1, '2026-11-13T15:00:00.000Z']]);
    expect(r.totals.prMerged).toBe(0);
  });
});

describe('the hourly split across zones and DST (§13 / prereview-4367-3 §4)', () => {
  const times = { prCreated: [Date.parse('2026-11-13T00:30:00Z'), Date.parse('2026-11-13T12:00:00Z')], prMerged: [Date.parse('2026-11-13T20:00:00Z')] };
  const window = { from: Date.parse('2026-11-13T00:00:00Z'), to: Date.parse('2026-11-14T00:00:00Z') };

  it('P15 the same absolute [from, to) in UTC and Asia/Tokyo: rows differ, totals are the same', () => {
    const utc = hourlyPrCounts(times, { ...window, tz: 'UTC' });
    const tokyo = hourlyPrCounts(times, { ...window, tz: 'Asia/Tokyo' });
    expect(utc.totals).toEqual(tokyo.totals);
    expect(utc.hours[0].hour).toBe('2026-11-13T00+00:00');
    expect(tokyo.hours[0].hour).toBe('2026-11-13T09+09:00');
    expect(utc.hours).toHaveLength(24);
    expect(tokyo.hours).toHaveLength(24);
  });

  it('a 23-hour day and a 25-hour day (America/New_York) have 23 and 25 rows; the repeated hour stays apart', () => {
    const spring = reconstruct(fixtureGh(), ['--date', '2026-03-08', '--tz', 'America/New_York']).result;
    expect(spring.hours).toHaveLength(23);
    const fall = reconstruct(fixtureGh(), ['--date', '2026-11-01', '--tz', 'America/New_York']).result;
    expect(fall.hours).toHaveLength(25);
    expect(fall.hours.map((h) => h.hour).filter((k) => k.startsWith('2026-11-01T01'))).toEqual(['2026-11-01T01-04:00', '2026-11-01T01-05:00']);
  });

  it('a zone offset by 30 minutes still gets one row per local hour', () => {
    const r = hourlyPrCounts(times, { ...window, tz: 'Asia/Kolkata' });
    expect(r.hours).toHaveLength(25);
    expect(r.totals).toEqual({ prCreated: 2, prMerged: 1 });
  });
});
