/**
 * Issue #4288 §2.7 / §4 — the readers (verify-run.sh's bash, machine-lock.ts, machine-lock-sync.mjs).
 *
 *   - Compatibility: an owner without a process group (every writer before #4288) and one with it
 *     (verify-run.sh's T1, merge-pr) × the three readers.
 *   - A moved-aside lock whose put-back failed is read as held while its record is alive: the
 *     §2.2 sequence (a record rewritten under a new token while a reader judged the old one), the
 *     put-back made to fail for real (the lock root read-only), the root given back.
 *   - Only names of the evacuation form are read (another mutex `a.lock.gone-b` is not mutex `a`'s).
 *   - Owners that cannot be read (chmod 000) are not free; owners that are missing are.
 *   - A put-back that stopped half way (§2.7 A / C) is completed or collected, never left to wedge.
 *
 * Positive controls load a copy of machine-lock-sync.mjs (or verify-run.sh) with §2.7 taken out.
 * Every root is under os.tmpdir().
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireMachineLock } from '@/lib/verification/machine-lock';
import * as lockSync from '../../../scripts/orchestrate/machine-lock-sync.mjs';
import {
  HOST,
  IMPLS,
  VERIFY_RUN,
  deadPid,
  goneEntries,
  isRoot,
  killStarted,
  liveGroup,
  lockOf,
  mutatedBash,
  mutatedSync,
  readOwnerToken,
  removeRoot,
  take,
  writeOwner,
} from './lock-4288-harness';
import type { Impl } from './lock-observation-scan-4288';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-gone-4288-'));
});
afterEach(() => {
  killStarted();
  removeRoot(root);
});

const goneDir = (name: string, suffix: string) => path.join(root, `${name}.lock.gone-${suffix}`);

describe('§4 compatibility: owners with and without the gate\'s group × the three readers', () => {
  const ROWS: { form: string; owner: () => Record<string, unknown>; taken: boolean }[] = [
    { form: 'old (no pgid), pid gone', owner: () => ({ pid: deadPid(), host: HOST, token: 'old', acquiredAt: 0 }), taken: true },
    { form: 'old (no pgid), pid alive', owner: () => ({ pid: process.pid, host: HOST, token: 'old-live', acquiredAt: 0 }), taken: false },
    { form: 'new T1, pid gone, group alive', owner: () => ({ pid: deadPid(), host: HOST, token: 't0-g1', acquiredAt: 0, pgid: liveGroup() }), taken: false },
    { form: 'new T1, pid gone, group gone', owner: () => ({ pid: deadPid(), host: HOST, token: 't0-g2', acquiredAt: 0, pgid: deadPid() }), taken: true },
    { form: 'new T1, pid alive, group gone', owner: () => ({ pid: process.pid, host: HOST, token: 't0-g3', acquiredAt: 0, pgid: deadPid() }), taken: false },
    { form: 'another host', owner: () => ({ pid: deadPid(), host: 'another-host', token: 'remote', acquiredAt: 0, pgid: deadPid() }), taken: false },
  ];
  const cases = ROWS.flatMap((row) => IMPLS.map((impl) => ({ ...row, impl })));

  it.each(cases)('$impl × $form → taken=$taken', async ({ impl, owner, taken }) => {
    const name = 'compat';
    const record = owner();
    writeOwner(lockOf(root, name), record);
    const r = await take(impl, root, name);
    expect(r.acquired).toBe(taken);
    if (!taken) expect(readOwnerToken(lockOf(root, name))).toBe(record.token);
    expect(goneEntries(root, name)).toEqual([]);
  }, 20000);
});

/**
 * The §2.2 sequence followed by a put-back that fails: a reader judged T0 (no group, pid gone) dead,
 * moved the lock aside — and found T1 (the gate's group, alive) there, because the runner published
 * it between the read and the move. The put-back's mkdir fails (the root read-only for a moment).
 */
async function recoverIntoFailedPutBack(
  impl: Impl,
  name: string,
  g: number,
  opts: { syncModule?: typeof lockSync; bashScript?: string; injected?: boolean } = {},
) {
  writeOwner(lockOf(root, name), { pid: deadPid(), host: HOST, token: 'T0', acquiredAt: 0 });
  const t1 = { pid: deadPid(), host: HOST, token: 'T0-g1', acquiredAt: 0, pgid: g };
  // The put-back's mkdir fails for real (the root read-only for a moment), or — `injected` — every
  // put-back mkdir of this reader answers EACCES while the root stays writable for its claim.
  const fault = opts.injected ? (point: string) => (point === 'restore-mkdir' ? 'EACCES' : undefined) : undefined;
  const onMoved = () => {
    const gone = goneEntries(root, name)[0];
    fs.writeFileSync(path.join(root, gone, 'owner'), JSON.stringify(t1));
    if (!opts.injected) fs.chmodSync(root, 0o555);
  };
  const giveBack = () => fs.chmodSync(root, 0o755);
  if (impl === 'ts') {
    let timer: NodeJS.Timeout | undefined;
    const r = await acquireMachineLock(name, {
      root,
      timeoutMs: 800,
      pollIntervalMs: 20,
      __testHooks: {
        fault,
        onRecover: (stage) => {
          if (stage !== 'moved') return;
          onMoved();
          timer = setTimeout(giveBack, 100);
        },
      },
    });
    clearTimeout(timer);
    giveBack();
    if (r.acquired) r.handle.release();
    return r.acquired;
  }
  if (impl === 'sync') {
    const mod = opts.syncModule ?? lockSync;
    let polls = 0;
    const r = mod.acquireMachineLockSync(name, {
      root,
      timeoutMs: 800,
      pollMs: 20,
      sleep: (ms: number) => {
        if (++polls === 3) giveBack();
        lockSync.sleepSync(ms);
      },
      hooks: { fault, onRecover: (stage: string) => (stage === 'moved' ? onMoved() : undefined) },
    });
    giveBack();
    if (r.acquired) r.release();
    return r.acquired;
  }
  // bash: stopped right after its move (pause:recover-moved), the record rewritten, then let go.
  const dir = path.join(root, '.handoff');
  fs.mkdirSync(dir);
  const driver = `
eval "$(sed -n '/^# --- machine-wide gate lock/,/^# --- gate execution/p' "$1")"
if lock_acquire "$2" 2; then echo acquired; lock_release "$LOCK_PATH" "$LOCK_TOKEN"; else echo not-acquired; fi`;
  const child = spawn('bash', ['-c', driver, 'bash', opts.bashScript ?? VERIFY_RUN, name], {
    env: {
      ...process.env,
      CM_VERIFY_LOCK_ROOT: root,
      CM_VERIFY_TEST_HANDOFF_DIR: dir,
      CM_VERIFY_TEST_HANDOFF: 'pause:recover-moved',
      CM_VERIFY_TEST_OBS_FAULT: opts.injected ? 'restore-mkdir=EACCES' : '',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const until = Date.now() + 10000;
  while (!fs.existsSync(path.join(dir, 'recover-moved.reached'))) {
    if (Date.now() > until) throw new Error('bash never reached recover-moved');
    await new Promise((r) => setTimeout(r, 10));
  }
  onMoved();
  fs.writeFileSync(path.join(dir, 'recover-moved.go'), '');
  await new Promise((r) => setTimeout(r, 400));
  giveBack();
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
  return out.trim() === 'acquired';
}

describe.skipIf(isRoot)('§2.7: a put-back that failed is read as held while its record lives', () => {
  it.each(IMPLS)('%s: neither the same reader nor a later one takes the lock while the group lives; the group gone, everything is collected', async (impl) => {
    const name = 'putback';
    const g = liveGroup();
    expect(await recoverIntoFailedPutBack(impl, name, g)).toBe(false);
    // A later reader of any implementation: still held (put back by now, or still moved aside).
    for (const other of IMPLS) expect((await take(other, root, name)).acquired, `${other} after ${impl}`).toBe(false);
    expect(readOwnerToken(lockOf(root, name)) ?? readOwnerToken(path.join(root, goneEntries(root, name)[0] ?? 'none'))).toBe('T0-g1');
    process.kill(-g, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 100));
    expect((await take(impl, root, name)).acquired).toBe(true);
    expect(goneEntries(root, name)).toEqual([]);
    expect(fs.existsSync(lockOf(root, name))).toBe(false);
  }, 30000);

  it.each(IMPLS)('%s: the put-back failing on every try (injected): the reader that failed it never claims past the record aside', async (impl) => {
    const g = liveGroup();
    expect(await recoverIntoFailedPutBack(impl, 'putback-injected', g, { injected: true })).toBe(false);
    expect(fs.existsSync(lockOf(root, 'putback-injected'))).toBe(false);
    expect(goneEntries(root, 'putback-injected')).toHaveLength(1);
  }, 30000);

  it('positive control (sync JS): with §2.7 taken out, the same reader claims the free path while the gate\'s group lives', async () => {
    const legacy = await mutatedSync(root, (s) => s.replace('const settled = settleGone(ctx);', 'const settled = { block: false };'));
    const g = liveGroup();
    expect(await recoverIntoFailedPutBack('sync', 'putback-legacy', g, { syncModule: legacy, injected: true })).toBe(true);
  }, 30000);

  it('positive control (bash): with §2.7 taken out, the same reader takes the lock once the root is writable again', async () => {
    const legacy = mutatedBash(root, (s) => s.replace('if [ -z "$la_blocker" ] && [ -z "$LOCK_UNKNOWN" ] && lock_settle_gone "$LOCK_PATH"; then', 'if [ -z "$la_blocker" ] && [ -z "$LOCK_UNKNOWN" ]; then'));
    const g = liveGroup();
    expect(await recoverIntoFailedPutBack('bash', 'putback-legacy', g, { bashScript: legacy })).toBe(true);
  }, 30000);
});

describe('§2.7 退避名の識別: only names of the evacuation form are read', () => {
  it.each(IMPLS)('%s: mutex `a` and mutex `a.lock.gone-b` never touch each other\'s lock', async (impl) => {
    const g = liveGroup();
    const other = writeOwner(lockOf(root, 'a.lock.gone-b'), { pid: deadPid(), host: HOST, token: 'X', acquiredAt: 0, pgid: g });
    fs.mkdirSync(path.join(root, 'a.lock.gone-1-2-3-4.lock'));
    fs.mkdirSync(path.join(root, `a.lock.gone-${'0'.repeat(8)}-1.queue`));
    const before = fs.readFileSync(path.join(other, 'owner'), 'utf8');
    const mtime = fs.statSync(path.join(other, 'owner')).mtimeMs;
    expect((await take(impl, root, 'a')).acquired).toBe(true);
    expect(fs.readFileSync(path.join(other, 'owner'), 'utf8')).toBe(before);
    expect(fs.statSync(path.join(other, 'owner')).mtimeMs).toBe(mtime);
    expect((await take(impl, root, 'a.lock.gone-b')).acquired).toBe(false);
    // The other way round: `a` held by a live holder, `a.lock.gone-b` taken and released beside it.
    process.kill(-g, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 100));
    writeOwner(lockOf(root, 'a'), { pid: process.pid, host: HOST, token: 'A', acquiredAt: 0 });
    expect((await take(impl, root, 'a.lock.gone-b')).acquired).toBe(true);
    expect(readOwnerToken(lockOf(root, 'a'))).toBe('A');
  }, 30000);

  it.each(IMPLS)('%s: a real evacuation name with a live record holds mutex `a`; a symlink of that name is not read', async (impl) => {
    const g = liveGroup();
    fs.symlinkSync(os.tmpdir(), path.join(root, 'a.lock.gone-x'));
    expect((await take(impl, root, 'a')).acquired).toBe(true);
    writeOwner(goneDir('a', '123-1700000000-45678-1'), { pid: deadPid(), host: HOST, token: 'T1', acquiredAt: 0, pgid: g });
    expect((await take(impl, root, 'a', { keep: true })).acquired).toBe(false);
  }, 30000);

  it('positive control (sync JS): a reader that takes every `<name>.lock.gone-*` moves another mutex\'s live owner into `a`', async () => {
    const legacy = await mutatedSync(root, (s) => s.replace('!GONE_SUFFIX_PATTERN.test(entry.slice(prefix.length))', 'false'));
    const g = liveGroup();
    writeOwner(lockOf(root, 'a.lock.gone-b'), { pid: deadPid(), host: HOST, token: 'X', acquiredAt: 0, pgid: g });
    await take('sync', root, 'a', { syncModule: legacy, keep: true });
    expect(readOwnerToken(lockOf(root, 'a'))).toBe('X');
    expect(fs.existsSync(lockOf(root, 'a.lock.gone-b'))).toBe(false);
  }, 30000);
});

describe.skipIf(isRoot)('§2.7 owners that cannot be read are not free; owners that are missing are', () => {
  it.each(IMPLS.flatMap((impl) => (['owner', 'dir'] as const).map((what) => ({ impl, what }))))('$impl: chmod 000 on the moved-aside $what — not taken; readable again: held while the group lives, taken once it is gone', async ({ impl, what }) => {
    const name = 'unreadable';
    const g = liveGroup();
    const gone = writeOwner(goneDir(name, '555-1'), { pid: deadPid(), host: HOST, token: 'T1', acquiredAt: 0, pgid: g });
    const target = what === 'owner' ? path.join(gone, 'owner') : gone;
    fs.chmodSync(target, 0o000);
    const r = await take(impl, root, name, { keep: true });
    fs.chmodSync(target, what === 'owner' ? 0o644 : 0o755);
    expect(r.acquired).toBe(false);
    expect(r.unknown).toMatch(/^point=gone-owner path=\S.* errno=EACCES$/);
    expect(fs.existsSync(lockOf(root, name))).toBe(false);
    expect((await take(impl, root, name)).acquired).toBe(false);
    process.kill(-g, 'SIGKILL');
    await new Promise((r2) => setTimeout(r2, 100));
    expect((await take(impl, root, name)).acquired).toBe(true);
    expect(goneEntries(root, name)).toEqual([]);
  }, 30000);

  it.each(IMPLS)('%s: a moved-aside directory with no owner (ENOENT) does not hold the lock, and is cleaned', async (impl) => {
    const name = 'missing';
    fs.mkdirSync(goneDir(name, '666-1'));
    expect((await take(impl, root, name)).acquired).toBe(true);
    expect(goneEntries(root, name)).toEqual([]);
  }, 20000);
});

describe('§2.7 a put-back stopped half way is completed or collected', () => {
  it.each(IMPLS)('%s: A (an empty lock + a live record aside) is completed: the record goes back into the lock', async (impl) => {
    const name = 'half-a';
    const g = liveGroup();
    fs.mkdirSync(lockOf(root, name));
    writeOwner(goneDir(name, '777-1'), { pid: deadPid(), host: HOST, token: 'T1', acquiredAt: 0, pgid: g });
    expect((await take(impl, root, name)).acquired).toBe(false);
    expect(readOwnerToken(lockOf(root, name))).toBe('T1');
    expect(goneEntries(root, name)).toEqual([]);
  }, 20000);

  it.each(IMPLS)('%s: A with the record gone: the empty lock and the record aside are collected and the lock is taken', async (impl) => {
    const name = 'half-a-dead';
    fs.mkdirSync(lockOf(root, name));
    writeOwner(goneDir(name, '777-1'), { pid: deadPid(), host: HOST, token: 'T1', acquiredAt: 0, pgid: deadPid() });
    expect((await take(impl, root, name)).acquired).toBe(true);
    expect(goneEntries(root, name)).toEqual([]);
    expect(fs.existsSync(lockOf(root, name))).toBe(false);
  }, 20000);

  it.each(IMPLS)('%s: C (the record back in the lock, an empty directory aside): the empty one never holds; the lock is recovered once the group is gone', async (impl) => {
    const name = 'half-c';
    writeOwner(lockOf(root, name), { pid: deadPid(), host: HOST, token: 'T1', acquiredAt: 0, pgid: deadPid() });
    fs.mkdirSync(goneDir(name, '888-1'));
    expect((await take(impl, root, name)).acquired).toBe(true);
    expect(goneEntries(root, name)).toEqual([]);
  }, 20000);

  it.each(IMPLS)('%s: a lock with another live owner is never removed by the collection of a dead record aside', async (impl) => {
    const name = 'half-other';
    writeOwner(lockOf(root, name), { pid: process.pid, host: HOST, token: 'LIVE', acquiredAt: 0 });
    writeOwner(goneDir(name, '999-1'), { pid: deadPid(), host: HOST, token: 'DEAD', acquiredAt: 0 });
    expect((await take(impl, root, name)).acquired).toBe(false);
    expect(readOwnerToken(lockOf(root, name))).toBe('LIVE');
  }, 20000);

  it('positive control (sync JS): with §2.7 taken out, A with the record gone wedges — the empty lock is never taken', async () => {
    const legacy = await mutatedSync(root, (s) => s.replace('const settled = settleGone(ctx);', 'const settled = { block: false };'));
    const name = 'half-legacy';
    fs.mkdirSync(lockOf(root, name));
    writeOwner(goneDir(name, '777-1'), { pid: deadPid(), host: HOST, token: 'T1', acquiredAt: 0, pgid: deadPid() });
    expect((await take('sync', root, name, { syncModule: legacy })).acquired).toBe(false);
  }, 20000);
});

describe('§2.7 row 7: release cleans only this acquisition\'s own record aside', () => {
  it.each(IMPLS)('%s: another holder\'s record aside stays', async (impl) => {
    const name = 'row7';
    const g = liveGroup();
    const r = await take(impl, root, name, {
      between: {
        fn: () => {
          fs.rmSync(lockOf(root, name), { recursive: true });
          writeOwner(goneDir(name, '1-1'), { pid: deadPid(), host: HOST, token: 'SOMEONE', acquiredAt: 0, pgid: g });
        },
        sh: `rm -rf "${lockOf(root, name)}"; mkdir "${goneDir(name, '1-1')}"; printf '{"pid":${deadPid()},"host":"${HOST}","token":"SOMEONE","acquiredAt":0,"pgid":${g}}' > "${goneDir(name, '1-1')}/owner"`,
      },
    });
    expect(r.acquired).toBe(true);
    expect(readOwnerToken(goneDir(name, '1-1'))).toBe('SOMEONE');
  }, 20000);
});
