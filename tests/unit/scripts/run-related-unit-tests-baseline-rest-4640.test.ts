/**
 * Issue #4640: the rest of #4594's P3 (the review of d711a8d45).
 *
 * P3-2: when a worktree has no own record and no peer, only the repository's
 * baseline is left — the 79 files of 5 s or more — so `splitLpt`'s median rule
 * weighed the other 1,351 files at 9,695 ms and every group's `expected=`
 * read 3,722 s (the true longest group is about 690 s). The fix weighs them by
 * NO_RECORD_DEFAULT_MS, the mean of the judge's C1 files under 5 s (~296 ms),
 * and only when nothing of the worktree or of a peer knows a file.
 *
 * P3-3: `--write-baseline` read only the own records, so a worktree that ran
 * part of the suite rewrote the repository's baseline with the heavy files it
 * happened to run — silently dropping the rest. It now refuses (exit 1, the
 * paths on stderr) when a baseline path that is still in the repository would
 * disappear, and writes such a drop only with `--allow-drop`.
 *
 * The review's rest (review-4640.md, claude-8):
 *   P2-1 `main` passing the options to the split is itself under test: the
 *        function tests (R1, R2) stayed green with the wiring removed.
 *   P3-1 a current baseline that reads neither ok nor missing (corrupt) counted
 *        no dropped path, so a partial worktree overwrote it anyway.
 *   P3-2 `--source --allow-drop` took `--allow-drop` as the source text.
 *
 * Invariants:
 *   I1 own > peer > baseline > median: an own or a peer record keeps the
 *      median default (NO_RECORD_DEFAULT_MS is not used then)
 *   I3 the split only estimates: the same files, each once
 *   I4 the existing call `splitLpt(files, durations, n)` answers as before
 *
 * Everything is computed on the fixture (the judge's C1 measure) or in an
 * os.tmpdir() sandbox: no vitest child runs.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as related from '../../../scripts/run-related-unit-tests.mjs';
import { removeTempDir } from '@tests/helpers/temp-dir';

type Durations = Map<string, number>;
type Peer = { name: string; durations: Durations };
type Merged = {
  durations: Durations;
  own: number;
  peer: number;
  baseline?: number;
  byPeer: [string, number][];
  none: number;
};
type Plan = {
  groups: string[][];
  expectedMs: number[];
  defaultWeight: number;
  known: number;
};

/*
 * Reached through the module object, not named imports: before the fix the
 * constant and the branch are not exported, and these tests must fail one by
 * one there, not at import.
 */
const api = related as unknown as {
  NO_RECORD_DEFAULT_MS?: number;
  splitOptionsFor?: (merged: Merged) => { defaultWeight: number } | undefined;
  splitLpt: (
    files: string[],
    durations: Durations,
    maxGroups?: number,
    options?: { defaultWeight?: number }
  ) => Plan;
  mergeDurations: (files: string[], own: Durations, peers: Peer[], baseline?: Durations) => Merged;
  readBaselineDurations: (options: { root: string }) => { status: string; durations: Durations };
  main: (argv: string[], deps?: Record<string, unknown>) => Promise<number>;
  MAX_GROUPS: number;
};

const REPO_ROOT = path.resolve(__dirname, '../../..');
const BASELINE_REL = path.join('scripts', 'related-durations-baseline.json');
const STORE_REL = path.join('node_modules', '.cache', 'cm-related', 'durations.json');
const FIXTURE = path.join(REPO_ROOT, 'tests/fixtures/related-split-4594/c1-durations.json');
/** The fixed cost of one file in a group (setup, import, environment), as in #4594 T1. */
const PER_FILE_MS = 360;
/** 15 minutes less a margin. */
const LIMIT_MS = 800_000;

const FILE_A = 'tests/unit/a.test.ts';
const FILE_B = 'tests/unit/b.test.ts';

function optionsFor(merged: Merged): { defaultWeight: number } | undefined {
  expect(typeof api.splitOptionsFor, 'splitOptionsFor must be exported (#4640)').toBe('function');
  return (api.splitOptionsFor as (m: Merged) => { defaultWeight: number } | undefined)(merged);
}

function truth(): Durations {
  const parsed = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')) as Record<string, number>;
  return new Map(Object.entries(parsed));
}

/** Each group's true time: the fixture's durations of its files, plus the fixed cost per file. */
function trueLoads(groups: string[][], real: Durations): number[] {
  return groups.map((g) => g.reduce((sum, f) => sum + (real.get(f) ?? 0), 0) + g.length * PER_FILE_MS);
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const tempDirs: string[] = [];
function tempRoot(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFileAt(root: string, rel: string, body: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function writeBaseline(root: string, durations: Record<string, number>): void {
  writeFileAt(
    root,
    BASELINE_REL,
    JSON.stringify({ version: 1, measuredAt: '2026-11-27', source: 'test', durations })
  );
}

function writeStore(root: string, durations: Record<string, number>): void {
  writeFileAt(root, STORE_REL, JSON.stringify({ version: 1, vitestCache: null, durations }));
}

/** The files of a group's `vitest run` command line. */
function groupFiles(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args.slice(1)) {
    if (a.startsWith('--')) break;
    out.push(a);
  }
  return out;
}

/** The json report vitest would write for `files`. */
function writeReport(args: string[], root: string, files: string[]): void {
  let t = 1_700_000_000_000;
  const testResults = files.map((file) => {
    const startTime = t;
    const endTime = t + 1000;
    t = endTime + 1;
    return { name: path.join(root, file), status: 'passed', message: '', startTime, endTime, assertionResults: [] };
  });
  const flag = args.find((a) => a.startsWith('--outputFile.json='));
  if (!flag) throw new Error('no --outputFile.json= in the group arguments');
  fs.writeFileSync(flag.slice('--outputFile.json='.length), JSON.stringify({ testResults }));
}

/** The write-baseline path must not collect, must not load vitest, must not run a group. */
const noRun = {
  collectChangedFiles: () => {
    throw new Error('must not collect');
  },
  collectSet: async () => {
    throw new Error('must not collect');
  },
  runGroup: async () => {
    throw new Error('must not run a group');
  },
};

/** console.error into an array: the write-baseline path reports there. */
let stderr: string[] = [];
beforeEach(() => {
  stderr = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map((a) => String(a)).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) removeTempDir(tempDirs.pop() as string);
});

describe('R1 (P3-2): only the baseline is left — the estimate is the size of the light files', () => {
  it('the C1 set with own and peer empty: the longest estimate is 0.7..1.1x the true longest, and under 800 s', () => {
    const real = truth();
    const files = [...real.keys()].sort();
    expect(files.length).toBe(1430);
    const baseline = api.readBaselineDurations({ root: REPO_ROOT });
    expect(baseline.status).toBe('ok');
    const merged = api.mergeDurations(files, new Map(), [], baseline.durations);
    expect(merged).toMatchObject({ own: 0, peer: 0, baseline: 79 });
    expect(api.NO_RECORD_DEFAULT_MS, 'the judge C1 light files average ~296 ms').toBe(300);

    const plan = api.splitLpt(files, merged.durations, api.MAX_GROUPS, optionsFor(merged));
    // I3: the same files, each once.
    expect(plan.groups).toHaveLength(4);
    expect(plan.groups.flat().sort()).toEqual(files);
    expect(plan.defaultWeight).toBe(300);

    const loads = trueLoads(plan.groups, real);
    const maxTrue = Math.max(...loads);
    const maxEstimate = Math.max(...plan.expectedMs);
    expect(maxTrue, `true loads (ms): ${loads.map(Math.round).join('/')}`).toBeLessThanOrEqual(LIMIT_MS);
    expect(maxEstimate).toBeGreaterThanOrEqual(0.7 * maxTrue);
    expect(maxEstimate).toBeLessThanOrEqual(1.1 * maxTrue);
  });

  it('negative control: without the options the unrecorded weigh the baseline median, as before', () => {
    const real = truth();
    const files = [...real.keys()].sort();
    const baseline = api.readBaselineDurations({ root: REPO_ROOT });
    const merged = api.mergeDurations(files, new Map(), [], baseline.durations);
    const plan = api.splitLpt(files, merged.durations, api.MAX_GROUPS);
    const maxTrue = Math.max(...trueLoads(plan.groups, real));
    // The median of a baseline of heavy files: the estimate is several times the truth.
    expect(plan.defaultWeight).toBe(median([...baseline.durations.values()]));
    expect(plan.defaultWeight).toBeGreaterThan(5_000);
    expect(Math.max(...plan.expectedMs)).toBeGreaterThan(3 * maxTrue);
    // I3 still holds without the options.
    expect(plan.groups.flat().sort()).toEqual(files);
  });
});

describe('R2 (I1): an own or a peer record keeps the median default', () => {
  const files = ['a', 'b', 'c', 'd', 'e'].map((n) => `tests/unit/${n}.test.ts`);
  const baseline = new Map([
    [files[1], 7000],
    [files[2], 9000],
  ]);

  it('own 1, peer 0: no default weight is passed', () => {
    const merged = api.mergeDurations(files, new Map([[files[0], 5000]]), [], baseline);
    expect(merged).toMatchObject({ own: 1, peer: 0, baseline: 2 });
    expect(optionsFor(merged)).toBeUndefined();
    const plan = api.splitLpt(files, merged.durations, 4, optionsFor(merged));
    expect(plan.defaultWeight).toBe(7000);
  });

  it('own 0, peer 1: no default weight is passed', () => {
    const peers: Peer[] = [{ name: 'wt-x', durations: new Map([[files[0], 5000]]) }];
    const merged = api.mergeDurations(files, new Map(), peers, baseline);
    expect(merged).toMatchObject({ own: 0, peer: 1, baseline: 2 });
    expect(optionsFor(merged)).toBeUndefined();
    const plan = api.splitLpt(files, merged.durations, 4, optionsFor(merged));
    expect(plan.defaultWeight).toBe(7000);
  });

  it('own 0, peer 0, baseline 0: no default weight is passed', () => {
    const merged = api.mergeDurations(files, new Map(), [], new Map());
    expect(merged).toMatchObject({ own: 0, peer: 0, baseline: 0 });
    expect(optionsFor(merged)).toBeUndefined();
  });

  it('own 0, peer 0, baseline 1 or more: the no-record default', () => {
    const merged = api.mergeDurations(files, new Map(), [], baseline);
    expect(merged).toMatchObject({ own: 0, peer: 0, baseline: 2 });
    expect(optionsFor(merged)).toEqual({ defaultWeight: 300 });
  });
});

describe('R3 (I4): splitLpt without the options answers as before', () => {
  const files = Array.from({ length: 8 }, (_, i) => `tests/unit/f${i + 1}.test.ts`);
  const durations = new Map(files.map((f, i) => [f, (i + 1) * 1000]));

  it('the textbook table of #4577, pinned: nothing changes for the 3-argument call', () => {
    const plan = api.splitLpt(files, durations, 4);
    expect(plan.expectedMs).toEqual([9000, 9000, 9000, 9000]);
    expect(plan.groups.map((g) => g.slice().sort())).toEqual([
      ['tests/unit/f1.test.ts', 'tests/unit/f8.test.ts'],
      ['tests/unit/f2.test.ts', 'tests/unit/f7.test.ts'],
      ['tests/unit/f3.test.ts', 'tests/unit/f6.test.ts'],
      ['tests/unit/f4.test.ts', 'tests/unit/f5.test.ts'],
    ]);
    expect(plan.known).toBe(8);
  });

  it('no options, an empty options object and an explicit undefined return the same plan', () => {
    const plain = api.splitLpt(files, durations, 4);
    expect(api.splitLpt(files, durations, 4, {})).toEqual(plain);
    expect(api.splitLpt(files, durations, 4, undefined)).toEqual(plain);
    // Without the option the unrecorded weigh the median of the recorded ones.
    const some = new Map([
      [files[0], 100],
      [files[1], 300],
    ]);
    expect(api.splitLpt(files, some, 4, {}).defaultWeight).toBe(200);
  });
});

describe('R4 (P3-3): --write-baseline does not drop a baseline path still in the repository', () => {
  it('a path in the baseline that the new content lacks: exit 1, the file unchanged, the path on stderr', async () => {
    const root = tempRoot('cm-4640-r4-');
    writeBaseline(root, { [FILE_A]: 6000, [FILE_B]: 7000 });
    writeStore(root, { [FILE_A]: 9000 });
    writeFileAt(root, FILE_A, '');
    writeFileAt(root, FILE_B, '');
    const before = fs.readFileSync(path.join(root, BASELINE_REL), 'utf-8');

    const code = await api.main(['--write-baseline', '--source', 'x'], { root, log: () => undefined, ...noRun });

    expect(code).toBe(1);
    expect(fs.readFileSync(path.join(root, BASELINE_REL), 'utf-8')).toBe(before);
    expect(stderr.some((l) => l.includes(FILE_B))).toBe(true);
  });

  it('the same shape with --allow-drop: written, holding only what the own records have', async () => {
    const root = tempRoot('cm-4640-r4b-');
    writeBaseline(root, { [FILE_A]: 6000, [FILE_B]: 7000 });
    writeStore(root, { [FILE_A]: 9000 });
    writeFileAt(root, FILE_A, '');
    writeFileAt(root, FILE_B, '');

    const code = await api.main(
      ['--write-baseline', '--source', 'x', '--allow-drop'],
      { root, log: () => undefined, ...noRun }
    );

    expect(code).toBe(0);
    const written = api.readBaselineDurations({ root });
    expect(written.status).toBe('ok');
    expect([...written.durations.entries()]).toEqual([[FILE_A, 9000]]);
  });

  it('a baseline path gone from the repository: written without the flag', async () => {
    const root = tempRoot('cm-4640-r4c-');
    writeBaseline(root, { [FILE_A]: 6000, [FILE_B]: 7000 });
    writeStore(root, { [FILE_A]: 9000 });
    writeFileAt(root, FILE_A, '');
    // FILE_B is not in the repository any more.

    const code = await api.main(['--write-baseline', '--source', 'x'], { root, log: () => undefined, ...noRun });

    expect(code).toBe(0);
    const written = api.readBaselineDurations({ root });
    expect(written.status).toBe('ok');
    expect([...written.durations.entries()]).toEqual([[FILE_A, 9000]]);
  });
});

describe('R5 (P3-3): the shapes --write-baseline accepts and rejects', () => {
  it('--source and --allow-drop (3 arguments): accepted and written', async () => {
    const root = tempRoot('cm-4640-r5-');
    writeBaseline(root, { [FILE_A]: 6000, [FILE_B]: 7000 });
    writeStore(root, { [FILE_A]: 9000 });
    writeFileAt(root, FILE_A, '');
    writeFileAt(root, FILE_B, '');

    const code = await api.main(
      ['--write-baseline', '--allow-drop', '--source', 'x'],
      { root, log: () => undefined, ...noRun }
    );

    expect(code).toBe(0);
    expect([...api.readBaselineDurations({ root }).durations.keys()]).toEqual([FILE_A]);
  });

  it.each<[string, string[]]>([
    ['--allow-drop alone', ['--write-baseline', '--allow-drop']],
    ['--allow-drop with no --source and a stray word', ['--write-baseline', '--allow-drop', 'x']],
    ['--source with no value, --allow-drop present', ['--write-baseline', '--allow-drop', '--source']],
    ['an unknown flag beside --source', ['--write-baseline', '--source', 'x', '--bogus']],
    ['a --source value that begins with --', ['--write-baseline', '--source', '--allow-drop']],
  ])('%s: exit 2 and nothing written', async (_label, argv) => {
    const root = tempRoot('cm-4640-r5b-');
    writeStore(root, { [FILE_A]: 9000 });
    writeFileAt(root, FILE_A, '');
    const code = await api.main(argv, { root, log: () => undefined, ...noRun });
    expect(code).toBe(2);
    expect(fs.existsSync(path.join(root, BASELINE_REL))).toBe(false);
  });
});

describe('R6 (P2-1): main itself passes the no-record default to the split', () => {
  it('a root that has only the baseline: the 4th argument is { defaultWeight: 300 } and the log says 300ms', async () => {
    const root = tempRoot('cm-4640-r6-');
    const files = ['tests/unit/a.test.ts', 'tests/unit/b.test.ts'];
    writeBaseline(root, { [files[0]]: 6000 });
    writeFileAt(root, files[0], '');
    writeFileAt(root, files[1], '');
    const logs: string[] = [];
    const splitCalls: { maxGroups?: number; options?: unknown }[] = [];
    // The existing injection point: record what main hands the split, then split for real.
    const split = (
      f: string[],
      d: Durations,
      maxGroups?: number,
      options?: { defaultWeight?: number }
    ): Plan => {
      splitCalls.push({ maxGroups, options });
      return api.splitLpt(f, d, maxGroups, options);
    };

    const code = await api.main(['--base', 'origin/develop'], {
      root,
      log: (msg: string) => logs.push(msg),
      out: () => undefined,
      baseEnv: { CI: 'true', PATH: process.env.PATH },
      tmpBase: path.join(root, 'g'),
      collectChangedFiles: () => ({ mergeBase: 'mb4640', files: ['src/x.ts'] }),
      findTextScanTests: () => [],
      collectSet: async () => files,
      readPeers: () => ({ status: 'ok', count: 0, peers: [] }),
      split,
      runGroup: async ({ args, logPath }: { args: string[]; logPath: string }) => {
        fs.writeFileSync(logPath, '');
        writeReport(args, root, groupFiles(args));
        return { code: 0, signal: null };
      },
    });

    expect(code).toBe(0);
    expect(splitCalls).toHaveLength(1);
    // Removing the 4th argument from main()'s call turns this red (see the mutation).
    expect(splitCalls[0].options).toEqual({ defaultWeight: 300 });
    expect(logs).toContain(
      'run-related-unit-tests: split=lpt groups=2 cache=missing known=1/2 default-weight=300ms'
    );
  });
});

describe('R7 (P3-1): a current baseline that reads neither ok nor missing', () => {
  it('corrupt: exit 1 without --allow-drop (the file kept, one reason line); written with it', async () => {
    const root = tempRoot('cm-4640-r7-');
    writeFileAt(root, BASELINE_REL, 'not json');
    writeStore(root, { [FILE_A]: 9000 });
    writeFileAt(root, FILE_A, '');

    const code = await api.main(['--write-baseline', '--source', 'x'], { root, log: () => undefined, ...noRun });

    expect(code).toBe(1);
    expect(fs.readFileSync(path.join(root, BASELINE_REL), 'utf-8')).toBe('not json');
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/corrupt/);
    expect(stderr[0]).toContain(BASELINE_REL);

    const allowed = await api.main(
      ['--write-baseline', '--source', 'x', '--allow-drop'],
      { root, log: () => undefined, ...noRun }
    );

    expect(allowed).toBe(0);
    expect([...api.readBaselineDurations({ root }).durations.entries()]).toEqual([[FILE_A, 9000]]);
  });
});
