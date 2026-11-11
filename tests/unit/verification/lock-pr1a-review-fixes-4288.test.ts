/**
 * Issue #4288 PR1a-b — the fixes of the PR1a reviews (PM Claude A / B, Codex review-4288-pr1a):
 *
 *   1. (A P2-1 / Codex P2) the sync JS's release() after a handOff follows bash's D12: a record whose
 *      recorded pid is gone is not removed by the holder (a head could recover it and take it between
 *      the read and the delete) — 'needs-head', and the caller releases with releaseAsHead (D5).
 *      A's reproduction (the successor's lock removed) is the positive control; the same scenes are
 *      one table for bash's lock_release_held and the sync JS (TS has no handover, D9).
 *   2. (A P3-1) machine-lock.ts creates the owner exclusively ('wx'): a copy with 'w' is red.
 *   3. (A P3-2 / B P3-1) scripts/lib/machine-lock.sh refuses to load under set -e, and why: an
 *      operation called under errexit ends the caller's shell part way.
 *   4. (Codex P3) recoverIfDead keeps the unknown of the moved-aside settle (as bash's LRO_UNKNOWN).
 *
 * Every root is under os.tmpdir(); nothing under ~/.commandmate.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as lockSync from '../../../scripts/orchestrate/machine-lock-sync.mjs';
import { acquireMachineLock } from '@/lib/verification/machine-lock';
import { HOST, REPO, deadPid, killStarted, liveGroup, mutatedSync, removeRoot } from './lock-4288-harness';

const LOADER = path.join(REPO, 'scripts/lib/machine-lock.sh');

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-pr1a-fixes-4288-'));
});
afterEach(() => {
  killStarted();
  removeRoot(root);
});

const baseEnv = (env: Record<string, string>) => ({
  ...process.env,
  CM_VERIFY_LOCK_ROOT: path.join(root, 'verify-root'),
  CM_VERIFY_TEST_OBS_FAULT: '',
  CM_VERIFY_TEST_HANDOFF: '',
  CM_VERIFY_TEST_HANDOFF_DIR: '',
  KILL_GRACE_SEC: '',
  ...env,
});

function bash(script: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30000, env: baseEnv(env) });
  return { out: (r.stdout ?? '').trim(), err: r.stderr ?? '', status: r.status };
}
/** A bash under `set -u` with the loader sourced. */
const sh = (script: string, env: Record<string, string> = {}) =>
  bash(`set -u\n. '${LOADER}' || { echo LOAD-FAILED; exit 3; }\n${script}`, env);

const ACQ = `if lock_acquire_path "$LK" "$(machine_lock_queue_of "$LK")" 0; then echo acquired; else echo "refused $LOCK_HELD_BY"; fi\n`;
const lockIn = (sub = 'run') => path.join(root, sub, 'commandmate-run.lock');
const ownerToken = (lock: string): string | null => {
  try {
    const text = fs.readFileSync(path.join(lock, 'owner'), 'utf8');
    return /^token=(.*)$/m.exec(text)?.[1] ?? JSON.parse(text).token ?? null;
  } catch {
    return null;
  }
};

describe('1. the sync JS\'s release after a handOff: a record whose recorded pid is gone is released as the head (D12)', () => {
  /**
   * A's reproduction: A hands its lock to a process (pid and group both gone by the release). Inside
   * A's release — after it read the owner, before the delete — B, the head, recovers the dead record
   * and takes the lock.
   */
  function race(mod: typeof lockSync) {
    const lock = lockIn();
    const g = deadPid();
    let successor: ReturnType<typeof lockSync.acquireMachineLockSync> | null = null;
    const a = mod.acquireMachineLockSync('x', {
      lockPath: lock,
      timeoutMs: 0,
      token: 'T0',
      hooks: {
        groupAlive: () => {
          successor ??= lockSync.acquireMachineLockSync('x', { lockPath: lock, timeoutMs: 0, token: 'SUCC' });
          return false;
        },
      },
    });
    expect(a.acquired).toBe(true);
    expect(a.handOff(g, g)).toEqual({ ok: true, token: `T0-g${g}` });
    const result = a.release();
    return { lock, g, result, successor: successor as ReturnType<typeof lockSync.acquireMachineLockSync> | null };
  }

  it('the successor B took between the read and the delete keeps its lock: needs-head, and the head release keeps B\'s', () => {
    const { lock, g, result, successor } = race(lockSync);
    expect(successor?.acquired).toBe(true);
    expect(result).toBe('needs-head');
    expect(ownerToken(lock)).toBe('SUCC');
    // The caller releases as the head (D5): another token on record → kept.
    expect(lockSync.releaseAsHead(lock, ['T0', `T0-g${g}`], { timeoutMs: 0 }).result).toBe('kept');
    expect(ownerToken(lock)).toBe('SUCC');
    expect(successor?.release()).toBe('released');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('positive control: the release that judged the group alone (PR1a) removes the successor\'s lock', async () => {
    const legacy = await mutatedSync(root, (s) => s.replace('if (mine && current.owner.pid !== process.pid) {', 'if (false) {'));
    const { lock, result, successor } = race(legacy);
    expect(successor?.acquired).toBe(true);
    expect(result).toBe('released');
    expect(fs.existsSync(lock), 'B\'s lock was removed under it').toBe(false);
  });

  it('negative: a lock never handed over (gate-runner / precheck / merge-pr) is released as before', () => {
    const lock = lockIn();
    const r = lockSync.acquireMachineLockSync('x', { lockPath: lock, timeoutMs: 0 });
    expect(r.release()).toBe('released');
    expect(r.release()).toBe('none');
    expect(fs.existsSync(lock)).toBe(false);
  });

  type Scene = { scene: string; pid: 'dead' | 'self'; group: 'dead' | 'live'; fault?: string; result: string; left: boolean; asHead?: string };
  const SCENES: Scene[] = [
    { scene: 'recorded pid gone, group empty (UAT\'s T1: the server stopped)', pid: 'dead', group: 'dead', result: 'needs-head', left: true, asHead: 'released' },
    { scene: 'recorded pid alive (the caller), group empty (daily\'s T1)', pid: 'self', group: 'dead', result: 'released', left: false },
    { scene: 'group with a member', pid: 'dead', group: 'live', result: 'deferred', left: true },
    { scene: 'recorded pid unknown (EPERM)', pid: 'dead', group: 'dead', fault: 'EPERM', result: 'deferred', left: true },
  ];
  const IMPLS = ['bash', 'sync'] as const;
  const ROWS = SCENES.flatMap((s) => IMPLS.map((impl) => ({ ...s, impl })));

  it.each(ROWS)('$impl: $scene → $result', ({ impl, pid, group, fault, result, left, asHead }) => {
    const lock = lockIn();
    const g = group === 'live' ? liveGroup() : deadPid();
    const dead = deadPid();
    if (impl === 'bash') {
      const r = sh(
        `machine_lock_use_kv_codec\n${ACQ}T0=$LOCK_TOKEN
lock_hand_off "$LK" "$LOCK_TOKEN" ${pid === 'self' ? '$$' : dead} ${g}; T1=$LHO_TOKEN; echo "stage=[$LHO_STAGE]"
[ -z "\${OBS_FAULT:-}" ] || CM_VERIFY_TEST_OBS_FAULT="pid=$OBS_FAULT"
lock_release_held "$LK"; echo "held=$LRH_RESULT"
CM_VERIFY_TEST_OBS_FAULT=
if [ "$LRH_RESULT" = needs-head ]; then lock_release_as_head "$LK" "$(machine_lock_queue_of "$LK")" 10 "$T0" "$T1"; echo "head=$LRAH_RESULT"; fi`,
        { LK: lock, OBS_FAULT: fault ?? '' },
      );
      const lines = r.out.split('\n');
      expect(lines.slice(0, 3), r.err).toEqual(['acquired', 'stage=[]', `held=${result}`]);
      if (asHead) {
        expect(lines[3]).toBe(`head=${asHead}`);
        expect(fs.existsSync(lock)).toBe(false);
      } else {
        expect(fs.existsSync(lock)).toBe(left);
      }
      return;
    }
    let faulting = false;
    const r = lockSync.acquireMachineLockSync('x', {
      lockPath: lock,
      timeoutMs: 0,
      token: 'T0',
      hooks: { fault: (point: string) => (faulting && point === 'pid' ? fault : undefined) },
    });
    expect(r.handOff(pid === 'self' ? process.pid : dead, g)).toEqual({ ok: true, token: `T0-g${g}` });
    faulting = true;
    expect(r.release()).toBe(result);
    faulting = false;
    expect(fs.existsSync(lock)).toBe(left);
    if (asHead) {
      expect(lockSync.releaseAsHead(lock, ['T0', `T0-g${g}`], { timeoutMs: 0 }).result).toBe(asHead);
      expect(fs.existsSync(lock)).toBe(false);
    }
  });

  it('sync JS: needs-head is once (the second call does nothing); deferred may be called again', () => {
    const lock = lockIn();
    const g = deadPid();
    const r = lockSync.acquireMachineLockSync('x', { lockPath: lock, timeoutMs: 0, token: 'T0' });
    r.handOff(g, g);
    expect(r.release()).toBe('needs-head');
    expect(r.release()).toBe('none');
    expect(ownerToken(lock)).toBe(`T0-g${g}`);
  });
});

describe('2. machine-lock.ts creates the owner exclusively', () => {
  const SUCCESSOR = JSON.stringify({ pid: process.pid, host: HOST, token: 'succ', acquiredAt: 0 });
  /** An owner put in between this call's mkdir and its create (the fault seam runs just before the open). */
  const putSuccessor = (point: string, target: string) => {
    if (point === 'owner-create') fs.writeFileSync(target, SUCCESSOR);
    return undefined;
  };

  it('an owner that is there is not written over: not acquired, the owner left as it was', async () => {
    const r = await acquireMachineLock('x', { root, timeoutMs: 0, __testHooks: { fault: putSuccessor } });
    expect(r.acquired).toBe(false);
    expect(ownerToken(path.join(root, 'x.lock'))).toBe('succ');
  });

  it('negative: nothing there → acquired and released as before', async () => {
    const r = await acquireMachineLock('x', { root, timeoutMs: 0 });
    expect(r.acquired).toBe(true);
    if (r.acquired) r.handle.release();
    expect(fs.existsSync(path.join(root, 'x.lock'))).toBe(false);
  });

  it('positive control: a copy that opens with \'w\' overwrites the successor\'s owner and calls it taken', async () => {
    const source = fs.readFileSync(path.join(REPO, 'src/lib/verification/machine-lock.ts'), 'utf8');
    const out = source
      .replace("openSync(file, 'wx')", "openSync(file, 'w')")
      .replace("from '@/lib/logger'", `from '${path.join(REPO, 'src/lib/logger')}'`);
    expect(out).not.toContain("openSync(file, 'wx')");
    const file = path.join(root, `machine-lock-mutated-${Math.random().toString(36).slice(2)}.ts`);
    fs.writeFileSync(file, out);
    const legacy = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as typeof import('@/lib/verification/machine-lock');
    const lockRoot = path.join(root, 'legacy');
    fs.mkdirSync(lockRoot);
    const r = await legacy.acquireMachineLock('x', { root: lockRoot, timeoutMs: 0, __testHooks: { fault: putSuccessor } });
    expect(r.acquired).toBe(true);
    expect(ownerToken(path.join(lockRoot, 'x.lock'))).not.toBe('succ');
    if (r.acquired) r.handle.release();
  });
});

describe('3. scripts/lib/machine-lock.sh is not loaded under set -e', () => {
  it.each(['set -e', 'set -euo pipefail'])('under %s the source fails with a message (the caller takes nothing)', (opts) => {
    const r = bash(`${opts}\n. '${LOADER}' || { echo LOAD-FAILED; exit 3; }\necho loaded`);
    expect(r.out).toBe('LOAD-FAILED');
    expect(r.status).toBe(3);
    expect(r.err).toContain('not loaded under set -e');
  });

  it('negative: under set -u it loads', () => {
    expect(sh('echo loaded').out).toBe('loaded');
  });

  it('why: errexit turned on after the load ends the caller part way through an operation (an owner-less <lock>)', () => {
    const lock = lockIn();
    fs.mkdirSync(lock, { recursive: true });
    const call = `lock_recover_only "$LK" "$(machine_lock_queue_of "$LK")" 0; echo "after=$LRO_RESULT"`;
    const errexit = sh(`set -e\n${call}`, { LK: lock });
    expect(errexit.out).not.toContain('after=');
    expect(errexit.status).not.toBe(0);
    expect(sh(call, { LK: lock }).out).toBe('after=kept');
  });
});

describe('4. recoverIfDead keeps the unknown of the moved-aside settle (Codex review-4288-pr1a P3)', () => {
  const listRootFault = (point: string) => (point === 'list-root' ? 'EACCES' : undefined);

  it('sync JS: list-root EACCES with no <lock> → absent, and the unknown is returned (as bash\'s LRO_UNKNOWN)', () => {
    const lock = lockIn();
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const r = lockSync.recoverIfDead(lock, { timeoutMs: 0, hooks: { fault: listRootFault } });
    expect(r.result).toBe('absent');
    expect(r.unknown).toMatchObject({ point: 'list-root', code: 'EACCES' });
  });

  it('bash: the same scene names the same point', () => {
    const lock = lockIn();
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const r = sh(`lock_recover_only "$LK" "$(machine_lock_queue_of "$LK")" 0; echo "$LRO_RESULT|$LRO_UNKNOWN"`, { LK: lock, CM_VERIFY_TEST_OBS_FAULT: 'list-root=EACCES' });
    expect(r.out).toMatch(/^absent\|point=list-root .*errno=EACCES$/);
  });

  it('negative: nothing failing → absent with no unknown', () => {
    const lock = lockIn();
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const r = lockSync.recoverIfDead(lock, { timeoutMs: 0 });
    expect(r).toEqual({ result: 'absent' });
  });

  it('positive control: the settle\'s unknown dropped (PR1a) → absent with nothing to say why', async () => {
    const legacy = await mutatedSync(root, (s) => s.replace('const first = settled.block && settled.unknown ? settled.unknown : null;', 'const first = null;'));
    const lock = lockIn();
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const r = legacy.recoverIfDead(lock, { timeoutMs: 0, hooks: { fault: listRootFault } });
    expect(r.result).toBe('absent');
    expect(r.unknown).toBeUndefined();
  });
});
