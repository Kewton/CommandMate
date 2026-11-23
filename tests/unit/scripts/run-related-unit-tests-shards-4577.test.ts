/**
 * Issue #4577: unit-related runs the union of the related set and the text-scan
 * set ONCE, split into at most 4 groups by LPT over vitest's own recorded file
 * durations, each group a serial `vitest run <files>` in its own short TMPDIR.
 *
 * Invariants (docs: the #4577 design, I1-I5):
 *   I1 a failing test fails the gate however the set is split (real vitest)
 *   I2 nothing failing passes the gate however the set is split (real vitest)
 *   I3 a non-zero / signalled / unspawnable group, or a group that ran fewer
 *      files than it was given, never turns into a pass
 *   I4 the groups partition the union exactly, whatever the duration cache holds
 *   I5 how one group is run: CI inherited untouched, no worker / shard flags,
 *      one short TMPDIR per group
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SHARD_TMP_PREFIX,
  main as mainSharded,
  readDurationCache,
  splitLpt,
  unionSets,
} from '../../../scripts/run-related-unit-tests.mjs';
import { removeTempDir } from '@tests/helpers/temp-dir';

const REPO = process.cwd();
const REAL_VITEST_TIMEOUT_MS = 180_000;

type Env = Record<string, string | undefined>;

interface GroupCall {
  cmd: string;
  args: string[];
  cwd: string;
  env: Env;
  logPath: string;
}

interface GroupOutcome {
  code: number | null;
  signal: string | null;
  error?: Error;
}

/** Writes the vitest json report a group would have written for `files` (relative to `root`). */
function writeReport(args: string[], root: string, files: string[], failed: string[] = []): void {
  const flag = args.find((a) => a.startsWith('--outputFile.json='));
  if (!flag) throw new Error(`no --outputFile.json= in ${args.join(' ')}`);
  const reportPath = flag.slice('--outputFile.json='.length);
  const testResults = files.map((file) => ({
    name: path.join(root, file),
    status: failed.includes(file) ? 'failed' : 'passed',
    message: '',
    assertionResults: [
      { fullName: `case of ${file}`, status: failed.includes(file) ? 'failed' : 'passed' },
    ],
  }));
  fs.writeFileSync(reportPath, JSON.stringify({ testResults }));
}

/** The files a group was handed: everything after `run` up to the first flag. */
function groupFiles(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args.slice(1)) {
    if (a.startsWith('--')) break;
    out.push(a);
  }
  return out;
}

function writeCache(root: string, body: string): void {
  const dir = path.join(root, 'node_modules', '.vite', 'vitest', 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'results.json'), body);
}

function cacheBody(durations: Record<string, number>): string {
  return JSON.stringify({
    version: '4.1.2',
    results: Object.entries(durations).map(([file, duration]) => [`:${file}`, { duration, failed: false }]),
  });
}

describe('unionSets (I4: the union of the two sets, overlap once)', () => {
  it('dedupes the overlap and counts each side', () => {
    const u = unionSets(['tests/unit/b.test.ts', 'tests/unit/a.test.ts'], ['tests/unit/a.test.ts', 'tests/unit/c.test.ts']);
    expect(u.files).toEqual(['tests/unit/a.test.ts', 'tests/unit/b.test.ts', 'tests/unit/c.test.ts']);
    expect([u.related, u.textscan, u.overlap]).toEqual([2, 2, 1]);
  });
});

describe('splitLpt (I4)', () => {
  const files = Array.from({ length: 8 }, (_, i) => `tests/unit/f${i + 1}.test.ts`);

  function assertPartition(groups: string[][], all: string[]): void {
    const flat = groups.flat();
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat.slice().sort()).toEqual(all.slice().sort());
    expect(groups.every((g) => g.length > 0)).toBe(true);
  }

  it('assigns longest first to the lightest group (the textbook table)', () => {
    const durations = new Map(files.map((f, i) => [f, (i + 1) * 1000]));
    const { groups, expectedMs } = splitLpt(files, durations, 4);
    // f8 f1 | f7 f2 | f6 f3 | f5 f4 : every load is 9000ms.
    expect(groups.map((g) => g.slice().sort())).toEqual([
      ['tests/unit/f1.test.ts', 'tests/unit/f8.test.ts'],
      ['tests/unit/f2.test.ts', 'tests/unit/f7.test.ts'],
      ['tests/unit/f3.test.ts', 'tests/unit/f6.test.ts'],
      ['tests/unit/f4.test.ts', 'tests/unit/f5.test.ts'],
    ]);
    expect(expectedMs).toEqual([9000, 9000, 9000, 9000]);
  });

  it('gives an unrecorded file the median of the recorded ones', () => {
    const durations = new Map([
      [files[0], 100],
      [files[1], 300],
    ]);
    const { defaultWeight, known } = splitLpt(files, durations, 4);
    expect(defaultWeight).toBe(200);
    expect(known).toBe(2);
  });

  it('uses N = min(4, |set|)', () => {
    expect(splitLpt(files.slice(0, 3), new Map(), 4).groups).toHaveLength(3);
    expect(splitLpt(files, new Map(), 4).groups).toHaveLength(4);
    expect(splitLpt(files, new Map(), 1).groups).toEqual([files]);
    expect(splitLpt([], new Map(), 4).groups).toEqual([]);
  });

  it.each([
    ['all recorded', new Map(files.map((f, i) => [f, i * 37 + 5]))],
    ['some unrecorded', new Map([[files[2], 5000]])],
    ['nothing recorded', new Map<string, number>()],
    ['only stale paths recorded', new Map([['tests/unit/gone.test.ts', 9999]])],
  ])('partitions the set exactly: %s', (_label, durations) => {
    const { groups } = splitLpt(files, durations, 4);
    expect(groups).toHaveLength(4);
    assertPartition(groups, files);
  });
});

describe('readDurationCache (I4: a missing or broken cache never throws)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4577-cache-'));
  });
  afterEach(() => {
    removeTempDir(root);
  });

  it('reads the per-file durations, dropping the project prefix', () => {
    writeCache(root, cacheBody({ 'tests/unit/a.test.ts': 1500, 'tests/unit/b.test.ts': 20 }));
    const c = readDurationCache({ root });
    expect(c.status).toBe('ok');
    expect(c.durations.get('tests/unit/a.test.ts')).toBe(1500);
    expect(c.durations.get('tests/unit/b.test.ts')).toBe(20);
  });

  it('reports missing when there is no cache', () => {
    const c = readDurationCache({ root });
    expect(c.status).toBe('missing');
    expect(c.durations.size).toBe(0);
  });

  it.each([
    ['not JSON', '{"version": "4.1.2", "results": [[":tests/unit/a.te'],
    ['wrong shape', JSON.stringify({ version: '4.1.2', results: 'nope' })],
    ['no version', JSON.stringify({ results: [] })],
  ])('reports corrupt and no durations: %s', (_label, body) => {
    writeCache(root, body);
    const c = readDurationCache({ root });
    expect(c.status).toBe('corrupt');
    expect(c.durations.size).toBe(0);
  });
});

/** mainSharded with every outside effect replaced. */
function harness(root: string, opts: {
  related?: string[];
  textscan?: string[];
  outcome?: (i: number, call: GroupCall) => GroupOutcome;
  report?: (i: number, call: GroupCall, files: string[]) => void;
  baseEnv?: Env;
  maxGroups?: number;
  collectSet?: () => Promise<string[]>;
}) {
  const calls: GroupCall[] = [];
  const logs: string[] = [];
  const outs: string[] = [];
  const tmpBase = path.join(root, 'g');
  const run = () =>
    mainSharded(['--base', 'origin/develop'], {
      root,
      log: (m: string) => logs.push(m),
      out: (m: string) => outs.push(m),
      baseEnv: opts.baseEnv ?? { CI: 'true', PATH: process.env.PATH },
      maxGroups: opts.maxGroups,
      tmpBase,
      collectChangedFiles: () => ({ mergeBase: 'mb123', files: ['src/x.ts'] }),
      findTextScanTests: () => opts.textscan ?? [],
      collectSet: opts.collectSet ?? (async () => opts.related ?? []),
      runGroup: async (call: GroupCall) => {
        const i = calls.length;
        calls.push(call);
        fs.writeFileSync(call.logPath, `log of group ${i + 1}\n`);
        const files = groupFiles(call.args);
        if (opts.report) opts.report(i, call, files);
        else writeReport(call.args, root, files);
        return opts.outcome ? opts.outcome(i, call) : { code: 0, signal: null };
      },
    });
  return { run, calls, logs, outs, tmpBase };
}

describe('mainSharded: never turns a bad group into a pass (I3)', () => {
  let root: string;
  const FILES = Array.from({ length: 8 }, (_, i) => `tests/unit/f${i + 1}.test.ts`);
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4577-i3-'));
  });
  afterEach(() => {
    removeTempDir(root);
  });

  it.each<[string, number, Parameters<typeof harness>[1]]>([
    ['one group exits 1', 1, { outcome: (i) => ({ code: i === 1 ? 1 : 0, signal: null }) }],
    ['one group is killed by a signal', 1, { outcome: (i) => ({ code: i === 2 ? null : 0, signal: i === 2 ? 'SIGKILL' : null }) }],
    ['one group fails to spawn', 1, { outcome: (i) => (i === 0 ? { code: null, signal: null, error: new Error('spawn ENOENT') } : { code: 0, signal: null }) }],
    ['one group ran fewer files than it was given', 1, { report: (i, call, files) => writeReport(call.args, root, i === 3 ? files.slice(1) : files) }],
    ['one group wrote no report', 1, { report: (i, call, files) => { if (i !== 0) writeReport(call.args, root, files); } }],
    ['the LAST group fails (not only the first counts)', 1, { outcome: (i) => ({ code: i === 3 ? 1 : 0, signal: null }) }],
    ['the FIRST group fails (not only the last counts)', 1, { outcome: (i) => ({ code: i === 0 ? 1 : 0, signal: null }) }],
    ['every group exits 0 and ran all its files', 0, {}],
  ])('%s -> exit %i', async (_label, expected, opts) => {
    const h = harness(root, { related: FILES, ...opts });
    expect(await h.run()).toBe(expected);
    expect(h.calls).toHaveLength(4);
  });

  it('returns 2 without running anything when the set cannot be collected', async () => {
    const h = harness(root, {
      collectSet: async () => {
        throw new Error('vitest would not start');
      },
    });
    expect(await h.run()).toBe(2);
    expect(h.calls).toEqual([]);
  });

  it('runs the union once: every file in exactly one group, overlap once', async () => {
    const h = harness(root, { related: FILES.slice(0, 6), textscan: FILES.slice(4) });
    expect(await h.run()).toBe(0);
    const handed = h.calls.flatMap((c) => groupFiles(c.args));
    expect(handed.slice().sort()).toEqual(FILES);
    expect(h.logs).toContain('run-related-unit-tests: set related=6 textscan=4 overlap=2 union=8');
  });

  it('runs nothing and passes when the union is empty', async () => {
    const h = harness(root, {});
    expect(await h.run()).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it('prints each group log after all groups ended, in group order', async () => {
    const h = harness(root, { related: FILES });
    await h.run();
    const joined = h.outs.join('');
    const idx = [1, 2, 3, 4].map((i) => joined.indexOf(`log of group ${i}`));
    expect(idx.every((n) => n >= 0)).toBe(true);
    expect(idx).toEqual(idx.slice().sort((a, b) => a - b));
  });
});

describe('mainSharded: the cache shapes only the split, never the set (I4)', () => {
  let root: string;
  const FILES = Array.from({ length: 7 }, (_, i) => `tests/unit/f${i + 1}.test.ts`);
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4577-i4-'));
  });
  afterEach(() => {
    removeTempDir(root);
  });

  it.each([
    ['ok', () => writeCache(root, cacheBody({ [FILES[0]]: 900, [FILES[1]]: 10 }))],
    ['missing', () => undefined],
    ['corrupt', () => writeCache(root, '{not json')],
    ['ok', () => writeCache(root, cacheBody({ 'tests/unit/stale.test.ts': 777 }))],
  ])('cache=%s: all files run, each once', async (status, setup) => {
    setup();
    const h = harness(root, { related: FILES });
    expect(await h.run()).toBe(0);
    const handed = h.calls.flatMap((c) => groupFiles(c.args));
    expect(handed.slice().sort()).toEqual(FILES);
    expect(new Set(handed).size).toBe(handed.length);
    expect(h.logs.some((l) => l.startsWith(`run-related-unit-tests: split=lpt groups=4 cache=${status} `))).toBe(true);
  });
});

describe('mainSharded: how one group is run (I5)', () => {
  let root: string;
  const FILES = Array.from({ length: 5 }, (_, i) => `tests/unit/f${i + 1}.test.ts`);
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4577-i5-'));
  });
  afterEach(() => {
    removeTempDir(root);
  });

  it.each([
    ['inherited CI=true', { CI: 'true' }],
    ['inherited CI absent', {}],
  ])('%s: CI is passed through untouched, NODE_ENV=test', async (_label, baseEnv) => {
    const h = harness(root, { related: FILES, baseEnv });
    await h.run();
    for (const call of h.calls) {
      expect(call.env.CI).toBe((baseEnv as Env).CI);
      expect('CI' in call.env).toBe('CI' in baseEnv);
      expect(call.env.NODE_ENV).toBe('test');
    }
  });

  it('adds no worker / parallelism / shard flags and runs `vitest run <files>`', async () => {
    const h = harness(root, { related: FILES });
    await h.run();
    for (const call of h.calls) {
      expect(call.cmd).toBe(path.join(root, 'node_modules', '.bin', 'vitest'));
      expect(call.args[0]).toBe('run');
      expect(call.args).toContain('--passWithNoTests');
      expect(call.args.some((a) => /^--(maxWorkers|no-file-parallelism|fileParallelism|shard)/.test(a))).toBe(false);
      expect(call.cwd).toBe(root);
    }
  });

  it('gives every group its own TMPDIR under the short base, and removes them', async () => {
    const h = harness(root, { related: FILES });
    await h.run();
    const dirs = h.calls.map((c) => c.env.TMPDIR as string);
    expect(new Set(dirs).size).toBe(h.calls.length);
    for (const d of dirs) {
      expect(d.startsWith(h.tmpBase)).toBe(true);
      expect(fs.existsSync(d)).toBe(false);
    }
  });

  it('the default base is short enough for a macOS unix socket under it (104 bytes)', () => {
    // mkdtemp adds 6 characters; the real-tmux tests then add about 50 more.
    expect(SHARD_TMP_PREFIX).toBe('/tmp/cms');
  });
});

/**
 * I1 / I2 with the real vitest: a small project in a temp dir. Only its own
 * 7-8 files run; the repository's tests/unit is never touched.
 */
describe('mainSharded with the real vitest (I1 positive / I2 negative control)', () => {
  let root: string;
  const PASSING = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => `tests/unit/${n}.test.ts`);
  const FAILING = 'tests/unit/fail.test.ts';
  const FAIL_LINE = `run-related-unit-tests: failed ${FAILING} > known failing 4577`;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4577-real-'));
    // Only the vitest package is linked: vitest's own cache (node_modules/.vite)
    // then lands in this temp dir, never in the repository's node_modules.
    fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
    fs.symlinkSync(path.join(REPO, 'node_modules', 'vitest'), path.join(root, 'node_modules', 'vitest'));
    fs.symlinkSync(path.join(REPO, 'node_modules', 'vitest', 'vitest.mjs'), path.join(root, 'node_modules', '.bin', 'vitest'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'cm-4577-probe', type: 'module', private: true }));
    fs.writeFileSync(path.join(root, 'vitest.config.mjs'), 'export default { test: { include: ["tests/**/*.test.ts"] } };\n');
    fs.mkdirSync(path.join(root, 'tests', 'unit'), { recursive: true });
    for (const f of PASSING) {
      fs.writeFileSync(path.join(root, f), `import { it, expect } from 'vitest';\nit('ok ${path.basename(f)}', () => { expect(1).toBe(1); });\n`);
    }
    fs.writeFileSync(path.join(root, FAILING), "import { it, expect } from 'vitest';\nit('known failing 4577', () => { expect(1).toBe(2); });\n");
  });
  afterEach(() => {
    removeTempDir(root);
  });

  /** The child vitest must not believe it is a worker of this one. */
  function childEnv(): Env {
    const env: Env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith('VITEST') && k !== 'TEST' && k !== 'TINYPOOL_WORKER_ID') env[k] = v;
    }
    return env;
  }

  async function runReal(files: string[], maxGroups: number) {
    const logs: string[] = [];
    const code = await mainSharded(['--base', 'origin/develop'], {
      root,
      log: (m: string) => logs.push(m),
      out: () => undefined,
      baseEnv: childEnv(),
      maxGroups,
      tmpBase: path.join(root, 'g'),
      collectChangedFiles: () => ({ mergeBase: 'mb', files: ['src/x.ts'] }),
      findTextScanTests: () => [],
      collectSet: async () => files,
    });
    return { code, logs };
  }

  const ALL = [...PASSING, FAILING];
  // Heavy: the failing file alone in the first group.
  const HEAVY = () => cacheBody({ ...Object.fromEntries(PASSING.map((f) => [f, 100])), [FAILING]: 100_000 });
  // Light: the failing file is placed last, into a light group (not the heavy first one).
  const LIGHT = () => cacheBody({ ...Object.fromEntries(PASSING.map((f, i) => [f, i === 0 ? 10_000 : 1000 * i])), [FAILING]: 1 });

  it('the two recorded shapes put the failing file in the heavy first group / in a later light group', () => {
    writeCache(root, HEAVY());
    expect(splitLpt(ALL, readDurationCache({ root }).durations, 4).groups[0]).toEqual([FAILING]);
    writeCache(root, LIGHT());
    const light = splitLpt(ALL, readDurationCache({ root }).durations, 4).groups;
    expect(light.findIndex((g) => g.includes(FAILING))).toBeGreaterThan(0);
  });

  // Asserts only the verdict, so it stays green whatever the split is (the split
  // must not decide pass / fail): the shape of the split is pinned just above.
  it(
    'one group (today\'s shape) and 4 LPT groups with the failing file heavy or light all exit 1 and name it',
    async () => {
      const one = await runReal(ALL, 1);
      writeCache(root, HEAVY());
      const heavy = await runReal(ALL, 4);
      writeCache(root, LIGHT());
      const light = await runReal(ALL, 4);
      for (const r of [one, heavy, light]) {
        expect(r.code).toBe(1);
        expect(r.logs).toContain(FAIL_LINE);
      }
    },
    REAL_VITEST_TIMEOUT_MS,
  );

  it(
    'negative control: without the failing file, 1 group and 4 groups both exit 0',
    async () => {
      const one = await runReal(PASSING, 1);
      const four = await runReal(PASSING, 4);
      expect([one.code, four.code]).toEqual([0, 0]);
      expect(four.logs.some((l) => l.includes(' failed '))).toBe(false);
    },
    REAL_VITEST_TIMEOUT_MS,
  );
});
