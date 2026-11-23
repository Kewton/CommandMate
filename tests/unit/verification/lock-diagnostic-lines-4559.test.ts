/**
 * #4559 r6 (lead-to-worker-4558-r6, PM decision 11-23): the diagnostic lines of an acquisition, as a table.
 *
 * Invariant: in each acquisition of one process, the re-read's unknown (event R) and the end of the wait
 * (event T: not taken within the budget) are, for the same observation (the same point, path and errno),
 * one line for R and T together; for different observations one line each; none when they do not occur.
 *
 * The matrix is the acquisition (the first in the process / the second in the same process / one after
 * D6) × the event (none / R / T / R and T, same observation / R and T, different observations), for bash
 * (verify-run.sh, fixed here) and the sync JS (the control: its warn-once is new per acquisition, not
 * changed). Every cell is typed and listed, and a cell left out fails below. The faults are put on the
 * owner read by its place: the re-read (lock_recover_judged / the read after the judgement) or the
 * judgement's read; all under os.tmpdir().
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { machineLockPath } from '@/lib/verification/machine-lock';
import * as lockSync from '../../../scripts/orchestrate/machine-lock-sync.mjs';
import { bashSection, cleanRoots, deadPid, freshRoot, VERIFY_RUN, writeDeadHolder } from './lock-holder-identity-4558-harness';

afterEach(() => cleanRoots());

type Acquisition = 'first' | 'second-in-process' | 'after-d6';
type Event = 'none' | 'R' | 'T' | 'RT-same' | 'RT-different';
interface Lines {
  /** Lines of R's observation (lock-owner, EIO). */
  eio: 0 | 1;
  /** Lines of T's other observation (lock-owner, EACCES: only when T is a different observation). */
  eacces: 0 | 1;
}

const ACQUISITIONS: readonly Acquisition[] = ['first', 'second-in-process', 'after-d6'];
const EVENTS: readonly Event[] = ['none', 'R', 'T', 'RT-same', 'RT-different'];

/** What each event is made of: the faults and the budget. */
const SETUP: Record<Event, { reread: 'none' | 'once' | 'always'; judge: 'none' | 'always-eio' | 'after-first-eacces'; budgetSec: number }> = {
  none: { reread: 'none', judge: 'none', budgetSec: 0 },
  R: { reread: 'once', judge: 'none', budgetSec: 2 },
  T: { reread: 'none', judge: 'always-eio', budgetSec: 0 },
  'RT-same': { reread: 'always', judge: 'none', budgetSec: 0 },
  'RT-different': { reread: 'once', judge: 'after-first-eacces', budgetSec: 3 },
};

/** The invariant per cell — the same for every acquisition. */
const MATRIX: Record<Acquisition, Record<Event, Lines>> = {
  first: { none: { eio: 0, eacces: 0 }, R: { eio: 1, eacces: 0 }, T: { eio: 1, eacces: 0 }, 'RT-same': { eio: 1, eacces: 0 }, 'RT-different': { eio: 1, eacces: 1 } },
  'second-in-process': { none: { eio: 0, eacces: 0 }, R: { eio: 1, eacces: 0 }, T: { eio: 1, eacces: 0 }, 'RT-same': { eio: 1, eacces: 0 }, 'RT-different': { eio: 1, eacces: 1 } },
  'after-d6': { none: { eio: 0, eacces: 0 }, R: { eio: 1, eacces: 0 }, T: { eio: 1, eacces: 0 }, 'RT-same': { eio: 1, eacces: 0 }, 'RT-different': { eio: 1, eacces: 1 } },
};
/** Whether the cell's acquisition is taken (R alone recovers on the next poll; none at once). */
const TAKEN: Record<Event, boolean> = { none: true, R: true, T: false, 'RT-same': false, 'RT-different': false };

const CELLS = ACQUISITIONS.flatMap((acquisition) => EVENTS.map((event) => ({ acquisition, event, lines: MATRIX[acquisition][event] })));

it('the table has every cell: 3 acquisitions × 5 events, each 0 or 1 line per observation', () => {
  expect(CELLS).toHaveLength(15);
  for (const c of CELLS) {
    expect(c.lines, `${c.acquisition} × ${c.event}`).toBeDefined();
    expect([0, 1]).toContain(c.lines.eio);
    expect([0, 1]).toContain(c.lines.eacces);
  }
});

const count = (lines: string[], errno: string) => lines.filter((l) => l.includes('machine-lock-unknown point=lock-owner') && l.includes(`errno=${errno}`)).length;

// --- bash --------------------------------------------------------------------------------------------

/**
 * lock_obs_owner wrapped after the section is loaded: a lock-owner read inside lock_recover_judged is the
 * re-read (REREAD mode), any other the judgement's (JUDGE mode). The counters live in this shell.
 */
const BASH_FAULTS = `
eval "orig_$(declare -f lock_obs_owner)"
eval "orig_$(declare -f lock_recover_judged)"
IN_REREAD=0; R_N=0; J_N=0; REREAD=none; JUDGE=none
lock_recover_judged() { IN_REREAD=1; orig_lock_recover_judged "$@"; IN_REREAD=0; }
lock_obs_owner() {
  ow_code=""
  if [ "$1" = lock-owner ]; then
    if [ "$IN_REREAD" = 1 ]; then
      R_N=$(( R_N + 1 ))
      case "$REREAD" in once) [ "$R_N" = 1 ] && ow_code=EIO;; always) ow_code=EIO;; esac
    else
      J_N=$(( J_N + 1 ))
      case "$JUDGE" in always-eio) ow_code=EIO;; after-first-eacces) [ "$J_N" -gt 1 ] && ow_code=EACCES;; esac
    fi
  fi
  if [ -n "$ow_code" ]; then
    ow_saved=\${CM_VERIFY_TEST_OBS_FAULT:-}
    CM_VERIFY_TEST_OBS_FAULT="lock-owner=$ow_code"
    orig_lock_obs_owner "$@"
    CM_VERIFY_TEST_OBS_FAULT=$ow_saved
    return 0
  fi
  orig_lock_obs_owner "$@"
}
dead_holder() { mkdir -p "$LK"; printf '{"pid":%s,"host":"%s","token":"D","acquiredAt":0,"v":1}\\n' "$DEAD" "$LOCK_HOST" > "$LK/owner"; }
`;

const BASH_PRIME: Record<Acquisition, string> = {
  first: ':',
  // The earlier acquisition names the same observation (its re-read fails once) and takes the lock.
  'second-in-process': 'REREAD=once; lock_acquire x 2; lock_release "$LOCK_PATH" "$LOCK_TOKEN"',
  // D6 names the same observation (its re-read fails once) and keeps the lock.
  'after-d6': 'REREAD=once; lock_recover_only "$LK" "${LK%.lock}.queue" 0',
};

function bashCell(acquisition: Acquisition, event: Event) {
  const root = freshRoot(`r6-bash-${acquisition}-${event}`);
  const lockPath = machineLockPath('x', root);
  const s = SETUP[event];
  const body = `${BASH_FAULTS}
dead_holder
${BASH_PRIME[acquisition]}
R_N=0; J_N=0; REREAD=${s.reread}; JUDGE=${s.judge}
echo "--- cell" >&2
dead_holder
lock_acquire x ${s.budgetSec}; echo "rc=$?"`;
  const r = spawnSync('bash', ['-c', bashSection(body), 'bash', VERIFY_RUN], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, CM_VERIFY_LOCK_ROOT: root, LK: lockPath, DEAD: String(deadPid()) },
  });
  const cell = (r.stderr ?? '').split('--- cell')[1] ?? '';
  return { rc: (r.stdout ?? '').trim().split('\n').pop(), lines: cell.split('\n') };
}

describe.each(CELLS)('bash: $acquisition × $event', ({ acquisition, event, lines }) => {
  it(`R / T lines: EIO ${lines.eio}, EACCES ${lines.eacces}`, () => {
    const got = bashCell(acquisition, event);
    expect({ rc: got.rc, eio: count(got.lines, 'EIO'), eacces: count(got.lines, 'EACCES') }).toEqual({ rc: TAKEN[event] ? 'rc=0' : 'rc=1', ...lines });
  }, 30000);
});

// --- sync JS (the control: not changed) ----------------------------------------------------------------

function syncFaults(event: Event | 'prime') {
  const s = event === 'prime' ? { reread: 'once' as const, judge: 'none' as const } : SETUP[event];
  const dead = deadPid();
  let nextIsReread = false;
  let r = 0;
  let j = 0;
  return {
    pidAlive: (pid: number): boolean => {
      if (pid === dead) {
        nextIsReread = true;
        return false;
      }
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    fault: (point: string): string | null => {
      if (point !== 'lock-owner') return null;
      if (nextIsReread) {
        nextIsReread = false;
        r += 1;
        return s.reread === 'always' || (s.reread === 'once' && r === 1) ? 'EIO' : null;
      }
      j += 1;
      if (s.judge === 'always-eio') return 'EIO';
      if (s.judge === 'after-first-eacces' && j > 1) return 'EACCES';
      return null;
    },
  };
}

function syncCell(acquisition: Acquisition, event: Event) {
  const root = freshRoot(`r6-sync-${acquisition}-${event}`);
  const lockPath = machineLockPath('x', root);
  writeDeadHolder(lockPath);
  if (acquisition === 'second-in-process') {
    const p = syncFaults('prime');
    const first = lockSync.acquireMachineLockSync('x', { lockPath, timeoutMs: 1500, pollMs: 20, hooks: p });
    if (first.acquired) first.release();
  }
  if (acquisition === 'after-d6') {
    const p = syncFaults('prime');
    lockSync.recoverIfDead(lockPath, { timeoutMs: 0, hooks: { fault: p.fault, onRecover: (stage: string) => (stage === 'recover-only-judged' ? p.pidAlive(deadPid()) : undefined) } });
  }
  writeDeadHolder(lockPath);
  const f = syncFaults(event);
  const warnings: string[] = [];
  const n = lockSync.acquireMachineLockSync('x', { lockPath, timeoutMs: SETUP[event].budgetSec * 1000, pollMs: 20, warn: (l: string) => warnings.push(l), hooks: f });
  if (n.acquired) n.release();
  return { acquired: n.acquired, lines: warnings };
}

describe.each(CELLS)('sync JS (control): $acquisition × $event', ({ acquisition, event, lines }) => {
  it(`R / T lines: EIO ${lines.eio}, EACCES ${lines.eacces}`, () => {
    const got = syncCell(acquisition, event);
    expect({ acquired: got.acquired, eio: count(got.lines, 'EIO'), eacces: count(got.lines, 'EACCES') }).toEqual({ acquired: TAKEN[event], ...lines });
  }, 30000);
});
