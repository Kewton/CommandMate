/**
 * Issue #4288 — the fixes after the review of the first implementation (Codex 5-2b and the PM's
 * Claude review, workspace runs/2026-11-09 review-4288.md / pm-review-4288-claude.md):
 *
 *   - P1 / P2-2 (a) (d): bash judged the owner by reading its pgid a second time; a failure of that one
 *     read came back empty — "no group" — and a live group's lock was recovered. The judgement now uses
 *     lock_obs_owner's one read. The failure is injected into the pgid read alone.
 *   - P2-1 (PM): bash's kill -0 is read under LC_ALL=C. The raw text a translated C library prints for
 *     ESRCH is handed back through a seam (a kill in its place that answers in the locale it sees).
 *   - P2-1 (Codex): a moved-aside record of a dead holder is kept while it is unknown whether an empty
 *     <lock> is a put-back stopped half way (lock-list EIO): once the fault clears, the lock is taken.
 *   - P3-1: "held by" names the recorded process group.
 *   - P3-2: an owner that could not be written leaves no <lock> without an owner.
 *
 * Every root is a directory under os.tmpdir(); positive controls run copies of the implementation
 * with the fix taken out, written under the same directory.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  HOST,
  IMPLS,
  VERIFY_RUN,
  deadPid,
  goneEntries,
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
import { guardTmpDirCount } from './tmp-leak-guard-4288';

// Every temp directory this file makes is removed (counted before and after: pr1af-impl-9).
guardTmpDirCount(["lock-review-4288-"]);

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-review-4288-'));
});
afterEach(() => {
  killStarted();
  removeRoot(root);
});

const deadOwner = (token: string, extra: Record<string, unknown> = {}) => ({ pid: deadPid(), host: HOST, token, acquiredAt: 0, ...extra });

/** The first implementation's lock_record_state: the pid, host and pgid read again from the file. */
const SECOND_READ = (s: string) =>
  s.replace(
    'lock_record_state() { # (reads LOB_PID LOB_HOST LOB_PGID)\n  lock_holder_state "$LOB_PID" "$LOB_HOST" "$LOB_PGID"\n}',
    `lock_record_state() { # <file>
  lrs_pid=$(lock_json_field "$1" pid)
  lrs_host=$(lock_json_field "$1" host)
  if [ -z "$lrs_pid" ] || [ "$lrs_host" != "$LOCK_HOST" ]; then echo alive; return 0; fi
  lrs_p=$(lock_obs_kill0 pid "$lrs_pid")
  if [ "$lrs_p" != gone ]; then echo "$lrs_p"; return 0; fi
  lock_group_state "$(lock_json_field "$1" pgid)"
}`,
  ).replace('la_state=$(lock_record_state)', 'la_state=$(lock_record_state "$LOCK_PATH/owner")');

/** The read of the pgid fails (EIO swallowed by `2>/dev/null`: lock_json_field answers nothing) — and only it. */
const PGID_READ_FAILS = (s: string) =>
  s.replace(
    'lock_json_field() { # <file> <key>\n',
    'lock_json_field() { # <file> <key>\n  case "$2" in pgid) return 0;; esac\n',
  );

describe('Codex P1 / PM P2-2: the owner is judged from one read — a failed read of the pgid alone takes nothing', () => {
  it('bash: the pgid read failing alone, a live group keeps its lock', async () => {
    const name = 'pgid-read';
    const g = liveGroup();
    writeOwner(lockOf(root, name), deadOwner('t1-live-group', { pgid: g }));
    const r = await take('bash', root, name, { bashScript: mutatedBash(root, PGID_READ_FAILS) });
    expect(r.acquired).toBe(false);
    expect(readOwnerToken(lockOf(root, name))).toBe('t1-live-group');
    expect(g).toBeGreaterThan(1);
  }, 30000);

  it('positive control: the second read (the first implementation) recovers the live group\'s lock under the same failure', async () => {
    const name = 'pgid-read';
    const g = liveGroup();
    writeOwner(lockOf(root, name), deadOwner('t1-live-group', { pgid: g }));
    const legacy = mutatedBash(root, (s) => PGID_READ_FAILS(SECOND_READ(s)));
    const r = await take('bash', root, name, { bashScript: legacy, keep: true });
    expect(r.acquired, 'the second read took a failed pgid read as "no group"').toBe(true);
  }, 30000);

  it('negative control: without the failure the second read also holds — the failure is what made the difference', async () => {
    const name = 'pgid-read';
    writeOwner(lockOf(root, name), deadOwner('t1-live-group', { pgid: liveGroup() }));
    const r = await take('bash', root, name, { bashScript: mutatedBash(root, SECOND_READ) });
    expect(r.acquired).toBe(false);
  }, 30000);

  it.each(IMPLS)('%s: the group gone too (ESRCH from both), the lock is recovered', async (impl) => {
    const name = 'pgid-dead';
    writeOwner(lockOf(root, name), deadOwner('t1-dead-group', { pgid: deadPid() }));
    expect((await take(impl, root, name)).acquired).toBe(true);
  }, 30000);

  it('bash: a ticket is judged from one read too (lock_ticket_retirable reads the file once)', () => {
    const script = `
eval "$(sed -n '/^# --- machine-wide gate lock/,/^# --- gate execution/p' "$1")"
lock_ticket_retirable "$2" "$(lock_now_ms)" || echo kept
`;
    const queue = path.join(root, 'q.queue');
    fs.mkdirSync(queue);
    const ticket = path.join(queue, '000000000001');
    const run = (t: Record<string, unknown>) => {
      fs.writeFileSync(ticket, JSON.stringify(t));
      return spawnSync('bash', ['-c', script, 'bash', VERIFY_RUN, ticket], { encoding: 'utf8', env: { ...process.env, CM_VERIFY_LOCK_ROOT: root } }).stdout.trim();
    };
    const now = Date.now();
    expect(run({ pid: deadPid(), host: HOST, token: 'a', createdAt: now, deadline: now + 60000, pgid: liveGroup() })).toBe('kept');
    expect(run({ pid: deadPid(), host: HOST, token: 'a', createdAt: now, deadline: now + 60000, pgid: deadPid() })).toBe('gone');
    expect(run({ pid: deadPid(), host: HOST, token: 'a', createdAt: now, deadline: now + 60000 })).toBe('gone');
    // A ticket that cannot be read is never retired.
    fs.chmodSync(ticket, 0o000);
    const unreadable = spawnSync('bash', ['-c', script, 'bash', VERIFY_RUN, ticket], { encoding: 'utf8', env: { ...process.env, CM_VERIFY_LOCK_ROOT: root } }).stdout.trim();
    fs.chmodSync(ticket, 0o644);
    if (process.getuid?.() !== 0) expect(unreadable).toBe('kept');
  }, 30000);
});

describe('PM P2-1: bash reads kill -0 under LC_ALL=C — a translated ESRCH is not read as unknown', () => {
  /** A kill that prints ESRCH the way a C library translated to Japanese would, unless it runs under C. */
  const shim = () => {
    const file = path.join(root, 'kill-translated');
    fs.writeFileSync(
      file,
      `#!/bin/bash
case "\${LC_ALL:-\${LC_MESSAGES:-\${LANG:-}}}" in
  C|POSIX) msg="No such process";;
  *) msg="そのようなプロセスはありません";;
esac
if kill "$@" 2>/dev/null; then exit 0; fi
echo "bash: kill: ($3) - $msg" >&2
exit 1
`,
    );
    fs.chmodSync(file, 0o755);
    return file;
  };
  const translatedEnv = (): NodeJS.ProcessEnv => {
    // Empty, not deleted: take() spreads process.env first, and an empty LC_* is ignored by the locale.
    return { ...process.env, LANG: 'ja_JP.UTF-8', LC_ALL: '', LC_MESSAGES: '', CM_VERIFY_LOCK_ROOT: root, CM_VERIFY_TEST_KILL0_CMD: shim() };
  };
  const NO_C = (s: string) => s.split('export LC_ALL=C; ').join('');
  const observe = (script: string, target: number) =>
    spawnSync('bash', ['-c', 'eval "$(sed -n \'/^# --- machine-wide gate lock/,/^# --- gate execution/p\' "$1")"; lock_obs_kill0 pid "$2"; lock_group_state "$2"', 'bash', script, String(target)], {
      encoding: 'utf8',
      env: translatedEnv(),
    }).stdout.trim().split('\n');

  it('the shim does answer in Japanese outside C (the seam is not vacuous)', () => {
    const r = spawnSync(shim(), ['-0', '--', String(deadPid())], { encoding: 'utf8', env: translatedEnv() });
    expect(r.stderr).toContain('そのようなプロセスはありません');
  });

  it('fixed: ESRCH in Japanese reads as gone (the pid and the group)', () => {
    expect(observe(VERIFY_RUN, deadPid())).toEqual(['gone', 'gone']);
  });

  it('positive control: without LC_ALL=C the same text reads as unknown', () => {
    expect(observe(mutatedBash(root, NO_C), deadPid())).toEqual(['unknown:pid:EUNKNOWN', 'unknown:group:EUNKNOWN']);
  });

  it('negative control: a live pid stays alive either way', () => {
    expect(observe(VERIFY_RUN, process.pid)[0]).toBe('alive');
    expect(observe(mutatedBash(root, NO_C), process.pid)[0]).toBe('alive');
  });

  it('end to end: a dead holder\'s lock is recovered under the translated text; without LC_ALL=C it never is', async () => {
    const name = 'translated';
    writeOwner(lockOf(root, name), deadOwner('dead'));
    const env = Object.fromEntries(Object.entries(translatedEnv()).filter((e): e is [string, string] => typeof e[1] === 'string'));
    const legacy = await take('bash', root, name, { bashScript: mutatedBash(root, NO_C), env, keep: true });
    expect(legacy.acquired).toBe(false);
    expect(legacy.unknown).toMatch(/^point=pid path=\S+ errno=EUNKNOWN$/);
    expect(env.LC_ALL).toBe('');
    const fixed = await take('bash', root, name, { env });
    expect(fixed.acquired).toBe(true);
  }, 30000);
});

describe('Codex P2-1: the moved-aside record is kept while a half put-back is unknown — the lock is taken once the fault clears', () => {
  const setup = (name: string) => {
    // A put-back that stopped after its mkdir (§2.7 A): an empty <lock>, and the dead holder's record aside.
    fs.mkdirSync(lockOf(root, name));
    writeOwner(path.join(root, `${name}.lock.gone-111-1`), deadOwner('dead-gone'));
  };

  it.each(IMPLS)('%s: lock-list EIO keeps both and names the unknown; without the fault the next head takes the lock', async (impl) => {
    const name = 'half';
    setup(name);
    const injected = await take(impl, root, name, { fault: 'lock-list=EIO' });
    expect(injected.acquired).toBe(false);
    expect(fs.existsSync(lockOf(root, name))).toBe(true);
    expect(goneEntries(root, name)).toEqual([`${name}.lock.gone-111-1`]);
    expect(injected.unknown).toMatch(/^point=lock-list path=\S+ errno=EIO$/);
    const after = await take(impl, root, name);
    expect(after.acquired, 'the fault cleared: taken').toBe(true);
    expect(goneEntries(root, name)).toEqual([]);
  }, 30000);

  it.each(IMPLS)('%s: lock-owner EACCES on the empty <lock> keeps the record too', async (impl) => {
    const name = 'half-owner';
    setup(name);
    const injected = await take(impl, root, name, { fault: 'lock-owner=EACCES' });
    expect(injected.acquired).toBe(false);
    expect(goneEntries(root, name)).toEqual([`${name}.lock.gone-111-1`]);
    expect((await take(impl, root, name)).acquired).toBe(true);
  }, 30000);

  it('positive control (sync JS): reclaiming past the unknown deletes the record, and the empty <lock> is never taken back', async () => {
    const name = 'half';
    setup(name);
    const legacy = await mutatedSync(root, (s) => s.replace("if (half.state === 'unknown') return { kept: true, unknown: half.unknown };", ''));
    await take('sync', root, name, { fault: 'lock-list=EIO', syncModule: legacy });
    expect(goneEntries(root, name)).toEqual([]);
    expect(fs.existsSync(lockOf(root, name))).toBe(true);
    expect((await take('sync', root, name)).acquired, 'wedged: nobody removes a <lock> without an owner').toBe(false);
  }, 30000);

  it('positive control (bash): the same', async () => {
    const name = 'half';
    setup(name);
    const legacy = mutatedBash(root, (s) => s.replace('      unknown:*) return 1;;\n      yes) rmdir', '      unknown:*) ;;\n      yes) rmdir'));
    await take('bash', root, name, { fault: 'lock-list=EIO', bashScript: legacy });
    expect(goneEntries(root, name)).toEqual([]);
    expect((await take('bash', root, name)).acquired).toBe(false);
  }, 30000);
});

describe('P3-1: "held by" names the recorded process group', () => {
  it.each(IMPLS)('%s: a dead runner whose gate group lives — pid and (pgid G)', async (impl) => {
    const name = 'held';
    const g = liveGroup();
    const pid = deadPid();
    writeOwner(lockOf(root, name), { pid, host: HOST, token: 't1', acquiredAt: 0, pgid: g });
    const r = await take(impl, root, name);
    expect(r.acquired).toBe(false);
    expect(r.heldBy).toBe(`pid ${pid} on ${HOST} (pgid ${g})`);
  }, 30000);

  it.each(IMPLS)('%s negative: an owner without a group is shown as before', async (impl) => {
    const name = 'held-plain';
    writeOwner(lockOf(root, name), { pid: process.pid, host: HOST, token: 't0', acquiredAt: 0 });
    const r = await take(impl, root, name);
    expect(r.heldBy).toBe(`pid ${process.pid} on ${HOST}`);
  }, 30000);
});

describe('P3-2: an owner that could not be written leaves no <lock> without an owner', () => {
  it('bash: not acquired, the <lock> taken out again, and the next head takes it', async () => {
    const name = 'owner-write';
    const r = await take('bash', root, name, { env: { CM_VERIFY_TEST_HANDOFF: 'fault:owner' } });
    expect(r.acquired).toBe(false);
    expect(r.log).toContain(`machine-lock-owner-write-failed ${lockOf(root, name)}`);
    expect(fs.existsSync(lockOf(root, name))).toBe(false);
    expect((await take('ts', root, name)).acquired).toBe(true);
  }, 30000);

  it('positive control (bash): taking the lock past the failed write leaves an ownerless <lock> nobody takes', async () => {
    const name = 'owner-write';
    const legacy = mutatedBash(root, (s) => s.replace('if ! lock_test_fault owner && printf', 'if lock_test_fault owner || printf'));
    const r = await take('bash', root, name, { env: { CM_VERIFY_TEST_HANDOFF: 'fault:owner' }, bashScript: legacy, keep: true });
    expect(r.acquired).toBe(true);
    expect(fs.existsSync(path.join(lockOf(root, name), 'owner'))).toBe(false);
    for (const impl of IMPLS) expect((await take(impl, root, name)).acquired, impl).toBe(false);
  }, 30000);

  it.each(['ts', 'sync'] as const)('%s: the error still ends the acquisition, and the <lock> is taken out again', async (impl) => {
    const name = 'owner-write';
    const r = await take(impl, root, name, { fault: 'owner-write=ENOSPC' });
    expect(r.acquired).toBe(false);
    expect(r.error).toContain('ENOSPC');
    expect(fs.existsSync(lockOf(root, name))).toBe(false);
    expect((await take(impl, root, name)).acquired).toBe(true);
  }, 30000);
});
