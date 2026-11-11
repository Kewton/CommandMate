/**
 * Issue #4288 PR1a-f impl-10 — the test seams verify-run.sh's lock section gained (PM の追記 3) and the
 * harness pieces of the closing conditions, each off by default (the default is today's behaviour):
 *
 *   - CM_VERIFY_TEST_KILL_GRACE_SEC / CM_VERIFY_TEST_KILL_WAIT_SEC: the drain's grace and the wait after KILL
 *     (B16 / B17 for PR1b; A6 / D12 here). Unset: KILL_GRACE_SEC=5, LOCK_KILL_WAIT_SEC=2.
 *   - CM_VERIFY_TEST_DRAIN_LOG: the drain's steps (term / term-sent / kill / drained / left / empty).
 *   - lock_now_sec: the drain's clock, redefinable after the load like lock_now_ms.
 *   - `<point>@@<target>=<ERRNO>`: a fault on the whole target only (B3: `@` is a substring match).
 *   - mark:<stage>: a mark that does not wait — lock_child_wait marks `child-withdrew` before it withdraws
 *     (the holder-group test can wait for the child instead of sleeping 2.5 s).
 *   - the temp-directory guard remembers the paths it made (A11), and the harness's fault parser reads `@@`.
 *
 * Every root is under os.tmpdir(); nothing under ~/.commandmate.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import * as fsNs from 'node:fs';
import { mkdtempSync as namedMkdtemp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, assertWithinLimit, deadPid, drivenDrainClock, faultFn, killStarted, removeRoot } from './lock-4288-harness';
import { guardTmpDirCount, trackTmpDirs } from './tmp-leak-guard-4288';

guardTmpDirCount(['lock-seams-4288-']);

const LOADER = path.join(REPO, 'scripts/lib/machine-lock.sh');

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-seams-4288-'));
});
afterEach(() => {
  killStarted();
  removeRoot(root);
});

function sh(script: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', `set -u\n. '${LOADER}' || { echo LOAD-FAILED; exit 3; }\n${script}`], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      CM_VERIFY_LOCK_ROOT: path.join(root, 'verify-root'),
      CM_VERIFY_TEST_OBS_FAULT: '',
      CM_VERIFY_TEST_HANDOFF: '',
      CM_VERIFY_TEST_HANDOFF_DIR: '',
      CM_VERIFY_TEST_KILL_GRACE_SEC: '',
      CM_VERIFY_TEST_KILL_WAIT_SEC: '',
      CM_VERIFY_TEST_DRAIN_LOG: '',
      ...env,
    },
  });
  assertWithinLimit(r, 'sh (bash)', 30000);
  return (r.stdout ?? '').trim();
}

describe('the drain seams: off by default, the grace / the wait / the steps when a test sets them', () => {
  it('negative: unset, KILL_GRACE_SEC=5 and LOCK_KILL_WAIT_SEC=2; a value that is not digits is ignored', () => {
    expect(sh('echo "$KILL_GRACE_SEC $LOCK_KILL_WAIT_SEC"')).toBe('5 2');
    expect(sh('echo "$KILL_GRACE_SEC $LOCK_KILL_WAIT_SEC"', { CM_VERIFY_TEST_KILL_GRACE_SEC: '1s', CM_VERIFY_TEST_KILL_WAIT_SEC: '-1' })).toBe('5 2');
  });

  it('set: the grace and the wait after KILL come from the test', () => {
    expect(sh('echo "$KILL_GRACE_SEC $LOCK_KILL_WAIT_SEC"', { CM_VERIFY_TEST_KILL_GRACE_SEC: '0', CM_VERIFY_TEST_KILL_WAIT_SEC: '7' })).toBe('0 7');
  });

  it('negative: lock_now_sec is the real `date +%s` unless redefined', () => {
    const [a, b] = sh('echo "$(lock_now_sec) $(date +%s)"').split(' ').map(Number);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
  });

  it('an empty group: no log by default; with the log, one line `empty`', () => {
    const g = deadPid();
    expect(sh(`if lock_drain_group ${g} 0; then echo drained; fi`)).toBe('drained');
    const log = path.join(root, 'steps');
    expect(sh(`if lock_drain_group ${g} 0; then echo drained; fi`, { CM_VERIFY_TEST_DRAIN_LOG: log })).toBe('drained');
    expect(fs.readFileSync(log, 'utf8')).toBe('empty\n');
  });

  it('the grace set to 0 by the seam: TERM, no read of the grace, KILL (driven clock: 3 reads)', () => {
    const drain = drivenDrainClock(root);
    const ready = path.join(root, 'ready');
    const out = sh(
      `${drain.bashPre}set -m
( trap '' TERM; : > '${ready}'; exec sleep 60 ) &
G=$!
set +m
while [ ! -e '${ready}' ]; do sleep 0.01; done
if lock_drain_group "$G" 0; then echo drained; else echo left; fi`,
      { ...drain.env, CM_VERIFY_TEST_KILL_GRACE_SEC: '0' },
    );
    expect([out, drain.steps(), drain.reads()]).toEqual(['drained', ['term', 'kill', 'drained'], 2]);
  }, 30000);
});

describe('B3: `<point>@@<target>` is a whole-target match; `<point>@<sub>` stays a substring match', () => {
  it('bash: @@ hits only the whole pid, @ hits every pid containing it', () => {
    const probe = (spec: string) => sh('for t in 123 4123 1234; do lock_test_obs_fault kill0 "$t"; printf "%s=%s " "$t" "${LTF_CODE:--}"; done', { CM_VERIFY_TEST_OBS_FAULT: spec });
    expect(probe('kill0@@123=EPERM')).toBe('123=EPERM 4123=- 1234=-');
    expect(probe('kill0@123=EPERM')).toBe('123=EPERM 4123=EPERM 1234=EPERM');
    expect(probe('kill0=EPERM')).toBe('123=EPERM 4123=EPERM 1234=EPERM');
  });

  it('the TS / sync drives read the same spec (the harness parser)', () => {
    const exact = faultFn('kill0@@123=EPERM');
    expect([exact?.('kill0', '123'), exact?.('kill0', '4123'), exact?.('other', '123')]).toEqual(['EPERM', undefined, undefined]);
    const sub = faultFn('kill0@123=EPERM');
    expect([sub?.('kill0', '123'), sub?.('kill0', '4123')]).toEqual(['EPERM', 'EPERM']);
    expect(faultFn('restore-mkdir=EACCES')?.('restore-mkdir', '/x')).toBe('EACCES');
  });
});

describe('mark:child-withdrew — lock_child_wait marks its withdrawal (no wait), only when asked', () => {
  const wait = (env: Record<string, string>) =>
    sh(`D=$(mktemp -d '${root}/cw-XXXXXX'); if lock_child_wait "$D/go" "$D/ack" $(( $(date +%s) - 1 )) $$; then echo ran; else echo withdrew; fi`, env);

  it('a passed deadline: withdraws, and the mark is written', () => {
    const dir = fs.mkdtempSync(path.join(root, 'handoff-'));
    expect(wait({ CM_VERIFY_TEST_HANDOFF: 'mark:child-withdrew', CM_VERIFY_TEST_HANDOFF_DIR: dir })).toBe('withdrew');
    expect(fs.existsSync(path.join(dir, 'child-withdrew.reached'))).toBe(true);
  });

  it('the go that cannot be made (handoff-go=EACCES): withdraws, and the mark is written', () => {
    const dir = fs.mkdtempSync(path.join(root, 'handoff-'));
    expect(wait({ CM_VERIFY_TEST_HANDOFF: 'mark:child-withdrew', CM_VERIFY_TEST_HANDOFF_DIR: dir, CM_VERIFY_TEST_OBS_FAULT: 'handoff-go=EACCES' })).toBe('withdrew');
    expect(fs.existsSync(path.join(dir, 'child-withdrew.reached'))).toBe(true);
  });

  it('negative: not asked, nothing is written (and the answer is the same)', () => {
    const dir = fs.mkdtempSync(path.join(root, 'handoff-'));
    expect(wait({ CM_VERIFY_TEST_HANDOFF: '', CM_VERIFY_TEST_HANDOFF_DIR: dir })).toBe('withdrew');
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('A11: the temp-directory guard remembers what it made', () => {
  it('positive: a directory made and left is named; negative: one removed is not; another process\'s of the same prefix is not counted', () => {
    const prefix = `lock-seams-4288-guard-${process.pid}-`;
    const t = trackTmpDirs([prefix]);
    let left = '';
    let removed = '';
    try {
      left = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      removed = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      fs.rmSync(removed, { recursive: true });
      // Another run beside this one (another worktree, a precheck): the same prefix, not this process's.
      spawnSync(process.execPath, ['-e', `require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), ${JSON.stringify(prefix)}))`]);
    } finally {
      t.stop();
    }
    try {
      expect(t.made()).toEqual([left, removed]);
      expect(t.left()).toEqual([left]);
    } finally {
      for (const n of fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith(prefix))) fs.rmSync(path.join(os.tmpdir(), n), { recursive: true, force: true });
    }
  });

  it('every import form of node:fs is seen (default, namespace, named — the forms the #4288 files use)', () => {
    const prefix = `lock-seams-4288-forms-${process.pid}-`;
    const t = trackTmpDirs([prefix]);
    let made: string[] = [];
    try {
      made = [fs.mkdtempSync(path.join(os.tmpdir(), prefix)), fsNs.mkdtempSync(path.join(os.tmpdir(), prefix)), namedMkdtemp(path.join(os.tmpdir(), prefix))];
    } finally {
      t.stop();
      for (const d of made) fs.rmSync(d, { recursive: true, force: true });
    }
    expect(t.made()).toEqual(made);
    expect(t.left()).toEqual([]);
  });

  it('stop() puts the real mkdtempSync back (no directory is remembered after it)', () => {
    const prefix = `lock-seams-4288-stop-${process.pid}-`;
    const t = trackTmpDirs([prefix]);
    t.stop();
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.rmSync(d, { recursive: true });
    expect(t.made()).toEqual([]);
  });
});
