/**
 * Tests for scripts/read-trace/measure.mjs (Issue #4432 PR3, design §2.3.5).
 * Injected run-log lines, git facts and tables only.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isB2Target,
  isUnitRelatedRun,
  loadTables,
  measureRuns,
  readRunLog,
} from '../../../../scripts/read-trace/measure.mjs';
import { buildTable } from '../../../../scripts/read-trace/table.mjs';
import { collectGateEnv } from '../../../../scripts/read-trace/gate-env.mjs';

const ENV = collectGateEnv({ root: '/r', env: { CI: 'true' }, nodeVersion: 'v22.0.0', platform: 'linux', arch: 'x64', readFile: () => Buffer.from('l'), exists: () => false });

function verifyLine(head: string, gates = 'passed=lint,unit-related@contract') {
  return { stage: 'verify', head, issue: 1, at: '2026-11-18T00:00:00Z', note: `exit=0 ${gates} key=x` };
}

function table(commit: string, key: string) {
  return buildTable({
    commit,
    key,
    gateEnv: ENV,
    repoRoot: '/r',
    traces: [
      { testPath: 'tests/unit/doc.test.ts', reads: { 'docs/a.md': ['fs.readFileSync'] }, children: [], workers: 0 },
      { testPath: 'tests/unit/other.test.ts', reads: {}, children: [], workers: 0 },
    ],
    report: {
      testResults: [
        { name: '/r/tests/unit/doc.test.ts', status: 'passed', startTime: 0, endTime: 100, assertionResults: [{ status: 'passed' }] },
        { name: '/r/tests/unit/other.test.ts', status: 'passed', startTime: 0, endTime: 300, assertionResults: [{ status: 'passed' }] },
      ],
    },
  });
}

describe('isUnitRelatedRun', () => {
  it('counts verify lines whose unit-related gate ran, passed or failed', () => {
    expect(isUnitRelatedRun(verifyLine('h'))).toBe(true);
    expect(isUnitRelatedRun(verifyLine('h', 'passed=lint failed=unit-related@contract'))).toBe(true);
  });

  it('does not count a SKIP, a run without the gate, or another stage', () => {
    expect(isUnitRelatedRun(verifyLine('h', 'passed=lint failed=unit-related@contract:SKIP'))).toBe(false);
    expect(isUnitRelatedRun(verifyLine('h', 'passed=lint,typecheck'))).toBe(false);
    expect(isUnitRelatedRun({ ...verifyLine('h'), stage: 'precheck' })).toBe(false);
    expect(isUnitRelatedRun({ stage: 'verify' })).toBe(false);
  });
});

describe('isB2Target', () => {
  it('is a full run whose every full-making file is md / locales / integration / e2e', () => {
    expect(isB2Target(['docs/a.md', 'src/x.ts'])).toBe(true);
    expect(isB2Target(['locales/ja/common.json', 'tests/unit/a.test.ts'])).toBe(true);
    expect(isB2Target(['tests/integration/a.test.ts'])).toBe(true);
  });

  it('is not a related-only run, nor a run with any other full-making file', () => {
    expect(isB2Target(['src/x.ts', 'tests/unit/a.test.ts'])).toBe(false);
    expect(isB2Target(['docs/a.md', 'package.json'])).toBe(false);
    expect(isB2Target(['docs/a.md', 'scripts/x.mjs'])).toBe(false);
    expect(isB2Target(['changelog.d/1.md', 'CHANGELOG.md', 'docs/module-reference.md'])).toBe(false);
  });
});

describe('measureRuns', () => {
  const facts: Record<string, { mergeBase: string; changedFiles: string[] }> = {
    h1: { mergeBase: 'm1', changedFiles: ['docs/a.md', 'src/x.ts'] },
    h2: { mergeBase: 'm2', changedFiles: ['docs/a.md'] },
    h3: { mergeBase: 'm3', changedFiles: ['docs/a.md'] },
    h4: { mergeBase: 'm1', changedFiles: ['src/only.ts'] },
  };
  const keys: Record<string, string> = { m1: 'k1', m2: 'k2', m3: 'k3' };

  it('counts hits and misses by reason and computes f over the hits', () => {
    const tables = new Map<string, unknown>([
      ['m1', table('m1', 'k1')],
      ['m2', table('m2', 'stale')],
    ]);
    const r = measureRuns({
      lines: [verifyLine('h1'), verifyLine('h2'), verifyLine('h3'), verifyLine('h4'), verifyLine('h1', 'failed=unit-related@contract:SKIP')],
      facts: (h: string) => facts[h] ?? null,
      keyOf: (c: string) => keys[c],
      tables,
      verifyGateEnv: ENV,
    });
    expect(r.targets).toBe(3);
    expect(r.hits).toBe(1);
    expect(r.hitRate).toBeCloseTo(1 / 3);
    expect(r.hitRateMet).toBe(false);
    expect(r.reasons).toEqual({ hit: 1, 'key-mismatch': 1, 'no-table': 1 });
    // doc.test.ts (100 ms) of 400 ms.
    expect(r.f).toBeCloseTo(0.25);
    expect(r.fMet).toBe(true);
    expect(r.fExcludesCodeRelated).toBe(true);
  });

  it('counts a gate-env difference as a miss, and a key lookup that throws as a miss', () => {
    const tables = new Map<string, unknown>([['m1', table('m1', 'k1')]]);
    const r = measureRuns({
      lines: [verifyLine('h1')],
      facts: (h: string) => facts[h] ?? null,
      keyOf: () => 'k1',
      tables,
      verifyGateEnv: { ...ENV, node: 'v24.0.0' },
    });
    expect(r).toMatchObject({ targets: 1, hits: 0, hitRate: 0, f: null, fMet: false, reasons: { 'gate-env-mismatch': 1 } });

    const thrown = measureRuns({
      lines: [verifyLine('h1')],
      facts: (h: string) => facts[h] ?? null,
      keyOf: () => {
        throw new Error('git failed');
      },
      tables,
      verifyGateEnv: ENV,
    });
    expect(thrown).toMatchObject({ hits: 0, reasons: { 'key-mismatch': 1 } });
  });

  it('reports no rate at all when there is no target run', () => {
    const r = measureRuns({ lines: [], facts: () => null, keyOf: () => '', tables: new Map(), verifyGateEnv: ENV });
    expect(r).toMatchObject({ targets: 0, hitRate: null, hitRateMet: false, f: null, fMet: false });
  });
});

describe('readers of the inputs', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('reads run-log lines (skipping torn ones) and tables from nested artifact dirs (skipping unreadable ones)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-trace-measure-'));
    const log = path.join(dir, 'run-1.jsonl');
    fs.writeFileSync(log, `${JSON.stringify(verifyLine('h1'))}\n{torn\n\n`);
    expect(readRunLog([log])).toHaveLength(1);
    fs.mkdirSync(path.join(dir, 'tables', 'read-trace-m1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tables', 'read-trace-m1', 'table-m1.json'), JSON.stringify(table('m1', 'k1')));
    fs.writeFileSync(path.join(dir, 'tables', 'broken.json'), '{');
    const tables = loadTables(path.join(dir, 'tables'));
    expect([...tables.keys()]).toEqual(['m1']);
  });
});
