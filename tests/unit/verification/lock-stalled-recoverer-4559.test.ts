/**
 * Issue #4559: a head that judged the holder dead, then stopped longer than its ticket's deadline +
 * 60 s (inside P0's 10 minutes), must not move the next holder's live lock when it resumes.
 *
 * The order is fixed with the test seams, never with real sleeps: the recoverer N stops right after its
 * judgement (the sync JS / TS: inside the last probe of the judgement, `pidAlive`; bash: the pause
 * `recover-judged`; the sync D6: `recover-only-judged`). Meanwhile the next waiter U takes the lock for
 * real (the sync JS with a clock 65 s ahead, so N's ticket is past deadline + 60 s and retired), then N
 * resumes. Before the fix N moved U's live lock aside — and an older runner U2 (a bare mkdir, the form
 * #4277's tests keep in view) took the free path in that window: two holders. After it, N reads the
 * record again before the move and leaves U's lock where it is.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { acquireMachineLock, machineLockPath } from '@/lib/verification/machine-lock';
import * as lockSync from '../../../scripts/orchestrate/machine-lock-sync.mjs';
import {
  bareTake,
  cleanRoots,
  deadPid,
  freshRoot,
  goneDirs,
  HOST,
  ownerToken,
  startPausedBash,
  takeAsSuccessor,
  until,
  writeDeadHolder,
} from './lock-holder-identity-4558-harness';
import { loadLegacy } from './lock-generation-4559-harness';

afterEach(() => cleanRoots());

/**
 * #4559 PR-2 (lead-tests §1 #1, reason (a)): with the generation chain the new version's successor cannot
 * take while the stopped recoverer N holds its generation — that order no longer happens between new
 * versions (machine-lock-generation-4559.test.ts T4 keeps it closed). The rows below keep their meaning
 * (a successor took while N stopped; N must not move it) with U the develop copy before #4559
 * (tests/fixtures/machine-lock-legacy/), which sees only the <lock>: the window that stays is design §6.5's
 * `mixed` row P-4.
 */
let legacy: typeof lockSync;
beforeAll(async () => {
  legacy = await loadLegacy(freshRoot('4559-legacy'));
});
const takeAsLegacySuccessor = (lockPath: string): Successor =>
  legacy.acquireMachineLockSync('x', { lockPath, timeoutMs: 2000, pollMs: 10, hooks: { now: () => Date.now() + 65_000, startOf: () => 0 } });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

type Successor = ReturnType<typeof takeAsSuccessor>;

/**
 * The seams of the JS recoverer: the probe that ends its judgement of D runs U's acquisition once
 * (`stall`), and the window right after its move lets U2's bare mkdir in.
 */
function recovererHooks(lockPath: string, stall: boolean, successor: (lockPath: string) => Successor = takeAsSuccessor) {
  const dead = deadPid();
  const seen = { u: null as Successor | null, u2: false, stages: [] as string[] };
  let pending = stall;
  return {
    seen,
    pidAlive: (pid: number): boolean => {
      if (pid === dead) {
        if (pending) {
          pending = false;
          seen.u = successor(lockPath);
        }
        return false;
      }
      return alive(pid);
    },
    onRecover: (stage: string): void => {
      seen.stages.push(stage);
      if (stage === 'moved' && seen.u?.acquired) seen.u2 = bareTake(lockPath, 'U2');
    },
  };
}

/** One holder, U's, at the lock path, nothing moved aside, and N never moved U's lock. */
function expectOneHolder(lockPath: string, seen: { u: Successor | null; u2: boolean; stages: string[] }): void {
  expect(seen.u?.acquired).toBe(true);
  expect({ owner: ownerToken(lockPath), u2: seen.u2, gone: goneDirs(lockPath), moved: seen.stages.includes('moved') }).toEqual({
    owner: seen.u?.token,
    u2: false,
    gone: [],
    moved: false,
  });
}

describe('#4559 sync JS: a recoverer stopped after its judgement', () => {
  it('positive: U took the lock while N stopped — N leaves it (one holder)', () => {
    const root = freshRoot('4559-sync');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const h = recovererHooks(lockPath, true, takeAsLegacySuccessor);
    const n = lockSync.acquireMachineLockSync('x', { lockPath, timeoutMs: 300, pollMs: 20, hooks: { pidAlive: h.pidAlive, onRecover: h.onRecover } });
    expect(n.acquired).toBe(false);
    expectOneHolder(lockPath, h.seen);
    expect(h.seen.u?.release()).toBe('released');
  });

  it('negative control: no stop — N recovers the dead holder and takes the lock, as before', () => {
    const root = freshRoot('4559-sync-ok');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const h = recovererHooks(lockPath, false);
    const warnings: string[] = [];
    const n = lockSync.acquireMachineLockSync('x', { lockPath, timeoutMs: 300, pollMs: 20, warn: (l: string) => warnings.push(l), hooks: { pidAlive: h.pidAlive, onRecover: h.onRecover } });
    expect([n.acquired, ownerToken(lockPath) === n.token, h.seen.stages]).toEqual([true, true, ['before-move', 'moved']]);
    expect(warnings.join('\n')).toContain('machine-lock-broken-stale');
    expect(n.release()).toBe('released');
  });
});

describe('#4559 sync JS D6 (recoverIfDead, the copy of bash lock_recover_only)', () => {
  it('positive: U took the lock while the guard stopped after recover-only-judged — kept, one holder', () => {
    const root = freshRoot('4559-d6');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const seen = { u: null as Successor | null, u2: false, stages: [] as string[] };
    const r = lockSync.recoverIfDead(lockPath, {
      timeoutMs: 0,
      hooks: {
        onRecover: (stage: string) => {
          seen.stages.push(stage);
          if (stage === 'recover-only-judged') seen.u = takeAsSuccessor(lockPath);
          if (stage === 'moved' && seen.u?.acquired) seen.u2 = bareTake(lockPath, 'U2');
        },
      },
    });
    expect(r.result).toBe('kept');
    expectOneHolder(lockPath, seen);
    expect(seen.u?.release()).toBe('released');
  });

  it('negative control: no stop — the dead holder\'s lock is removed', () => {
    const root = freshRoot('4559-d6-ok');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    expect(lockSync.recoverIfDead(lockPath, { timeoutMs: 0 }).result).toBe('removed');
    expect(ownerToken(lockPath)).toBeNull();
  });
});

describe('#4559 bash D6 (verify-run.sh lock_recover_only → lock_recover)', () => {
  const guard = 'lock_recover_only "$LK" "${LK%.lock}.queue" 0; echo "$LRO_RESULT"';

  it('positive: U took the lock while the guard stopped after recover-only-judged — kept, one holder', async () => {
    const root = freshRoot('4559-bash-d6');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const n = startPausedBash(root, guard, ['recover-only-judged', 'recover-moved'], { LK: lockPath });
    const seen = { u: null as Successor | null, u2: false, stages: [] as string[] };
    expect(await until(() => n.reached('recover-only-judged'))).toBe(true);
    seen.u = takeAsSuccessor(lockPath);
    n.go('recover-only-judged');
    let exited = false;
    void n.exited.then(() => (exited = true));
    expect(await until(() => exited || n.reached('recover-moved'))).toBe(true);
    if (n.reached('recover-moved')) {
      seen.stages.push('moved');
      seen.u2 = bareTake(lockPath, 'U2');
      n.go('recover-moved');
    }
    await n.exited;
    expect(n.out().trim()).toBe('kept');
    expectOneHolder(lockPath, seen);
    expect(seen.u?.release()).toBe('released');
  }, 30000);

  // F64-guard-restore-failed's original injection point (machine-lock-owner-atomic-4288.test.ts moved its
  // successor to pause:recover-rechecked): after the judgement, before the re-read, the owner rewritten in
  // place to a live T2 and the restore mkdir failing. After #4559 the record is not moved at all.
  it('F64\'s original point: a live T2 written after recover-only-judged (restore-mkdir=EACCES) — kept in place, nothing moved aside', async () => {
    const root = freshRoot('4559-bash-d6-f64');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const n = startPausedBash(root, guard, ['recover-only-judged'], { LK: lockPath, CM_VERIFY_TEST_OBS_FAULT: 'restore-mkdir=EACCES' });
    expect(await until(() => n.reached('recover-only-judged'))).toBe(true);
    const tmp = path.join(lockPath, '.t2');
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, host: HOST, token: 'T2', acquiredAt: Date.now(), v: 1 }));
    fs.renameSync(tmp, path.join(lockPath, 'owner'));
    n.go('recover-only-judged');
    await n.exited;
    expect({ result: n.out().trim(), owner: ownerToken(lockPath), gone: goneDirs(lockPath) }).toEqual({ result: 'kept', owner: 'T2', gone: [] });
  }, 30000);

  it('negative control: no stop — the dead holder\'s lock is removed, as before', async () => {
    const root = freshRoot('4559-bash-d6-ok');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const n = startPausedBash(root, guard, [], { LK: lockPath });
    await n.exited;
    expect([n.out().trim(), ownerToken(lockPath)]).toEqual(['removed', null]);
  }, 30000);
});

describe('#4559 TS: a recoverer stopped after its judgement', () => {
  it('positive: U took the lock while N stopped — N leaves it (one holder)', async () => {
    const root = freshRoot('4559-ts');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const h = recovererHooks(lockPath, true, takeAsLegacySuccessor);
    const n = await acquireMachineLock('x', { root, timeoutMs: 300, pollIntervalMs: 20, __testHooks: { pidAlive: h.pidAlive, onRecover: h.onRecover } });
    expect(n.acquired).toBe(false);
    expectOneHolder(lockPath, h.seen);
    expect(h.seen.u?.release()).toBe('released');
  });

  it('negative control: no stop — N recovers the dead holder and takes the lock, as before', async () => {
    const root = freshRoot('4559-ts-ok');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const h = recovererHooks(lockPath, false);
    const n = await acquireMachineLock('x', { root, timeoutMs: 300, pollIntervalMs: 20, __testHooks: { pidAlive: h.pidAlive, onRecover: h.onRecover } });
    expect([n.acquired, h.seen.stages]).toEqual([true, ['before-move', 'moved']]);
    if (n.acquired) n.handle.release();
  });
});

describe('#4559 bash (verify-run.sh lock_acquire_path → lock_recover)', () => {
  it('positive: U took the lock while bash stopped at recover-judged — bash leaves it (one holder)', async () => {
    const root = freshRoot('4559-bash');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const n = startPausedBash(root, 'lock_acquire x 1; echo "rc=$?"', ['recover-judged', 'recover-moved']);
    const seen = { u: null as Successor | null, u2: false, stages: [] as string[] };
    expect(await until(() => n.reached('recover-judged'))).toBe(true);
    seen.u = takeAsSuccessor(lockPath);
    n.go('recover-judged');
    let exited = false;
    void n.exited.then(() => (exited = true));
    expect(await until(() => exited || n.reached('recover-moved'))).toBe(true);
    if (n.reached('recover-moved')) {
      seen.stages.push('moved');
      seen.u2 = bareTake(lockPath, 'U2');
      n.go('recover-moved');
    }
    await n.exited;
    expect(n.out().trim()).toBe('rc=1');
    expectOneHolder(lockPath, seen);
    expect(seen.u?.release()).toBe('released');
  }, 30000);

  it('negative control: no stop — bash recovers the dead holder and takes the lock, as before', async () => {
    const root = freshRoot('4559-bash-ok');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const n = startPausedBash(root, 'lock_acquire x 1; echo "rc=$?"; [ "$(lock_owner_field "$LOCK_PATH" token)" = "$LOCK_TOKEN" ] && echo mine', []);
    await n.exited;
    expect(n.out().trim().split('\n')).toEqual(['rc=0', 'mine']);
    expect(n.err()).toContain('broke a stale lock');
  }, 30000);
});
