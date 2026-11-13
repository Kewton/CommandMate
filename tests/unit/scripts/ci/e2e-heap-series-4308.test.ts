/**
 * [Issue #4308] Heap time series, timeline reporter, and the local-inert negative control.
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const probe = req('../../../../scripts/ci/e2e-heap-probe.cjs');
const Reporter = req('../../../../scripts/ci/e2e-timeline-reporter.cjs');
const ROOT = path.resolve(__dirname, '../../../..');

let dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'heap-series-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function lines(file: string): Array<Record<string, unknown>> {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('heap series', () => {
  it('startProbe writes JSONL with timestamp/pid/heapUsed/heapTotal/rss and keeps the summary json', () => {
    const d = tmp();
    probe.startProbe(d, 20);
    const f = path.join(d, `series-${process.pid}.jsonl`);
    const recs = lines(f);
    expect(recs.length).toBeGreaterThanOrEqual(1);
    const r = recs[0];
    expect(Number.isNaN(Date.parse(r.timestamp as string))).toBe(false);
    expect(r.pid).toBe(process.pid);
    for (const k of ['heapUsed', 'heapTotal', 'rss']) expect(r[k]).toBeGreaterThan(0);
    expect(probe.readRecords(d).length).toBe(1); // heap-<pid>.json only; series is not a summary record
  });

  it('caps the number of lines', () => {
    const d = tmp();
    const f = path.join(d, 's.jsonl');
    const rec = probe.buildSeriesRecord(1, { heapUsed: 1, heapTotal: 2, rss: 3 }, 0);
    let n = 0;
    for (let i = 0; i < 10; i++) n = probe.appendSeries(f, rec, n, 3);
    expect(n).toBe(3);
    expect(lines(f).length).toBe(3);
    expect(probe.MAX_SERIES_LINES).toBeGreaterThan(0);
  });

  it('does not throw on an unwritable path or bad input', () => {
    const d = tmp();
    expect(probe.appendSeries(path.join(d, 'no', 'such', 'x.jsonl'), { a: 1 }, 0)).toBe(0);
    expect(probe.buildSeriesRecord(1, null)).toBeNull();
    expect(() => probe.startProbe(path.join(d, 'afile', 'x'), 20)).not.toThrow();
  });
});

describe('timeline reporter', () => {
  it('records test begin/end times and respects the cap', () => {
    const d = tmp();
    const rep = new Reporter({ dir: d, max: 3 });
    const t = { title: 't1', location: { file: '/x/y/spec-a.spec.ts' } };
    rep.onTestBegin(t, { retry: 0 });
    rep.onTestEnd(t, { retry: 0, status: 'passed', duration: 12 });
    rep.onTestBegin(t, { retry: 1 });
    rep.onTestEnd(t, { retry: 1, status: 'passed', duration: 1 });
    const recs = lines(path.join(d, 'timeline.jsonl'));
    expect(recs.length).toBe(3);
    expect(recs[0]).toMatchObject({ event: 'test-begin', file: 'spec-a.spec.ts', title: 't1' });
    expect(recs[1]).toMatchObject({ event: 'test-end', status: 'passed', durationMs: 12 });
    expect(rep.printsToStdio()).toBe(false);
  });

  it('never throws on an unusable dir or odd input', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'afile'), '');
    const rep = new Reporter({ dir: path.join(d, 'afile', 'sub') });
    expect(() => rep.onTestBegin({}, undefined)).not.toThrow();
    expect(() => rep.onTestEnd(undefined, undefined)).not.toThrow();
  });
});

describe('local runs stay inert (negative control)', () => {
  it('playwright.config wires the reporter only under CI and CM_E2E_HEAP_PROBE_DIR', () => {
    const src = fs.readFileSync(path.join(ROOT, 'playwright.config.ts'), 'utf8');
    expect(src).toMatch(/process\.env\.CI\s*\n?\s*\?/);
    expect(src).toMatch(/process\.env\.CM_E2E_HEAP_PROBE_DIR \? \[\['\.\/scripts\/ci\/e2e-timeline-reporter\.cjs'\]/);
    expect(src).toMatch(/:\s*'html'/);
  });

  it('requiring the probe without CM_E2E_HEAP_PROBE_DIR writes nothing', () => {
    const d = tmp();
    const env = { ...process.env };
    delete env.CM_E2E_HEAP_PROBE_DIR;
    const r = spawnSync(process.execPath, ['--require', path.join(ROOT, 'scripts/ci/e2e-heap-probe.cjs'), '-e', '0'], {
      cwd: d,
      env,
    });
    expect(r.status).toBe(0);
    expect(fs.readdirSync(d)).toEqual([]);
  });
});
