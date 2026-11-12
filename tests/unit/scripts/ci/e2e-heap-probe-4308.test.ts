/**
 * [Issue #4308] E2E heap probe.
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const probe = req('../../../../scripts/ci/e2e-heap-probe.cjs');
const MB = 1024 * 1024;

let dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'heap-probe-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('e2e-heap-probe', () => {
  it('computes the ratio in percent (1 decimal)', () => {
    expect(probe.computeRatio(5400 * MB, 8192 * MB)).toBe(65.9);
    expect(probe.computeRatio(0, 8192 * MB)).toBe(0);
  });

  it('returns null for an invalid limit instead of throwing', () => {
    expect(probe.computeRatio(1, 0)).toBeNull();
    expect(probe.computeRatio(NaN, 10)).toBeNull();
  });

  it('picks the highest peak and ignores broken records / files', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'heap-1.json'), JSON.stringify({ peakHeapUsed: 100 * MB, heapSizeLimit: 1000 * MB }));
    fs.writeFileSync(path.join(d, 'heap-2.json'), JSON.stringify({ peakHeapUsed: 500 * MB, heapSizeLimit: 1000 * MB }));
    fs.writeFileSync(path.join(d, 'heap-3.json'), '{broken');
    fs.writeFileSync(path.join(d, 'other.json'), JSON.stringify({ peakHeapUsed: 9e12, heapSizeLimit: 1 }));
    const line = probe.summarize(d, path.join(d, 'summary.md'));
    expect(line).toBe('E2E heap peak: 500MB / limit 1000MB = 50% (headroom 50%)');
    expect(fs.readFileSync(path.join(d, 'summary.md'), 'utf8')).toBe(line + '\n');
  });

  it('does not throw when the directory is missing or the summary file is unwritable', () => {
    const d = tmp();
    expect(() => probe.summarize(path.join(d, 'nope'), path.join(d, 'nope', 'x.md'))).not.toThrow();
    expect(probe.summarize(path.join(d, 'nope'))).toBe('E2E heap probe: no data');
  });

  it('startProbe writes a record and never throws on an unusable dir', () => {
    const d = tmp();
    probe.startProbe(path.join(d, 'out'), 50);
    const recs = probe.readRecords(path.join(d, 'out'));
    expect(recs.length).toBe(1);
    expect(recs[0].peakHeapUsed).toBeGreaterThan(0);
    const file = path.join(d, 'afile');
    fs.writeFileSync(file, 'x');
    expect(() => probe.startProbe(path.join(file, 'sub'), 50)).not.toThrow();
  });
});
