/**
 * #4559 (review r3): the re-read that #4559 added before the move must not cost the recovery when it
 * fails once, and a lock gone by the re-read keeps develop's `absent`.
 *
 * Item 1: one EIO on the re-read only (the owner read right after the judgement, armed by the judgement's
 * seam). Before the fix the holder was marked broken before the re-read, so the acquisition never
 * recovered it for the rest of its wait, and nothing was named; D6 / recoverIfDead folded the unknown
 * into a plain `kept`. After it the next poll judges again and recovers, and the unknown is named once.
 * Item 2: the lock removed between the judgement and the re-read — D6 answers `absent`, recoverIfDead
 * `'absent'`, as on develop.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { acquireMachineLock, machineLockPath } from '@/lib/verification/machine-lock';
import * as lockSync from '../../../scripts/orchestrate/machine-lock-sync.mjs';
import { cleanRoots, deadPid, freshRoot, ownerToken, startPausedBash, until, writeDeadHolder } from './lock-holder-identity-4558-harness';

vi.mock('@/lib/logger', () => {
  const g = globalThis as { __reread4559Logs?: string[] };
  const LOGS = (g.__reread4559Logs ??= []);
  const push = (event: string, data?: unknown) => LOGS.push(`${event} ${JSON.stringify(data ?? {})}`);
  const logger = { warn: push, info: () => {}, error: push, debug: () => {}, withContext: () => logger };
  return { createLogger: () => logger };
});
const LOGS = ((globalThis as { __reread4559Logs?: string[] }).__reread4559Logs ??= []);

afterEach(() => {
  LOGS.length = 0;
  cleanRoots();
});

/** The JS seams: the judgement of D (pidAlive) arms one EIO on the next `lock-owner` read — the re-read. */
function oneRereadFault(armOn: 'pid' | 'every' | 'none') {
  const dead = deadPid();
  const s = { armed: false, fired: 0 };
  return {
    s,
    arm: () => (s.armed = true),
    pidAlive: (pid: number): boolean => {
      if (pid === dead) {
        if ((armOn === 'pid' && s.fired === 0) || armOn === 'every') s.armed = true;
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
      if (point !== 'lock-owner' || !s.armed) return null;
      s.armed = false;
      s.fired += 1;
      return 'EIO';
    },
  };
}

const named = (lines: string[]) => lines.filter((l) => /machine-lock-unknown.*point=lock-owner|machine-lock-unknown \{"point":"lock-owner"/.test(l));

describe('#4559 r3 item 1: one EIO on the re-read — recovered on the next poll, named once', () => {
  it('sync JS acquisition', () => {
    const root = freshRoot('r3-sync');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const f = oneRereadFault('pid');
    const warnings: string[] = [];
    const n = lockSync.acquireMachineLockSync('x', { lockPath, timeoutMs: 1500, pollMs: 20, warn: (l: string) => warnings.push(l), hooks: { pidAlive: f.pidAlive, fault: f.fault } });
    expect({ acquired: n.acquired, fired: f.s.fired, named: named(warnings).length }).toEqual({ acquired: true, fired: 1, named: 1 });
    expect(n.release()).toBe('released');
  });

  it('sync JS acquisition, negative control: no EIO — recovered in the same poll, nothing named', () => {
    const root = freshRoot('r3-sync-ok');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const f = oneRereadFault('none');
    const warnings: string[] = [];
    const n = lockSync.acquireMachineLockSync('x', { lockPath, timeoutMs: 0, pollMs: 20, warn: (l: string) => warnings.push(l), hooks: { pidAlive: f.pidAlive, fault: f.fault } });
    expect({ acquired: n.acquired, named: named(warnings).length }).toEqual({ acquired: true, named: 0 });
    expect(n.release()).toBe('released');
  });

  it('TS acquisition', async () => {
    const root = freshRoot('r3-ts');
    writeDeadHolder(machineLockPath('x', root));
    const f = oneRereadFault('pid');
    const n = await acquireMachineLock('x', { root, timeoutMs: 1500, pollIntervalMs: 20, __testHooks: { pidAlive: f.pidAlive, fault: f.fault } });
    expect({ acquired: n.acquired, fired: f.s.fired, named: named(LOGS).length }).toEqual({ acquired: true, fired: 1, named: 1 });
    if (n.acquired) n.handle.release();
  });

  it('TS acquisition, negative control: no EIO — recovered in the same poll, nothing named', async () => {
    const root = freshRoot('r3-ts-ok');
    writeDeadHolder(machineLockPath('x', root));
    const f = oneRereadFault('none');
    const n = await acquireMachineLock('x', { root, timeoutMs: 0, pollIntervalMs: 20, __testHooks: { pidAlive: f.pidAlive, fault: f.fault } });
    expect({ acquired: n.acquired, named: named(LOGS).length }).toEqual({ acquired: true, named: 0 });
    if (n.acquired) n.handle.release();
  });

  it('sync JS recoverIfDead (D6\'s copy): the unknown result, named; the next call removes it', () => {
    const root = freshRoot('r3-d6-sync');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const f = oneRereadFault('none');
    const r = lockSync.recoverIfDead(lockPath, { timeoutMs: 0, hooks: { fault: f.fault, onRecover: (stage: string) => (stage === 'recover-only-judged' ? f.arm() : undefined) } });
    expect({ result: r.result, point: r.unknown?.point, code: r.unknown?.code, owner: ownerToken(lockPath) }).toEqual({ result: 'kept', point: 'lock-owner', code: 'EIO', owner: 'D' });
    expect(lockSync.recoverIfDead(lockPath, { timeoutMs: 0 }).result).toBe('removed');
  });
});

/** bash: lock_obs_owner wrapped so that, once $ARM exists, the next lock-owner read fails with EIO once. */
const ONE_EIO = `
eval "orig_$(declare -f lock_obs_owner)"
lock_obs_owner() {
  if [ "$1" = lock-owner ] && [ -e "$ARM" ] && [ ! -e "$ARM.fired" ]; then
    : > "$ARM.fired"
    oo_saved=\${CM_VERIFY_TEST_OBS_FAULT:-}
    CM_VERIFY_TEST_OBS_FAULT="lock-owner=EIO"
    orig_lock_obs_owner "$@"
    CM_VERIFY_TEST_OBS_FAULT=$oo_saved
    return 0
  fi
  orig_lock_obs_owner "$@"
}
`;

describe('#4559 r3 item 1 (bash): one EIO on the re-read', () => {
  it('lock_acquire_path: recovered on the next poll, named once', async () => {
    const root = freshRoot('r3-bash');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const arm = `${root}/arm`;
    const n = startPausedBash(root, `${ONE_EIO}\nlock_acquire x 2; echo "rc=$?"`, ['recover-judged'], { ARM: arm });
    expect(await until(() => n.reached('recover-judged'))).toBe(true);
    fs.writeFileSync(arm, '');
    n.go('recover-judged');
    await n.exited;
    expect({ out: n.out().trim(), fired: fs.existsSync(`${arm}.fired`), named: named(n.err().split('\n')).length }).toEqual({ out: 'rc=0', fired: true, named: 1 });
  }, 30000);

  it('lock_acquire_path, negative control: no EIO — recovered in the same poll, nothing named', async () => {
    const root = freshRoot('r3-bash-ok');
    writeDeadHolder(machineLockPath('x', root));
    const n = startPausedBash(root, `${ONE_EIO}\nlock_acquire x 0; echo "rc=$?"`, [], { ARM: `${root}/arm` });
    await n.exited;
    expect({ out: n.out().trim(), named: named(n.err().split('\n')).length }).toEqual({ out: 'rc=0', named: 0 });
  }, 30000);

  it('D6 lock_recover_only: kept with LRO_UNKNOWN named (not a plain kept); the next call removes it', async () => {
    const root = freshRoot('r3-bash-d6');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const arm = `${root}/arm`;
    const call = 'lock_recover_only "$LK" "${LK%.lock}.queue" 0; echo "$LRO_RESULT|$LRO_UNKNOWN"; lock_recover_only "$LK" "${LK%.lock}.queue" 0; echo "$LRO_RESULT"';
    const n = startPausedBash(root, `${ONE_EIO}\n${call}`, ['recover-only-judged'], { ARM: arm, LK: lockPath });
    expect(await until(() => n.reached('recover-only-judged'))).toBe(true);
    fs.writeFileSync(arm, '');
    // The .go file stays: the second call passes the same pause without stopping.
    n.go('recover-only-judged');
    await n.exited;
    expect(fs.existsSync(`${arm}.fired`)).toBe(true);
    const [first, second] = n.out().trim().split('\n');
    expect({ first, second }).toEqual({ first: `kept|point=lock-owner path=${lockPath}/owner errno=EIO`, second: 'removed' });
  }, 30000);
});

describe('#4559 r3 item 2: a lock gone by the re-read keeps develop\'s absent', () => {
  it('bash D6 lock_recover_only: absent', async () => {
    const root = freshRoot('r3-absent-bash');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const n = startPausedBash(root, 'lock_recover_only "$LK" "${LK%.lock}.queue" 0; echo "$LRO_RESULT"', ['recover-only-judged'], { LK: lockPath });
    expect(await until(() => n.reached('recover-only-judged'))).toBe(true);
    fs.rmSync(lockPath, { recursive: true });
    n.go('recover-only-judged');
    await n.exited;
    expect(n.out().trim()).toBe('absent');
  }, 30000);

  it('sync JS recoverIfDead: absent', () => {
    const root = freshRoot('r3-absent-sync');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const r = lockSync.recoverIfDead(lockPath, { timeoutMs: 0, hooks: { onRecover: (stage: string) => (stage === 'recover-only-judged' ? fs.rmSync(lockPath, { recursive: true }) : undefined) } });
    expect(r.result).toBe('absent');
  });
});

/**
 * Review r4 (lead-to-worker-4558-r4). 1: merge-pr's onStaleHolder is called before the re-read, as on
 * develop and 95d507189 — once per token, also when the re-read fails on every poll. 2 (a): a re-read
 * unknown still there when the wait runs out is named once, not again by the timeout's line. 2 (b): the
 * check for "gone" after a re-read that finds no owner (the listing of the owner-less <lock>) failing is
 * a named unknown, not a plain kept.
 */
describe('#4559 r4 item 1: onStaleHolder (merge-pr) before the re-read, once per token', () => {
  const take = (lockPath: string, f: ReturnType<typeof oneRereadFault>, timeoutMs: number, pidAlive = f.pidAlive) => {
    const calls: string[] = [];
    const warnings: string[] = [];
    const n = lockSync.acquireMachineLockSync('x', {
      lockPath,
      timeoutMs,
      pollMs: 20,
      warn: (l: string) => warnings.push(l),
      onStaleHolder: (owner: { token: string }) => calls.push(owner.token),
      hooks: { pidAlive, fault: f.fault },
    });
    return { n, calls, warnings };
  };

  it('ordinary recovery: called once with the dead holder, and the lock is taken', () => {
    const root = freshRoot('r4-stale');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const r = take(lockPath, oneRereadFault('none'), 0);
    expect({ acquired: r.n.acquired, calls: r.calls }).toEqual({ acquired: true, calls: ['D'] });
    r.n.release();
  });

  it('one EIO on the re-read: called once (not again on the next poll), and the lock is taken', () => {
    const root = freshRoot('r4-stale-eio');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const f = oneRereadFault('pid');
    const r = take(lockPath, f, 1500);
    expect({ acquired: r.n.acquired, fired: f.s.fired, calls: r.calls }).toEqual({ acquired: true, fired: 1, calls: ['D'] });
    r.n.release();
  });

  it('the re-read fails on every poll: called once, not taken, the lock unchanged, named once', () => {
    const root = freshRoot('r4-stale-every');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const f = oneRereadFault('every');
    const r = take(lockPath, f, 300);
    expect(f.s.fired).toBeGreaterThan(1);
    expect({ acquired: r.n.acquired, calls: r.calls, owner: ownerToken(lockPath), named: named(r.warnings).length }).toEqual({ acquired: false, calls: ['D'], owner: 'D', named: 1 });
  });

  it('the holder replaced after the judgement (develop calls it too): called once, nothing moved', () => {
    const root = freshRoot('r4-stale-swap');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const f = oneRereadFault('none');
    let swapped = false;
    const pidAlive = (pid: number): boolean => {
      const answer = f.pidAlive(pid);
      if (pid === deadPid() && !swapped) {
        swapped = true;
        fs.writeFileSync(`${lockPath}/owner`, JSON.stringify({ pid: process.pid, host: 'h', token: 'S', acquiredAt: Date.now(), v: 1 }));
      }
      return answer;
    };
    const r = take(lockPath, f, 0, pidAlive);
    expect({ acquired: r.n.acquired, calls: r.calls, owner: ownerToken(lockPath) }).toEqual({ acquired: false, calls: ['D'], owner: 'S' });
  });
});

describe('#4559 r4 item 2 (a): the re-read\'s unknown at the end of the wait is named once', () => {
  it('sync JS (budget 0): not taken, the lock unchanged, one line', () => {
    const root = freshRoot('r4-once-sync');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const f = oneRereadFault('pid');
    const warnings: string[] = [];
    const n = lockSync.acquireMachineLockSync('x', { lockPath, timeoutMs: 0, warn: (l: string) => warnings.push(l), hooks: { pidAlive: f.pidAlive, fault: f.fault } });
    expect({ acquired: n.acquired, point: n.unknown?.point, owner: ownerToken(lockPath), named: named(warnings).length }).toEqual({ acquired: false, point: 'lock-owner', owner: 'D', named: 1 });
  });

  it('TS (budget 0): not taken, the lock unchanged, one line', async () => {
    const root = freshRoot('r4-once-ts');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const f = oneRereadFault('pid');
    const n = await acquireMachineLock('x', { root, timeoutMs: 0, __testHooks: { pidAlive: f.pidAlive, fault: f.fault } });
    expect({ acquired: n.acquired, owner: ownerToken(lockPath), named: named(LOGS).length }).toEqual({ acquired: false, owner: 'D', named: 1 });
  });

  it('bash (budget 0): not taken, the lock unchanged, one line', async () => {
    const root = freshRoot('r4-once-bash');
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    const arm = `${root}/arm`;
    const n = startPausedBash(root, `${ONE_EIO}\nlock_acquire x 0; echo "rc=$?"`, ['recover-judged'], { ARM: arm });
    expect(await until(() => n.reached('recover-judged'))).toBe(true);
    fs.writeFileSync(arm, '');
    n.go('recover-judged');
    await n.exited;
    expect({ out: n.out().trim(), owner: ownerToken(lockPath), named: named(n.err().split('\n')).length }).toEqual({ out: 'rc=1', owner: 'D', named: 1 });
  }, 30000);

  it('negative control (bash): another unknown at the end of the wait keeps its line', async () => {
    const root = freshRoot('r4-once-bash-other');
    writeDeadHolder(machineLockPath('x', root));
    const n = startPausedBash(root, 'lock_acquire x 0; echo "rc=$?"', [], { CM_VERIFY_TEST_OBS_FAULT: 'lock-owner=EIO' });
    await n.exited;
    expect(n.err()).toContain('machine-lock-unknown point=lock-owner');
    expect(n.err()).toContain('(not taken: unknown is never read as free)');
  }, 30000);
});

/** bash: lock_obs_list wrapped so that, once $ARM exists, the next lock-list listing fails with EIO once. */
const ONE_LIST_EIO = `
eval "orig_$(declare -f lock_obs_list)"
lock_obs_list() {
  if [ "$1" = lock-list ] && [ -e "$ARM" ] && [ ! -e "$ARM.fired" ]; then
    : > "$ARM.fired"
    ol_saved=\${CM_VERIFY_TEST_OBS_FAULT:-}
    CM_VERIFY_TEST_OBS_FAULT="lock-list=EIO"
    orig_lock_obs_list "$@"
    CM_VERIFY_TEST_OBS_FAULT=$ol_saved
    return 0
  fi
  orig_lock_obs_list "$@"
}
`;

describe('#4559 r4 item 2 (b): the re-read finds no owner and the listing fails — a named unknown', () => {
  const gutted = (root: string) => {
    const lockPath = machineLockPath('x', root);
    writeDeadHolder(lockPath);
    return { lockPath, gut: () => fs.rmSync(`${lockPath}/owner`) };
  };

  it('sync JS recoverIfDead: kept with the lock-list unknown', () => {
    const root = freshRoot('r4-list-sync');
    const { lockPath, gut } = gutted(root);
    let armed = false;
    const r = lockSync.recoverIfDead(lockPath, {
      timeoutMs: 0,
      hooks: {
        onRecover: (stage: string) => {
          if (stage === 'recover-only-judged') {
            gut();
            armed = true;
          }
        },
        fault: (point: string) => (point === 'lock-list' && armed ? ((armed = false), 'EIO') : null),
      },
    });
    expect({ result: r.result, point: r.unknown?.point, code: r.unknown?.code, dir: fs.existsSync(lockPath) }).toEqual({ result: 'kept', point: 'lock-list', code: 'EIO', dir: true });
  });

  it('sync JS recoverIfDead, negative control: the listing answers — kept, nothing named (the owner-less <lock> stays)', () => {
    const root = freshRoot('r4-list-sync-ok');
    const { lockPath, gut } = gutted(root);
    const r = lockSync.recoverIfDead(lockPath, { timeoutMs: 0, hooks: { onRecover: (stage: string) => (stage === 'recover-only-judged' ? gut() : undefined) } });
    expect({ result: r.result, unknown: r.unknown ?? null, dir: fs.existsSync(lockPath) }).toEqual({ result: 'kept', unknown: null, dir: true });
  });

  it('bash D6: kept with LRO_UNKNOWN naming lock-list, one line', async () => {
    const root = freshRoot('r4-list-bash');
    const { lockPath, gut } = gutted(root);
    const arm = `${root}/arm`;
    const n = startPausedBash(root, `${ONE_LIST_EIO}\nlock_recover_only "$LK" "\${LK%.lock}.queue" 0; echo "$LRO_RESULT|$LRO_UNKNOWN"`, ['recover-only-judged'], { ARM: arm, LK: lockPath });
    expect(await until(() => n.reached('recover-only-judged'))).toBe(true);
    gut();
    fs.writeFileSync(arm, '');
    n.go('recover-only-judged');
    await n.exited;
    expect(n.out().trim()).toBe(`kept|point=lock-list path=${lockPath} errno=EIO`);
    expect(n.err().split('\n').filter((l) => l.includes('machine-lock-unknown point=lock-list'))).toHaveLength(1);
  }, 30000);

  it('bash D6, negative control: the listing answers — kept, nothing named', async () => {
    const root = freshRoot('r4-list-bash-ok');
    const { lockPath, gut } = gutted(root);
    const n = startPausedBash(root, 'lock_recover_only "$LK" "${LK%.lock}.queue" 0; echo "$LRO_RESULT|$LRO_UNKNOWN"', ['recover-only-judged'], { LK: lockPath });
    expect(await until(() => n.reached('recover-only-judged'))).toBe(true);
    gut();
    n.go('recover-only-judged');
    await n.exited;
    expect(n.out().trim()).toBe('kept|');
  }, 30000);
});
