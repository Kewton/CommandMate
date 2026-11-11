/**
 * Issue #4288 PR1a — the machine-wide lock as the base of run-lock and supervisor.lock
 * (docs/design/lock-reservation-rest-4288.md §1.6–§1.10): the options and operations added to the
 * three implementations, all off by default (the existing tests of #4277 / #4288 hold the defaults).
 *
 *   - sync JS (scripts/orchestrate/machine-lock-sync.mjs): lockPath (D2), ownerCodec (D1), token /
 *     ownerPid, ownerlessGraceMs (D3), the owner's exclusive create (D3), hooks.kill (D10),
 *     handOff (D4), releaseAsHead (D5), recoverIfDead (D6).
 *   - bash, through the loader scripts/lib/machine-lock.sh (verify-run.sh's lock section): the same,
 *     plus lstart (D7), lock_child_wait (D9) and lock_release_held (D12) — and the loader itself:
 *     loaded once, and the settings its operations need come with it (Codex review-4288h P2-1).
 *   - D9 before / after the publish (review-4288h P2-2) and the end states of a handover that failed
 *     part way (review-4288h P3), op by op.
 *
 * Positive controls run a copy with the fix taken out (mutatedBash / mutatedSync) or the pre-#4288
 * form written out in the test. Every root is under os.tmpdir(); nothing under ~/.commandmate.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as lockSync from '../../../scripts/orchestrate/machine-lock-sync.mjs';
import {
  HOST,
  REPO,
  deadPid,
  groupAlive,
  killStarted,
  liveGroup,
  mutatedBash,
  mutatedSync,
  removeRoot,
  started,
  writeOwner,
} from './lock-4288-harness';

const LOADER = path.join(REPO, 'scripts/lib/machine-lock.sh');

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-options-4288-'));
});
afterEach(() => {
  killStarted();
  removeRoot(root);
});

/** A bash under `set -u` with the loader sourced (nothing of KILL_GRACE_SEC & co. set by the caller). */
const prelude = (verifyRun?: string) =>
  `set -u\n${verifyRun ? `MACHINE_LOCK_VERIFY_RUN='${verifyRun}'\n` : ''}. '${LOADER}' || { echo LOAD-FAILED; exit 3; }\n`;

const baseEnv = (env: Record<string, string>) => ({
  ...process.env,
  CM_VERIFY_LOCK_ROOT: path.join(root, 'verify-root'),
  CM_VERIFY_TEST_OBS_FAULT: '',
  CM_VERIFY_TEST_HANDOFF: '',
  CM_VERIFY_TEST_HANDOFF_DIR: '',
  KILL_GRACE_SEC: '',
  ...env,
});

function sh(script: string, env: Record<string, string> = {}, o: { verifyRun?: string; timeout?: number } = {}) {
  const r = spawnSync('bash', ['-c', prelude(o.verifyRun) + script], { encoding: 'utf8', timeout: o.timeout ?? 30000, env: baseEnv(env) });
  return { out: (r.stdout ?? '').trim(), err: r.stderr ?? '', status: r.status };
}

function shBg(script: string, env: Record<string, string> = {}): ChildProcess {
  const child = spawn('bash', ['-c', prelude() + script], { stdio: ['ignore', 'pipe', 'pipe'], env: baseEnv(env) });
  started.push(child);
  return child;
}

/** The bash acquisition by path (budget 0: one poll, as run-lock and supervisor.lock take it). */
const ACQ = `if lock_acquire_path "$LK" "$(machine_lock_queue_of "$LK")" 0; then echo acquired; else echo "refused $LOCK_HELD_BY"; fi\n`;
const KV = 'machine_lock_use_kv_codec\n';

const kvRecord = (o: { pid: number; token: string; host?: string; pgid?: number | string; lstart?: string }) =>
  `pid=${o.pid}\n${o.host === undefined ? `host=${HOST}\n` : o.host ? `host=${o.host}\n` : ''}token=${o.token}\nstarted_at=2026-11-10T00:00:00Z\n${o.lstart ? `lstart=${o.lstart}\n` : ''}${o.pgid !== undefined ? `pgid=${o.pgid}\n` : ''}`;

const writeKv = (lock: string, o: Parameters<typeof kvRecord>[0]) => {
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner'), kvRecord(o));
};

/** The same codec as the loader's machine_lock_use_kv_codec, for the sync JS (run-lock.ts's in PR1b). */
const kvCodec = {
  parse(text: string) {
    const rec: Record<string, unknown> = {};
    for (const line of text.split('\n')) {
      const i = line.indexOf('=');
      if (i <= 0) continue;
      const k = line.slice(0, i);
      if (k in rec) continue;
      const v = line.slice(i + 1);
      rec[k] = ['pid', 'pgid', 'acquiredAt'].includes(k) && /^\d+$/.test(v) ? Number(v) : v;
    }
    if (rec.host === undefined) rec.host = HOST;
    return rec;
  },
  format(rec: Record<string, unknown>) {
    return `pid=${rec.pid}\nhost=${rec.host}\ntoken=${rec.token}\nstarted_at=${new Date(Number(rec.acquiredAt ?? 0)).toISOString()}\n${rec.pgid !== undefined ? `pgid=${rec.pgid}\n` : ''}`;
  },
};

const readText = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
const ownerOf = (lock: string) => readText(path.join(lock, 'owner'));
const tokenOf = (lock: string) => /^token=(.*)$/m.exec(ownerOf(lock) ?? '')?.[1] ?? null;
const gones = (lock: string) => fs.readdirSync(path.dirname(lock)).filter((e) => e.startsWith(`${path.basename(lock)}.gone-`));
const lockIn = (sub = 'run') => path.join(root, sub, 'commandmate-run.lock');
/**
 * Wait, yielding to the event loop: a process this test killed is reaped by node only between turns
 * of the loop, and until then its zombie answers kill -0 (a synchronous wait would never see it go).
 */
async function until(predicate: () => boolean, timeoutMs = 10000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}
const pidGone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
};
const ageDir = (dir: string, ageMs: number) => {
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(dir, t, t);
};

describe('D2 / D1 / token / ownerPid: a lock named by its path, in key=value, under the caller\'s token', () => {
  it('sync JS: the lock, its queue and its records live beside the path; the bash loader excludes it and takes it after', async () => {
    const lock = lockIn();
    const holder = liveGroup();
    // #4288 PR1a-f I1-b (design §5.1): the first acquisition records its own pid only — another
    // ownerPid is refused before the ticket and the mkdir (F56). The record of another live process is
    // put by the test (the form an older copy or a hand-off leaves).
    const other = lockSync.acquireMachineLockSync('ignored', { lockPath: lock, timeoutMs: 0, token: 'run-T0', ownerPid: holder, ownerCodec: kvCodec });
    expect(other.acquired).toBe(false);
    expect(other.unknown).toEqual({ point: 'owner-pid', path: lock, code: 'EINVAL' });
    expect(fs.existsSync(lock)).toBe(false);
    const r = lockSync.acquireMachineLockSync('ignored', { lockPath: lock, timeoutMs: 0, token: 'run-T0', ownerCodec: kvCodec });
    expect(r.acquired).toBe(true);
    expect(r.path).toBe(lock);
    expect(tokenOf(lock)).toBe('run-T0');
    expect(ownerOf(lock)).toMatch(new RegExp(`^pid=${process.pid}$`, 'm'));
    expect(fs.existsSync(path.join(root, 'run', 'commandmate-run.queue'))).toBe(true);
    expect(lockSync.queueDirOfPath(lock)).toBe(path.join(root, 'run', 'commandmate-run.queue'));
    expect(lockSync.queueDirOfPath(path.join(root, 'x', 'held'))).toBe(path.join(root, 'x', 'held.queue'));
    expect(r.release()).toBe('released');
    writeKv(lock, { pid: holder, token: 'run-T0' });
    // The bash loader, the same path and codec: the holder is alive → refused.
    expect(sh(KV + ACQ, { LK: lock }).out).toMatch(/^refused/);
    // D12's invariant (PR1a-c, codex-2 review-4288-pr1ab P2-1): a record whose pid is not the caller is
    // released as the head (D5), which keeps it while the holder lives.
    expect(sh(KV + ACQ, { LK: lock }).out).toMatch(/^refused/);
    expect(lockSync.releaseAsHead(lock, ['run-T0'], { timeoutMs: 0, ownerCodec: kvCodec }).result).toBe('deferred');
    killStarted();
    expect(await until(() => !groupAlive(holder))).toBe(true);
    expect(lockSync.releaseAsHead(lock, ['run-T0'], { timeoutMs: 0, ownerCodec: kvCodec }).result).toBe('released');
    expect(sh(KV + ACQ, { LK: lock }).out).toBe('acquired');
  });

  it('the bash loader writes key=value with host= under LOCK_WANT_TOKEN / LOCK_OWNER_PID, and the sync JS reads it the same way', async () => {
    const lock = lockIn();
    // #4288 PR1a-f I1-b (design §5.1): the bash takes the lock under its own pid and stays alive — its
    // own pid keeps the record (another LOCK_OWNER_PID is refused, F56).
    expect(sh(`${KV}LOCK_OWNER_PID=${liveGroup()}\n${ACQ}`, { LK: lock }).out).toMatch(/^refused/);
    expect(fs.existsSync(lock)).toBe(false);
    const child = shBg(`${KV}LOCK_WANT_TOKEN=run-B\nLOCK_OWNER_PID=$$\n${ACQ}exec sleep 60\n`, { LK: lock });
    const live = child.pid as number;
    expect(await until(() => tokenOf(lock) === 'run-B')).toBe(true);
    const text = ownerOf(lock) ?? '';
    expect(text).toMatch(/^pid=\d+$/m);
    expect(text).toMatch(new RegExp(`^host=${HOST.replace(/[.]/g, '\\.')}$`, 'm'));
    expect(text).toMatch(/^token=run-B$/m);
    expect(text).toMatch(/^started_at=\d{4}-\d\d-\d\dT/m);
    expect(text).toMatch(new RegExp(`^pid=${live}$`, 'm'));
    expect(text).toMatch(/^v=1$/m);
    const held = lockSync.acquireMachineLockSync('x', { lockPath: lock, timeoutMs: 0, ownerCodec: kvCodec });
    expect(held.acquired).toBe(false);
    expect(held.heldBy).toBe(`pid ${live} on ${HOST}`);
    killStarted();
    expect(await until(() => pidGone(live))).toBe(true);
    // Its pid dead (an older record without host= is this host's): recovered by the sync JS.
    writeKv(lock, { pid: deadPid(), token: 'run-old', host: '' });
    const taken = lockSync.acquireMachineLockSync('x', { lockPath: lock, timeoutMs: 0, ownerCodec: kvCodec });
    expect(taken.acquired).toBe(true);
    taken.release();
  });

  it('key=value: a pgid= that is not a number is unknown in both (EINVAL), never "no group"', () => {
    const lock = lockIn();
    writeKv(lock, { pid: deadPid(), token: 'bad-pgid', pgid: 'x9' });
    const bash = sh(`${KV}${ACQ}`, { LK: lock });
    expect(bash.out).toMatch(/^refused /);
    expect(bash.err).toContain('point=lock-owner');
    expect(bash.err).toContain('errno=EINVAL');
    const sync = lockSync.acquireMachineLockSync('x', { lockPath: lock, timeoutMs: 0, ownerCodec: kvCodec });
    expect(sync.acquired).toBe(false);
    expect(sync.unknown).toEqual({ point: 'lock-owner', path: path.join(lock, 'owner'), code: 'EINVAL' });
    expect(tokenOf(lock)).toBe('bad-pgid');
  });
});

describe('D3: an owner-less, empty <lock> is taken out by the head only past the caller\'s grace (ms, not find -mmin)', () => {
  const ROWS = [
    { age: 59_000, taken: false },
    { age: 61_000, taken: true },
  ];
  it.each(ROWS)('bash and sync JS agree at $age ms: taken=$taken', ({ age, taken }) => {
    for (const impl of ['bash', 'sync'] as const) {
      const lock = lockIn(`${impl}-${age}`);
      fs.mkdirSync(lock, { recursive: true });
      ageDir(lock, age);
      const got =
        impl === 'bash'
          ? sh(`LOCK_OWNERLESS_GRACE_MS=60000\n${ACQ}`, { LK: lock }).out === 'acquired'
          : lockSync.acquireMachineLockSync('x', { lockPath: lock, timeoutMs: 0, ownerlessGraceMs: 60_000 }).acquired;
      expect(got, impl).toBe(taken);
    }
  });

  it('negative: without the option an owner-less <lock> is never taken (verify-run.sh and the gate runners as before)', () => {
    const lock = lockIn();
    fs.mkdirSync(lock, { recursive: true });
    ageDir(lock, 3_600_000);
    expect(sh(ACQ, { LK: lock }).out).toMatch(/^refused/);
    expect(lockSync.acquireMachineLockSync('x', { lockPath: lock, timeoutMs: 0 }).acquired).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('a <lock> that is not empty, or has an owner, is never taken out by age', () => {
    const lock = lockIn();
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'stray'), '');
    ageDir(lock, 3_600_000);
    expect(sh(`LOCK_OWNERLESS_GRACE_MS=60000\n${ACQ}`, { LK: lock }).out).toMatch(/^refused/);
    expect(lockSync.acquireMachineLockSync('x', { lockPath: lock, timeoutMs: 0, ownerlessGraceMs: 60_000 }).acquired).toBe(false);
    expect(fs.existsSync(path.join(lock, 'stray'))).toBe(true);
  });
});

describe('D3: the owner is created exclusively — nothing there is written over, and nothing of anyone else is removed', () => {
  /** <lock>/owner made beforehand in five forms (P2-8). */
  const KINDS: { kind: string; make: (owner: string) => void; still: (owner: string) => boolean }[] = [
    { kind: 'a regular file (a successor\'s owner)', make: (o) => fs.writeFileSync(o, '{"pid":1,"token":"succ"}'), still: (o) => readText(o) === '{"pid":1,"token":"succ"}' },
    { kind: 'a directory', make: (o) => fs.mkdirSync(o), still: (o) => fs.statSync(o).isDirectory() },
    { kind: 'a symlink to a directory', make: (o) => { fs.mkdirSync(`${o}-target`); fs.symlinkSync(`${o}-target`, o); }, still: (o) => fs.lstatSync(o).isSymbolicLink() && fs.readdirSync(`${o}-target`).length === 0 },
    { kind: 'a symlink to /dev/null', make: (o) => fs.symlinkSync('/dev/null', o), still: (o) => fs.readlinkSync(o) === '/dev/null' },
    { kind: 'a dangling symlink', make: (o) => fs.symlinkSync(path.join(path.dirname(o), 'nowhere'), o), still: (o) => fs.lstatSync(o).isSymbolicLink() && !fs.existsSync(path.join(path.dirname(o), 'nowhere')) },
  ];

  it.each(KINDS)('bash lock_obs_create: $kind → not taken, left as it was', ({ make, still }) => {
    const lock = lockIn();
    fs.mkdirSync(lock, { recursive: true });
    const owner = path.join(lock, 'owner');
    make(owner);
    const r = sh(`printf '%s\\n' "$(lock_format_owner $$ mine 1)" | lock_obs_create owner-create "$LK/owner" mine; echo "rc=$?"`, { LK: lock });
    const rc = Number(/rc=(\d+)/.exec(r.out)?.[1]);
    expect(rc, r.out).not.toBe(0);
    expect(still(owner)).toBe(true);
  });

  it.each(KINDS)('sync JS create: $kind → not created, left as it was', ({ make, still }) => {
    const lock = lockIn();
    fs.mkdirSync(lock, { recursive: true });
    const owner = path.join(lock, 'owner');
    make(owner);
    expect(lockSync.makeObserver().create('owner-create', owner, '{"pid":2,"token":"mine"}').state).toBe('exists');
    expect(still(owner)).toBe(true);
  });

  // #4288 PR1a-f (design §5.1): the exclusion is the publish's link(2), not the tmp's create — the
  // mutation replaces the publish (/bin/link, linkSync) with a rename (mv -f, renameSync). The expectation
  // (written over and called taken) is the same.
  it('positive control: the write without set -C / wx overwrites the successor\'s owner and calls it taken', async () => {
    const lock = lockIn();
    fs.mkdirSync(lock, { recursive: true });
    const owner = path.join(lock, 'owner');
    const legacyBash = mutatedBash(root, (s) => s.replace('elif lok_out=$(LC_ALL=C /bin/link -- "$2" "$3" 2>&1); then', 'elif lok_out=$(LC_ALL=C mv -f -- "$2" "$3" 2>&1); then'));
    fs.writeFileSync(owner, '{"pid":1,"token":"succ"}');
    const r = sh(`printf '%s\\n' "$(lock_format_owner $$ mine 1)" | lock_obs_create owner-create "$LK/owner" mine; echo "rc=$?"`, { LK: lock }, { verifyRun: legacyBash });
    expect(r.out).toBe('rc=0');
    expect(readText(owner)).toContain('"token":"mine"');
    const legacySync = await mutatedSync(root, (s) => s.replace('() => fs.linkSync(from, to)', '() => fs.renameSync(from, to)'));
    fs.writeFileSync(owner, '{"pid":1,"token":"succ"}');
    const linked = legacySync.makeObserver().create('owner-create', owner, '{"pid":2,"token":"mine"}', path.join(lock, '.owner-mine'));
    expect(linked.state).toBe('created');
    expect(legacySync.makeObserver().link('owner-publish', path.join(lock, '.owner-mine'), owner).state).toBe('linked');
    expect(readText(owner)).toContain('mine');
    // negative: the real link answers EEXIST and leaves the successor's owner
    fs.writeFileSync(owner, '{"pid":1,"token":"succ"}');
    lockSync.makeObserver().create('owner-create', owner, '{"pid":2,"token":"mine"}', path.join(lock, '.owner-mine'));
    expect(lockSync.makeObserver().link('owner-publish', path.join(lock, '.owner-mine'), owner).state).toBe('exists');
    expect(readText(owner)).toContain('succ');
  });

  it('bash: the undo removes only what this create made — owner-write taken out; owner-unlink / lock-rmdir failing leave the <lock> (nobody holds it twice)', () => {
    const lock = lockIn();
    const write = sh(ACQ, { LK: lock, CM_VERIFY_TEST_HANDOFF: 'fault:owner-write' });
    expect(write.out).toMatch(/^refused/);
    expect(write.err).toContain(`machine-lock-owner-write-failed ${lock} (taken out again; not acquired)`);
    expect(fs.existsSync(lock)).toBe(false);
    const unlink = sh(ACQ, { LK: lock, CM_VERIFY_TEST_HANDOFF: 'fault:owner-write,fault:owner-unlink' });
    expect(unlink.err).toContain(`machine-lock-owner-write-failed ${lock} (and it could not be taken out again)`);
    // #4288 PR1a-f (design §5.1): what is half written is only the tmp — `<lock>/.owner-<token>` stays,
    // and `<lock>/owner` was never published (I1).
    expect(fs.readdirSync(lock).filter((n) => n.startsWith('.owner-'))).toHaveLength(1);
    expect(fs.existsSync(path.join(lock, 'owner'))).toBe(false);
    fs.rmSync(lock, { recursive: true });
    const rmdir = sh(ACQ, { LK: lock, CM_VERIFY_TEST_HANDOFF: 'fault:owner-write,fault:lock-rmdir' });
    expect(rmdir.err).toContain('(and it could not be taken out again)');
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.existsSync(path.join(lock, 'owner'))).toBe(false);
  });

  it('sync JS: the same undo — the error ends the acquisition, and a failed undo leaves the <lock>', () => {
    const lock = lockIn();
    const fault = (spec: Record<string, string>) => (point: string) => spec[point];
    expect(() => lockSync.acquireMachineLockSync('x', { lockPath: lock, timeoutMs: 0, hooks: { fault: fault({ 'owner-write': 'ENOSPC' }) } })).toThrow(/ENOSPC/);
    expect(fs.existsSync(lock)).toBe(false);
    expect(() => lockSync.acquireMachineLockSync('x', { lockPath: lock, timeoutMs: 0, hooks: { fault: fault({ 'owner-write': 'ENOSPC', 'owner-unlink': 'EIO' }) } })).toThrow(/ENOSPC/);
    // #4288 PR1a-f (design §5.1): the tmp stays, the owner was never published (I1).
    expect(fs.readdirSync(lock).filter((n) => n.startsWith('.owner-'))).toHaveLength(1);
    expect(fs.existsSync(path.join(lock, 'owner'))).toBe(false);
  });
});

describe('D10: the sync JS\'s hooks.kill goes through the same three-valued classification', () => {
  const killThat = (code?: string) => (target: number) => {
    if (target !== heldPid) return process.kill(target, 0);
    if (!code) return true;
    throw Object.assign(new Error(code), { code });
  };
  let heldPid = 0;

  it.each([
    { code: undefined, acquired: false },
    { code: 'ESRCH', acquired: true },
    { code: 'EPERM', acquired: false, unknown: 'EPERM' },
    { code: 'EIO', acquired: false, unknown: 'EIO' },
  ])('owner pid answering $code → acquired=$acquired', ({ code, acquired, unknown }) => {
    const lock = lockIn();
    heldPid = 4_000_000 + Math.floor(Math.random() * 1000);
    writeOwner(lock, { pid: heldPid, host: HOST, token: 'held', acquiredAt: 0 });
    const r = lockSync.acquireMachineLockSync('x', { lockPath: lock, timeoutMs: 0, hooks: { kill: killThat(code) } });
    expect(r.acquired).toBe(acquired);
    if (unknown) {
      expect(r.unknown).toEqual({ point: 'pid', path: lock, code: unknown });
      expect(gones(lock)).toEqual([]);
      expect(JSON.parse(ownerOf(lock) ?? '{}').token).toBe('held');
    }
    r.release();
  });

  it('another waiter\'s ticket: EPERM keeps it (blocks), ESRCH retires it', () => {
    const lock = lockIn();
    const queue = lockSync.queueDirOfPath(lock);
    heldPid = 4_100_000;
    fs.mkdirSync(queue, { recursive: true });
    fs.writeFileSync(path.join(queue, lockSync.ticketName(1)), JSON.stringify({ pid: heldPid, host: HOST, token: 'other', createdAt: Date.now(), deadline: Date.now() + 600_000 }));
    const eperm = lockSync.acquireMachineLockSync('x', { lockPath: lock, timeoutMs: 0, hooks: { kill: killThat('EPERM'), startOf: () => null } });
    expect(eperm.acquired).toBe(false);
    expect(eperm.heldBy).toContain('queue ticket');
    const esrch = lockSync.acquireMachineLockSync('x', { lockPath: lock, timeoutMs: 0, hooks: { kill: killThat('ESRCH'), startOf: () => null } });
    expect(esrch.acquired).toBe(true);
    esrch.release();
  });

  it('positive control: a boolean probe that reads every failure but EPERM as dead (run-lock.ts\'s defaultIsAlive) takes on EIO', () => {
    const lock = lockIn();
    heldPid = 4_200_000;
    writeOwner(lock, { pid: heldPid, host: HOST, token: 'held', acquiredAt: 0 });
    const defaultIsAlive = (pid: number) => {
      try {
        killThat('EIO')(pid);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
      }
    };
    const r = lockSync.acquireMachineLockSync('x', { lockPath: lock, timeoutMs: 0, hooks: { pidAlive: defaultIsAlive } });
    expect(r.acquired, 'EIO read as dead recovers a live owner').toBe(true);
    r.release();
  });
});

describe('D4: handOff publishes the protected process and its group under a new token', () => {
  it('T1 = <T0>-g<G> with the pid and the group; the release waits for the group; readers judge pid AND group', async () => {
    const lock = lockIn();
    const g = liveGroup();
    const r = lockSync.acquireMachineLockSync('x', { lockPath: lock, timeoutMs: 0, token: 'T0' });
    const handed = r.handOff(g, g);
    expect(handed).toEqual({ ok: true, token: `T0-g${g}` });
    expect(JSON.parse(ownerOf(lock) ?? '{}')).toMatchObject({ pid: g, pgid: g, token: `T0-g${g}` });
    // The group is alive: the release defers and may be called again.
    expect(r.release()).toBe('deferred');
    expect(fs.existsSync(lock)).toBe(true);
    // A waiter (bash, the same rules) is refused while the group lives, even with the pid dead.
    writeOwner(lock, { pid: deadPid(), host: HOST, token: `T0-g${g}`, acquiredAt: 0, pgid: g });
    expect(sh(ACQ, { LK: lock }).out).toMatch(/^refused .*\(pgid \d+\)/);
    killStarted();
    expect(await until(() => !groupAlive(g))).toBe(true);
    // D12 (PR1a-b, as bash's lock_release_held): the recorded pid (g) is gone too, so the holder does
    // not remove it itself — a head could be recovering it — and releases it as the head (D5).
    expect(r.release()).toBe('needs-head');
    expect(fs.existsSync(lock)).toBe(true);
    expect(lockSync.releaseAsHead(lock, ['T0', `T0-g${g}`], { timeoutMs: 0 }).result).toBe('released');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it.each([
    { stage: 'tmp', fault: 'handoff-tmp', onRecord: 'T0' },
    { stage: 'mv', fault: 'handoff-publish', onRecord: 'T0' },
    { stage: 'verify', fault: 'handoff-verify', onRecord: 'T1' },
  ])('a failure at $stage leaves $onRecord on record, and the release still knows T1 (P3: no lock left)', ({ stage, fault, onRecord }) => {
    const lock = lockIn();
    const g = deadPid();
    const r = lockSync.acquireMachineLockSync('x', { lockPath: lock, timeoutMs: 0, token: 'T0', hooks: { fault: (p: string) => (p === fault ? 'EIO' : undefined) } });
    const handed = r.handOff(process.pid, g);
    expect(handed.ok).toBe(false);
    expect(handed.stage).toBe(stage);
    expect(JSON.parse(ownerOf(lock) ?? '{}').token).toBe(onRecord === 'T0' ? 'T0' : `T0-g${g}`);
    expect(r.release()).toBe('released');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('a successor\'s record is never handed over or released', () => {
    const lock = lockIn();
    const r = lockSync.acquireMachineLockSync('x', { lockPath: lock, timeoutMs: 0, token: 'T0' });
    writeOwner(lock, { pid: process.pid, host: HOST, token: 'successor', acquiredAt: 0 });
    expect(r.handOff(process.pid, liveGroup())).toMatchObject({ ok: false, stage: 'token' });
    expect(r.release()).toBe('kept');
    expect(JSON.parse(ownerOf(lock) ?? '{}').token).toBe('successor');
  });
});

describe('D5: the release by someone who is not the holder, as the head', () => {
  it.each([
    { form: 'its token, holder gone', owner: () => ({ pid: deadPid(), host: HOST, token: 'T1', acquiredAt: 0 }), result: 'released', left: false },
    { form: 'its token, holder alive', owner: () => ({ pid: process.pid, host: HOST, token: 'T1', acquiredAt: 0 }), result: 'deferred', left: true },
    { form: 'its token, pid gone, group alive', owner: () => ({ pid: deadPid(), host: HOST, token: 'T1', acquiredAt: 0, pgid: liveGroup() }), result: 'deferred', left: true },
    { form: 'another token', owner: () => ({ pid: deadPid(), host: HOST, token: 'successor', acquiredAt: 0 }), result: 'kept', left: true },
  ])('sync JS: $form → $result', ({ owner, result, left }) => {
    const lock = lockIn();
    writeOwner(lock, owner());
    expect(lockSync.releaseAsHead(lock, ['T0', 'T1'], { timeoutMs: 0 }).result).toBe(result);
    expect(fs.existsSync(lock)).toBe(left);
    expect(fs.readdirSync(lockSync.queueDirOfPath(lock)).filter((e) => /^\d{12}$/.test(e)).map((e) => JSON.parse(readText(path.join(lockSync.queueDirOfPath(lock), e)) ?? '{}').done)).not.toContain(undefined);
  });

  it('sync JS: not the head in time → nothing is done; a missing owner cleans only its own moved-aside record', () => {
    const lock = lockIn();
    writeOwner(lock, { pid: deadPid(), host: HOST, token: 'T0', acquiredAt: 0 });
    const queue = lockSync.queueDirOfPath(lock);
    fs.mkdirSync(queue, { recursive: true });
    fs.writeFileSync(path.join(queue, lockSync.ticketName(1)), JSON.stringify({ pid: process.pid, host: HOST, token: 'ahead', createdAt: Date.now(), deadline: Date.now() + 600_000 }));
    expect(lockSync.releaseAsHead(lock, ['T0'], { timeoutMs: 0 }).result).toBe('not-head');
    expect(tokenOf(lock) ?? JSON.parse(ownerOf(lock) ?? '{}').token).toBe('T0');
    fs.rmSync(queue, { recursive: true });
    fs.rmSync(lock, { recursive: true });
    writeOwner(`${lock}.gone-x-1`, { pid: process.pid, host: HOST, token: 'T0', acquiredAt: 0 });
    writeOwner(`${lock}.gone-y-1`, { pid: process.pid, host: HOST, token: 'other', acquiredAt: 0 });
    expect(lockSync.releaseAsHead(lock, ['T0'], { timeoutMs: 0 }).result).toBe('missing');
    expect(gones(lock)).toEqual([`${path.basename(lock)}.gone-y-1`]);
  });

  it('bash: a taker that comes between the read and the delete is refused (the release is the head), and takes it after', async () => {
    const lock = lockIn();
    const server = liveGroup();
    writeKv(lock, { pid: server, token: 'T1' });
    const dir = fs.mkdtempSync(path.join(root, 'pause-'));
    const down = shBg(`${KV}lock_release_as_head "$LK" "$(machine_lock_queue_of "$LK")" 10 T0 T1; echo "down=$LRAH_RESULT"`, {
      LK: lock,
      CM_VERIFY_TEST_HANDOFF: 'pause:release-head-read',
      CM_VERIFY_TEST_HANDOFF_DIR: dir,
    });
    let downOut = '';
    down.stdout?.on('data', (d) => (downOut += String(d)));
    expect(await until(() => fs.existsSync(path.join(dir, 'release-head-read.reached')))).toBe(true);
    process.kill(-server, 'SIGKILL'); // the server stops; down has not read the owner yet
    expect(await until(() => !groupAlive(server))).toBe(true);
    const between = sh(`${KV}${ACQ}`, { LK: lock });
    expect(between.out).toMatch(/^refused queue ticket/);
    fs.writeFileSync(path.join(dir, 'release-head-read.go'), '');
    await new Promise((resolve) => down.on('exit', resolve));
    expect(downOut.trim()).toBe('down=released');
    expect(fs.existsSync(lock)).toBe(false);
    expect(sh(`${KV}${ACQ}`, { LK: lock }).out).toBe('acquired');
  });

  it('positive control: the pre-#4288 release (read the token, then rm -rf) removes the successor that came between', async () => {
    const lock = lockIn();
    writeKv(lock, { pid: deadPid(), token: 'T1' });
    const dir = fs.mkdtempSync(path.join(root, 'pause-'));
    const legacy = spawn('bash', ['-c', `t=$(sed -n 's/^token=//p' "$LK/owner"); : > "$D/read"; while [ ! -e "$D/go" ]; do sleep 0.05; done; [ "$t" = T1 ] && rm -rf "$LK"; echo done`], {
      env: { ...process.env, LK: lock, D: dir },
    });
    started.push(legacy);
    expect(await until(() => fs.existsSync(path.join(dir, 'read')))).toBe(true);
    const successor = sh(`${KV}${ACQ}`, { LK: lock });
    expect(successor.out).toBe('acquired');
    fs.writeFileSync(path.join(dir, 'go'), '');
    await new Promise((resolve) => legacy.on('exit', resolve));
    expect(fs.existsSync(lock), 'the successor\'s lock was removed under it').toBe(false);
  });
});

describe('D6: recover without taking', () => {
  it.each([
    { form: 'holder gone', owner: () => ({ pid: deadPid(), token: 'dead' }), result: 'removed', left: false },
    { form: 'holder alive', owner: () => ({ pid: process.pid, token: 'live' }), result: 'kept', left: true },
  ])('bash and sync JS: $form → $result, never a mkdir', ({ owner, result, left }) => {
    const bashLock = lockIn('bash');
    writeKv(bashLock, owner());
    const r = sh(`${KV}lock_recover_only "$LK" "$(machine_lock_queue_of "$LK")" 0; echo "$LRO_RESULT"`, { LK: bashLock });
    expect(r.out).toBe(result);
    expect(fs.existsSync(bashLock)).toBe(left);
    const syncLock = lockIn('sync');
    const o = owner();
    writeOwner(syncLock, { ...o, host: HOST, acquiredAt: 0 });
    expect(lockSync.recoverIfDead(syncLock, { timeoutMs: 0 }).result).toBe(result);
    expect(fs.existsSync(syncLock)).toBe(left);
  });

  it('bash and sync JS: an owner-less <lock> past the grace is taken out; younger is kept', () => {
    const old = lockIn('old');
    fs.mkdirSync(old, { recursive: true });
    ageDir(old, 61_000);
    expect(sh(`LOCK_OWNERLESS_GRACE_MS=60000\nlock_recover_only "$LK" "$(machine_lock_queue_of "$LK")" 0; echo "$LRO_RESULT"`, { LK: old }).out).toBe('removed');
    const young = lockIn('young');
    fs.mkdirSync(young, { recursive: true });
    ageDir(young, 59_000);
    expect(lockSync.recoverIfDead(young, { timeoutMs: 0, ownerlessGraceMs: 60_000 }).result).toBe('kept');
    ageDir(young, 61_000);
    expect(lockSync.recoverIfDead(young, { timeoutMs: 0, ownerlessGraceMs: 60_000 }).result).toBe('removed');
  });

  it('a live lock put in after the judgement (recover-only-judged) is put back, not removed — bash and sync JS', async () => {
    const lock = lockIn('bash');
    writeKv(lock, { pid: deadPid(), token: 'dead' });
    const dir = fs.mkdtempSync(path.join(root, 'pause-'));
    const guard = shBg(`${KV}lock_recover_only "$LK" "$(machine_lock_queue_of "$LK")" 0; echo "$LRO_RESULT"`, {
      LK: lock,
      CM_VERIFY_TEST_HANDOFF: 'pause:recover-only-judged',
      CM_VERIFY_TEST_HANDOFF_DIR: dir,
    });
    let out = '';
    guard.stdout?.on('data', (d) => (out += String(d)));
    expect(await until(() => fs.existsSync(path.join(dir, 'recover-only-judged.reached')))).toBe(true);
    fs.rmSync(lock, { recursive: true });
    writeKv(lock, { pid: process.pid, token: 'new' });
    fs.writeFileSync(path.join(dir, 'recover-only-judged.go'), '');
    await new Promise((resolve) => guard.on('exit', resolve));
    expect(out.trim()).toBe('kept');
    expect(tokenOf(lock)).toBe('new');
    expect(gones(lock)).toEqual([]);

    const syncLock = lockIn('sync');
    writeOwner(syncLock, { pid: deadPid(), host: HOST, token: 'dead', acquiredAt: 0 });
    const res = lockSync.recoverIfDead(syncLock, {
      timeoutMs: 0,
      hooks: {
        onRecover: (stage: string) => {
          if (stage !== 'recover-only-judged') return;
          fs.rmSync(syncLock, { recursive: true });
          writeOwner(syncLock, { pid: process.pid, host: HOST, token: 'new', acquiredAt: 0 });
        },
      },
    });
    expect(res.result).toBe('kept');
    expect(JSON.parse(ownerOf(syncLock) ?? '{}').token).toBe('new');
  });
});

describe('D7 (loader): supervisor.lock\'s lstart — a reused pid is gone, in the lock and in a moved-aside record alike', () => {
  const lstartOf = (pid: number) => spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).stdout.trim();

  it.each([
    { form: 'another lstart (the pid was reused)', lstart: () => 'Thu Jan  1 00:00:00 1970', result: 'removed' },
    { form: 'the same lstart (the holder itself)', lstart: (pid: number) => lstartOf(pid), result: 'kept' },
  ])('the lock: $form → $result', ({ lstart, result }) => {
    const lock = lockIn();
    const pid = liveGroup();
    writeKv(lock, { pid, token: 'sup', lstart: lstart(pid) });
    expect(sh(`${KV}lock_recover_only "$LK" "$(machine_lock_queue_of "$LK")" 0; echo "$LRO_RESULT"`, { LK: lock }).out).toBe(result);
  });

  it('ps that cannot say is unknown: kept, and named', () => {
    const lock = lockIn();
    writeKv(lock, { pid: liveGroup(), token: 'sup', lstart: 'Thu Jan  1 00:00:00 1970' });
    const r = sh(`${KV}lock_recover_only "$LK" "$(machine_lock_queue_of "$LK")" 0; echo "$LRO_RESULT $LRO_UNKNOWN"`, { LK: lock, CM_VERIFY_TEST_OBS_FAULT: 'lstart=EIO' });
    expect(r.out).toBe(`kept point=lstart path=${lock} errno=EIO`);
  });

  it('a moved-aside record with a reused pid is settled and the lock taken in one call; positive control: lock_settle_gone judging by lock_holder_state keeps it', () => {
    const lock = lockIn();
    const pid = liveGroup();
    const gone = `${lock}.gone-xx-1`;
    writeKv(gone, { pid, token: 'sup-old', lstart: 'Thu Jan  1 00:00:00 1970' });
    const legacy = mutatedBash(root, (s) => s.replace('    lsg_state=$(lock_record_state)', '    lsg_state=$(lock_holder_state "$LOB_PID" "$LOB_HOST" "$LOB_PGID")'));
    // Read alive: put back as the lock, and the acquisition refused.
    expect(sh(`${KV}${ACQ}`, { LK: lock }, { verifyRun: legacy }).out).toMatch(/^refused/);
    expect(tokenOf(lock)).toBe('sup-old');
    fs.rmSync(lock, { recursive: true, force: true });
    writeKv(gone, { pid, token: 'sup-old', lstart: 'Thu Jan  1 00:00:00 1970' });
    expect(sh(`${KV}${ACQ}`, { LK: lock }).out).toBe('acquired');
    expect(gones(lock)).toEqual([]);
  });
});

describe('D9 (review-4288h P2-2): the protected process starts only after its group is on record', () => {
  /** A parent that takes the lock, forks the child (its own group, waiting for go) and hands over. */
  const parent = (form: 'daily' | 'uat', work: string) => `${KV}${ACQ}
D=$WORK
set -m
( lock_child_wait "$D/go" "$D/ack" $(( $(date +%s) + 30 )) $$ || exit 125; exec sh -c '${work}' "$D" ) &
G=$!
set +m
echo "$G" > "$D/group"
lock_hand_off "$LK" "$LOCK_TOKEN" ${form === 'uat' ? '"$G"' : '$$'} "$G"
[ -z "$LHO_STAGE" ] || { echo "stage=$LHO_STAGE"; exit 1; }
lock_test_pause published
mkdir "$D/go"
lock_test_pause signalled
wait "$G"
`;

  it('tmp (before the publish): the parent killed, the next taker may take — and the old child never starts its work', async () => {
    const lock = lockIn();
    const work = fs.mkdtempSync(path.join(root, 'work-'));
    const p = shBg(parent('daily', 'echo started > "$0/started"; exec sleep 60'), { LK: lock, WORK: work, CM_VERIFY_TEST_HANDOFF: 'pause:tmp', CM_VERIFY_TEST_HANDOFF_DIR: work });
    expect(await until(() => fs.existsSync(path.join(work, 'tmp.reached')))).toBe(true);
    process.kill(p.pid as number, 'SIGKILL');
    const g = Number(readText(path.join(work, 'group')));
    expect(await until(() => pidGone(p.pid as number) && !groupAlive(g))).toBe(true);
    expect(sh(`${KV}${ACQ}`, { LK: lock }).out).toBe('acquired');
    expect(fs.existsSync(path.join(work, 'started'))).toBe(false);
    expect(fs.existsSync(path.join(work, 'ack'))).toBe(false);
  });

  it.each(['daily', 'uat'] as const)('published (%s): the group on record keeps the lock while any member lives', async (form) => {
    const lock = lockIn();
    const work = fs.mkdtempSync(path.join(root, 'work-'));
    // The work: a member that outlives the group's leader (UAT: the server's own child).
    const p = shBg(parent(form, 'sleep 60 & echo started > "$0/started"; wait'), { LK: lock, WORK: work, CM_VERIFY_TEST_HANDOFF: 'pause:signalled', CM_VERIFY_TEST_HANDOFF_DIR: work });
    expect(await until(() => fs.existsSync(path.join(work, 'signalled.reached')))).toBe(true);
    expect(await until(() => fs.existsSync(path.join(work, 'started')))).toBe(true);
    const g = Number(readText(path.join(work, 'group')));
    // daily: the parent (the recorded pid) dies. UAT: `up` is over and the group's leader (the
    // recorded pid: the server) dies — its own child goes on in the group.
    process.kill(p.pid as number, 'SIGKILL');
    expect(await until(() => pidGone(p.pid as number))).toBe(true);
    if (form === 'uat') {
      process.kill(g, 'SIGKILL');
      expect(await until(() => pidGone(g))).toBe(true);
    }
    expect(groupAlive(g)).toBe(true);
    expect(sh(`${KV}${ACQ}`, { LK: lock }).out).toMatch(/^refused/);
    process.kill(-g, 'SIGKILL');
    expect(await until(() => !groupAlive(g))).toBe(true);
    expect(sh(`${KV}${ACQ}`, { LK: lock }).out).toBe('acquired');
  });

  it('positive control: the pid handed over without the group (the pre-#4288 set_pid) is taken while the work still runs', async () => {
    const lock = lockIn();
    const work = fs.mkdtempSync(path.join(root, 'work-'));
    const legacy = `${KV}${ACQ}
set -m
( exec sh -c 'echo started > "$0/started"; exec sleep 60' "$WORK" ) &
G=$!
set +m
echo "$G" > "$WORK/group"
printf '%s\\n' "$(lock_format_owner $$ "$LOCK_TOKEN" 1)" > "$LK/owner.tmp" && mv -f "$LK/owner.tmp" "$LK/owner"
: > "$WORK/handed"
wait "$G"
`;
    const p = shBg(legacy, { LK: lock, WORK: work });
    expect(await until(() => fs.existsSync(path.join(work, 'handed')) && fs.existsSync(path.join(work, 'started')))).toBe(true);
    process.kill(p.pid as number, 'SIGKILL');
    const g = Number(readText(path.join(work, 'group')));
    expect(await until(() => pidGone(p.pid as number))).toBe(true);
    expect(groupAlive(g)).toBe(true);
    expect(sh(`${KV}${ACQ}`, { LK: lock }).out, 'taken while the old work runs').toBe('acquired');
  });
});

describe('D12 and review-4288h P3: the holder\'s own release, and the end state of a handover that failed part way', () => {
  const held = (body: string, env: Record<string, string> = {}) => sh(`${KV}${ACQ}${body}`, env);

  it('normal: removed; twice: the second does nothing (a later mkdir-only <lock> stays)', () => {
    const lock = lockIn();
    const r = held(`lock_release_held "$LK"; echo "1=$LRH_RESULT"; mkdir "$LK"; lock_release_held "$LK"; echo "2=$LRH_RESULT"`, { LK: lock });
    expect(r.out.split('\n')).toEqual(['acquired', '1=released', '2=none']);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it.each([
    { form: 'another token', make: `printf 'pid=%s\\ntoken=successor\\n' $$ > "$LK/owner"`, check: (lock: string) => tokenOf(lock) === 'successor' },
    { form: 'missing (another taker between its mkdir and its owner)', make: 'rm -f "$LK/owner"', check: (lock: string) => fs.existsSync(lock) },
    { form: 'corrupt (no token)', make: `printf 'pid=%s\\n' $$ > "$LK/owner"`, check: (lock: string) => fs.existsSync(path.join(lock, 'owner')) },
  ])('$form: the canonical lock is not removed', ({ make, check }) => {
    const lock = lockIn();
    const r = held(`${make}\nlock_release_held "$LK"; echo "$LRH_RESULT"`, { LK: lock });
    expect(r.out.split('\n')[1]).toBe('kept');
    expect(check(lock)).toBe(true);
  });

  // #4288 PR1a-f (design §3.1, §5.1): lock_release's missing branch keeps the <lock> now, as
  // lock_release_held does — the expectation of this former positive control is reversed (消す側から消さ
  // ない側へ). The name is kept (the contract's decision): it names what the pre-PR1a-f section did.
  it('positive control: verify-run.sh\'s lock_release on a missing owner removes the other taker\'s <lock>', () => {
    const lock = lockIn();
    held(`T=$LOCK_TOKEN; rm -f "$LK/owner"; lock_release "$LK" "$T"; echo done`, { LK: lock });
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('a group that has a member keeps the lock (release-deferred); the drain empties it with the section\'s KILL_GRACE_SEC, and then it goes', () => {
    const lock = lockIn();
    const r = held(
      `set -m
( trap '' TERM; exec sleep 60 ) &
G=$!
set +m
lock_hand_off "$LK" "$LOCK_TOKEN" $$ "$G"
echo "stage=[$LHO_STAGE]"
LOCK_HELD_PATH_SAVED=$LOCK_HELD_PATH
lock_release_held "$LK"; echo "held=$LRH_RESULT"
s=$(date +%s); if lock_drain_group "$G" 0; then echo drained; fi; echo "took=$(( $(date +%s) - s ))"
LOCK_HELD_PATH=$LOCK_HELD_PATH_SAVED; LOCK_PENDING_TOKEN="$LOCK_TOKEN-g$G"
lock_release_held "$LK"; echo "after=$LRH_RESULT"`,
      { LK: lock },
    );
    const lines = r.out.split('\n');
    expect(lines.slice(0, 3)).toEqual(['acquired', 'stage=[]', 'held=deferred']);
    expect(lines[3]).toBe('drained');
    expect(Number(/took=(\d+)/.exec(lines[4])?.[1])).toBeGreaterThanOrEqual(4);
    expect(lines[5]).toBe('after=released');
    expect(fs.existsSync(lock)).toBe(false);
  }, 30000);

  it.each<{ stage: string; env: Record<string, string>; record: string }>([
    { stage: 'tmp', env: { CM_VERIFY_TEST_HANDOFF: 'fault:tmp' }, record: 'T0' },
    { stage: 'mv', env: { CM_VERIFY_TEST_OBS_FAULT: 'handoff-publish=EIO' }, record: 'T0' },
    { stage: 'verify', env: { CM_VERIFY_TEST_OBS_FAULT: 'handoff-verify=EIO' }, record: 'T1' },
  ])('daily form, failed at $stage ($record on record): lock_release_held removes it (the recorded pid is the caller)', ({ stage, env, record }) => {
    const lock = lockIn();
    const r = held(`lock_hand_off "$LK" "$LOCK_TOKEN" $$ ${deadPid()}; echo "stage=$LHO_STAGE"; sed -n 's/^token=//p' "$LK/owner"; lock_release_held "$LK"; echo "$LRH_RESULT"`, { LK: lock, ...env });
    const [, st, token, result] = r.out.split('\n');
    expect(st).toBe(`stage=${stage}`);
    expect(/-g\d+$/.test(token)).toBe(record === 'T1');
    expect(result).toBe('released');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('UAT form, published and the server (the recorded pid) stopped: needs-head, then lock_release_as_head removes it', () => {
    const lock = lockIn();
    const server = deadPid();
    const r = held(
      `lock_hand_off "$LK" "$LOCK_TOKEN" ${server} ${server}; T0=$LOCK_TOKEN; T1=$LHO_TOKEN
lock_release_held "$LK"; echo "held=$LRH_RESULT"
lock_release_as_head "$LK" "$(machine_lock_queue_of "$LK")" 10 "$T0" "$T1"; echo "head=$LRAH_RESULT"`,
      { LK: lock, CM_VERIFY_TEST_OBS_FAULT: 'handoff-verify=EIO' },
    );
    expect(r.out.split('\n').slice(1)).toEqual(['held=needs-head', 'head=released']);
    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe('the loader (scripts/lib/machine-lock.sh)', () => {
  it('review-4288h P2-1: under set -u with nothing set, the operations\' settings come with the section (verify-run.sh\'s own values)', () => {
    const r = sh('echo "$KILL_GRACE_SEC $HANDOFF_WAIT_SEC $LOCK_POLL_SEC [$LOCK_OWNERLESS_GRACE_MS] [$LOCK_OWNER_CODEC]"');
    expect(r.out).toBe('5 30 0.25 [] []');
    const source = fs.readFileSync(path.join(REPO, '.claude/skills/cmate-verify/scripts/verify-run.sh'), 'utf8');
    const section = source.slice(source.indexOf('# --- machine-wide gate lock'), source.indexOf('# --- gate execution'));
    expect(section).toMatch(/^KILL_GRACE_SEC=5$/m);
    expect(source.match(/^KILL_GRACE_SEC=/gm)).toHaveLength(1);
  });

  it('positive control (P2-1): a section without KILL_GRACE_SEC drains a TERM-ignoring group with no grace at all', () => {
    const legacy = mutatedBash(root, (s) => s.replace(/\nKILL_GRACE_SEC=5\n/, '\n'));
    const drain = `set -m
( trap '' TERM; exec sleep 60 ) &
G=$!
set +m
s=$(date +%s); lock_drain_group "$G" 0; echo "took=$(( $(date +%s) - s ))"`;
    const tookOf = (out: string) => Number(/took=(\d+)/.exec(out)?.[1]);
    expect(tookOf(sh(drain, {}, { verifyRun: legacy }).out), 'KILL at once: the grace was 0').toBeLessThanOrEqual(2);
    expect(tookOf(sh(drain).out), 'the section\'s own 5 s grace').toBeGreaterThanOrEqual(4);
  }, 30000);

  it('is loaded once: a second source keeps the first load\'s state', () => {
    const r = sh(`LOCK_TICKET=kept-by-first-load\n. '${LOADER}'; echo "$? $LOCK_TICKET $MACHINE_LOCK_LOADED"`);
    expect(r.out).toBe('0 kept-by-first-load 1');
  });

  it.each([
    { form: 'without the end marker', edit: (s: string) => s.replace('# --- gate execution', '# --- gate run') },
    { form: 'with the begin marker twice', edit: (s: string) => s.replace('# --- gate execution', '# --- machine-wide gate lock (again)\n# --- gate execution') },
  ])('a verify-run.sh $form fails the source (the caller takes nothing)', ({ edit }) => {
    const bad = mutatedBash(root, edit);
    const r = spawnSync('bash', ['-c', `set -u\nMACHINE_LOCK_VERIFY_RUN='${bad}'\n. '${LOADER}' || { echo LOAD-FAILED; exit 3; }\necho loaded`], { encoding: 'utf8', env: baseEnv({}) });
    expect(r.stdout.trim()).toBe('LOAD-FAILED');
    expect(r.status).toBe(3);
  });

  it('verify-run.sh\'s copies stay byte-identical', () => {
    const a = fs.readFileSync(path.join(REPO, '.claude/skills/cmate-verify/scripts/verify-run.sh'));
    const b = fs.readFileSync(path.join(REPO, '.agents/skills/cmate-verify/scripts/verify-run.sh'));
    expect(a.equals(b)).toBe(true);
  });
});
