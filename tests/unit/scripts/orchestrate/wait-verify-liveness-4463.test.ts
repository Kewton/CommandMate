/**
 * #4463: the busy wait of wait-verify judges a run by whether it can still be read as `running`,
 * not by its gate rows moving.
 *
 * A run that is read as `running` is waited for until the cap (a run alive in a queue, on a mutex,
 * or in a long gate leaves its rows untouched for hours: Sprint 7, #4459 reviews 1–3). It is given
 * up on (exit 99, never a verdict) only when the server cannot be reached for
 * VERIFY_UNREACHABLE_SEC, or when the cap derived from verify.yaml runs out. Both are counted in
 * the time this process was awake, so a laptop that slept or a clock that jumped does not spend them.
 *
 * Driven through `runVerify` (the exported entry the busy wait sits behind) with a fake CLI, a fake
 * clock and a fake sleep. The sleep has a ceiling: a wait that never gives up throws instead of
 * hanging the suite. Fixtures live under os.tmpdir() and are removed afterwards.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runVerify,
  VERIFY_BUSY_CAP_SEC,
  VERIFY_UNREACHABLE_SEC,
} from '../../../../scripts/orchestrate/wait-verify.mjs';

const POLL_MS = 30_000;
const SLEEP_CEILING = 30_000;
const BUSY_LOG = "Error: A verification run is already in progress for 'wt-1' (run 7)\n";
const PASS_LOG = 'Verifying: wt-1 (run 8)\nGATE scope PASS (exit=0, 0.1s)\nRESULT passed\n';

type View = { status: string; gates?: { gateId: string; status: string }[] };
/** One `verify show 7` answer: a view, or `null` for "the server did not answer". */
type Read = View | null;

let tmp: string;
let worktree: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-wait-verify-4463-'));
  // A worktree with no verify.yaml of its own: this repository's is read, as for '/wt' elsewhere.
  worktree = path.join(tmp, 'wt');
  fs.mkdirSync(worktree);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * @param reads the answers of `verify show 7`, in order; the last repeats
 * @param jumps clock jumps (ms) applied just before the poll of that index (0-based)
 */
function busyWait(reads: Read[], { jumps = {} as Record<number, number> } = {}) {
  let clock = Date.UTC(2026, 10, 19, 1, 0);
  let shows = 0;
  let spawns = 0;
  const sleeps: number[] = [];
  const errors: string[] = [];
  const ctx = {
    spawnToLog: (_cli: string, _args: string[], { logFile }: { logFile: string }) => {
      spawns += 1;
      fs.writeFileSync(logFile, spawns === 1 ? BUSY_LOG : PASS_LOG);
      return spawns === 1 ? 99 : 0;
    },
    run: (command: string, args: string[]) => {
      if (command === 'git') return { status: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
      if (args[0] === 'verify' && args[1] === 'show' && args[2] === '7') {
        clock += jumps[shows] ?? 0;
        const read = reads[Math.min(shows, reads.length - 1)];
        shows += 1;
        if (read === null) return { status: 1, stdout: '', stderr: 'fetch failed: ECONNREFUSED' };
        return { status: 0, stdout: JSON.stringify({ run: { id: 7, worktreeId: 'wt-1', startedAt: new Date(0).toISOString(), ...read } }), stderr: '' };
      }
      if (args[0] === 'verify' && args[1] === 'show') return { status: 1, stdout: '', stderr: 'not found' };
      throw new Error(`unexpected ${command} ${args.join(' ')}`);
    },
    sleep: (ms: number) => {
      sleeps.push(ms);
      if (sleeps.length > SLEEP_CEILING) throw new Error('the busy wait did not end in a finite time');
      clock += ms;
    },
    now: () => new Date(clock),
    error: (line: string) => errors.push(line),
    o: { cli: 'commandmatedev', wt: 'wt-1', worktree, mutexRetries: 0 },
    cwd: tmp,
    supersededBy: () => null,
  };
  const result = runVerify(ctx, ['verify', 'wt-1'], path.join(tmp, 'verify.log'));
  const waitedSec = sleeps.filter((ms) => ms === POLL_MS).length * (POLL_MS / 1000);
  return { result, spawns, waitedSec, errors };
}

const running = (gates: View['gates'] = []): View => ({ status: 'running', gates });
const repeat = <T,>(n: number, item: T): T[] => Array.from({ length: n }, () => item);
/** Polls that cover `sec` seconds of waiting. */
const polls = (sec: number) => Math.ceil(sec / (POLL_MS / 1000));
/** Longer than the old limit (13200 s, the worst single gate of this repository): #4463 review P2-3. */
const LONG_SEC = 20_000;

function expectWaitedOut(r: ReturnType<typeof busyWait>) {
  expect(r.result.exitCode).toBe(0);
  expect(r.spawns).toBe(2);
  expect(r.result.notes).toContain('waited-for=run 7');
  expect(r.result.notes.join(' ')).not.toContain('(still running)');
}

function expectGivenUp(r: ReturnType<typeof busyWait>, reason: 'unreachable' | 'cap') {
  // I3: giving up is never a verdict — the 409's exit 99 stands, and no second verification ran.
  expect(r.result.exitCode).toBe(99);
  expect(r.spawns).toBe(1);
  // I4: the run-log note keeps its shape; the reason goes to stderr only.
  expect(r.result.notes).toEqual(['waited-for=run 7(still running)']);
  expect(r.errors.some((line) => new RegExp(`busy-gave-up=${reason}@\\d+`).test(line))).toBe(true);
}

describe('#4463 live runs are not given up on (I1)', () => {
  it('L1 queued behind other runs: no gate row for longer than the old limit', () => {
    expectWaitedOut(busyWait([...repeat(polls(LONG_SEC), running([])), { status: 'passed' }]));
  });

  it('L2 waiting on the cpu.heavy mutex: one open row for longer than the old limit', () => {
    const open = running([{ gateId: 'lint', status: 'passed' }, { gateId: 'unit', status: 'running' }]);
    expectWaitedOut(busyWait([...repeat(polls(LONG_SEC), open), { status: 'failed' }]));
  });

  it('L3 a long gate: its row stays open, nothing else moves', () => {
    const open = running([{ gateId: 'build', status: 'passed' }, { gateId: 'integration', status: 'running' }]);
    expectWaitedOut(busyWait([...repeat(polls(LONG_SEC), open), { status: 'passed' }]));
  });

  it('L4 the clock jumps (sleep, NTP) while the server is briefly unreachable: not given up on', () => {
    // A 3600 s jump between two polls is more than the unreachable window in wall-clock time.
    const reads: Read[] = [null, null, null, running(), { status: 'passed' }];
    expectWaitedOut(busyWait(reads, { jumps: { 2: 3_600_000 } }));
  });

  it('L4b the clock jumps while the run is read as running, many times: the cap is not spent by it', () => {
    const jumps = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [i + 1, 10 * 3_600_000]));
    expectWaitedOut(busyWait([...repeat(40, running()), { status: 'passed' }], { jumps }));
  });

  it('L5 the server is rebuilt (unreachable for 1200 s) and closes the run as error: verify again', () => {
    expectWaitedOut(busyWait([...repeat(polls(1200), null), { status: 'error' }]));
  });
});

describe('#4463 dead runs are given up on in a finite time (I2, I3)', () => {
  it('D1 the server is gone: exit 99 once it has been unreachable for the window', () => {
    const r = busyWait([null]);
    expectGivenUp(r, 'unreachable');
    expect(r.waitedSec).toBeGreaterThanOrEqual(VERIFY_UNREACHABLE_SEC - 30);
    expect(r.waitedSec).toBeLessThanOrEqual(VERIFY_UNREACHABLE_SEC + 30);
  });

  it('D2 a run that stays running for ever (F3/F4): exit 99 at the cap', () => {
    const r = busyWait([running([{ gateId: 'unit', status: 'running' }])]);
    expectGivenUp(r, 'cap');
    const cap = VERIFY_BUSY_CAP_SEC;
    expect(r.waitedSec).toBeGreaterThanOrEqual(cap - 30);
    expect(r.waitedSec).toBeLessThanOrEqual(cap + 60);
  });

  it('L6 reads that alternate between running and unreachable: the cap ends it, not the unreachable window', () => {
    const r = busyWait(Array.from({ length: SLEEP_CEILING }, (_, i) => (i % 2 === 0 ? running() : null)));
    expectGivenUp(r, 'cap');
  });
});

describe('#4463 review 2 / PM: the cap is one named constant, 7 days, whatever verify.yaml says', () => {
  const writeYaml = (text: string) => {
    fs.mkdirSync(path.join(worktree, '.commandmate'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.commandmate', 'verify.yaml'), text);
  };

  it('the decided numbers: cap 604800 s (7 days), unreachable 1800 s', () => {
    expect(VERIFY_BUSY_CAP_SEC).toBe(604_800);
    expect(VERIFY_UNREACHABLE_SEC).toBe(1800);
    const r = busyWait([null]);
    expect(r.waitedSec).toBeGreaterThanOrEqual(1770);
    expect(r.waitedSec).toBeLessThanOrEqual(1830);
  });

  it('L7 a run longer than any verify.yaml formula gave (contract gates: 13 × 7000 s and more) is waited for', () => {
    // review 2 P1-1: contract-declared gates are not in verify.yaml; 120000 s is past the old 86400 floor.
    expectWaitedOut(busyWait([...repeat(polls(120_000), running([{ gateId: 'contract-12', status: 'running' }])), { status: 'passed' }]));
  });

  it('a verify.yaml the server would refuse (a 400-digit timeoutSec) does not make the cap infinite', () => {
    // review 2 P1-2: the wait does not read verify.yaml at all any more.
    writeYaml(`version: 1\ngates:\n  - id: unit\n    command: "true"\n    timeoutSec: "${'9'.repeat(400)}"\n    mutex: cpu.heavy\n`);
    const r = busyWait([running([{ gateId: 'unit', status: 'running' }])]);
    expectGivenUp(r, 'cap');
    expect(r.waitedSec).toBeGreaterThanOrEqual(604_800 - 30);
    expect(r.waitedSec).toBeLessThanOrEqual(604_800 + 60);
  });

  it('a small verify.yaml does not lower the cap either', () => {
    writeYaml('version: 1\ngates:\n  - id: lint\n    command: "true"\n    timeoutSec: 60\n');
    const r = busyWait([...repeat(polls(200_000), running()), { status: 'passed' }]);
    expectWaitedOut(r);
  });
});
