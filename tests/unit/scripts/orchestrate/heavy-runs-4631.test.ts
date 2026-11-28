/**
 * Issue #4631: the wait for the heavy runs (vitest / next build / precheck.mjs / verify-run.sh) lives in
 * scripts/orchestrate/heavy-runs.mjs instead of a line copied into requests, and the tools that start a
 * heavy run inside (wait-verify, precheck, merge-pr, merge-train) wait for it themselves.
 *
 * ## Range (I3): the wait is not a lock
 * Two waiters that both read zero both start — the same window v4 (the copied line) leaves. Nothing here
 * proves or asks for mutual exclusion; the machine lock `cpu.heavy` (resource-sem, precheck's heavy
 * steps) is unchanged and not exercised. What is fixed:
 *   表 A — which rows of a `ps -axo pid=,ppid=,comm=,args=` table count (I1 / I2, the three S12 mistakes);
 *   表 B — each tool waits before it starts the heavy run (the four overlaps of S12), and a `main` called
 *          without `waitHeavy` waits for nothing (I6) and keeps its exit code and record (I4);
 *   表 C — the `count` / `wait` entry, with the process table and the sleep faked.
 *
 * No real `ps` is read and nothing sleeps: inside vitest the sibling workers are `node …vitest…` rows, so a
 * real wait would never end. The fixture (tests/fixtures/heavy-runs-4631/) is a copy with dummy paths.
 * The run records, worktrees and git repositories are under os.tmpdir() and removed after each test.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendRecord, readRecords } from '../../../../scripts/orchestrate/run-log.mjs';
import { main as waitVerifyMain } from '../../../../scripts/orchestrate/wait-verify.mjs';
import { HEAVY_TEST_FILES, main as precheckMain } from '../../../../scripts/orchestrate/precheck.mjs';
import { LAST_REQUIRED_CHECKS, main as mergePrMain } from '../../../../scripts/orchestrate/merge-pr.mjs';
import { main as mergeTrainMain } from '../../../../scripts/orchestrate/merge-train.mjs';
import { HEAD_A, HEAD_B, fakeGit, openPr } from './pr-fake';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const FIXTURE = path.join(REPO_ROOT, 'tests/fixtures/heavy-runs-4631/ps-table-a.txt');

type Run = { pid: number; args: string };
type PsRead = { ok: boolean; text: string; detail?: string };
interface HeavyModule {
  heavyRuns: (psText: string, options?: { selfPid?: number | null; precheckPeers?: boolean }) => Run[];
  waitForNoHeavy: (deps: {
    readPs: () => PsRead;
    sleep: (ms: number) => void;
    now: () => number;
    error: (line: string) => void;
    selfPid?: number | null;
    precheckPeers?: boolean;
  }) => { waitedMs: number; reads: number; unreadable: string | null };
  main: (
    argv: string[],
    deps?: { readPs?: () => PsRead; sleep?: (ms: number) => void; now?: () => number; selfPid?: number | null; log?: (l: string) => void; error?: (l: string) => void }
  ) => number;
  POLL_MS: number;
  NOTICE_MS: number;
  PS_ARGS: string[];
}

// Dynamic: before the script exists every test of 表 A and 表 C fails on its own (not the file at load).
const HEAVY_PATH = '../../../../scripts/orchestrate/heavy-runs.mjs';
const loadHeavy = async (): Promise<HeavyModule> => (await import(/* @vite-ignore */ HEAVY_PATH)) as HeavyModule;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-heavy-runs-4631-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 表 A: which rows count
// ---------------------------------------------------------------------------

/** The waiting process of the fixture: a precheck under a precheck under merge-pr's inner and outer node. */
const SELF = 603;

const TABLE_A: { pid: number; count: boolean; why: string }[] = [
  { pid: 700, count: true, why: 'node の vitest の main' },
  { pid: 701, count: true, why: 'node の vitest の worker（forks の args）' },
  { pid: 702, count: true, why: 'comm がパスの node（basename で照合）の vitest の worker' },
  { pid: 710, count: true, why: 'node の next build' },
  { pid: 720, count: true, why: '他人の node precheck.mjs' },
  { pid: 730, count: true, why: 'bash の verify-run.sh' },
  { pid: 1, count: false, why: 'launchd' },
  { pid: 500, count: false, why: '端末の zsh' },
  { pid: 600, count: false, why: '祖先の node merge-pr.mjs（外側）' },
  { pid: 601, count: false, why: '祖先の node merge-pr.mjs（内側）' },
  { pid: 602, count: false, why: '祖先（ppid の鎖）の node precheck.mjs' },
  { pid: SELF, count: false, why: '自分の pid（node precheck.mjs が自分の args の precheck.mjs で自分を待たない）' },
  { pid: 800, count: false, why: "誤り 1: zsh で until ! pgrep -f 'vitest|next build' を走らせている行" },
  { pid: 801, count: false, why: 'zsh で v4 の 1 行そのもの（args に vitest・precheck.mjs・verify-run.sh）' },
  { pid: 802, count: false, why: '誤り 2: grep -q 走行中 の行（順番表の文字）' },
  { pid: 803, count: false, why: '誤り 3: node の wait-verify.mjs（返しを待つだけ）' },
  { pid: 804, count: false, why: 'comm が node でない vitest の文字（less vitest.log）' },
  { pid: 805, count: false, why: 'sh の -c で verify-run.sh の文字を含む行' },
  { pid: 806, count: false, why: 'bash の -c の vitest（bash は verify-run.sh だけが重い）' },
  { pid: 807, count: false, why: 'pgrep の行' },
  { pid: 808, count: false, why: 'ps の行（読み手）' },
];

describe('表 A: the rows of a process table that count (I1 / I2)', () => {
  const text = () => fs.readFileSync(FIXTURE, 'utf8');

  it('the table covers every row of the fixture once', () => {
    const pids = text()
      .split('\n')
      .map((l) => /^\s*(\d+)\s/.exec(l)?.[1])
      .filter(Boolean)
      .map(Number);
    expect(pids.sort((a, b) => a - b)).toEqual(TABLE_A.map((r) => r.pid).sort((a, b) => a - b));
  });

  it.each(TABLE_A)('pid $pid counted=$count — $why', async ({ pid, count }) => {
    const { heavyRuns } = await loadHeavy();
    const counted = heavyRuns(text(), { selfPid: SELF }).map((r) => r.pid);
    expect(counted.includes(pid)).toBe(count);
  });

  it('returns the pid and the args of each counted row, in table order', async () => {
    const { heavyRuns } = await loadHeavy();
    const runs = heavyRuns(text(), { selfPid: SELF });
    expect(runs.map((r) => r.pid)).toEqual([700, 701, 702, 710, 720, 730]);
    expect(runs[0]).toEqual({ pid: 700, args: 'node /work/b/node_modules/.bin/vitest run tests/unit/scripts/orchestrate' });
  });

  it('without a selfPid the waiting precheck and its precheck ancestor count (the lineage is what leaves them out)', async () => {
    const { heavyRuns } = await loadHeavy();
    const counted = heavyRuns(text()).map((r) => r.pid);
    expect(counted).toContain(SELF);
    expect(counted).toContain(602);
  });

  it("a precheck's own wait counts another precheck only through its vitest child (two waiting prechecks do not wait for each other)", async () => {
    const { heavyRuns } = await loadHeavy();
    const a = '  10     1 node node /w/a/scripts/orchestrate/precheck.mjs --issue 1\n';
    const b = '  20     1 node node /w/b/scripts/orchestrate/precheck.mjs --issue 2\n';
    // Both before their first vitest: each reads zero, as two v4 lines both reading zero (I3).
    expect(heavyRuns(a + b, { selfPid: 10, precheckPeers: false })).toEqual([]);
    expect(heavyRuns(a + b, { selfPid: 20, precheckPeers: false })).toEqual([]);
    // B's vitest child still counts for A, and a vitest naming precheck.mjs is still a vitest.
    const child = '  21    20 node node /w/b/node_modules/.bin/vitest related --run scripts/orchestrate/precheck.mjs\n';
    expect(heavyRuns(a + b + child, { selfPid: 10, precheckPeers: false }).map((r) => r.pid)).toEqual([21]);
    // Every other waiter (a shell's `wait`, wait-verify, merge-pr, merge-train) counts B itself, as v4 does.
    expect(heavyRuns(a + b, { selfPid: 10 }).map((r) => r.pid)).toEqual([20]);
  });
});

// ---------------------------------------------------------------------------
// 表 C: the entry
// ---------------------------------------------------------------------------

const BUSY = '  700     1 node node /work/b/node_modules/.bin/vitest run\n  900     1 /bin/zsh zsh\n';
const IDLE = '  900     1 /bin/zsh zsh\n';

/** A process table that answers `texts` in turn (the last repeats), and a clock the fake sleep moves. */
function fakeMachine(texts: (string | null)[]) {
  let reads = 0;
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps = {
    readPs: (): PsRead => {
      const text = texts[Math.min(reads, texts.length - 1)];
      reads += 1;
      return text === null ? { ok: false, text: '', detail: 'exit 1: ps: no' } : { ok: true, text };
    },
    sleep: (ms: number) => {
      sleeps.push(ms);
      if (sleeps.length > 10_000) throw new Error('the wait did not end');
      clock += ms;
    },
    now: () => clock,
    selfPid: 900,
    log: (l: string) => out.push(l),
    error: (l: string) => err.push(l),
  };
  return { deps, sleeps, out, err, reads: () => reads };
}

describe('表 C: the count / wait entry', () => {
  it('reads ps with pid, ppid, comm and args, polls every 15 s and speaks every 5 min', async () => {
    const h = await loadHeavy();
    expect(h.PS_ARGS).toEqual(['-axo', 'pid=,ppid=,comm=,args=']);
    expect(h.POLL_MS).toBe(15_000);
    expect(h.NOTICE_MS).toBe(300_000);
  });

  it('count: exit 0 with no line when none runs', async () => {
    const { main } = await loadHeavy();
    const m = fakeMachine([IDLE]);
    expect(main(['count'], m.deps)).toBe(0);
    expect(m.out).toEqual([]);
  });

  it('count: exit 1 with one `<pid> <args>` line per run', async () => {
    const { main } = await loadHeavy();
    const m = fakeMachine([BUSY]);
    expect(main(['count'], m.deps)).toBe(1);
    expect(m.out).toEqual(['700 node /work/b/node_modules/.bin/vitest run']);
  });

  it('wait: returns at once when none runs (no sleep, nothing on stderr)', async () => {
    const { main } = await loadHeavy();
    const m = fakeMachine([IDLE]);
    expect(main(['wait'], m.deps)).toBe(0);
    expect(m.sleeps).toEqual([]);
    expect(m.err).toEqual([]);
    expect(m.reads()).toBe(1);
  });

  it('wait: returns when the second read finds none, after one 15 s sleep, and says what it waited for', async () => {
    const { main } = await loadHeavy();
    const m = fakeMachine([BUSY, IDLE]);
    expect(main(['wait'], m.deps)).toBe(0);
    expect(m.sleeps).toEqual([15_000]);
    expect(m.reads()).toBe(2);
    expect(m.err).toHaveLength(1);
    expect(m.err[0]).toContain('1 heavy run(s): 700 node /work/b/node_modules/.bin/vitest run');
  });

  it('wait: the stderr line names the pid and the whole args of every run it waits for (what to look at to stop it)', async () => {
    const { main } = await loadHeavy();
    const two = `${BUSY}  730     1 bash bash /w/scripts/verify-run.sh --gates unit --extra a b c\n`;
    const m = fakeMachine([two, IDLE]);
    expect(main(['wait'], m.deps)).toBe(0);
    expect(m.err).toHaveLength(1);
    expect(m.err[0]).toContain('2 heavy run(s): 700 node /work/b/node_modules/.bin/vitest run | 730 bash /w/scripts/verify-run.sh --gates unit --extra a b c');
  });

  it('wait: one stderr line at the start and then every 5 min, no default limit', async () => {
    const { main } = await loadHeavy();
    // 41 busy reads: 40 sleeps of 15 s = 10 min, then none.
    const m = fakeMachine([...Array.from({ length: 41 }, () => BUSY), IDLE]);
    expect(main(['wait'], m.deps)).toBe(0);
    expect(m.sleeps).toHaveLength(41);
    expect(m.err.map((l) => /waiting (\d+)s/.exec(l)?.[1])).toEqual(['0', '300', '600']);
  });

  it('wait: an unreadable table ends the wait (exit 2, said on stderr) instead of hanging the caller', async () => {
    const { main, waitForNoHeavy } = await loadHeavy();
    const m = fakeMachine([null]);
    expect(main(['wait'], m.deps)).toBe(2);
    expect(m.err.join('\n')).toContain('could not be read');
    const again = fakeMachine([BUSY, null]);
    expect(waitForNoHeavy({ ...again.deps }).unreadable).toBe('exit 1: ps: no');
  });

  it('usage and a main without a process reader: exit 2, nothing read (I6)', async () => {
    const { main } = await loadHeavy();
    const err: string[] = [];
    expect(main([], { error: (l) => err.push(l) })).toBe(2);
    expect(main(['count', 'x'], { error: (l) => err.push(l) })).toBe(2);
    expect(main(['count'], { error: (l) => err.push(l) })).toBe(2);
    expect(main(['wait'], { readPs: () => ({ ok: true, text: BUSY }), error: (l) => err.push(l) })).toBe(2);
    expect(err).toHaveLength(4);
  });

  it('the self pid and its ancestors are left out of count', async () => {
    const { main } = await loadHeavy();
    const m = fakeMachine(['  700     1 node node /w/node_modules/.bin/vitest run\n  710   700 node node /w/x.mjs\n']);
    expect(main(['count'], { ...m.deps, selfPid: 710 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 表 B: each tool waits before the heavy run it starts
// ---------------------------------------------------------------------------

describe('表 B: the real wait is given only by each entry (I6)', () => {
  it.each(['wait-verify.mjs', 'precheck.mjs', 'merge-pr.mjs', 'merge-train.mjs'])('%s passes heavyWaiter only inside `if (isMain)`', (file) => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'scripts/orchestrate', file), 'utf8');
    const entry = text.lastIndexOf('\nif (isMain)');
    expect(entry).toBeGreaterThan(0);
    const calls = [...text.matchAll(/heavyWaiter\(/g)].map((m) => m.index ?? -1);
    expect(calls.length).toBeGreaterThan(0);
    for (const at of calls) expect(at).toBeGreaterThan(entry);
  });
});

describe("表 B: only precheck's entry leaves the other prechecks out of its wait (precheckPeers: false)", () => {
  // precheck waits before every heavy step, while it is itself a `node … precheck.mjs` row: counting the
  // other prechecks would make two of them wait for each other for ever. The other three tools are never
  // counted while they wait, and count a precheck as v4 does.
  const ENTRY_PEERS: { file: string; peersOff: boolean }[] = [
    { file: 'precheck.mjs', peersOff: true },
    { file: 'wait-verify.mjs', peersOff: false },
    { file: 'merge-pr.mjs', peersOff: false },
    { file: 'merge-train.mjs', peersOff: false },
  ];
  it.each(ENTRY_PEERS)('$file: precheckPeers: false given by its entry = $peersOff', ({ file, peersOff }) => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'scripts/orchestrate', file), 'utf8');
    const entry = text.slice(text.lastIndexOf('\nif (isMain)'));
    const waiters = [...entry.matchAll(/heavyWaiter\(\{([^}]*)\}\)/g)].map((m) => m[1]);
    expect(waiters.length).toBeGreaterThan(0);
    for (const options of waiters) {
      expect(/\bprecheckPeers:\s*false\b/.test(options)).toBe(peersOff);
      if (!peersOff) expect(options).not.toContain('precheckPeers');
    }
  });
});

// --- wait-verify ------------------------------------------------------------

const PASS_LOG = ['Completed: wt-1 (basis=hook_stop)', 'Verifying: wt-1 (run 12)', 'GATE lint PASS (exit=0, 1.0s)', 'RESULT passed', ''].join('\n');
const T0 = Date.UTC(2026, 10, 27, 1, 0);
const iso = (minute: number) => new Date(T0 + minute * 60_000).toISOString();

const BUSY_VERIFY_LOG = "Error: A verification run is already in progress for 'wt-1' (run 11). Wait for it to finish, then retry.\n";
/** Gates with the `[timing]` marker, so the record carries queueSec / mutexSec / runSec. */
const TIMED_GATES = [
  { gateId: 'lint', status: 'passed', exitCode: 0, durationMs: 40_000, logTail: '[timing] queue=4.0s mutex=0.0s run=40.0s' },
  { gateId: 'unit-related', status: 'passed', exitCode: 0, durationMs: 600_000, logTail: 'ok\n[timing] queue=30.0s mutex=120.0s run=600.0s' },
];

/**
 * commandmatedev and git faked; the verification run started at 01:05, the last commit at `commitMinute`.
 * `busyFirst`: the first verify finds another run of the worktree going (exit 99), which then ends.
 * `waitMs`: what the fake wait moves the clock by.
 */
function waitVerifyHarness({ commitMinute = 3, withWait = true, busyFirst = false, waitMs = 0 } = {}) {
  const events: string[] = [];
  let clock = T0;
  let verifies = 0;
  const worktree = path.join(tmp, 'wt');
  fs.mkdirSync(worktree, { recursive: true });
  const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
  const deps = {
    spawnToLog: (_command: string, args: string[], { logFile }: { logFile: string }) => {
      events.push(args[0]);
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      if (args[0] === 'verify' && busyFirst && verifies++ === 0) {
        fs.writeFileSync(logFile, BUSY_VERIFY_LOG);
        return 99;
      }
      fs.writeFileSync(logFile, PASS_LOG);
      clock += 600_000;
      return 0;
    },
    run: (command: string, args: string[]) => {
      if (command === 'git') {
        const sub = args.slice(2);
        if (sub[0] === 'rev-parse') return ok(`${HEAD_A}\n`);
        if (sub[0] === 'status') return ok('');
        if (sub[0] === 'log') return ok(`${iso(commitMinute)}\n`);
        throw new Error(`unexpected git ${sub.join(' ')}`);
      }
      if (args[0] === 'task' && args[1] === 'list') return ok('[]');
      if (args[0] === 'task' && args[1] === 'show') return { status: 1, stdout: '', stderr: 'not found' };
      if (args[0] === 'verify' && args[1] === 'show') return ok(JSON.stringify({ run: { id: Number(args[2]), worktreeId: 'wt-1', status: 'passed', startedAt: iso(5), gates: TIMED_GATES } }));
      if (args[0] === 'verify' && args[1] === 'history') return ok(JSON.stringify([{ id: 12, startedAt: iso(5) }]));
      if (args[0] === 'capture' && args.includes('--json')) return ok(JSON.stringify({ lastStopEventAt: T0 + 4 * 60_000, autoYes: { enabled: false } }));
      if (args[0] === 'auto-yes') return ok('');
      throw new Error(`unexpected ${command} ${args.join(' ')}`);
    },
    resolveTarget: (_wt: string, selector: string) => ({ instanceId: selector }),
    sleep: (ms: number) => {
      clock += ms;
    },
    now: () => new Date(clock),
    home: tmp,
    log: () => {},
    error: () => {},
    ...(withWait
      ? {
          waitHeavy: () => {
            events.push('heavy');
            clock += waitMs;
          },
        }
      : {}),
  };
  const runDir = path.join(tmp, 'runs', '2026-11-27');
  const argv = (...extra: string[]) => [
    '--run-dir', runDir, '--issues', '4631', '--issue', '4631', '--wt', 'wt-1', '--worktree', worktree, '--instance', 'claude', '--task', 't-1', ...extra,
  ];
  const record = () => readRecords(runDir, '4631').records.filter((r: { stage: string }) => r.stage === 'verify').at(-1);
  return { deps, events, argv, record };
}

describe('表 B: wait-verify waits before every verify it starts (重なり: wait-verify が待たずに verify を始めた)', () => {
  it('the first verify — positive control: without the wait the order has no heavy before verify', () => {
    const h = waitVerifyHarness();
    expect(waitVerifyMain(h.argv(), h.deps)).toBe(0);
    expect(h.events).toEqual(['wait', 'heavy', 'verify']);
  });

  it('the re-verification after a commit landed during the first (reverify)', () => {
    const h = waitVerifyHarness({ commitMinute: 6 });
    expect(waitVerifyMain(h.argv(), h.deps)).toBe(0);
    expect(h.events).toEqual(['wait', 'heavy', 'verify', 'heavy', 'verify']);
  });

  it.each([['--after-reinstruct'], ['--reverify']])('the verify after a re-instruction (%s)', (flag) => {
    const h = waitVerifyHarness();
    expect(waitVerifyMain(h.argv(flag), h.deps)).toBe(0);
    expect(h.events).toEqual(['wait', 'heavy', 'verify']);
  });

  it('the retry after another run of the worktree kept the first from starting (busy, attempt 2)', () => {
    const h = waitVerifyHarness({ busyFirst: true });
    expect(waitVerifyMain(h.argv(), h.deps)).toBe(0);
    expect(h.events).toEqual(['wait', 'heavy', 'verify', 'heavy', 'verify']);
  });

  it('I4: a wait of 600 s adds 600 to durationSec only; queueSec / mutexSec / runSec and the result stay', () => {
    // The two harnesses share one run dir: each record is read right after its own run.
    const plain = waitVerifyHarness();
    expect(waitVerifyMain(plain.argv(), plain.deps)).toBe(0);
    const a = plain.record();
    const waited = waitVerifyHarness({ waitMs: 600_000 });
    expect(waitVerifyMain(waited.argv(), waited.deps)).toBe(0);
    const b = waited.record();
    expect(a.queueSec).toBe(34);
    expect(b.durationSec).toBe(a.durationSec + 600);
    expect({ result: b.result, queueSec: b.queueSec, mutexSec: b.mutexSec, runSec: b.runSec }).toEqual({
      result: a.result, queueSec: a.queueSec, mutexSec: a.mutexSec, runSec: a.runSec,
    });
  });

  it('negative control (I4 / I6): main without waitHeavy waits for nothing and records the same result', () => {
    const plain = waitVerifyHarness({ withWait: false });
    expect(waitVerifyMain(plain.argv(), plain.deps)).toBe(0);
    expect(plain.events).toEqual(['wait', 'verify']);
    const a = plain.record();
    const waited = waitVerifyHarness();
    expect(waitVerifyMain(waited.argv(), waited.deps)).toBe(0);
    const b = waited.record();
    expect(b.result).toBe(a.result);
    expect(b.durationSec).toBe(a.durationSec);
  });
});

// --- precheck ---------------------------------------------------------------

const manyTests = Array.from({ length: HEAVY_TEST_FILES }, (_, i) => `tests/unit/many/t${i}.test.ts`);

/**
 * precheck with git, the steps and cpu.heavy faked. `relatedTests`: estimateRelatedTests' count (50 on makes
 * `related` a wide step). `lockWaitMs`: what the fake lock says it waited. `waitMs`: what the fake wait moves
 * the clock by. `waitHeavy`: a wait of the test's own instead of the recording one.
 */
function precheckHarness({
  changed = ['scripts/orchestrate/precheck.mjs'],
  naming = [] as string[],
  withWait = true,
  relatedTests = 0,
  lockWaitMs = 0,
  waitMs = 0,
  waitHeavy = null as null | ((events: string[]) => void),
} = {}) {
  const events: string[] = [];
  let clock = T0;
  // Each harness its own home and run dir: a second precheck at the same HEAD would otherwise find the first's record.
  const own = fs.mkdtempSync(path.join(tmp, 'precheck-'));
  const deps = {
    run: (command: string, args: string[]) => {
      if (command === 'git') {
        const sub = args.slice(2);
        if (sub[0] === 'rev-parse') return { status: 0, stdout: `${HEAD_A}\n`, stderr: '' };
        if (sub[0] === 'status') return { status: 0, stdout: '', stderr: '' };
        if (sub.includes('--diff-filter=ACMR')) return { status: 0, stdout: changed.join('\n'), stderr: '' };
        if (sub.includes('--diff-filter=D')) return { status: 0, stdout: '', stderr: '' };
        if (sub.includes('--unified=0')) return { status: 0, stdout: '', stderr: '' };
        if (sub[0] === 'log' && sub.includes('--first-parent')) return { status: 0, stdout: `${HEAD_A} ${'f'.repeat(40)}\n`, stderr: '' };
        if (sub[0] === 'diff-tree') return { status: 0, stdout: `${changed[0]}\n`, stderr: '' };
        throw new Error(`unexpected git ${sub.join(' ')}`);
      }
      events.push(`run ${command} ${args.slice(0, 2).join(' ')}`);
      return { status: 0, stdout: '', stderr: '' };
    },
    findTestsNaming: () => naming,
    estimateRelatedTests: () => relatedTests,
    acquireHeavyLock: () => {
      events.push('lock');
      return { acquired: true, waitedMs: lockWaitMs, heldBy: null, release: () => {} };
    },
    home: own,
    now: () => new Date(clock),
    log: () => {},
    error: (line: string) => events.push(`error ${line}`),
    ...(withWait
      ? {
          waitHeavy: () => {
            if (waitHeavy) return waitHeavy(events);
            events.push('heavy');
            clock += waitMs;
          },
        }
      : {}),
  };
  const runDir = path.join(own, 'runs', '2026-11-27');
  const argv = (...extra: string[]) => ['--run-dir', runDir, '--issues', '4631', '--issue', '4631', '--worktree', path.join(tmp, 'wt'), ...extra];
  const record = () => readRecords(runDir, '4631').records.filter((r: { stage: string }) => r.stage === 'precheck').at(-1);
  return { deps, events, argv, record };
}

const startsHeavy = (e: string) => e.startsWith('run npx vitest') || e === 'run npm run build';

/** Each heavy step (vitest / `npm run build`) has the wait right before it, and no wait stands elsewhere. */
function expectWaitBeforeEachHeavy(events: string[]) {
  const heavySteps = events.filter(startsHeavy);
  expect(heavySteps.length).toBeGreaterThan(0);
  expect(events.filter((e) => e === 'heavy')).toHaveLength(heavySteps.length);
  events.forEach((e, i) => {
    if (e === 'heavy') expect(events.slice(i + 1).find((n) => n !== 'lock')).toSatisfy(startsHeavy);
  });
}

describe('表 B: precheck waits before each vitest / next build step it starts (重なり: precheck の段の移りの隙間)', () => {
  it('waits right before each vitest step, after the light steps — positive control', () => {
    const h = precheckHarness();
    expect(precheckMain(h.argv(), h.deps)).toBe(0);
    const first = h.events.findIndex(startsHeavy);
    expect(first).toBeGreaterThan(0);
    expect(h.events[first - 1]).toBe('heavy');
    expect(h.events.indexOf('run npx tsc')).toBeLessThan(first - 1);
    expect(h.events.filter(startsHeavy)).toEqual(['run npx vitest related', 'run npx vitest run']);
    expectWaitBeforeEachHeavy(h.events);
  });

  it('waits again before the build step (--build), and not before the light build:cli / build:server', () => {
    const h = precheckHarness({ naming: manyTests });
    expect(precheckMain(h.argv('--build'), h.deps)).toBe(0);
    expect(h.events).toContain('run npm run build');
    expect(h.events[h.events.indexOf('run npm run build') - 1]).toBe('heavy');
    expect(h.events[h.events.indexOf('run npm run build:cli') - 1]).not.toBe('heavy');
    expectWaitBeforeEachHeavy(h.events);
  });

  it('a wide step first (related with 50 tests on): the wait, then the lock, then the step', () => {
    const h = precheckHarness({ relatedTests: HEAVY_TEST_FILES });
    expect(precheckMain(h.argv(), h.deps)).toBe(0);
    const at = h.events.indexOf('heavy');
    expect(h.events.slice(at, at + 3)).toEqual(['heavy', 'lock', 'run npx vitest related']);
  });

  it("A moving on from related waits for B's vitest that started in the gap (two prechecks, precheckPeers: false)", async () => {
    const { waitForNoHeavy } = await loadHeavy();
    // A (pid 10) and B (pid 20) are both `node … precheck.mjs`; B's vitest (21) runs while A is between steps.
    const a = '  10     1 node node /w/a/scripts/orchestrate/precheck.mjs --issue 1\n';
    const b = '  20     1 node node /w/b/scripts/orchestrate/precheck.mjs --issue 2\n';
    const bVitest = '  21    20 node node /w/b/node_modules/.bin/vitest run tests/unit/guards\n';
    const tables = [a + b, a + b + bVitest, a + b + bVitest, a + b];
    let read = 0;
    const h = precheckHarness({
      waitHeavy: (events) => {
        let sleeps = 0;
        const waited = waitForNoHeavy({
          readPs: () => ({ ok: true, text: tables[Math.min(read++, tables.length - 1)] }),
          sleep: () => {
            sleeps += 1;
            if (sleeps > 100) throw new Error('the wait did not end');
          },
          now: () => 0,
          error: () => {},
          selfPid: 10,
          precheckPeers: false,
        });
        events.push(`heavy sleeps=${sleeps} unreadable=${waited.unreadable}`);
      },
    });
    expect(precheckMain(h.argv(), h.deps)).toBe(0);
    const waits = h.events.filter((e) => e.startsWith('heavy'));
    // Before related: B is only a precheck (not counted); before tests: B's vitest, two sleeps, then none.
    expect(waits).toEqual(['heavy sleeps=0 unreadable=null', 'heavy sleeps=2 unreadable=null']);
    expect(h.events[h.events.indexOf('run npx vitest run') - 1]).toBe('heavy sleeps=2 unreadable=null');
  });

  it('negative control: a run of light steps only (heavy steps left to CI) does not wait', () => {
    const h = precheckHarness({ changed: ['docs/x.md'], naming: manyTests });
    expect(precheckMain(h.argv('--heavy-to-ci'), h.deps)).toBe(0);
    expect(h.events.some(startsHeavy)).toBe(false);
    expect(h.events).not.toContain('heavy');
  });

  it('negative control (I4 / I6): main without waitHeavy waits for nothing; exit and record are the same', () => {
    const plain = precheckHarness({ withWait: false });
    expect(precheckMain(plain.argv(), plain.deps)).toBe(0);
    expect(plain.events).not.toContain('heavy');
    const waited = precheckHarness();
    expect(precheckMain(waited.argv(), waited.deps)).toBe(0);
    expect(waited.events.filter((e) => e !== 'heavy')).toEqual(plain.events);
    const [a, b] = [plain.record(), waited.record()];
    expect({ result: b.result, mutexSec: b.mutexSec, durationSec: b.durationSec }).toEqual({ result: a.result, mutexSec: a.mutexSec, durationSec: a.durationSec });
  });

  it('I4: a wait of 600 s adds 600 to durationSec only; mutexSec / runSec and the result stay (one wide step)', () => {
    const opts = { changed: ['docs/x.md'], naming: manyTests, lockWaitMs: 30_000 };
    const plain = precheckHarness(opts);
    expect(precheckMain(plain.argv(), plain.deps)).toBe(0);
    const waited = precheckHarness({ ...opts, waitMs: 600_000 });
    expect(precheckMain(waited.argv(), waited.deps)).toBe(0);
    expect(waited.events.filter((e) => e === 'heavy')).toHaveLength(1);
    const [a, b] = [plain.record(), waited.record()];
    expect(a.mutexSec).toBe(30);
    expect(b.durationSec).toBe(a.durationSec + 600);
    expect({ result: b.result, mutexSec: b.mutexSec, runSec: b.runSec }).toEqual({ result: a.result, mutexSec: a.mutexSec, runSec: a.runSec });
  });
});

// --- merge-pr ---------------------------------------------------------------

describe('表 B: merge-pr waits before its inner precheck (重なり: develop が進んだ後の取り直しの precheck)', () => {
  const OPTS = 'opts=base:origin/develop,kind:-,metrics:false,allow-removed:false,build:false';

  function runMerge(fake: ReturnType<typeof fakeGit>, { withWait = true } = {}) {
    const runDir = path.join(tmp, 'runs', '2026-11-27');
    const worktree = path.join(tmp, 'wt');
    fs.mkdirSync(path.join(worktree, 'dev-reports', 'module-reference'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'dev-reports', 'module-reference', 'issue-3477.md'), '追記なし\n');
    const events: string[] = [];
    let clock = T0;
    const code = mergePrMain(['--run-dir', runDir, '--issues', '3477', '--issue', '3477', '--worktree', worktree], {
      run: fake.run,
      sleep: (ms: number) => {
        clock += ms;
      },
      now: () => new Date(clock),
      findTestsNaming: () => [],
      home: tmp,
      lockRoot: path.join(tmp, 'locks'),
      log: () => {},
      error: () => {},
      runPrecheck: () => {
        events.push('precheck');
        return 1;
      },
      ...(withWait ? { waitHeavy: () => events.push('heavy') } : {}),
    } as Parameters<typeof mergePrMain>[1]);
    return { code, events, runDir };
  }

  function recordWork(runDir: string, precheckHead: string) {
    appendRecord(runDir, '3477', { issue: 3477, stage: 'verify', result: 'ok', head: HEAD_A, note: 'exit=0(passed) passed=lint,typecheck failed=-' });
    appendRecord(runDir, '3477', { issue: 3477, stage: 'review', result: 'ok', head: HEAD_A });
    appendRecord(runDir, '3477', { issue: 3477, stage: 'findings', result: 'ok', head: HEAD_A });
    appendRecord(runDir, '3477', { issue: 3477, stage: 'precheck', result: 'ok', head: precheckHead, note: `tsc=ok tests=ok ${OPTS}` });
  }

  it('the precheck after develop moved (the refresh) — positive control', () => {
    recordWork(path.join(tmp, 'runs', '2026-11-27'), HEAD_A);
    const r = runMerge(fakeGit({ prs: [openPr()], behind: true }));
    expect(r.code).toBe(1);
    expect(r.events).toEqual(['heavy', 'precheck']);
  });

  it('the precheck of a HEAD that has none yet (no refresh)', () => {
    recordWork(path.join(tmp, 'runs', '2026-11-27'), HEAD_B);
    const r = runMerge(fakeGit({ prs: [openPr()] }));
    expect(r.code).toBe(1);
    expect(r.events).toEqual(['heavy', 'precheck']);
  });

  it('negative control (I4 / I6): without waitHeavy the precheck runs as before, with the same exit', () => {
    recordWork(path.join(tmp, 'runs', '2026-11-27'), HEAD_A);
    const r = runMerge(fakeGit({ prs: [openPr()], behind: true }), { withWait: false });
    expect(r.code).toBe(1);
    expect(r.events).toEqual(['precheck']);
  });

  it('negative control: no precheck to run, no wait', () => {
    recordWork(path.join(tmp, 'runs', '2026-11-27'), HEAD_A);
    const r = runMerge(fakeGit({ prs: [openPr()], checks: [LAST_REQUIRED_CHECKS.map((name) => ({ name, bucket: 'pass' }))] }));
    expect(r.events).toEqual([]);
  });
});

// --- merge-train ------------------------------------------------------------

const GITHUB_URL = 'https://github.com/Kewton/CommandMate.git';
const GIT_ENV = { GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

function g(cwd: string, ...args: string[]): string {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${out.stderr}`);
  return out.stdout.trim();
}

/**
 * A repository with a bare origin and one worktree / PR per Issue (as merge-train-4369.test.ts builds it),
 * a fake gh for what the train reads before its precheck, and the precheck faked to stop the train.
 */
function trainWorld(issues: number[]) {
  const bare = path.join(tmp, 'origin.git');
  const repo = path.join(tmp, 'repo');
  const runDir = path.join(tmp, 'runs', '2026-11-27');
  const home = path.join(tmp, 'home');
  const tmpdir = path.join(tmp, 'tmpdir');
  for (const dir of [home, tmpdir]) fs.mkdirSync(dir, { recursive: true });
  g(tmp, 'init', '-q', '--bare', '-b', 'develop', bare);
  g(tmp, 'init', '-q', '-b', 'develop', repo);
  g(repo, 'config', 'user.name', 'fixture');
  g(repo, 'config', 'user.email', 'fixture@localhost');
  g(repo, 'config', 'commit.gpgsign', 'false');
  g(repo, 'config', `url.${bare}.insteadOf`, GITHUB_URL);
  g(repo, 'remote', 'add', 'origin', GITHUB_URL);
  fs.writeFileSync(path.join(repo, '.gitignore'), '/node_modules\n/dev-reports/\n');
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', 'base');
  g(repo, 'push', '-q', '-u', 'origin', 'develop');
  const ISSUES = '4401-4409';
  const prs = new Map<number, Record<string, unknown>>();
  for (const issue of issues) {
    const branch = `feature/${issue}-x`;
    const wt = path.join(tmp, `wt-${issue}`);
    g(repo, 'worktree', 'add', '-q', '-b', branch, wt, 'develop');
    fs.writeFileSync(path.join(wt, `f${issue}.txt`), `issue ${issue}\n`);
    fs.mkdirSync(path.join(wt, 'changelog.d'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'changelog.d', `${issue}.md`), `<!-- ### Added -->\n- **feat(x): y** (#${issue}): z\n`);
    g(wt, 'add', '-A');
    g(wt, 'commit', '-q', '-m', `feat: #${issue}`);
    g(wt, 'push', '-q', 'origin', branch);
    fs.mkdirSync(path.join(wt, 'dev-reports', 'module-reference'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'dev-reports', 'module-reference', `issue-${issue}.md`), '追記なし\n');
    fs.mkdirSync(path.join(wt, 'node_modules'));
    const head = g(wt, 'rev-parse', 'HEAD');
    const pr = issue + 1000;
    appendRecord(runDir, ISSUES, { issue, stage: 'verify', result: 'ok', head, note: 'exit=0(passed) passed=lint,typecheck,unit failed=-' });
    appendRecord(runDir, ISSUES, { issue, stage: 'review', result: 'ok', head });
    appendRecord(runDir, ISSUES, { issue, stage: 'findings', result: 'ok', head });
    appendRecord(runDir, ISSUES, { issue, stage: 'precheck', result: 'ok', head, note: 'tsc=ok tests=ok opts=base:origin/develop,kind:-,metrics:false,allow-removed:false,build:false' });
    appendRecord(runDir, ISSUES, { issue, stage: 'pr', result: 'ok', head, note: `pr=#${pr} opened` });
    prs.set(pr, {
      number: pr, state: 'OPEN', headRefOid: head, headRefName: branch, baseRefName: 'develop',
      headRepository: { name: 'CommandMate' }, headRepositoryOwner: { login: 'Kewton' }, isCrossRepository: false,
    });
  }
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const gh = (args: string[]) => {
    const key = args.slice(0, 2).join(' ');
    if (key === 'pr view') {
      const pr = prs.get(Number(args[2]));
      return pr ? ok(JSON.stringify(pr)) : { status: 1, stdout: '', stderr: 'no pull requests found for branch' };
    }
    if (key === 'pr checks') return ok(JSON.stringify(LAST_REQUIRED_CHECKS.map((name) => ({ name, bucket: 'pass' }))));
    if (args[0] === 'api') {
      const apiPath = args[args.length - 1];
      if (apiPath.endsWith('/protection')) return { status: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)' };
      if (apiPath.includes('/rules/branches/')) return ok('[]');
      if (args[1] === 'graphql') return ok(JSON.stringify({ data: { repository: { mergeQueue: null } } }));
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const run = (command: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) => {
    if (command === 'git') {
      const out = spawnSync('git', args, { cwd: opts.cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...(opts.env ?? {}) }, maxBuffer: 64 * 1024 * 1024 });
      return { status: out.status ?? 1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
    }
    if (command === 'gh') return gh(args);
    throw new Error(`unexpected ${command} ${args.join(' ')}`);
  };
  let clock = Date.parse('2026-11-27T00:00:00.000Z');
  let seq = 0;
  const go = (queue: string, { withWait = true, events = [] as string[] } = {}) => {
    const code = mergeTrainMain(['--run-dir', runDir, '--issues', ISSUES, '--queue', queue, '--poll', '30'], {
      run,
      sleep: (ms: number) => {
        clock += ms;
      },
      now: () => new Date(clock),
      random: () => (++seq).toString(16).padStart(6, '0'),
      pid: 4631,
      home,
      repoDir: repo,
      tmpdir,
      lockRoot: path.join(tmp, 'locks', 'train'),
      mergeLockRoot: path.join(tmp, 'locks', 'merge'),
      log: () => {},
      error: () => {},
      out: () => {},
      runPrecheck: () => {
        events.push('precheck');
        return 1;
      },
      ...(withWait ? { waitHeavy: () => events.push('heavy') } : {}),
    } as Parameters<typeof mergeTrainMain>[1]);
    return { code, events };
  };
  return { go };
}

describe('表 B: merge-train waits before each inner precheck (重なり: 列車の内側の precheck 3 本)', () => {
  it('three trains, three prechecks: a wait before each — positive control', () => {
    const w = trainWorld([4401, 4402, 4403]);
    const events: string[] = [];
    for (const queue of ['4401', '4402', '4403']) expect(w.go(queue, { events }).code).toBe(1);
    expect(events).toEqual(['heavy', 'precheck', 'heavy', 'precheck', 'heavy', 'precheck']);
  });

  it('negative control (I4 / I6): without waitHeavy the precheck runs as before, with the same exit', () => {
    const w = trainWorld([4401]);
    const r = w.go('4401', { withWait: false });
    expect(r.code).toBe(1);
    expect(r.events).toEqual(['precheck']);
  });
});

// ---------------------------------------------------------------------------
// 表 K: the role by the script position, not by a word in the args (#4651)
// ---------------------------------------------------------------------------

/**
 * The v4 line, copied whole into a request body (#4651): every heavy word sits in it, and nothing in it
 * is a heavy run.
 */
const V4_LINE = String.raw`until [ -z "$(ps -axo comm=,args= | awk '($1 ~ /(^|\/)node$/ && /vitest|next build|precheck\.mjs/) || ($1 ~ /(^|\/)bash$/ && /verify-run\.sh/)')" ]; do sleep 15; done;`;

/** One row of `ps -axo pid=,ppid=,comm=,args=` as the fixture writes it. */
const psRow = (pid: number, comm: string, args: string) => `  ${pid}     1 ${comm} ${args}\n`;

type RowK = { name: string; comm: string; args: string; count: boolean; precheckPeers?: boolean };

/** The four tools and the two waits that wait: never a heavy run themselves (K10-I2). */
const WAITER_ROWS: RowK[] = [
  { name: 'wait-verify with vitest in its args', comm: 'node', args: 'node /w/scripts/orchestrate/wait-verify.mjs --issue 1 --gates vitest', count: false },
  { name: 'merge-pr with next build in its args', comm: 'node', args: 'node /w/scripts/orchestrate/merge-pr.mjs --issue 1 --note next build', count: false },
  { name: 'merge-train with precheck.mjs in its args', comm: 'node', args: 'node /w/scripts/orchestrate/merge-train.mjs --queue 1 precheck.mjs', count: false },
  { name: 'heavy-runs wait', comm: 'node', args: 'node /w/scripts/orchestrate/heavy-runs.mjs wait', count: false },
  { name: 'commandmate wait with vitest in its args', comm: 'node', args: 'node /w/bin/commandmate.js wait wt-1 --instance c --timeout 60 --gates vitest', count: false },
];

/** The row of the script position: A / B (the false positives) and C–G (what still counts). */
const TABLE_K: RowK[] = [
  // A: a request body carries every heavy word, and the row is `commandmate send` (not a run).
  { name: 'A: commandmate send with the v4 line in the body', comm: 'node', args: `node /w/bin/commandmate.js send wt-1 ${V4_LINE} --instance c`, count: false },
  // B: the value of an option is not a script.
  { name: 'B: commandmate verify --gates vitest', comm: 'node', args: 'node /w/bin/commandmate.js verify wt-1 --gates vitest', count: false },
  { name: 'B: commandmate verify --gates lint,vitest', comm: 'node', args: 'node /w/bin/commandmate.js verify wt-1 --gates lint,vitest', count: false },
  // C–G: the real runs count as before.
  { name: 'C: the vitest main', comm: 'node', args: 'node /w/node_modules/.bin/vitest run tests/unit/a.test.ts', count: true },
  { name: 'D: the vitest worker (forks.js under /vitest/)', comm: 'node', args: 'node /w/node_modules/vitest/dist/workers/forks.js', count: true },
  { name: "E: another precheck's precheck.mjs (precheckPeers: true)", comm: 'node', args: 'node /w/scripts/orchestrate/precheck.mjs --issue 1', count: true },
  { name: "E: precheck.mjs with precheckPeers: false (a precheck's own wait)", comm: 'node', args: 'node /w/scripts/orchestrate/precheck.mjs --issue 1', count: false, precheckPeers: false },
  { name: 'F: next build', comm: 'node', args: 'node /w/node_modules/.bin/next build', count: true },
  { name: 'G: bash with verify-run.sh as its script', comm: '/bin/bash', args: '/bin/bash /w/scripts/verify-run.sh --cwd /w', count: true },
  // The waiters (K10-I2).
  ...WAITER_ROWS,
  // Node's own options are skipped before the script; `-e` means there is no script.
  { name: 'option: --max-old-space-size=4096 before vitest', comm: 'node', args: 'node --max-old-space-size=4096 /w/node_modules/.bin/vitest run', count: true },
  { name: 'option: --import tsx (a value in the next word) before vitest', comm: 'node', args: 'node --import tsx /w/node_modules/.bin/vitest run', count: true },
  { name: 'option: -r x (a value in the next word) before precheck.mjs', comm: 'node', args: 'node -r x /w/scripts/orchestrate/precheck.mjs --issue 1', count: true },
  { name: 'option: -e with vitest in the code', comm: 'node', args: "node -e require('vitest')", count: false },
  { name: 'option: --disable-warning X (a value in the next word) before vitest', comm: 'node', args: 'node --disable-warning ExperimentalWarning /w/node_modules/.bin/vitest run', count: true },
  { name: 'option: --env-file .env (a value in the next word) before vitest', comm: 'node', args: 'node --env-file .env /w/node_modules/.bin/vitest run', count: true },
  { name: 'option: -pe (a bundle of -p and -e) with vitest next', comm: 'node', args: 'node -pe /w/node_modules/.bin/vitest', count: false },
  { name: 'option: -ep (a bundle of -e and -p) with vitest next', comm: 'node', args: 'node -ep /w/node_modules/.bin/vitest', count: false },
  { name: 'option: -e with vitest next (there is no script after -e)', comm: 'node', args: 'node -e /w/node_modules/.bin/vitest', count: false },
  { name: 'node -- (end of options) then vitest', comm: 'node', args: 'node -- /w/node_modules/.bin/vitest run', count: true },
  { name: 'next dev is not next build', comm: 'node', args: 'node /w/node_modules/.bin/next dev', count: false },
  { name: 'a script of another name with next build in its args', comm: 'node', args: 'node /w/scripts/build.mjs next build', count: false },
  // bash: a `-c` string is not a script file; another script with the word in its args is not one either.
  { name: 'bash -c with verify-run.sh in the string', comm: '/bin/bash', args: '/bin/bash -c /w/scripts/verify-run.sh unit', count: false },
  { name: 'bash with another script and verify-run.sh in its args', comm: '/bin/bash', args: '/bin/bash /w/scripts/other.sh verify-run.sh', count: false },
  // bash's options that take a value in the next word are skipped with it.
  { name: 'bash -o pipefail (a value in the next word) before verify-run.sh', comm: '/bin/bash', args: '/bin/bash -o pipefail /w/scripts/verify-run.sh --cwd /w', count: true },
  { name: 'bash -O extglob (a value in the next word) before verify-run.sh', comm: '/bin/bash', args: '/bin/bash -O extglob /w/scripts/verify-run.sh --cwd /w', count: true },
  { name: 'bash -euo pipefail (a bundle ending in the -o that takes a value) before verify-run.sh', comm: '/bin/bash', args: '/bin/bash -euo pipefail /w/scripts/verify-run.sh --cwd /w', count: true },
  { name: 'bash -- (end of options) then verify-run.sh', comm: '/bin/bash', args: '/bin/bash -- /w/scripts/verify-run.sh --cwd /w', count: true },
  // The npx / npm exec parent is counted too, so the wait starts before the child exists; npm rewrites
  // process.title (`npm exec vitest …`) and comm to npm right after, so the row lasts an instant.
  { name: 'the npx parent that runs vitest', comm: 'node', args: 'node /w/node_modules/npm/bin/npx-cli.js vitest run tests/unit/a.test.ts', count: true },
  { name: 'the npm exec parent that runs vitest', comm: 'node', args: 'node /usr/lib/node_modules/npm/bin/npm-cli.js exec vitest run tests/unit/a.test.ts', count: true },
];

describe('表 K: the role by the script position, not by a word in the args (#4651 K10-I1 / K10-I2)', () => {
  it.each(TABLE_K)('$name — counted=$count', async ({ comm, args, count, precheckPeers }) => {
    const { heavyRuns } = await loadHeavy();
    const runs = heavyRuns(psRow(700, comm, args), { precheckPeers: precheckPeers ?? true });
    expect(runs.map((r) => r.pid)).toEqual(count ? [700] : []);
  });

  it('K10-I2: a waiter row is not counted as a heavy run, whether it is this process or another', async () => {
    const { heavyRuns } = await loadHeavy();
    for (const [i, row] of WAITER_ROWS.entries()) {
      const pid = 900 + i;
      const text = psRow(pid, row.comm, row.args);
      expect({ name: row.name, asSelf: heavyRuns(text, { selfPid: pid }), asOther: heavyRuns(text, { selfPid: 1 }) }).toEqual({
        name: row.name,
        asSelf: [],
        asOther: [],
      });
    }
  });
});
