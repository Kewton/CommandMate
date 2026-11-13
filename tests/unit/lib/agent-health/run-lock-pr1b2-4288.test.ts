/**
 * #4288 PR1b-2: the run-lock callers take PR1a-f's rules as they are.
 *  - the grace of an owner-less `<lock>` is PR1a-f's constant (600000), not a value written in run-lock;
 *  - a pid that is not the caller's own is refused before anything is made (I1-b), and the TS side has no
 *    door for a caller's own record keys (I1-c: the only field it passes is `label`).
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_OWNER_GRACE_MS } from '../../../../scripts/orchestrate/machine-lock-sync.mjs';
import { OWNERLESS_GRACE_MS, acquireRunLock } from '@/lib/agent-health/run-lock';
import { REAL_SHELL_SUBPROCESS_TIMEOUT_MS, assertSubprocessCompleted } from '@tests/helpers/real-shell-budget';
import { removeTempDir } from '@tests/helpers/temp-dir';

const RUN_LOCK_SH = path.resolve(__dirname, '../../../../scripts/uat/run-lock.sh');
const RUN_LOCK_TS = path.resolve(__dirname, '../../../../src/lib/agent-health/run-lock.ts');

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-rl-pr1b2-'));
});
afterEach(() => {
  removeTempDir(root);
});

describe('#4288 PR1b-2 the grace of an owner-less <lock> is PR1a-f’s constant', () => {
  it('TS: OWNERLESS_GRACE_MS is EMPTY_OWNER_GRACE_MS (600000)', () => {
    expect(EMPTY_OWNER_GRACE_MS).toBe(600_000);
    expect(OWNERLESS_GRACE_MS).toBe(EMPTY_OWNER_GRACE_MS);
  });

  it('TS: run-lock.ts has no number literal for the grace', () => {
    const src = fs.readFileSync(RUN_LOCK_TS, 'utf8');
    expect(src).not.toMatch(/OWNERLESS_GRACE_MS\s*(:\s*number\s*)?=\s*[0-9_]+\s*;/);
    expect(src).toMatch(/OWNERLESS_GRACE_MS: number = EMPTY_OWNER_GRACE_MS/);
  });

  it('bash: RUN_LOCK_OWNERLESS_GRACE_MS is the section’s LOCK_EMPTY_OWNER_GRACE_MS, and is not written as a number in run-lock.sh', () => {
    const r = spawnSync('bash', ['-c', `. '${RUN_LOCK_SH}'; echo "$RUN_LOCK_OWNERLESS_GRACE_MS $LOCK_EMPTY_OWNER_GRACE_MS $RUN_LOCK_LOAD_ERROR"`], {
      env: { ...process.env, CM_RUN_LOCK_DIR: path.join(root, 'lock') },
      encoding: 'utf8',
      timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
    });
    assertSubprocessCompleted(r, 'run-lock.sh');
    expect(r.stdout.trim()).toBe(`${EMPTY_OWNER_GRACE_MS} ${EMPTY_OWNER_GRACE_MS}`);
    expect(fs.readFileSync(RUN_LOCK_SH, 'utf8')).not.toMatch(/^RUN_LOCK_OWNERLESS_GRACE_MS=[0-9]+/m);
  });

  it('an owner-less empty <lock> is taken only past the grace (10 minutes)', () => {
    const lock = path.join(root, 'lock');
    fs.mkdirSync(lock);
    const env = { CM_RUN_LOCK_DIR: lock, CM_RUN_LOCK_TOKEN: '' };
    const now = Date.now();
    // 2 minutes past the old 60 s grace is still young under 600 s
    expect(acquireRunLock({ label: 'a', env, now: () => new Date(now + 120_000) }).ok).toBe(false);
    expect(acquireRunLock({ label: 'a', env, now: () => new Date(now + 2 * OWNERLESS_GRACE_MS) }).ok).toBe(true);
  });
});

describe('#4288 PR1b-2 acquireRunLock refuses a pid that is not its own', () => {
  it('refuses before it makes the lock or the queue (the message names both pids)', () => {
    const lock = path.join(root, 'lock');
    const res = acquireRunLock({ label: 't', env: { CM_RUN_LOCK_DIR: lock, CM_RUN_LOCK_TOKEN: '' }, pid: process.pid + 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(`pid ${process.pid + 1} is not this process (${process.pid})`);
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.existsSync(`${lock}.queue`)).toBe(false);
  });

  it('takes the lock with its own pid, and the record carries the writer’s version (v=1) beside the keys it always had', () => {
    const lock = path.join(root, 'lock');
    const res = acquireRunLock({ label: 't', env: { CM_RUN_LOCK_DIR: lock, CM_RUN_LOCK_TOKEN: '' }, pid: process.pid, token: 'own-tok' });
    expect(res.ok).toBe(true);
    const text = fs.readFileSync(path.join(lock, 'owner'), 'utf8');
    expect(text).toContain(`pid=${process.pid}\n`);
    expect(text).toContain('token=own-tok\n');
    expect(text).toContain('label=t\n');
    expect(text).toContain('v=1\n');
    if (res.ok) res.release();
  });

  it('has no option that carries record keys: AcquireRunLockOptions passes only the label as an extra field', () => {
    const src = fs.readFileSync(RUN_LOCK_TS, 'utf8');
    expect(src).toMatch(/ownerFields: \{ label: options\.label \}/);
    expect(src).not.toMatch(/ownerFields: \{[^}]*\.\.\./);
  });
});
