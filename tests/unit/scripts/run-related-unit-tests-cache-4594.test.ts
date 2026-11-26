/**
 * Issue #4594: unit-related's 4 groups all write vitest's one results cache, so
 * only the last group's files keep a duration (273 of 1092 after a run), and a
 * split from that partial record skewed one group to 17.4 min. The script now
 * keeps every group's durations in its own store and reads it first.
 *
 * Scope: what this guards against is losing the duration records of a run and
 * the skewed split that follows. A store edited by hand on purpose is out of scope.
 *
 * Invariants:
 *   N1 after a 4-group run, every file run keeps its duration (C1, C2)
 *   N2 with only part of the durations known, no group's true load exceeds 1.5x
 *      the mean (C3); unrecorded files are still weighed by the median
 *   N3 a missing / broken / unwritable store never changes the verdict or the
 *      exit code, and says so in one line (C4)
 *   N4 the existing log lines keep their fields and order (C5)
 *   N5 vitest's own results.json is never written by the script (C6)
 *
 * Every group is a fake (no vitest child): it writes the json report vitest
 * would, with per-file startTime / endTime, and, when asked, vitest's results
 * cache the way 4 concurrent vitest runs leave it (the last group wins).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { main, splitLpt } from '../../../scripts/run-related-unit-tests.mjs';
import { removeTempDir } from '@tests/helpers/temp-dir';

type Env = Record<string, string | undefined>;

interface GroupCall {
  cmd: string;
  args: string[];
  cwd: string;
  env: Env;
  logPath: string;
}

/** The own store, as a path relative to the worktree root (spelled out: the test must not lean on the script's constant). */
const STORE_REL = path.join('node_modules', '.cache', 'cm-related', 'durations.json');
const VITEST_CACHE_DIR = path.join('node_modules', '.vite', 'vitest', 'da39a3ee5e6b4b0d3255bfef95601890afd80709');

function groupFiles(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args.slice(1)) {
    if (a.startsWith('--')) break;
    out.push(a);
  }
  return out;
}

function reportPathOf(args: string[]): string {
  const flag = args.find((a) => a.startsWith('--outputFile.json='));
  if (!flag) throw new Error(`no --outputFile.json= in ${args.join(' ')}`);
  return flag.slice('--outputFile.json='.length);
}

/** The json report of vitest 4.1.2 for `files`: each file's startTime / endTime span is its duration. */
function writeReport(args: string[], root: string, files: string[], truth: Map<string, number>, failed: string[] = []): void {
  let t = 1_700_000_000_000;
  const testResults = files.map((file) => {
    const startTime = t;
    const endTime = t + (truth.get(file) ?? 0);
    t = endTime + 3;
    return {
      name: path.join(root, file),
      status: failed.includes(file) ? 'failed' : 'passed',
      message: '',
      startTime,
      endTime,
      assertionResults: [{ fullName: `case of ${file}`, status: failed.includes(file) ? 'failed' : 'passed' }],
    };
  });
  fs.writeFileSync(reportPathOf(args), JSON.stringify({ testResults }));
}

function vitestCachePath(root: string): string {
  return path.join(root, VITEST_CACHE_DIR, 'results.json');
}

function writeVitestCache(root: string, durations: Map<string, number>): void {
  fs.mkdirSync(path.dirname(vitestCachePath(root)), { recursive: true });
  fs.writeFileSync(
    vitestCachePath(root),
    JSON.stringify({ version: '4.1.2', results: [...durations].map(([f, duration]) => [`:${f}`, { duration, failed: false }]) })
  );
}

function readVitestCache(root: string): Map<string, number> {
  try {
    const parsed = JSON.parse(fs.readFileSync(vitestCachePath(root), 'utf-8')) as { results: [string, { duration: number }][] };
    return new Map(parsed.results.map(([k, v]) => [k.slice(k.indexOf(':') + 1), v.duration]));
  } catch {
    return new Map();
  }
}

function readStoreFile(root: string): Record<string, number> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, STORE_REL), 'utf-8')) as { durations?: Record<string, number> };
    return parsed.durations ?? null;
  } catch {
    return null;
  }
}

/**
 * main() with every outside effect faked. `vitestCache`: each group also writes
 * vitest's results cache as vitest does (what was there when the group started
 * plus its own files), so the group that ends last decides what is left.
 */
function harness(root: string, opts: {
  files: string[];
  truth: Map<string, number>;
  vitestCache?: boolean;
  failed?: string[];
  outcome?: (i: number) => { code: number | null; signal: string | null };
  extra?: Record<string, unknown>;
}) {
  const calls: GroupCall[] = [];
  const logs: string[] = [];
  const run = async () => {
    calls.length = 0;
    logs.length = 0;
    const atStart = opts.vitestCache ? readVitestCache(root) : new Map<string, number>();
    const code = await main(['--base', 'origin/develop'], {
      root,
      log: (m: string) => logs.push(m),
      out: () => undefined,
      baseEnv: { CI: 'true', PATH: process.env.PATH },
      tmpBase: path.join(root, 'g'),
      collectChangedFiles: () => ({ mergeBase: 'mb4594', files: ['src/x.ts'] }),
      findTextScanTests: () => [],
      collectSet: async () => opts.files,
      readPeers: () => ({ status: 'ok', count: 0, peers: [] }),
      runGroup: async (call: GroupCall) => {
        const i = calls.length;
        calls.push(call);
        fs.writeFileSync(call.logPath, `log of group ${i + 1}\n`);
        const files = groupFiles(call.args);
        writeReport(call.args, root, files, opts.truth, opts.failed ?? []);
        if (opts.vitestCache) {
          const mine = new Map(atStart);
          for (const f of files) mine.set(f, opts.truth.get(f) ?? 0);
          writeVitestCache(root, mine);
        }
        return opts.outcome ? opts.outcome(i) : { code: (opts.failed ?? []).some((f) => files.includes(f)) ? 1 : 0, signal: null };
      },
      ...opts.extra,
    });
    return code;
  };
  const handed = () => calls.map((c) => groupFiles(c.args).slice().sort());
  return { run, calls, logs, handed };
}

const durationsLine = (logs: string[]) => logs.find((l) => l.startsWith('run-related-unit-tests: durations='));
const storeLines = (logs: string[]) => logs.filter((l) => l.includes('durations-store'));

function names(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `tests/unit/f${String(i).padStart(4, '0')}.test.ts`);
}

/** Durations (ms) by 2% steps of a measured results.json (369 files), plus its heavy tail. */
const SHAPE = [
  3, 3, 4, 4, 4, 5, 5, 6, 7, 8, 8, 9, 10, 11, 12, 13, 15, 17, 19, 22, 25, 28, 31, 33, 40, 46, 54, 63, 78, 91, 103, 117, 129, 148,
  170, 193, 212, 233, 247, 282, 332, 361, 423, 487, 570, 671, 904, 1597, 3452, 5000, 9000, 22433, 52102, 165107,
];

/** A deterministic synthetic suite: `files` drawn from SHAPE by a seeded LCG. */
function syntheticTruth(files: string[], seed: number): Map<string, number> {
  let x = seed;
  const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  return new Map(files.map((f) => [f, SHAPE[Math.floor(rnd() * SHAPE.length)]]));
}

function trueLoads(groups: string[][], truth: Map<string, number>): number[] {
  return groups.map((g) => g.reduce((a, f) => a + (truth.get(f) ?? 0), 0));
}

function worstOverMean(groups: string[][], truth: Map<string, number>): number {
  const loads = trueLoads(groups, truth);
  const mean = loads.reduce((a, b) => a + b, 0) / loads.length;
  return Math.max(...loads) / mean;
}

describe('#4594 the own duration store', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4594-'));
  });
  afterEach(() => {
    try {
      fs.chmodSync(path.join(root, 'node_modules', '.cache', 'cm-related'), 0o755);
    } catch {
      // only the read-only case made it
    }
    removeTempDir(root);
  });

  const FILES = names(40);
  const TRUTH = new Map(FILES.map((f, i) => [f, (i % 7) * 900 + (i % 3) * 40 + 5]));

  it('C1 (N1): after a 4-group run, every file run keeps its duration (not only the last group\'s)', async () => {
    const h = harness(root, { files: FILES, truth: TRUTH, vitestCache: true });
    expect(await h.run()).toBe(0);
    expect(h.calls).toHaveLength(4);
    // vitest's own cache shows the loss the store makes up for: the last group only.
    expect(readVitestCache(root).size).toBe(h.handed()[3].length);
    expect(readStoreFile(root)).toEqual(Object.fromEntries(TRUTH));
  });

  it('C1 (N1): a later run replaces the files it ran and keeps the records of the files it did not run', async () => {
    expect(await harness(root, { files: FILES, truth: TRUTH }).run()).toBe(0);
    const later = new Map(FILES.slice(0, 10).map((f) => [f, 77_777]));
    expect(await harness(root, { files: FILES.slice(0, 10), truth: later }).run()).toBe(0);
    const want = Object.fromEntries(TRUTH);
    for (const f of FILES.slice(0, 10)) want[f] = 77_777;
    expect(readStoreFile(root)).toEqual(want);
  });

  it('C2 (N1): the next run reads every duration from the own store, ahead of a partial / stale vitest cache', async () => {
    // A stale vitest cache from before: every file 1ms. The 4 groups then leave
    // fresh values there for the last group's files only.
    writeVitestCache(root, new Map(FILES.map((f) => [f, 1])));
    const h = harness(root, { files: FILES, truth: TRUTH, vitestCache: true });
    expect(await h.run()).toBe(0);
    expect(await h.run()).toBe(0);
    expect(durationsLine(h.logs)).toBe('run-related-unit-tests: durations=own:40 peer:0 default:0 peers=0');
    expect(h.handed()).toEqual(splitLpt(FILES, TRUTH, 4).groups.map((g) => g.slice().sort()));
  });

  it('C2 (N1): another worktree\'s own store is read too (its store, then its vitest cache)', async () => {
    const peer = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4594-peer-'));
    try {
      expect(await harness(peer, { files: FILES, truth: TRUTH, vitestCache: true }).run()).toBe(0);
      const h = harness(root, {
        files: FILES,
        truth: TRUTH,
        extra: { readPeers: undefined, listWorktrees: () => [peer] },
      });
      expect(await h.run()).toBe(0);
      expect(durationsLine(h.logs)).toBe(`run-related-unit-tests: durations=own:0 peer:40(${path.basename(peer)}:40) default:0 peers=1`);
      expect(h.handed()).toEqual(splitLpt(FILES, TRUTH, 4).groups.map((g) => g.slice().sort()));
    } finally {
      removeTempDir(peer);
    }
  });

  it('C6: vitest\'s results.json is not written by the script (bytes and mtime kept, nothing added under .vite)', async () => {
    writeVitestCache(root, new Map(FILES.map((f) => [f, 123])));
    fs.utimesSync(vitestCachePath(root), 1_600_000, 1_600_000);
    const before = `${fs.readFileSync(vitestCachePath(root), 'utf-8')}@${fs.statSync(vitestCachePath(root)).mtimeMs}`;
    const listing = () => fs.readdirSync(path.join(root, 'node_modules', '.vite'), { recursive: true }).map(String).sort();
    const beforeList = listing();
    expect(await harness(root, { files: FILES, truth: TRUTH }).run()).toBe(0);
    expect(`${fs.readFileSync(vitestCachePath(root), 'utf-8')}@${fs.statSync(vitestCachePath(root)).mtimeMs}`).toBe(before);
    expect(listing()).toEqual(beforeList);
  });
});

describe('#4594 C3 (N2): the 17.4-minute shape', () => {
  const FILES = names(1092);
  const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

  it('reproduces with the split rule alone: only the last group of a cacheless run known -> estimates even, true loads skewed', () => {
    // The facts of the accepted run (s11): known=271/1092, one known file alone
    // in group 1, 3 groups of 368 at an even estimate, true loads 177/615/580/1021 s.
    let worst = 0;
    for (const seed of SEEDS) {
      const truth = syntheticTruth(FILES, seed);
      const last = splitLpt(FILES, new Map(), 4).groups[3];
      const plan = splitLpt(FILES, new Map(last.map((f) => [f, truth.get(f) as number])), 4);
      const est = plan.expectedMs;
      expect(Math.max(...est) / (est.reduce((a, b) => a + b, 0) / 4)).toBeLessThan(1.2);
      worst = Math.max(worst, worstOverMean(plan.groups, truth));
      // With every duration known, the same rule is even.
      expect(worstOverMean(splitLpt(FILES, truth, 4).groups, truth)).toBeLessThanOrEqual(1.05);
    }
    expect(worst).toBeGreaterThan(1.5);
  });

  it(
    'after a 4-group run, the next run splits so that no group\'s true load exceeds 1.5x the mean',
    async () => {
      const ratios: string[] = [];
      for (const seed of SEEDS) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4594-c3-'));
        try {
          const truth = syntheticTruth(FILES, seed);
          const h = harness(root, { files: FILES, truth, vitestCache: true });
          expect(await h.run()).toBe(0);
          expect(await h.run()).toBe(0);
          const r = worstOverMean(h.handed(), truth);
          if (r > 1.5) ratios.push(`seed ${seed}: ${r.toFixed(2)}`);
        } finally {
          removeTempDir(root);
        }
      }
      expect(ratios).toEqual([]);
    },
    120_000,
  );
});

describe('#4594 C4 (N3): a store that is missing, broken or unwritable never changes the verdict', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4594-n3-'));
  });
  afterEach(() => {
    for (const p of [path.join(root, 'node_modules', '.cache', 'cm-related'), path.join(root, 'node_modules', '.cache')]) {
      try {
        fs.chmodSync(p, 0o755);
      } catch {
        // not made by this case
      }
    }
    removeTempDir(root);
  });

  const FILES = names(12);
  const TRUTH = new Map(FILES.map((f, i) => [f, (i + 1) * 100]));
  const storeDir = () => path.join(root, 'node_modules', '.cache', 'cm-related');

  it.each<[string, () => void, number]>([
    ['missing (a first run)', () => undefined, 0],
    ['not JSON', () => {
      fs.mkdirSync(storeDir(), { recursive: true });
      fs.writeFileSync(path.join(storeDir(), 'durations.json'), '{"version":1,"durations":{"tests/unit/f');
    }, 1],
    ['wrong shape', () => {
      fs.mkdirSync(storeDir(), { recursive: true });
      fs.writeFileSync(path.join(storeDir(), 'durations.json'), JSON.stringify({ version: 1, durations: [1, 2] }));
    }, 1],
    ['a negative duration', () => {
      fs.mkdirSync(storeDir(), { recursive: true });
      fs.writeFileSync(path.join(storeDir(), 'durations.json'), JSON.stringify({ version: 1, durations: { [FILES[0]]: -5 } }));
    }, 1],
    ['its directory read-only (cannot be written)', () => {
      fs.mkdirSync(storeDir(), { recursive: true });
      fs.chmodSync(storeDir(), 0o555);
    }, 1],
    ['node_modules/.cache is a file (cannot be made)', () => {
      fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(root, 'node_modules', '.cache'), 'not a dir');
    }, 1],
  ])('%s: no throw, the same exit for a pass and a failure, at most one log line', async (_label, prepare, lines) => {
    prepare();
    const pass = harness(root, { files: FILES, truth: TRUTH });
    expect(await pass.run()).toBe(0);
    expect(pass.calls.flatMap((c) => groupFiles(c.args)).sort()).toEqual(FILES);
    expect(storeLines(pass.logs)).toHaveLength(lines);
    expect(pass.logs[pass.logs.length - 1]).toBe('run-related-unit-tests: result exit=0 groups=4 union=12');

    prepare();
    const fail = harness(root, { files: FILES, truth: TRUTH, failed: [FILES[5]] });
    expect(await fail.run()).toBe(1);
    expect(fail.logs).toContain(`run-related-unit-tests: failed ${FILES[5]} > case of ${FILES[5]}`);
    expect(fail.logs[fail.logs.length - 1]).toBe('run-related-unit-tests: result exit=1 groups=4 union=12');
  });

  it('a group that wrote no report or was signalled: its files keep no new record, the verdict stays a failure', async () => {
    const h = harness(root, {
      files: FILES,
      truth: TRUTH,
      outcome: (i) => (i === 2 ? { code: null, signal: 'SIGTERM' } : { code: 0, signal: null }),
    });
    expect(await h.run()).toBe(1);
    expect(h.logs[h.logs.length - 1]).toBe('run-related-unit-tests: result exit=1 groups=4 union=12');
  });
});

describe('#4594 C5 (N4): the existing log lines keep their fields and order', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4594-n4-'));
  });
  afterEach(() => {
    removeTempDir(root);
  });

  it('split= / durations= / group / result lines, first run and a run reading the store', async () => {
    const FILES = names(9);
    const TRUTH = new Map(FILES.map((f, i) => [f, (i + 1) * 1000]));
    const h = harness(root, { files: FILES, truth: TRUTH, failed: [FILES[8]] });
    for (const known of [0, 9]) {
      expect(await h.run()).toBe(1);
      expect(h.logs.slice(0, 4)).toEqual([
        'run-related-unit-tests: mode=related changed=1 textscan=0',
        'run-related-unit-tests: set related=9 textscan=0 overlap=0 union=9',
        expect.stringMatching(new RegExp(`^run-related-unit-tests: split=lpt groups=4 cache=missing known=${known}/9 default-weight=\\d+ms$`)),
        `run-related-unit-tests: durations=own:${known} peer:0 default:${9 - known} peers=0`,
      ]);
      const groups = h.logs.filter((l) => / group \d\/4 /.test(l));
      expect(groups).toHaveLength(4);
      for (const l of groups) {
        expect(l).toMatch(/^run-related-unit-tests: group \d\/4 files=\d+ expected=(\d+\.\d+s|-) actual=\d+\.\ds ran=\d+ exit=\d+$/);
      }
      expect(h.logs[h.logs.length - 1]).toBe('run-related-unit-tests: result exit=1 groups=4 union=9');
      expect(storeLines(h.logs)).toEqual([]);
    }
  });
});
