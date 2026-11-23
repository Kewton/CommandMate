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
function oneRereadFault(armOn: 'pid' | 'none') {
  const dead = deadPid();
  const s = { armed: false, fired: 0 };
  return {
    s,
    arm: () => (s.armed = true),
    pidAlive: (pid: number): boolean => {
      if (pid === dead) {
        if (armOn === 'pid' && s.fired === 0) s.armed = true;
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
