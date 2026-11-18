/**
 * Tests for scripts/read-trace/table.mjs and gate-env.mjs (Issue #4432 PR3).
 *
 * The lookup is fail-closed: positive control = the key and the gate-env both
 * match → hit; negative controls = key differs / no table / unreadable table /
 * gate-env differs (or is missing) → miss. Built from injected records only.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  buildTable,
  computeF,
  isB2DataFile,
  lookupHit,
  readerKey,
  READER_PATHS,
  selectTests,
  TABLE_VERSION,
} from '../../../../scripts/read-trace/table.mjs';
import { collectGateEnv, compareGateEnv } from '../../../../scripts/read-trace/gate-env.mjs';

const ROOT = '/repo';

function gateEnv(overrides: Record<string, unknown> = {}) {
  return {
    ...collectGateEnv({
      root: ROOT,
      env: { PATH: '/bin', CI: 'true' },
      nodeVersion: 'v22.1.0',
      platform: 'linux',
      arch: 'arm64',
      readFile: () => Buffer.from('lock'),
      exists: (p: string) => p === '/bin/git' || p === '/bin/bash',
    }),
    ...overrides,
  };
}

function passed(name: string, ms: number) {
  return { name: `${ROOT}/${name}`, status: 'passed', startTime: 1000, endTime: 1000 + ms, assertionResults: [{ status: 'passed' }] };
}

function sampleTable(key = 'key-a', env = gateEnv()) {
  return buildTable({
    commit: 'c0ffee',
    key,
    gateEnv: env,
    repoRoot: ROOT,
    traces: [
      { testPath: 'tests/unit/reads-doc.test.ts', reads: { 'docs/a.md': ['fs.readFileSync'] }, children: [], workers: 0 },
      { testPath: 'tests/unit/lists-docs.test.ts', reads: { docs: ['fs.readdirSync'] }, children: [], workers: 0 },
      { testPath: 'tests/unit/stats-docs.test.ts', reads: { docs: ['fs.statSync'] }, children: [], workers: 0 },
      { testPath: 'tests/unit/spawns.test.ts', reads: {}, children: [{ fn: 'spawnSync', command: 'git' }], workers: 0 },
      { testPath: 'tests/unit/worker.test.ts', reads: {}, children: [], workers: 1 },
      { testPath: 'tests/unit/unrelated.test.ts', reads: { 'src/x.ts': ['fs.readFileSync'] }, children: [], workers: 0 },
      { testPath: 'tests/unit/guards/g.test.ts', reads: {}, children: [], workers: 0 },
      { testPath: 'tests/unit/skipped.test.ts', reads: {}, children: [], workers: 0 },
      { testPath: 'tests/unit/only-traced.test.ts', reads: {}, children: [], workers: 0 },
    ],
    report: {
      testResults: [
        passed('tests/unit/reads-doc.test.ts', 100),
        passed('tests/unit/lists-docs.test.ts', 100),
        passed('tests/unit/stats-docs.test.ts', 100),
        passed('tests/unit/spawns.test.ts', 100),
        passed('tests/unit/worker.test.ts', 100),
        passed('tests/unit/unrelated.test.ts', 400),
        passed('tests/unit/guards/g.test.ts', 50),
        { ...passed('tests/unit/skipped.test.ts', 50), assertionResults: [{ status: 'passed' }, { status: 'skipped' }] },
        passed('tests/unit/only-reported.test.ts', 100),
      ],
    },
  });
}

describe('buildTable', () => {
  it('records reads and durations, and makes children / workers / non-pass / untraced / unreported files opaque', () => {
    const t = sampleTable();
    expect(t.version).toBe(TABLE_VERSION);
    expect(t.files['tests/unit/reads-doc.test.ts']).toMatchObject({ opaque: false, durationMs: 100, reads: { 'docs/a.md': ['fs.readFileSync'] } });
    expect(t.files['tests/unit/spawns.test.ts'].reasons).toEqual(['child-process']);
    expect(t.files['tests/unit/worker.test.ts'].reasons).toEqual(['worker-thread']);
    expect(t.files['tests/unit/skipped.test.ts'].reasons).toEqual(['not-passed']);
    expect(t.files['tests/unit/only-reported.test.ts'].reasons).toEqual(['no-trace']);
    expect(t.files['tests/unit/only-traced.test.ts'].reasons).toEqual(['not-reported']);
    expect(t.files['tests/unit/unrelated.test.ts'].opaque).toBe(false);
  });

  it('treats a failed file as opaque (M7)', () => {
    const t = buildTable({
      commit: 'c',
      key: 'k',
      gateEnv: gateEnv(),
      repoRoot: ROOT,
      traces: [{ testPath: 'tests/unit/f.test.ts', reads: {}, children: [], workers: 0 }],
      report: { testResults: [{ ...passed('tests/unit/f.test.ts', 10), status: 'failed' }] },
    });
    expect(t.files['tests/unit/f.test.ts'].reasons).toEqual(['not-passed']);
  });
});

describe('lookupHit (fail-closed)', () => {
  it('positive control: key and gate-env both match → hit', () => {
    expect(lookupHit({ table: sampleTable('key-a'), expectedKey: 'key-a', gateEnv: gateEnv() })).toEqual({ hit: true, reason: 'hit' });
  });

  it('negative control: the key does not match → miss', () => {
    expect(lookupHit({ table: sampleTable('key-a'), expectedKey: 'key-b', gateEnv: gateEnv() })).toMatchObject({ hit: false, reason: 'key-mismatch' });
  });

  it('negative control: an empty expected key never matches, even an empty table key', () => {
    expect(lookupHit({ table: sampleTable(''), expectedKey: '', gateEnv: gateEnv() })).toMatchObject({ hit: false, reason: 'key-mismatch' });
  });

  it('negative control: no table → miss', () => {
    expect(lookupHit({ table: undefined, expectedKey: 'key-a', gateEnv: gateEnv() })).toMatchObject({ hit: false, reason: 'no-table' });
  });

  it('negative control: an unreadable table or another version → miss', () => {
    expect(lookupHit({ table: 'garbage', expectedKey: 'key-a', gateEnv: gateEnv() })).toMatchObject({ hit: false, reason: 'unreadable' });
    expect(lookupHit({ table: { ...sampleTable('key-a'), version: 999 }, expectedKey: 'key-a', gateEnv: gateEnv() })).toMatchObject({ hit: false, reason: 'version' });
  });

  it.each([
    ['node', { node: 'v22.2.0' }],
    ['platform', { platform: 'darwin' }],
    ['ci', { ci: false }],
    ['lockfileHash', { lockfileHash: 'other' }],
    ['tools', { tools: { ...gateEnv().tools, shellcheck: true } }],
  ])('negative control: the gate-env differs in %s → miss (opaque)', (field, overrides) => {
    const r = lookupHit({ table: sampleTable('key-a'), expectedKey: 'key-a', gateEnv: gateEnv(overrides) });
    expect(r).toEqual({ hit: false, reason: 'gate-env-mismatch', diffs: [field] });
  });

  it('negative control: a missing gate-env on either side → miss', () => {
    expect(lookupHit({ table: sampleTable('key-a'), expectedKey: 'key-a', gateEnv: undefined })).toMatchObject({ hit: false, reason: 'gate-env-mismatch' });
    const noEnv = { ...sampleTable('key-a'), gateEnv: undefined };
    expect(lookupHit({ table: noEnv, expectedKey: 'key-a', gateEnv: gateEnv() })).toMatchObject({ hit: false, reason: 'gate-env-mismatch' });
    const { lockfileHash: _drop, ...partial } = gateEnv();
    expect(compareGateEnv(partial, gateEnv())).toEqual({ same: false, diffs: ['lockfileHash'] });
  });
});

describe('readerKey', () => {
  it('hashes the object of every reader path, and changes when one of them changes', () => {
    const objects: Record<string, string> = Object.fromEntries(READER_PATHS.map((p) => [p, `obj-${p}`]));
    const runGit = (args: string[]) => {
      const p = args[1].split(':')[1];
      if (!(p in objects)) throw new Error('missing');
      return `${objects[p]}\n`;
    };
    const a = readerKey('c1', { runGit });
    expect(readerKey('c1', { runGit })).toBe(a);
    objects.src = 'obj-src-changed';
    expect(readerKey('c1', { runGit })).not.toBe(a);
    delete objects['vitest.config.ts'];
    const missing = readerKey('c1', { runGit });
    expect(missing).not.toBe(a);
    expect(missing).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('selectTests and computeF', () => {
  it('selects readers of the changed file, directory listers of its ancestors, opaque files and the always-run dirs', () => {
    const t = sampleTable();
    const s = selectTests({ table: t, changedFiles: ['docs/a.md', 'src/lib/x.ts'] });
    expect([...s].sort()).toEqual([
      'tests/unit/guards/g.test.ts',
      'tests/unit/lists-docs.test.ts',
      'tests/unit/only-reported.test.ts',
      'tests/unit/only-traced.test.ts',
      'tests/unit/reads-doc.test.ts',
      'tests/unit/skipped.test.ts',
      'tests/unit/spawns.test.ts',
      'tests/unit/worker.test.ts',
    ]);
    // A stat of the parent dir is not a listing, and src/ is not a data file here.
    expect(s.has('tests/unit/stats-docs.test.ts')).toBe(false);
    expect(s.has('tests/unit/unrelated.test.ts')).toBe(false);
  });

  it('selects a changed test file itself and anything passed as related', () => {
    const t = sampleTable();
    const s = selectTests({
      table: t,
      changedFiles: ['tests/unit/unrelated.test.ts'],
      relatedTests: ['tests/unit/stats-docs.test.ts'],
    });
    expect(s.has('tests/unit/unrelated.test.ts')).toBe(true);
    expect(s.has('tests/unit/stats-docs.test.ts')).toBe(true);
  });

  it('computes f as selected time over total time', () => {
    const t = sampleTable();
    const r = computeF(t, new Set(['tests/unit/unrelated.test.ts', 'tests/unit/guards/g.test.ts']));
    expect(r.totalMs).toBe(1100);
    expect(r.selectedMs).toBe(450);
    expect(r.f).toBeCloseTo(450 / 1100);
    expect(computeF({ files: {} }, new Set()).f).toBeNull();
  });

  it('classifies B2 data files', () => {
    expect(isB2DataFile('docs/x.md')).toBe(true);
    // M1: locale JSON is read through vite's transform, invisible to the tracer.
    expect(isB2DataFile('locales/en/common.json')).toBe(false);
    expect(isB2DataFile('tests/integration/a.test.ts')).toBe(true);
    expect(isB2DataFile('tests/e2e/a.spec.ts')).toBe(true);
    expect(isB2DataFile('src/a.ts')).toBe(false);
    expect(isB2DataFile('package.json')).toBe(false);
    expect(isB2DataFile('scripts/a.sh')).toBe(false);
  });
});

describe('collectGateEnv', () => {
  it('records node, platform, arch, CI, the lockfile hash and which tools are on PATH', () => {
    const env = gateEnv();
    expect(env).toMatchObject({ node: 'v22.1.0', platform: 'linux', arch: 'arm64', ci: true });
    expect(env.lockfileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(env.tools).toMatchObject({ git: true, bash: true, tmux: false, shellcheck: false });
  });

  it('records a missing lockfile as `missing` rather than throwing', () => {
    const env = collectGateEnv({ root: ROOT, env: {}, readFile: () => { throw new Error('ENOENT'); }, exists: () => false });
    expect(env.lockfileHash).toBe('missing');
  });

  it('compares tool maps regardless of key order', () => {
    const a = gateEnv();
    const reversed = Object.fromEntries(Object.entries(a.tools).reverse());
    expect(compareGateEnv(a, { ...a, tools: reversed })).toEqual({ same: true, diffs: [] });
  });
});
