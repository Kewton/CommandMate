/**
 * Issue #3359 — src/lib/agent-health/run-lock.ts, the run.ts side of the lock
 * that scripts/uat/run-lock.sh takes for UAT and daily.sh.
 *
 * Before this, run.ts wrote its pid to `run.lock` (read, check, write: two
 * runs that started together both got in) and nothing else looked at it. The
 * lock directory lives under the test's own temp dir (CM_RUN_LOCK_DIR).
 *
 * @vitest-environment node
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireRunLock,
  formatRunLockOwner,
  parseRunLockOwner,
  readRunLockOwner,
  runLockDir,
} from '@/lib/agent-health/run-lock';
import { REAL_SHELL_SUBPROCESS_TIMEOUT_MS, assertSubprocessCompleted } from '@tests/helpers/real-shell-budget';
import { removeTempDir } from '@tests/helpers/temp-dir';

const RUN_LOCK_SH = path.resolve(__dirname, '../../../../scripts/uat/run-lock.sh');

let root: string;
let lockDir: string;
let env: Record<string, string>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-run-lock-'));
  lockDir = path.join(root, 'lock');
  env = { CM_RUN_LOCK_DIR: lockDir, CM_RUN_LOCK_TOKEN: '' };
});

afterEach(() => {
  removeTempDir(root);
});

function writeOwner(pid: number, token: string, label = 'uat'): void {
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'owner'), formatRunLockOwner({ pid, startedAt: 'x', label, token }));
}

describe('runLockDir', () => {
  it('uses CM_RUN_LOCK_DIR, else <tmpdir>/commandmate-run.lock (never ~/.commandmate)', () => {
    expect(runLockDir({ CM_RUN_LOCK_DIR: '/x/lock' }, '/t')).toBe('/x/lock');
    expect(runLockDir({}, '/t')).toBe('/t/commandmate-run.lock');
    expect(runLockDir({})).toBe(path.join(os.tmpdir(), 'commandmate-run.lock'));
  });
});

describe('acquireRunLock', () => {
  it('takes a free lock, refuses a second caller, and releases only its own', () => {
    const first = acquireRunLock({ label: 'agent-health', env });
    expect(first.ok).toBe(true);
    const second = acquireRunLock({ label: 'agent-health', env, pid: process.pid, token: 'other' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain(`pid ${process.pid}`);

    if (first.ok) {
      expect(readRunLockOwner(lockDir)?.token).toBe(first.token);
      first.release();
    }
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('takes over a lock whose owner is dead, not one whose owner is alive', () => {
    writeOwner(4242, 'stale');
    const taken = acquireRunLock({ label: 'agent-health', env, isAlive: () => false, token: 'mine' });
    expect(taken.ok).toBe(true);
    expect(readRunLockOwner(lockDir)?.token).toBe('mine');

    const refused = acquireRunLock({ label: 'agent-health', env, isAlive: () => true, token: 'later' });
    expect(refused.ok).toBe(false);
    expect(readRunLockOwner(lockDir)?.token).toBe('mine');
  });

  it('treats an ownerless lock as being made, until it is older than a minute', () => {
    fs.mkdirSync(lockDir);
    const now = Date.now();
    expect(acquireRunLock({ label: 'a', env, now: () => new Date(now) }).ok).toBe(false);
    expect(acquireRunLock({ label: 'a', env, now: () => new Date(now + 120_000) }).ok).toBe(true);
  });

  it('is inherited by a child whose CM_RUN_LOCK_TOKEN names the live holder, and the child does not release it', () => {
    writeOwner(process.pid, 'daily-token', 'daily');
    const child = acquireRunLock({ label: 'agent-health', env: { ...env, CM_RUN_LOCK_TOKEN: 'daily-token' } });
    expect(child.ok && child.how).toBe('inherited');
    if (child.ok) child.release();
    expect(readRunLockOwner(lockDir)?.token).toBe('daily-token');

    // A wrong token is refused (negative control).
    expect(acquireRunLock({ label: 'agent-health', env: { ...env, CM_RUN_LOCK_TOKEN: 'nope' } }).ok).toBe(false);
  });

  it('agrees with scripts/uat/run-lock.sh on the directory and the owner format', () => {
    const held = acquireRunLock({ label: 'agent-health', env, token: 'ts-token' });
    expect(held.ok).toBe(true);
    const result = spawnSync(
      'bash',
      ['-c', `. '${RUN_LOCK_SH}'; run_lock_acquire uat $$ sh-token || { echo "$RUN_LOCK_ERROR"; exit 1; }`],
      { env: { ...process.env, ...env }, encoding: 'utf8', timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS }
    );
    assertSubprocessCompleted(result, 'run-lock.sh');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`pid ${process.pid}, label agent-health`);
    if (held.ok) held.release();

    // And the other way: what bash writes, the TS side reads.
    const bashHeld = spawnSync('bash', ['-c', `. '${RUN_LOCK_SH}'; run_lock_acquire uat ${process.pid} sh-token /r`], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
    });
    assertSubprocessCompleted(bashHeld, 'run-lock.sh');
    expect(bashHeld.status).toBe(0);
    expect(readRunLockOwner(lockDir)).toMatchObject({ pid: process.pid, label: 'uat', token: 'sh-token', runDir: '/r' });
    expect(acquireRunLock({ label: 'agent-health', env }).ok).toBe(false);
  });
});

describe('parseRunLockOwner', () => {
  it('needs a pid and a token', () => {
    expect(parseRunLockOwner(null)).toBeNull();
    expect(parseRunLockOwner('pid=abc\ntoken=t\n')).toBeNull();
    expect(parseRunLockOwner('pid=12\n')).toBeNull();
    expect(parseRunLockOwner('pid=12\nstarted_at=s\nlabel=l\ntoken=t\n')).toEqual({
      pid: 12,
      startedAt: 's',
      label: 'l',
      token: 't',
    });
  });
});
