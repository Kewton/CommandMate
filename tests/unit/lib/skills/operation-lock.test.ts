/**
 * Issue #1234: owner-aware exclusive lock for Skill operations.
 *
 * The behaviour that matters is what the lock refuses to do: it must not
 * reclaim a lock whose owner is alive, and it must not let a non-owner release
 * or renew. Age alone is never sufficient evidence of abandonment.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { hostname, tmpdir } from 'os';
import { join } from 'path';
import {
  SKILL_LOCK_FOREIGN_HOST_GRACE_MS,
  SKILL_LOCK_LEASE_MS,
  acquireSkillOperationLock,
  buildSkillOperationLockKey,
  evaluateSkillLock,
  listSkillOperationLockKeys,
  readSkillOperationLock,
  releaseOrphanSkillLocks,
  releaseSkillOperationLock,
  renewSkillOperationLease,
  type SkillOperationLockRecord,
} from '@/lib/skills/operation-lock';
import { SKILL_LOCK_DIRNAME, ensureSkillStateDir } from '@/lib/skills/operation-store';

let root: string;
const KEY = buildSkillOperationLockKey('/srv/worktrees/wt-1', 'demo-skill');
const T0 = 1_800_000_000_000;

/** Simulate a lock written by a different process on this host. */
function writeForeignLock(
  overrides: Partial<Omit<SkillOperationLockRecord, 'owner'>> & {
    owner?: Partial<SkillOperationLockRecord['owner']>;
  } = {}
): SkillOperationLockRecord {
  const { owner, ...rest } = overrides;
  const record: SkillOperationLockRecord = {
    schemaVersion: 1,
    key: KEY,
    operationId: 'op-foreign',
    acquiredAt: T0,
    renewedAt: T0,
    leaseExpiresAt: T0 + SKILL_LOCK_LEASE_MS,
    ...rest,
    owner: {
      nonce: 'foreign-nonce',
      pid: 424242,
      host: hostname(),
      processGeneration: 'other-process-generation',
      ...owner,
    },
  };
  const dir = ensureSkillStateDir(SKILL_LOCK_DIRNAME, { root });
  writeFileSync(join(dir, `${KEY}.lock`), JSON.stringify(record), { mode: 0o600 });
  return record;
}

const ALIVE = () => true;
const DEAD = () => false;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cm-skill-lock-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('lock key derivation', () => {
  it('is stable for the same resolved worktree and skill', () => {
    expect(buildSkillOperationLockKey('/srv/wt', 'a-skill')).toBe(
      buildSkillOperationLockKey('/srv/wt', 'a-skill')
    );
  });

  it('separates different skills in the same worktree', () => {
    expect(buildSkillOperationLockKey('/srv/wt', 'a-skill')).not.toBe(
      buildSkillOperationLockKey('/srv/wt', 'b-skill')
    );
  });

  it('never puts an untrusted name into the filename', () => {
    const key = buildSkillOperationLockKey('/srv/wt', 'a-skill');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    acquireSkillOperationLock({ key, operationId: 'op-1' }, { root, now: T0 });
    expect(listSkillOperationLockKeys({ root })).toEqual([key]);
  });
});

describe('acquisition and exclusion', () => {
  it('grants the lock when free', () => {
    const result = acquireSkillOperationLock({ key: KEY, operationId: 'op-1' }, { root, now: T0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reclaimed).toBe(false);
    expect(result.lock.owner.nonce).toMatch(/^[0-9a-f]{48}$/);
    expect(result.lock.leaseExpiresAt).toBe(T0 + SKILL_LOCK_LEASE_MS);
  });

  it('refuses a second acquisition while the lease is valid', () => {
    acquireSkillOperationLock({ key: KEY, operationId: 'op-1' }, { root, now: T0 });
    const second = acquireSkillOperationLock(
      { key: KEY, operationId: 'op-2' },
      { root, now: T0 + 1_000 }
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('HELD');
    expect(second.heldBy?.operationId).toBe('op-1');
  });

  it('does not leak the lock file path to the caller', () => {
    acquireSkillOperationLock({ key: KEY, operationId: 'op-1' }, { root, now: T0 });
    const denied = acquireSkillOperationLock({ key: KEY, operationId: 'op-2' }, { root, now: T0 });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(Object.keys(denied.heldBy ?? {})).toEqual([
      'operationId',
      'acquiredAt',
      'leaseExpiresAt',
    ]);
  });
});

describe('a live owner is never reclaimed', () => {
  it('refuses reclaim while the lease is valid even if the owner looks dead', () => {
    writeForeignLock();
    const result = acquireSkillOperationLock(
      { key: KEY, operationId: 'op-2' },
      { root, now: T0 + 1, isProcessAlive: DEAD }
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('HELD');
  });

  it('refuses reclaim after lease expiry while the owning PID is alive', () => {
    // This is the case age-only staleness gets wrong: a long install that
    // missed a heartbeat is still writing payload.
    writeForeignLock();
    const result = acquireSkillOperationLock(
      { key: KEY, operationId: 'op-2' },
      { root, now: T0 + SKILL_LOCK_LEASE_MS + 60_000, isProcessAlive: ALIVE }
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('HELD_BY_LIVE_OWNER');
    expect(readSkillOperationLock(KEY, { root })?.owner.nonce).toBe('foreign-nonce');
  });

  it('does not reclaim a same-process lease-expired lock while this process is alive', () => {
    // Issue #1427: the lock is written by THIS process (real generation + pid).
    // Route handlers share one process and never renew, so a lapsed lease is not
    // proof that a concurrent same-process operation abandoned it — it stays held.
    const first = acquireSkillOperationLock({ key: KEY, operationId: 'op-1' }, { root, now: T0 });
    expect(first.ok).toBe(true);
    const contender = acquireSkillOperationLock(
      { key: KEY, operationId: 'op-2' },
      { root, now: T0 + SKILL_LOCK_LEASE_MS + 1, isProcessAlive: ALIVE }
    );
    expect(contender.ok).toBe(false);
    if (contender.ok) return;
    expect(contender.reason).toBe('HELD_BY_LIVE_OWNER');
    // Nothing was stolen: op-1 still owns the lock.
    expect(readSkillOperationLock(KEY, { root })?.operationId).toBe('op-1');
  });

  it('a renewed lease keeps the lock out of reach', () => {
    const first = acquireSkillOperationLock({ key: KEY, operationId: 'op-1' }, { root, now: T0 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const renewed = renewSkillOperationLease(first.lock, { root, now: T0 + 25_000 });
    expect(renewed?.leaseExpiresAt).toBe(T0 + 25_000 + SKILL_LOCK_LEASE_MS);

    const contender = acquireSkillOperationLock(
      { key: KEY, operationId: 'op-2' },
      { root, now: T0 + 40_000, isProcessAlive: DEAD }
    );
    expect(contender.ok).toBe(false);
  });
});

describe('stale reclaim', () => {
  it('reclaims once the lease expired and the owner is gone', () => {
    writeForeignLock();
    const result = acquireSkillOperationLock(
      { key: KEY, operationId: 'op-2' },
      { root, now: T0 + SKILL_LOCK_LEASE_MS + 1, isProcessAlive: DEAD }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reclaimed).toBe(true);
    expect(readSkillOperationLock(KEY, { root })?.operationId).toBe('op-2');
  });

  it('treats an unparseable lock as reclaimable, since it can never expire', () => {
    const dir = ensureSkillStateDir(SKILL_LOCK_DIRNAME, { root });
    writeFileSync(join(dir, `${KEY}.lock`), 'not json at all');
    const result = acquireSkillOperationLock(
      { key: KEY, operationId: 'op-2' },
      { root, now: T0, isProcessAlive: ALIVE }
    );
    expect(result.ok).toBe(true);
  });

  it('waits out an extra grace before reclaiming a lock owned by another host', () => {
    writeForeignLock({ owner: { host: 'some-other-machine' } });

    const tooEarly = acquireSkillOperationLock(
      { key: KEY, operationId: 'op-2' },
      { root, now: T0 + SKILL_LOCK_LEASE_MS + 1_000, isProcessAlive: DEAD }
    );
    expect(tooEarly.ok).toBe(false);
    if (!tooEarly.ok) expect(tooEarly.reason).toBe('HELD_UNVERIFIABLE_OWNER');

    const later = acquireSkillOperationLock(
      { key: KEY, operationId: 'op-2' },
      {
        root,
        now: T0 + SKILL_LOCK_LEASE_MS + SKILL_LOCK_FOREIGN_HOST_GRACE_MS + 1,
        isProcessAlive: DEAD,
      }
    );
    expect(later.ok).toBe(true);
  });

  it('reclaims a lease-expired lock this process wrote once its owning pid is gone', () => {
    // Models a crash: the lock file this process wrote outlives its owner. Reclaim
    // is now driven purely by liveness — the same-generation shortcut is gone
    // (Issue #1427) — so a dead owner is still recovered.
    const first = acquireSkillOperationLock({ key: KEY, operationId: 'op-1' }, { root, now: T0 });
    expect(first.ok).toBe(true);
    const again = acquireSkillOperationLock(
      { key: KEY, operationId: 'op-2' },
      { root, now: T0 + SKILL_LOCK_LEASE_MS + 1, isProcessAlive: DEAD }
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.reclaimed).toBe(true);
    expect(readSkillOperationLock(KEY, { root })?.operationId).toBe('op-2');
  });
});

describe('concurrent same-process requests never steal a live lock', () => {
  // Issue #1427: two requests for the same (worktree, skill) hit one shared
  // process. The install/uninstall route turns any denied acquire into
  // SKILL_INSTALL_LOCKED (409); these pin that the *second* request is always
  // denied rather than winning the lock, at both lease phases.
  it('denies the second request while the first lease is still valid', () => {
    const first = acquireSkillOperationLock({ key: KEY, operationId: 'op-1' }, { root, now: T0 });
    expect(first.ok).toBe(true);
    const second = acquireSkillOperationLock(
      { key: KEY, operationId: 'op-2' },
      { root, now: T0 + 5_000, isProcessAlive: ALIVE }
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('HELD');
  });

  it('still denies the second request after the first lease lapses', () => {
    const first = acquireSkillOperationLock({ key: KEY, operationId: 'op-1' }, { root, now: T0 });
    expect(first.ok).toBe(true);
    const second = acquireSkillOperationLock(
      { key: KEY, operationId: 'op-2' },
      { root, now: T0 + SKILL_LOCK_LEASE_MS + 5_000, isProcessAlive: ALIVE }
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('HELD_BY_LIVE_OWNER');
    expect(readSkillOperationLock(KEY, { root })?.operationId).toBe('op-1');
  });
});

describe('owner-only release and renew', () => {
  it('releases when the nonce matches', () => {
    const first = acquireSkillOperationLock({ key: KEY, operationId: 'op-1' }, { root, now: T0 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(releaseSkillOperationLock(first.lock, { root })).toBe(true);
    expect(readSkillOperationLock(KEY, { root })).toBeNull();
  });

  it('refuses to release another owner lock', () => {
    const held = writeForeignLock();
    const impostor: SkillOperationLockRecord = {
      ...held,
      operationId: 'op-2',
      owner: { ...held.owner, nonce: 'guessed-nonce' },
    };
    expect(releaseSkillOperationLock(impostor, { root })).toBe(false);
    expect(readSkillOperationLock(KEY, { root })?.owner.nonce).toBe('foreign-nonce');
  });

  it('refuses to renew after the lock was reclaimed by someone else', () => {
    const first = acquireSkillOperationLock({ key: KEY, operationId: 'op-1' }, { root, now: T0 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Someone else legitimately reclaimed it after the owner died.
    releaseSkillOperationLock(first.lock, { root });
    writeForeignLock({ operationId: 'op-2' });

    expect(renewSkillOperationLease(first.lock, { root, now: T0 + 1_000 })).toBeNull();
  });

  it('renew does not resurrect a removed lock', () => {
    const first = acquireSkillOperationLock({ key: KEY, operationId: 'op-1' }, { root, now: T0 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    releaseSkillOperationLock(first.lock, { root });
    expect(renewSkillOperationLease(first.lock, { root, now: T0 + 1 })).toBeNull();
    expect(readSkillOperationLock(KEY, { root })).toBeNull();
  });

  it('writes lock records without a machine path inside', () => {
    acquireSkillOperationLock({ key: KEY, operationId: 'op-1' }, { root, now: T0 });
    const raw = readFileSync(join(root, SKILL_LOCK_DIRNAME, `${KEY}.lock`), 'utf-8');
    expect(raw).not.toContain('/srv/worktrees/wt-1');
    expect(raw).not.toContain('demo-skill');
  });
});

describe('orphan lock cleanup', () => {
  it('removes only locks whose owner is verifiably gone', () => {
    const activeKey = buildSkillOperationLockKey('/srv/wt', 'active-skill');
    acquireSkillOperationLock(
      { key: activeKey, operationId: 'op-active', leaseMs: 60 * 60_000 },
      { root, now: T0 }
    );
    writeForeignLock();

    const released = releaseOrphanSkillLocks({
      root,
      now: T0 + SKILL_LOCK_LEASE_MS + 1,
      isProcessAlive: DEAD,
    });

    expect(released).toEqual([KEY]);
    expect(readSkillOperationLock(KEY, { root })).toBeNull();
    expect(readSkillOperationLock(activeKey, { root })?.operationId).toBe('op-active');
  });

  it('keeps a lock held by a live foreign owner', () => {
    writeForeignLock();
    const released = releaseOrphanSkillLocks({
      root,
      now: T0 + SKILL_LOCK_LEASE_MS + 1,
      isProcessAlive: ALIVE,
    });
    expect(released).toEqual([]);
    expect(readSkillOperationLock(KEY, { root })).not.toBeNull();
  });

  it('keeps every unexpired lock', () => {
    writeForeignLock();
    expect(releaseOrphanSkillLocks({ root, now: T0, isProcessAlive: DEAD })).toEqual([]);
  });
});

describe('evaluateSkillLock', () => {
  it('reports FREE for a missing record', () => {
    expect(evaluateSkillLock(null, { now: T0 })).toBe('FREE');
  });

  it('reclaims a crash orphan from another generation once its pid is gone', () => {
    // A record left by a crashed prior process: same host, different generation,
    // lease long expired. Liveness — not generation — is the deciding evidence,
    // so crash recovery is preserved after the shortcut removal (Issue #1427).
    const orphan = writeForeignLock();
    expect(
      evaluateSkillLock(orphan, { now: T0 + SKILL_LOCK_LEASE_MS + 1, isProcessAlive: DEAD })
    ).toBe('RECLAIMABLE');
  });

  it('keeps a crash orphan whose pid was reused by a live process', () => {
    const orphan = writeForeignLock();
    expect(
      evaluateSkillLock(orphan, { now: T0 + SKILL_LOCK_LEASE_MS + 1, isProcessAlive: ALIVE })
    ).toBe('HELD_BY_LIVE_OWNER');
  });
});
