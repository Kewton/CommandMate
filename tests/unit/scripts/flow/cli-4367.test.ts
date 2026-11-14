/**
 * The CLI of flow PR1a (Issue #4367, docs/design/flow-metrics-4367.md §6.2・§7.3・§7.4・§7.5):
 * T-D (deadlines), T-I's CLI rows (I11〜I17), P16, L11 and the mutations M7〜M11.
 *
 * Each case gets its own tmpdir for CM_FLOW_DIR / CM_VERIFY_LOCK_ROOT / home, passed through
 * `deps` (process.env is not changed). The real `gh` and `git` are never called.
 *
 * @vitest-environment node
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../../../scripts/flow/flow.mjs';
import { isAllowedCall, makeRunBounded } from '../../../../scripts/flow/runner.mjs';
import { acquireMachineLockSync } from '../../../../scripts/orchestrate/machine-lock-sync.mjs';
import * as aggregateModule from '../../../../scripts/flow/aggregate.mjs';
import * as configModule from '../../../../scripts/flow/config.mjs';
import * as recordModule from '../../../../scripts/flow/record.mjs';
import * as runnerModule from '../../../../scripts/flow/runner.mjs';
import * as sourcesModule from '../../../../scripts/flow/sources.mjs';
import * as flowModule from '../../../../scripts/flow/flow.mjs';
import { TempDirs, fakeRun, ghByKind, holds, io, ok, prList, type Call, type FakeGit, type GhAnswer, type RunAnswer } from './flow-fakes';

const temps = new TempDirs();
afterEach(() => temps.cleanup());

type Main = typeof main;
type Deps = NonNullable<Parameters<Main>[1]>;

const AT = Date.parse('2026-11-13T10:00:03.120Z');
const SLUG = 'kewton.commandmate';

/** A clock the fake run can move; `queue` answers the next reads first. */
function makeClock(start = 0) {
  const state = { t: start, queue: [] as number[], reads: 0 };
  const read = () => {
    state.reads += 1;
    return state.queue.length > 0 ? (state.queue.shift() as number) : state.t;
  };
  return { state, read };
}

interface World {
  root: string;
  flowDir: string;
  lockRoot: string;
  home: string;
  calls: Call[];
  clock: ReturnType<typeof makeClock>;
  io: ReturnType<typeof io>;
  deps: Deps;
  recordFile: () => string | null;
  lines: () => string[];
}

function world(options: { git?: FakeGit; gh?: GhAnswer; onGh?: (args: string[], w: World) => void; yaml?: string; deps?: Partial<Deps> } = {}): World {
  const base = temps.make();
  const root = path.join(base, 'repo');
  fs.mkdirSync(root);
  if (options.yaml !== undefined) {
    fs.mkdirSync(path.join(root, '.commandmate'));
    fs.writeFileSync(path.join(root, '.commandmate', 'flow.yaml'), options.yaml);
  }
  const flowDir = path.join(base, 'flow');
  const lockRoot = path.join(base, 'locks');
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const calls: Call[] = [];
  const clock = makeClock();
  const out = io();
  const gh = options.gh ?? ghByKind(ok('[]'), ok('[]'));
  const w = {} as World;
  const baseRun = fakeRun(options.git ?? {}, (args) => {
    options.onGh?.(args, w);
    return gh(args);
  }, calls);
  Object.assign(w, {
    root,
    flowDir,
    lockRoot,
    home,
    calls,
    clock,
    io: out,
    deps: {
      run: baseRun,
      monoNow: clock.read,
      now: () => AT,
      env: { CM_FLOW_DIR: flowDir, CM_VERIFY_LOCK_ROOT: lockRoot },
      home,
      cwd: root,
      stdout: out.stdout,
      stderr: out.stderr,
      uuid: () => 'tick-1',
      ...options.deps,
    },
    recordFile: () => {
      const dir = path.join(flowDir, SLUG);
      if (!fs.existsSync(dir)) return null;
      const files = fs.readdirSync(dir);
      return files.length === 1 ? path.join(dir, files[0]) : null;
    },
    lines: () => {
      const file = w.recordFile();
      return file ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    },
  });
  return w;
}

const ghCalls = (w: World) => w.calls.filter((c) => c.cmd === 'gh');
const record = (w: World) => JSON.parse(w.lines()[0]);

describe('tick: the record (acceptance 3, §2.2)', () => {
  it('takes the lock and writes one tick line of §2.2 under CM_FLOW_DIR/<slug>/<date>.jsonl', () => {
    const w = world({ gh: ghByKind(ok(prList('createdAt', [[1, '2026-11-13T05:00:00Z']])), ok('[]')), yaml: 'tz: Asia/Tokyo\n' });
    expect(main(['tick'], w.deps)).toBe(0);
    expect(w.recordFile()).toBe(path.join(w.flowDir, SLUG, '2026-11-13.jsonl'));
    expect(w.lines()).toHaveLength(1);
    const rec = record(w);
    expect(Object.keys(rec).sort()).toEqual(['at', 'base', 'durationMs', 'kind', 'metrics', 'repo', 'tickId', 'v', 'window'].sort());
    expect(rec).toMatchObject({ v: 1, kind: 'tick', tickId: 'tick-1', at: '2026-11-13T10:00:03.120Z', repo: 'Kewton/CommandMate', base: 'develop' });
    expect(Object.keys(rec.metrics).sort()).toEqual(['prCreated', 'prMerged']);
    expect(rec.metrics.prCreated).toMatchObject({ value: 1, coverage: 'search-observed', complete: false, limit: 1000 });
    expect(rec.metrics.prMerged).toMatchObject({ value: 0, coverage: 'search-observed', complete: false });
    expect(w.io.out).toHaveLength(1);
    expect(fs.existsSync(path.join(w.lockRoot, `flow.${SLUG}.lock`))).toBe(false);
  });

  it('the window is [to − 24 h, to) with to = at floored to the minute − 10 min (the grace: a guess)', () => {
    const w = world();
    expect(main(['tick'], w.deps)).toBe(0);
    expect(record(w).window).toEqual({ from: '2026-11-12T09:50:00.000Z', to: '2026-11-13T09:50:00.000Z' });
    const search = ghCalls(w).map((c) => c.args[9]);
    expect(search).toEqual(['created:2026-11-12..2026-11-13', 'merged:2026-11-12..2026-11-13']);
  });
});

describe('T-D: deadlines (§7.3)', () => {
  it('D1 identification with a negative budget: run not called, exit 2', () => {
    const w = world();
    w.clock.state.queue.push(0, 40_000);
    expect(main(['tick'], w.deps)).toBe(2);
    expect(w.calls).toEqual([]);
    expect(w.recordFile()).toBeNull();
  });

  it('D2 identification with 0.5 ms left (floored to 0): not called', () => {
    const w = world();
    w.clock.state.queue.push(0, 29_999.5);
    expect(main(['tick'], w.deps)).toBe(2);
    expect(w.calls).toEqual([]);
  });

  it('D3 identification with 1 ms left: called with timeout 1 and SIGKILL', () => {
    const w = world();
    w.clock.state.queue.push(0, 29_999);
    main(['status'], w.deps);
    expect(w.calls[0].options).toMatchObject({ timeout: 1, killSignal: 'SIGKILL' });
  });

  it('D4 the first gh with time to spare: timeout = min(30000, left), positive', () => {
    const w = world();
    expect(main(['tick'], w.deps)).toBe(0);
    expect(ghCalls(w)[0].options.timeout).toBe(30_000);
  });

  it('D5 the deadline reached right before the second gh: not called, prMerged timeout', () => {
    const w = world({
      onGh: (args, self) => {
        if (args[9].startsWith('created')) self.clock.state.queue.push(199_999, 200_000);
      },
    });
    expect(main(['tick'], w.deps)).toBe(0);
    expect(ghCalls(w)).toHaveLength(1);
    expect(record(w).metrics.prCreated.value).toBe(0);
    expect(record(w).metrics.prMerged).toMatchObject({ value: null, why: 'timeout' });
  });

  it('D6 the second gh back 1 ms before the deadline: its value is used', () => {
    const w = world({
      gh: ghByKind(ok('[]'), ok(prList('mergedAt', [[5, '2026-11-13T05:00:00Z']]))),
      onGh: (args, self) => {
        if (args[9].startsWith('merged')) self.clock.state.t = 199_999;
      },
    });
    expect(main(['tick'], w.deps)).toBe(0);
    expect(record(w).metrics.prMerged.value).toBe(1);
  });

  it.each([200_000, 200_001])('D7 the second gh back at %d (deadline 200000): discarded as timeout, still one line', (back) => {
    const w = world({
      gh: ghByKind(ok('[]'), ok(prList('mergedAt', [[5, '2026-11-13T05:00:00Z']]))),
      onGh: (args, self) => {
        if (args[9].startsWith('merged')) self.clock.state.t = back;
      },
    });
    expect(main(['tick'], w.deps)).toBe(0);
    expect(w.lines()).toHaveLength(1);
    expect(record(w).metrics.prMerged).toMatchObject({ value: null, why: 'timeout' });
  });

  it('D8 run throws for the second gh: prMerged fail, the tick goes on', () => {
    const w = world({
      gh: (args) => {
        if (args[9].startsWith('merged')) throw new Error('spawn exploded');
        return ok('[]');
      },
    });
    expect(main(['tick'], w.deps)).toBe(0);
    expect(record(w).metrics.prMerged).toMatchObject({ value: null, why: 'fail' });
    expect(record(w).metrics.prCreated.value).toBe(0);
  });

  it('D9 the wall clock goes back 1 hour: the budget is the monotonic one; the window follows at', () => {
    const back = AT - 3_600_000;
    const w = world({ deps: { now: () => back } });
    expect(main(['tick'], w.deps)).toBe(0);
    expect(ghCalls(w).map((c) => c.options.timeout)).toEqual([30_000, 30_000]);
    expect(record(w).window.to).toBe('2026-11-13T08:50:00.000Z');
  });

  it('D10 an unexpected exception in stage 5: nothing written, exit 1, release once', () => {
    let releases = 0;
    const w = world({
      deps: {
        uuid: () => {
          throw new Error('no uuid');
        },
        lock: () => ({ acquired: true, release: () => (releases++, 'released') }),
      },
    });
    expect(main(['tick'], w.deps)).toBe(1);
    expect(w.recordFile()).toBeNull();
    expect(releases).toBe(1);
    expect(w.io.out).toEqual([]);
  });

  it('D12 each gh budget comes from the same deadline, not re-taken per call', () => {
    const w = world({
      onGh: (args, self) => {
        if (args[9].startsWith('created')) self.clock.state.t = 185_000;
      },
    });
    expect(main(['tick'], w.deps)).toBe(0);
    expect(ghCalls(w).map((c) => c.options.timeout)).toEqual([30_000, 15_000]);
  });
});

/** D11 / L11 as a check over a main (M10 swaps it). */
function releaseThrowsRow(impl: Main): void {
  let releases = 0;
  const w = world({
    deps: {
      lock: () => ({
        acquired: true,
        release: () => {
          releases += 1;
          throw Object.assign(new Error('EBUSY: cannot remove'), { code: 'EBUSY' });
        },
      }),
    },
  });
  expect(impl(['tick'], w.deps)).toBe(1);
  expect(releases).toBe(1);
  expect(w.io.out).toEqual([]);
  expect(w.io.err.filter((l) => l.includes('release'))).toHaveLength(1);
  // L11: the line written before the failed release stays, and the next reader reads it.
  expect(w.lines()).toHaveLength(1);
  const status = io();
  expect(main(['status', '--json'], { ...w.deps, stdout: status.stdout, stderr: status.stderr })).toBe(0);
  expect(JSON.parse(status.out[0]).latest.tickId).toBe('tick-1');
}

describe('D11 / L11: the release throws after the line was written', () => {
  it('exit 1, one stderr line, no summary, release called once; the line stays and is read', () => {
    releaseThrowsRow(main);
  });

  it('an earlier exit 1 (unfinished tail) is not turned into 0 by a release that succeeds', () => {
    const w = world();
    fs.mkdirSync(path.join(w.flowDir, SLUG), { recursive: true });
    const file = path.join(w.flowDir, SLUG, '2026-11-13.jsonl');
    fs.writeFileSync(file, '{"v":1');
    expect(main(['tick'], w.deps)).toBe(1);
    expect(w.io.err).toContain(`flow: unfinished tail in ${file}; not appending`);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"v":1');
    expect(w.io.out).toEqual([]);
    expect(fs.existsSync(path.join(w.lockRoot, `flow.${SLUG}.lock`))).toBe(false);
  });
});

/** I11 as a check over a main (M9 swaps it). */
function readOnlyRow(impl: Main, cmd: 'report' | 'status', yaml: string | undefined, linked: boolean, records: boolean): void {
  const w = world({ yaml, git: linked ? { develop: true } : {} });
  if (records) {
    expect(main(['tick'], w.deps)).toBe(0);
    w.calls.length = 0;
  }
  const lockEntries = fs.existsSync(w.lockRoot) ? fs.readdirSync(w.lockRoot) : [];
  const out = io();
  const argv = cmd === 'report' ? ['report', '--from', '2026-11-13T00:00:00Z', '--to', '2026-11-14T00:00:00Z', '--json'] : ['status', '--json'];
  expect(impl(argv, { ...w.deps, stdout: out.stdout, stderr: out.stderr })).toBe(0);
  expect(w.calls.every((c) => c.cmd === 'git' && isAllowedCall(c.cmd, c.args)), JSON.stringify(w.calls)).toBe(true);
  expect(fs.existsSync(w.flowDir)).toBe(records);
  expect(fs.existsSync(w.lockRoot) ? fs.readdirSync(w.lockRoot) : []).toEqual(lockEntries);
  if (records) expect(w.lines()).toHaveLength(1);
  const shown = JSON.parse(out.out[0]);
  if (cmd === 'status') expect(shown.state).toBe(records ? 'observed' : 'no-records');
  else expect(shown.observations).toHaveLength(records ? 1 : 0);
  expect(shown.recordsExist).toBe(records);
}

const I11_CASES = (['report', 'status'] as const).flatMap((cmd) =>
  [undefined, 'base: develop\n'].flatMap((yaml) => [false, true].flatMap((linked) => [false, true].map((records) => [cmd, yaml, linked, records] as const)))
);

describe('T-I: the CLI rows (§7.4)', () => {
  it.each(I11_CASES)('I11 %s yaml=%j linked=%s records=%s: identification git only, nothing made', (cmd, yaml, linked, records) => {
    readOnlyRow(main, cmd, yaml, linked, records);
  });

  it.each(['report', 'status'])('I12 %s: identification fails or runs out: exit 2, not widened', (cmd) => {
    const argv = cmd === 'report' ? ['report', '--from', '2026-11-13T00:00:00Z', '--to', '2026-11-14T00:00:00Z'] : ['status'];
    const failing = world({ git: { origin: 'git@gitlab.com:x/y.git' } });
    expect(main(argv, failing.deps)).toBe(2);
    expect(failing.io.out).toEqual([]);
    const late = world();
    late.clock.state.queue.push(0, 30_000);
    expect(main(argv, late.deps)).toBe(2);
    expect(late.calls).toEqual([]);
  });

  it.each([['tick'], ['reconstruct', '--date', '2026-11-13']])('I13 %s calls only the allowed git and the two searches', (...argv) => {
    const w = world({ git: { develop: false, originHead: 'refs/remotes/origin/main' } });
    expect(main(argv, w.deps)).toBe(0);
    for (const c of w.calls) expect(isAllowedCall(c.cmd, c.args), JSON.stringify(c)).toBe(true);
    const gh = ghCalls(w).map((c) => c.args);
    expect(gh).toHaveLength(2);
    expect(gh[0]).toEqual(['pr', 'list', '--repo', 'Kewton/CommandMate', '--base', 'main', '--state', 'all', '--search', expect.stringMatching(/^created:\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/), '--limit', '1000', '--json', 'number,createdAt,baseRefName']);
    expect(gh[1]).toEqual(['pr', 'list', '--repo', 'Kewton/CommandMate', '--base', 'main', '--state', 'merged', '--search', expect.stringMatching(/^merged:/), '--limit', '1000', '--json', 'number,mergedAt,baseRefName']);
  });

  it('isAllowedCall refuses anything else (and the runner does not start it)', () => {
    const refused: Array<[string, string[]]> = [
      ['gh', ['api', 'repos/x/y']],
      ['gh', ['pr', 'list', '--repo', 'a/b', '--base', 'develop', '--state', 'open', '--search', 'created:2026-11-12..2026-11-13', '--limit', '1000', '--json', 'number,createdAt,baseRefName']],
      ['gh', ['pr', 'list', '--repo', 'a/b', '--base', 'develop', '--state', 'all', '--search', 'created:2026-11-12..2026-11-13 is:open', '--limit', '1000', '--json', 'number,createdAt,baseRefName']],
      ['gh', ['pr', 'list', '--repo', 'a/b', '--base', 'develop', '--state', 'all', '--search', 'created:2026-11-12..2026-11-13', '--limit', '1000', '--json', 'number,createdAt,baseRefName,title']],
      ['git', ['fetch', 'origin']],
      ['git', ['rev-parse', '--verify', 'HEAD']],
      ['curl', ['https://api.github.com']],
    ];
    const calls: Call[] = [];
    const runBounded = makeRunBounded({ run: (cmd: string, args: string[], options: Call['options']) => (calls.push({ cmd, args, options }), { status: 0, stdout: '' }), monoNow: () => 0 });
    for (const [cmd, args] of refused) {
      expect(isAllowedCall(cmd, args), args.join(' ')).toBe(false);
      expect(runBounded(cmd, args, { deadlineMono: 1e9, capMs: 1000 })).toEqual({ status: 'refused', called: false });
    }
    expect(calls).toEqual([]);
  });

  it.each([
    [['nope']],
    [[]],
    [['tick', '--ledger-dir', 'x']],
    [['tick', '--json']],
    [['tick', '--date', '2026-11-13']],
    [['status', '--from', '2026-11-13T00:00:00Z']],
    [['reconstruct']],
    [['reconstruct', '--date', '2026-02-30']],
    [['reconstruct', '--date', '20261113']],
    [['reconstruct', '--date', '2026-11-13', '--from', '2026-11-13T00:00:00Z', '--to', '2026-11-14T00:00:00Z']],
    [['reconstruct', '--from', '2026-11-13T00:00:00Z']],
    [['reconstruct', '--from', '2026-11-14T00:00:00Z', '--to', '2026-11-13T00:00:00Z']],
    [['reconstruct', '--from', '2026-10-01T00:00:00Z', '--to', '2026-11-13T00:00:00Z']],
    [['reconstruct', '--from', 'yesterday', '--to', '2026-11-13T00:00:00Z']],
    [['reconstruct', '--from', '2026-11-13T00:00:00', '--to', '2026-11-14T00:00:00']],
    [['report']],
    [['report', '--from', '2026-11-13T00:00:00Z', '--to', '2026-11-14T00:00:00Z', '--date', '2026-11-13']],
    [['status', '--tz', 'Mars/Olympus']],
    [['status', '--repo-root']],
    [['status', '--json', '--json']],
  ])('I14 %j: exit 2, nothing called', (argv) => {
    const w = world();
    expect(main(argv, w.deps)).toBe(2);
    expect(w.calls).toEqual([]);
    expect(fs.existsSync(w.flowDir)).toBe(false);
  });

  it('I14 --repo-root that is not a git repository: exit 2', () => {
    const w = world({ git: { isRepo: false } });
    expect(main(['status', '--repo-root', temps.make()], w.deps)).toBe(2);
  });

  it('I14 (negative) a 31-day window is accepted', () => {
    const w = world();
    expect(main(['reconstruct', '--from', '2026-10-13T00:00:00Z', '--to', '2026-11-13T00:00:00Z', '--json'], w.deps)).toBe(0);
  });
});

/** I15 as a check over a main (M11 swaps it). */
function liveHolderRow(impl: Main): void {
  const w = world();
  const held = acquireMachineLockSync(`flow.${SLUG}`, { root: w.lockRoot, timeoutMs: 0 });
  expect(held.acquired).toBe(true);
  try {
    expect(impl(['tick'], w.deps)).toBe(0);
    expect(w.recordFile()).toBeNull();
    expect(w.calls.filter((c) => c.cmd === 'gh')).toEqual([]);
    expect(w.io.err.filter((l) => l.startsWith('flow: tick skipped: held by'))).toHaveLength(1);
  } finally {
    held.release();
  }
}

/** I17 as a check over a main: a second tick starts while the first is fetching. */
function concurrentRow(impl: Main): void {
  let inner: number | null = null;
  const w = world({
    onGh: (args, self) => {
      if (inner === null && args[9].startsWith('created')) inner = impl(['tick'], { ...self.deps, uuid: () => 'tick-2' });
    },
  });
  expect(impl(['tick'], w.deps)).toBe(0);
  expect(inner).toBe(0);
  expect(w.lines()).toHaveLength(1);
  expect(record(w).tickId).toBe('tick-1');
}

describe('T-I: the lock (§7.4 I15〜I17)', () => {
  it('I15 a live holder: nothing written, exit 0, one stderr line', () => {
    liveHolderRow(main);
  });

  it('I16 the holder pid is gone (ESRCH): the part recovers it and the tick runs', () => {
    const w = world();
    const dead = spawnSync(process.execPath, ['-e', '0']).pid as number;
    const lockDir = path.join(w.lockRoot, `flow.${SLUG}.lock`);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'owner'), JSON.stringify({ pid: dead, host: os.hostname(), token: 'dead-token', acquiredAt: Date.now() - 60_000, v: 1 }));
    expect(main(['tick'], w.deps)).toBe(0);
    expect(w.lines()).toHaveLength(1);
  });

  it('I17 two ticks at once (the real part, a temp root): one writes, the other skips with exit 0', () => {
    concurrentRow(main);
  });

  it('a lock that cannot be observed (unknown) or that throws: exit 1, nothing written', () => {
    const unknown = world({ deps: { lock: () => ({ acquired: false, heldBy: null, unknown: { point: 'queue', path: '/x', code: 'EIO' }, release: () => 'none' }) } });
    expect(main(['tick'], unknown.deps)).toBe(1);
    expect(unknown.recordFile()).toBeNull();
    const throwing = world({
      deps: {
        lock: () => {
          throw new Error('EACCES');
        },
      },
    });
    expect(main(['tick'], throwing.deps)).toBe(1);
    expect(ghCalls(throwing)).toEqual([]);
  });
});

describe('P16 (C1): what PR1a does not record is unsupported, never 0', () => {
  it('report / status show the unsupported metrics by name and carry no value for them', () => {
    const w = world();
    expect(main(['tick'], w.deps)).toBe(0);
    for (const argv of [['status', '--json'], ['report', '--from', '2026-11-13T00:00:00Z', '--to', '2026-11-14T00:00:00Z', '--json']]) {
      const out = io();
      expect(main(argv, { ...w.deps, stdout: out.stdout })).toBe(0);
      const shown = JSON.parse(out.out[0]);
      expect(shown.unsupported).toEqual(expect.arrayContaining(['openPrs', 'ciQueue', 'ledgerWip', 'resources', 'alerts']));
      const observed = shown.latest ?? shown.observations[0];
      expect(Object.keys(observed.metrics).sort()).toEqual(['prCreated', 'prMerged']);
    }
    const text = io();
    expect(main(['status'], { ...w.deps, stdout: text.stdout })).toBe(0);
    expect(text.out.join('\n')).toMatch(/unsupported \(not recorded by this version\): openPrs, ciQueue, ledgerWip/);
    expect(text.out.join('\n')).toContain('観測した件数（検索） — 母集団の完全な数ではない');
    expect(text.out.join('\n')).toMatch(/PR created: 0（観測した件数・検索）/);
  });

  it('no module of scripts/flow/ exports a CI, ledger, alert, WIP, resource or open-PR reader', () => {
    const names = [aggregateModule, configModule, recordModule, runnerModule, sourcesModule, flowModule].flatMap((m) => Object.keys(m));
    expect(names.filter((n) => /ci[A-Z_]|^ci$|ledger|alert|wip|resource|openPr|notify|runner(?!$)/i.test(n) && n !== 'UNSUPPORTED')).toEqual([]);
  });
});

describe('status and report: what they show', () => {
  it('status distinguishes no records / unfinished only / observed with an unfinished tail and corrupt lines', () => {
    const w = world();
    const shown = (argv: string[]) => {
      const out = io();
      expect(main(argv, { ...w.deps, stdout: out.stdout })).toBe(0);
      return JSON.parse(out.out[0]);
    };
    expect(shown(['status', '--json']).state).toBe('no-records');
    const dir = path.join(w.flowDir, SLUG);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-11-13.jsonl'), '{"v":1,"kind":"tick"');
    expect(shown(['status', '--json'])).toMatchObject({ state: 'unfinished-only', unfinishedTail: true, latest: null });
    fs.writeFileSync(path.join(dir, '2026-11-12.jsonl'), 'garbage\n');
    fs.writeFileSync(path.join(dir, '2026-11-13.jsonl'), '');
    expect(main(['tick'], w.deps)).toBe(0);
    fs.appendFileSync(path.join(dir, '2026-11-13.jsonl'), '{"half":');
    expect(shown(['status', '--json'])).toMatchObject({ state: 'observed', unfinishedTail: true, corruptLines: 1, latest: { tickId: 'tick-1' } });
  });

  it('report lists every observation with its own window and does not sum them', () => {
    const w = world();
    expect(main(['tick'], w.deps)).toBe(0);
    expect(main(['tick'], { ...w.deps, now: () => AT + 900_000, uuid: () => 'tick-2' })).toBe(0);
    const out = io();
    expect(main(['report', '--from', '2026-11-13T00:00:00Z', '--to', '2026-11-14T00:00:00Z'], { ...w.deps, stdout: out.stdout })).toBe(0);
    const rows = out.out.filter((l) => l.startsWith('2026-11-13T'));
    expect(rows).toHaveLength(2);
    expect(out.out.join('\n')).not.toMatch(/total/i);
    expect(out.out[0]).toContain('windows are not summed');
  });

  it('a record dir that cannot be read: exit 1, not "no records"', () => {
    const w = world();
    fs.mkdirSync(w.flowDir, { recursive: true });
    fs.writeFileSync(path.join(w.flowDir, SLUG), 'a file where the dir should be');
    expect(main(['status'], w.deps)).toBe(1);
    expect(w.io.err.join('\n')).toContain('cannot read the record');
  });

  it('the latest is withheld when a newer file is over the size limit', () => {
    const w = world();
    expect(main(['tick'], w.deps)).toBe(0);
    const dir = path.join(w.flowDir, SLUG);
    fs.writeFileSync(path.join(dir, '2026-11-14.jsonl'), Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
    const out = io();
    expect(main(['status', '--json'], { ...w.deps, stdout: out.stdout })).toBe(0);
    expect(JSON.parse(out.out[0])).toMatchObject({ state: 'truncated', latest: null, truncated: true });
  });
});

/** The runner rows D2 / D5 / D7 over a runner factory (M7・M8 swap it). */
type Factory = typeof makeRunBounded;
const RUNNER_ROWS: Record<string, (factory: Factory) => void> = {
  'D2 0.5 ms left: not called': (factory) => {
    const calls: unknown[] = [];
    const rb = factory({ run: (...a: unknown[]) => (calls.push(a), { status: 0, stdout: '' }), monoNow: () => 999.5 });
    expect(rb('git', ['remote', 'get-url', 'origin'], { deadlineMono: 1000, capMs: 10_000 })).toEqual({ status: 'timeout', called: false });
    expect(calls).toEqual([]);
  },
  'D5 exactly at the deadline: not called': (factory) => {
    const calls: unknown[] = [];
    const rb = factory({ run: (...a: unknown[]) => (calls.push(a), { status: 0, stdout: '' }), monoNow: () => 1000 });
    expect(rb('git', ['remote', 'get-url', 'origin'], { deadlineMono: 1000, capMs: 10_000 }).called).toBe(false);
    expect(calls).toEqual([]);
  },
  'D7 back at the deadline: timeout': (factory) => {
    let t = 0;
    const rb = factory({ run: () => ((t = 1000), { status: 0, stdout: 'x' }), monoNow: () => t });
    expect(rb('git', ['remote', 'get-url', 'origin'], { deadlineMono: 1000, capMs: 10_000 })).toEqual({ status: 'timeout', called: true });
  },
};

describe('T-M M7〜M11: each guard removed turns its row red (§7.5)', () => {
  // M7: checks the budget before flooring it (0.5 passes the check and is spawned with timeout 0).
  const checkThenFloor: Factory = (deps = {}) => {
    const run = deps.run as (c: string, a: string[], o: object) => RunAnswer;
    const monoNow = deps.monoNow as () => number;
    return ((cmd: string, args: string[], { deadlineMono, capMs }: { deadlineMono: number; capMs: number }) => {
      const budget = Math.min(capMs, deadlineMono - monoNow());
      if (!(budget < 0)) {
        const r = run(cmd, args, { timeout: Math.floor(budget), killSignal: 'SIGKILL' });
        return { status: r.status === 0 ? 'ok' : 'fail', called: true, stdout: r.stdout };
      }
      return { status: 'timeout', called: false };
    }) as ReturnType<Factory>;
  };
  // M8: uses a result that came back after the deadline.
  const keepsLate: Factory = (deps = {}) => {
    const real = makeRunBounded(deps);
    const run = deps.run as (c: string, a: string[], o: object) => RunAnswer;
    return ((cmd: string, args: string[], o: { deadlineMono: number; capMs: number }) => {
      const r = real(cmd, args, o);
      if (r.status === 'timeout' && r.called) {
        const again = run(cmd, args, {});
        return { status: 'ok', called: true, stdout: again.stdout };
      }
      return r;
    }) as ReturnType<Factory>;
  };

  it.each([
    ['M7 budget 0 called / checked before the floor', checkThenFloor, ['D2 0.5 ms left: not called', 'D5 exactly at the deadline: not called']],
    ['M8 the result after the deadline is used', keepsLate, ['D7 back at the deadline: timeout']],
  ] as Array<[string, Factory, string[]]>)('%s', (_name, mutant, rows) => {
    for (const row of rows) {
      expect(holds(() => RUNNER_ROWS[row](makeRunBounded)), `${row} real`).toBe(true);
      expect(holds(() => RUNNER_ROWS[row](mutant)), `${row} mutant`).toBe(false);
    }
  });

  it('M9 report / status that call gh or make the record dir: I11 is red', () => {
    const noisy: Main = (argv, deps = {}) => {
      const code = main(argv, deps);
      (deps.run as (c: string, a: string[], o: object) => unknown)('gh', ['api', 'rate_limit'], {});
      fs.mkdirSync(path.join(String(deps.env?.CM_FLOW_DIR), SLUG), { recursive: true });
      return code;
    };
    for (const cmd of ['report', 'status'] as const) {
      expect(holds(() => readOnlyRow(main, cmd, undefined, false, false))).toBe(true);
      expect(holds(() => readOnlyRow(noisy, cmd, undefined, false, false))).toBe(false);
    }
  });

  it('M10 the release exception swallowed into exit 0: D11 / L11 are red', () => {
    const swallowing: Main = (argv, deps = {}) =>
      main(argv, {
        ...deps,
        lock: (name: string, options: object) => {
          const held = (deps.lock as (n: string, o: object) => { release: () => string })(name, options);
          return {
            ...held,
            release: () => {
              try {
                return held.release();
              } catch {
                return 'released';
              }
            },
          };
        },
      });
    expect(holds(() => releaseThrowsRow(main))).toBe(true);
    expect(holds(() => releaseThrowsRow(swallowing))).toBe(false);
  });

  it('M11 no lock: I15 and I17 are red', () => {
    const lockless: Main = (argv, deps = {}) => main(argv, { ...deps, lock: () => ({ acquired: true, heldBy: null, release: () => 'released' }) });
    expect(holds(() => liveHolderRow(main))).toBe(true);
    expect(holds(() => liveHolderRow(lockless))).toBe(false);
    expect(holds(() => concurrentRow(main))).toBe(true);
    expect(holds(() => concurrentRow(lockless))).toBe(false);
  });
});
