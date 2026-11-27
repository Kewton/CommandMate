/**
 * Issue #4594 (受け入れの差し戻し、受入 3): a worktree with no duration record
 * at all (a fresh clone, no vitest cache, no peer) weighs every file 1, so LPT
 * deals the files out by path, every 4th to the same group. With the judge's
 * C1 durations that is 917/497/379/917 s, and verify's unit-related ran 939 s
 * and 951 s, over 15 minutes. The fix: a baseline of the files of 5 s or more,
 * kept in the repository (`scripts/related-durations-baseline.json`), weighs the
 * files no own / peer record knows, before the median.
 *
 * Invariants:
 *   I3 the set of files run does not change: only the split's estimate does
 *   I4 an own record beats a peer record, and both beat the baseline
 *   I5 a missing / broken / other-version baseline never throws, and the split
 *      is then the split without a baseline
 *   I6 the `durations=` line keeps its fields and order; the baseline comes last
 *
 * Everything here is computed on the fixture (the judge's C1 measure, 1430
 * files): no vitest child runs, and the machine's load cannot move the result.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
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
type Baseline = { status: string; durations: Durations; error?: string };

/*
 * Reached through the module object, not named imports: before the fix the
 * baseline reader does not exist, and these tests must fail one by one there
 * (an empty baseline), not at import.
 */
const api = related as unknown as {
  mergeDurations: (files: string[], own: Durations, peers: Peer[], baseline?: Durations) => Merged;
  splitLpt: (files: string[], durations: Durations, maxGroups?: number) => { groups: string[][]; expectedMs: number[]; defaultWeight: number; known: number };
  readBaselineDurations?: (options: { root: string }) => Baseline;
  main: (argv: string[], deps?: Record<string, unknown>) => Promise<number>;
  MAX_GROUPS: number;
  DURATION_STORE: string;
};

const REPO_ROOT = path.resolve(__dirname, '../../..');
const BASELINE_REL = path.join('scripts', 'related-durations-baseline.json');
const FIXTURE = path.join(REPO_ROOT, 'tests/fixtures/related-split-4594/c1-durations.json');
/** The fixed cost of one file in a group (setup, import, environment), measured on C1. */
const PER_FILE_MS = 360;
/** 15 minutes less a margin. */
const LIMIT_MS = 800_000;

function readBaseline(root: string): Baseline {
  if (typeof api.readBaselineDurations !== 'function') return { status: 'absent', durations: new Map() };
  return api.readBaselineDurations({ root });
}

function truth(): Durations {
  const parsed = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')) as Record<string, number>;
  return new Map(Object.entries(parsed));
}

/** Each group's true time: the fixture's durations of its files, plus the fixed cost per file. */
function trueLoads(groups: string[][], real: Durations): number[] {
  return groups.map((g) => g.reduce((sum, f) => sum + (real.get(f) ?? 0), 0) + g.length * PER_FILE_MS);
}

const tempDirs: string[] = [];
function tempRoot(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
function writeBaselineFile(root: string, body: string): void {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, BASELINE_REL), body);
}

afterEach(() => {
  while (tempDirs.length > 0) removeTempDir(tempDirs.pop() as string);
});

describe('Issue #4594 T1: no record at all — the C1 set splits under 15 minutes', () => {
  it('the 1430 files of C1, own and peer empty, the repository baseline: the longest group is 800 s or less', () => {
    const real = truth();
    const files = [...real.keys()].sort();
    expect(files.length).toBe(1430);
    const baseline = readBaseline(REPO_ROOT);
    const merged = api.mergeDurations(files, new Map(), [], baseline.durations);
    const plan = api.splitLpt(files, merged.durations, api.MAX_GROUPS);
    expect(plan.groups.length).toBe(4);
    // I3: the same files, each once.
    expect(plan.groups.flat().sort()).toEqual(files);
    const loads = trueLoads(plan.groups, real);
    expect(Math.max(...loads), `true loads (ms): ${loads.map(Math.round).join('/')}`).toBeLessThanOrEqual(LIMIT_MS);
  });
});

describe('Issue #4594 T2: own > peer > baseline > median', () => {
  const files = [
    'tests/unit/a.test.ts',
    'tests/unit/b.test.ts',
    'tests/unit/c.test.ts',
    'tests/unit/d.test.ts',
    'tests/unit/e.test.ts',
  ];
  const own: Durations = new Map([['tests/unit/a.test.ts', 100]]);
  const peers: Peer[] = [
    { name: 'wt-x', durations: new Map([['tests/unit/a.test.ts', 999], ['tests/unit/b.test.ts', 200]]) },
  ];

  it('each file takes the first record that knows it, and the baseline count is returned', () => {
    const root = tempRoot('cm-4594-t2-');
    writeBaselineFile(
      root,
      JSON.stringify({
        version: 1,
        measuredAt: '2026-11-27',
        source: 'test',
        durations: { 'tests/unit/a.test.ts': 7000, 'tests/unit/b.test.ts': 7000, 'tests/unit/c.test.ts': 9000 },
      })
    );
    const baseline = readBaseline(root);
    expect(baseline.status).toBe('ok');
    const merged = api.mergeDurations(files, own, peers, baseline.durations);
    expect([...merged.durations.entries()]).toEqual([
      ['tests/unit/a.test.ts', 100],
      ['tests/unit/b.test.ts', 200],
      ['tests/unit/c.test.ts', 9000],
    ]);
    expect(merged).toMatchObject({ own: 1, peer: 1, baseline: 1, none: 2, byPeer: [['wt-x', 1]] });
    // The files found nowhere weigh the median of the recorded ones (splitLpt's default).
    const plan = api.splitLpt(files, merged.durations, 4);
    expect(plan.defaultWeight).toBe(200);
    expect(plan.known).toBe(3);
  });

  it('without a baseline argument the result is what it was before (baseline 0)', () => {
    const merged = api.mergeDurations(files, own, peers);
    expect([...merged.durations.keys()]).toEqual(['tests/unit/a.test.ts', 'tests/unit/b.test.ts']);
    expect(merged).toMatchObject({ own: 1, peer: 1, baseline: 0, none: 3 });
  });
});

describe('Issue #4594 T3: a missing or broken baseline is no baseline', () => {
  const files = ['tests/unit/a.test.ts', 'tests/unit/b.test.ts', 'tests/unit/c.test.ts', 'tests/unit/d.test.ts', 'tests/unit/e.test.ts'];
  const own: Durations = new Map([['tests/unit/a.test.ts', 3000]]);
  const without = api.splitLpt(files, api.mergeDurations(files, own, []).durations, 4);

  const cases: [string, string | null, string][] = [
    ['missing', null, 'missing'],
    ['not JSON', '{ "version": 1, "durations": ', 'corrupt'],
    ['another version', JSON.stringify({ version: 2, durations: { 'tests/unit/b.test.ts': 9000 } }), 'corrupt'],
    ['a negative value', JSON.stringify({ version: 1, durations: { 'tests/unit/b.test.ts': 9000, 'tests/unit/c.test.ts': -1 } }), 'corrupt'],
    ['a string value', JSON.stringify({ version: 1, durations: { 'tests/unit/b.test.ts': '9000' } }), 'corrupt'],
    ['durations not an object', JSON.stringify({ version: 1, durations: [9000] }), 'corrupt'],
  ];
  for (const [name, body, status] of cases) {
    it(`${name}: no throw, empty, and the split is the split without a baseline`, () => {
      const root = tempRoot('cm-4594-t3-');
      if (body !== null) writeBaselineFile(root, body);
      expect(typeof api.readBaselineDurations).toBe('function');
      const baseline = readBaseline(root);
      expect(baseline.status).toBe(status);
      expect(baseline.durations.size).toBe(0);
      const merged = api.mergeDurations(files, own, [], baseline.durations);
      expect(merged.baseline).toBe(0);
      expect(api.splitLpt(files, merged.durations, 4)).toEqual(without);
    });
  }

  it('a baseline path not in the set is ignored', () => {
    const merged = api.mergeDurations(files, own, [], new Map([['tests/unit/gone.test.ts', 90_000]]));
    expect(merged.durations.has('tests/unit/gone.test.ts')).toBe(false);
    expect(merged).toMatchObject({ own: 1, peer: 0, baseline: 0, none: 4 });
    expect(api.splitLpt(files, merged.durations, 4)).toEqual(without);
  });
});

describe('Issue #4594 T4: the repository baseline', () => {
  it('version 1 with measuredAt and source; 1..200 integer values of 5000 or more, test paths in path order', () => {
    const parsed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, BASELINE_REL), 'utf-8')) as {
      version: unknown;
      measuredAt: unknown;
      source: unknown;
      durations: Record<string, unknown>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof parsed.source).toBe('string');
    expect((parsed.source as string).length).toBeGreaterThan(0);
    const keys = Object.keys(parsed.durations);
    expect(keys.length).toBeGreaterThanOrEqual(1);
    expect(keys.length).toBeLessThanOrEqual(200);
    expect(keys).toEqual([...keys].sort());
    for (const key of keys) {
      expect(key).toMatch(/^tests\/unit\/.+\.test\.tsx?$/);
      const value = parsed.durations[key];
      expect(Number.isInteger(value), key).toBe(true);
      expect(value as number, key).toBeGreaterThanOrEqual(5000);
    }
    // What the script reads is what the file says.
    const read = readBaseline(REPO_ROOT);
    expect(read.status).toBe('ok');
    expect(read.durations.size).toBe(keys.length);
  });
});

describe('Issue #4594 I6: the durations= line ends with the baseline count', () => {
  async function durationsLine(root: string): Promise<string | undefined> {
    const files = ['tests/unit/a.test.ts', 'tests/unit/b.test.ts', 'tests/unit/c.test.ts'];
    const logs: string[] = [];
    await api.main(['--base', 'origin/develop'], {
      root,
      log: (msg: string) => logs.push(msg),
      out: () => undefined,
      tmpBase: path.join(root, 'g'),
      collectChangedFiles: () => ({ mergeBase: 'deadbeef', files: ['tests/unit/a.test.ts'] }),
      findTextScanTests: () => [],
      collectSet: async () => files,
      listWorktrees: () => [],
      runGroup: async ({ logPath }: { logPath: string }) => {
        fs.writeFileSync(logPath, '');
        return { code: 0, signal: null };
      },
    });
    return logs.find((l) => l.startsWith('run-related-unit-tests: durations='));
  }

  it('a baseline in the root: the existing fields as they were, then baseline:<n>', async () => {
    const root = tempRoot('cm-4594-i6-');
    writeBaselineFile(root, JSON.stringify({ version: 1, measuredAt: '2026-11-27', source: 'test', durations: { 'tests/unit/b.test.ts': 6000, 'tests/unit/z.test.ts': 6000 } }));
    expect(await durationsLine(root)).toBe('run-related-unit-tests: durations=own:0 peer:0 default:2 peers=0 baseline:1');
  });

  it('a broken baseline: baseline:0 and why', async () => {
    const root = tempRoot('cm-4594-i6b-');
    writeBaselineFile(root, 'not json');
    expect(await durationsLine(root)).toBe('run-related-unit-tests: durations=own:0 peer:0 default:3 peers=0 baseline:0(corrupt)');
  });

  it('no baseline file: the line is what it was before', async () => {
    const root = tempRoot('cm-4594-i6c-');
    expect(await durationsLine(root)).toBe('run-related-unit-tests: durations=own:0 peer:0 default:3 peers=0');
  });
});

describe('Issue #4594 T5: --write-baseline', () => {
  function seedStore(root: string): void {
    const file = path.join(root, api.DURATION_STORE ?? path.join('node_modules', '.cache', 'cm-related', 'durations.json'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        vitestCache: null,
        durations: {
          'tests/unit/z.test.ts': 12000.4,
          'tests/unit/a.test.ts': 4999.9,
          'tests/unit/m.test.ts': 5000,
          'tests/unit/b.test.ts': 30,
        },
      })
    );
  }
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

  it('writes the own records of 5000 ms or more, rounded, in path order, with the date and the source', async () => {
    const root = tempRoot('cm-4594-t5-');
    seedStore(root);
    const code = await api.main(['--write-baseline', '--source', 'x'], {
      root,
      log: () => undefined,
      now: () => new Date(2026, 10, 27, 12, 0, 0),
      ...noRun,
    });
    expect(code).toBe(0);
    const text = fs.readFileSync(path.join(root, BASELINE_REL), 'utf-8');
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({
      version: 1,
      measuredAt: '2026-11-27',
      source: 'x',
      durations: { 'tests/unit/m.test.ts': 5000, 'tests/unit/z.test.ts': 12000 },
    });
    expect(Object.keys(parsed.durations)).toEqual(['tests/unit/m.test.ts', 'tests/unit/z.test.ts']);
    expect(readBaseline(root).status).toBe('ok');
  });

  for (const argv of [['--write-baseline'], ['--write-baseline', '--source'], ['--write-baseline', '--source', '']]) {
    it(`${JSON.stringify(argv)}: exit 2 and nothing written`, async () => {
      const root = tempRoot('cm-4594-t5b-');
      seedStore(root);
      const code = await api.main(argv, { root, log: () => undefined, ...noRun });
      expect(code).toBe(2);
      expect(fs.existsSync(path.join(root, BASELINE_REL))).toBe(false);
    });
  }

  it('no own record of 5000 ms or more: exit 1, the existing baseline kept', async () => {
    const root = tempRoot('cm-4594-t5c-');
    writeBaselineFile(root, 'keep');
    const code = await api.main(['--write-baseline', '--source', 'x'], { root, log: () => undefined, ...noRun });
    expect(code).toBe(1);
    expect(fs.readFileSync(path.join(root, BASELINE_REL), 'utf-8')).toBe('keep');
  });
});
