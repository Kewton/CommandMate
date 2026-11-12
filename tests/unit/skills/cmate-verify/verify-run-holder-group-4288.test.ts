/**
 * Issue #4288 (the first item): verify-run.sh publishes its gate's process group on the owner record
 * before the gate starts, and releases the lock only once that group is empty.
 *
 * Before, the owner named only the runner's pid. A gate runs in a group of its own (`set -m`), so
 * kill -9 to the runner alone left the gate running while every reader — bash, machine-lock.ts,
 * machine-lock-sync.mjs — judged the holder dead and took the lock: two gates on one resource
 * (dev-reports/issue/4288/repro-1.md). docs/design/verify-lock-holder-group-4288.md §2.2–§2.6.
 *
 * Every run here is a real verify-run.sh in a git repository under os.tmpdir(), with its lock root
 * (CM_VERIFY_LOCK_ROOT) and TMPDIR in the same temporary directory. The runner is started as the
 * leader of a group of its own so that afterEach can stop it and everything it left (the watchdog).
 * Positive controls run a copy of the script with the fix taken out (written under the same
 * temporary directory) and show the same steps let a reader in.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  IMPLS,
  VERIFY_RUN,
  groupAlive,
  killStarted,
  lockOf,
  mutatedBash,
  removeRoot,
  started,
  take,
  waitSync,
} from '../../verification/lock-4288-harness';

let root: string;
let repo: string;
let locks: string;
const runs: ChildProcess[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-holder-4288-'));
  repo = path.join(root, 'repo');
  locks = path.join(root, 'locks');
  fs.mkdirSync(path.join(root, 'tmp'));
  fs.mkdirSync(path.join(root, 'handoff'));
  fs.mkdirSync(repo);
  const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
});

afterEach(() => {
  for (const child of runs.splice(0)) {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  // Gate groups this file learned about.
  for (const g of gateGroups.splice(0)) {
    try {
      process.kill(-g, 'SIGKILL');
    } catch {
      // gone
    }
  }
  killStarted();
  removeRoot(root);
});

const gateGroups: number[] = [];

interface Gate {
  id?: string;
  command: string;
  timeoutSec?: number;
  retryOnFail?: boolean;
}

function config(gates: Gate[], mutex = 'holder'): string {
  for (const g of gates) if (g.command.includes('"')) throw new Error('the YAML subset has no escapes: no " in a command');
  const lines = ['version: 1', 'gates:'];
  for (const g of gates) {
    lines.push(`  - id: ${g.id ?? 'g'}`, `    command: "${g.command}"`, `    timeoutSec: ${g.timeoutSec ?? 60}`, `    mutex: ${mutex}`);
    if (g.retryOnFail) lines.push('    retryOnFail: 1');
  }
  lines.push('options:', '  skipInPrimaryCheckout: false');
  const file = path.join(root, `verify-${Math.random().toString(36).slice(2)}.yaml`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CM_VERIFY_LOCK_ROOT: locks,
    TMPDIR: path.join(root, 'tmp'),
    CM_VERIFY_TEST_HANDOFF_DIR: path.join(root, 'handoff'),
    MARK: root,
    ...extra,
  };
}

/** A whole run, synchronously. */
function runSync(gates: Gate[], extra: Record<string, string> = {}, script = VERIFY_RUN) {
  const r = spawnSync('bash', [script, '--config', config(gates), '--cwd', repo, '--skip-work-evidence', '--base-ref', 'HEAD'], {
    encoding: 'utf8',
    env: env(extra),
    timeout: 60000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A run in the background, leading its own group. */
function runAsync(gates: Gate[], extra: Record<string, string> = {}, script = VERIFY_RUN) {
  const out = path.join(root, `run-${runs.length}.out`);
  const err = path.join(root, `run-${runs.length}.err`);
  const child = spawn('bash', [script, '--config', config(gates), '--cwd', repo, '--skip-work-evidence', '--base-ref', 'HEAD'], {
    env: env(extra),
    detached: true,
    stdio: ['ignore', fs.openSync(out, 'w'), fs.openSync(err, 'w')],
  });
  runs.push(child);
  let exited: number | null | undefined;
  child.on('exit', (code) => {
    exited = code;
  });
  return {
    child,
    pid: child.pid as number,
    stdout: () => fs.readFileSync(out, 'utf8'),
    stderr: () => fs.readFileSync(err, 'utf8'),
    done: () => exited !== undefined,
    wait: async (ms = 30000) => {
      const until = Date.now() + ms;
      while (exited === undefined) {
        if (Date.now() > until) throw new Error('run did not end');
        await new Promise((r) => setTimeout(r, 20));
      }
      return exited;
    },
  };
}

const mark = (name: string) => path.join(root, name);
const handoff = (file: string) => path.join(root, 'handoff', file);
const lockPath = () => lockOf(locks, 'holder');
const owner = (): Record<string, unknown> | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockPath(), 'owner'), 'utf8'));
  } catch {
    return null;
  }
};
async function until(predicate: () => boolean, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The three readers, one after another; each releases what it took. */
async function readers(name = 'holder') {
  const out: Record<string, boolean> = {};
  for (const impl of IMPLS) out[impl] = (await take(impl, locks, name)).acquired;
  return out;
}
const NONE = { bash: false, ts: false, sync: false };
const ALL = { bash: true, ts: true, sync: true };

/** Remove the fix: the gate starts at the fork and the owner never names its group (the code before #4288). */
const withoutHandoff = (s: string) =>
  s
    .replace('  if [ -n "$rga_lock_token" ]; then\n    rga_go=', '  if false; then\n    rga_go=')
    .replace('  if [ -n "$rga_lock_token" ]; then\n    run_gate_handoff', '  if false; then\n    run_gate_handoff');

describe('R (repro-1): the runner alone killed while its gate runs', () => {
  const GATE = { command: 'touch $MARK/started; sleep 60' };

  it('positive: the owner names the gate\'s group under a new token, and no reader takes the lock while the gate lives', async () => {
    const run = runAsync([GATE]);
    await until(() => fs.existsSync(mark('started')));
    const o = owner()!;
    expect(o.pid).toBe(run.pid);
    expect(typeof o.pgid).toBe('number');
    const g = o.pgid as number;
    gateGroups.push(g);
    expect(String(o.token)).toMatch(new RegExp(`^${run.pid}-\\d+-\\d+-g${g}$`));
    expect(groupAlive(g)).toBe(true);
    // Control: the runner alive — nobody takes it, of course.
    expect(await readers()).toEqual(NONE);

    process.kill(run.pid, 'SIGKILL');
    await run.wait();
    expect(groupAlive(g), 'the gate outlived its runner').toBe(true);
    // The fix: pid gone, group alive — held, for all three readers.
    expect(await readers()).toEqual(NONE);
    expect(owner()!.token).toBe(o.token);

    process.kill(-g, 'SIGKILL');
    await until(() => !groupAlive(g));
    // The gate gone too: the next one takes it.
    expect(await readers()).toEqual(ALL);
  }, 60000);

  // PM review P3-5: the watchdog, not the test, stops the gate (design §2.6) — the runner alone killed,
  // the watchdog it left counts timeoutSec from the ack and empties G; then the lock is taken.
  it('the runner alone killed with a short timeoutSec: held while G lives, the watchdog stops G at the timeout, then all three take it', async () => {
    const run = runAsync([{ command: 'touch $MARK/started; sleep 60', timeoutSec: 3 }]);
    await until(() => fs.existsSync(mark('started')));
    const g = owner()!.pgid as number;
    gateGroups.push(g);
    process.kill(run.pid, 'SIGKILL');
    await run.wait();
    expect(groupAlive(g), 'the gate outlived its runner').toBe(true);
    const held = await take('ts', locks, 'holder');
    expect(held.acquired).toBe(false);
    expect(held.heldBy).toBe(`pid ${run.pid} on ${os.hostname()} (pgid ${g})`);
    // Nobody signals G here: only the watchdog can empty it.
    await until(() => !groupAlive(g), 15000);
    expect(fs.existsSync(lockPath()), 'the lock stays for the next reader to recover').toBe(true);
    expect(await readers()).toEqual(ALL);
    // The watchdog itself ends (the runner's group, which it was left in, empties).
    expect(waitSync(() => !groupAlive(run.pid), 10000)).toBe(true);
  }, 60000);

  it('positive control: a watchdog that never stops G leaves it running past the timeout (the test above is not vacuous)', async () => {
    const legacy = mutatedBash(root, (s) => s.replace('      : > "$rgh_mark"\n      kill -s TERM -- "-$rgh_pid" 2>/dev/null\n      sleep "$KILL_GRACE_SEC"\n      kill -s KILL -- "-$rgh_pid" 2>/dev/null\n', '      : > "$rgh_mark"\n'));
    const run = runAsync([{ command: 'touch $MARK/started; sleep 60', timeoutSec: 1 }], {}, legacy);
    await until(() => fs.existsSync(mark('started')));
    const g = owner()!.pgid as number;
    gateGroups.push(g);
    process.kill(run.pid, 'SIGKILL');
    await run.wait();
    await new Promise((r) => setTimeout(r, 3000));
    expect(groupAlive(g)).toBe(true);
    expect((await take('ts', locks, 'holder')).acquired).toBe(false);
  }, 60000);

  it('positive control: with the handoff taken out, a reader takes the lock while the old gate still runs', async () => {
    const legacy = mutatedBash(root, withoutHandoff);
    const run = runAsync([GATE], {}, legacy);
    await until(() => fs.existsSync(mark('started')));
    expect(owner()!.pgid).toBeUndefined();
    process.kill(run.pid, 'SIGKILL');
    await run.wait();
    const r = await take('ts', locks, 'holder', { keep: true });
    expect(r.acquired, 'the reader took the lock of a gate still running').toBe(true);
  }, 60000);
});

describe('§2.3 / §2.4: the gate starts only after its group is on record — a handoff that fails starts nothing', () => {
  const SIDE = { command: 'echo ran >> $MARK/side' };
  const sideCount = () => (fs.existsSync(mark('side')) ? fs.readFileSync(mark('side'), 'utf8').split('\n').filter(Boolean).length : 0);

  it('negative: without a fault the gate runs exactly once and the lock is released', () => {
    const r = runSync([SIDE]);
    expect(r.stdout).toContain('GATE g PASS exit=0');
    expect(sideCount()).toBe(1);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it.each([
    ['handoff-group', 'EIO', 'group'],
    ['handoff-token', 'EACCES', 'token'],
    ['handoff-publish', 'EIO', 'mv'],
    ['handoff-verify', 'EIO', 'verify'],
    ['handoff-signal', 'EACCES', 'signal'],
    ['handoff-ack', 'EACCES', 'ack'],
  ])('%s=%s: stage=%s, FAIL 125, nothing ran, not retried, the lock given back', (point, code, stage) => {
    const r = runSync([{ ...SIDE, retryOnFail: true }], { CM_VERIFY_TEST_OBS_FAULT: `${point}=${code}` });
    expect(r.stdout).toContain('GATE g FAIL exit=125');
    expect(r.stderr).toContain(`machine-lock-handoff-failed ${lockPath()} stage=${stage}`);
    expect(r.stderr).not.toContain('[flaky]');
    expect(sideCount()).toBe(0);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it('a tmp write that fails (fault:tmp): stage=tmp, nothing ran', () => {
    const r = runSync([SIDE], { CM_VERIFY_TEST_HANDOFF: 'fault:tmp' });
    expect(r.stderr).toContain('stage=tmp');
    expect(sideCount()).toBe(0);
  });

  it('handoff-self=EPERM: the child cannot tell its runner is alive, withdraws, and runs nothing (stage=abort)', async () => {
    const run = runAsync([SIDE], { CM_VERIFY_TEST_OBS_FAULT: 'handoff-self=EPERM', CM_VERIFY_TEST_HANDOFF: 'pause:published,mark:child-withdrew' });
    await until(() => fs.existsSync(handoff('published.reached')));
    // #4288 PR1a-f impl-11 (codex P2-2): the runner goes on once the child has withdrawn (its mark), not after 500 ms.
    await until(() => fs.existsSync(handoff('child-withdrew.reached')));
    fs.writeFileSync(handoff('published.go'), '');
    await run.wait();
    expect(run.stderr()).toContain('stage=abort');
    expect(sideCount()).toBe(0);
  }, 30000);

  it('the handoff deadline: a runner stopped (alive) before its signal — the child withdraws at the deadline, nothing runs, 125 not 124', async () => {
    const run = runAsync([SIDE], { CM_VERIFY_TEST_HANDOFF: 'pause:published,mark:child-withdrew', CM_VERIFY_TEST_HANDOFF_WAIT_SEC: '1' });
    await until(() => fs.existsSync(handoff('published.reached')));
    // #4288 PR1a-f impl-11 (codex P2-2): the runner is let go once the child has withdrawn at its deadline
    // (the mark), not 2.5 s later — a loaded child may not have seen its deadline by then.
    await until(() => fs.existsSync(handoff('child-withdrew.reached')));
    fs.writeFileSync(handoff('published.go'), '');
    await run.wait();
    expect(run.stdout()).toContain('GATE g FAIL exit=125');
    expect(run.stderr()).toContain('stage=abort');
    expect(sideCount()).toBe(0);
  }, 30000);

  it('handoff-go=EACCES: a child that cannot make its withdrawal and does not see the signal does not run (stage=ack)', async () => {
    const run = runAsync([SIDE], {
      CM_VERIFY_TEST_OBS_FAULT: 'handoff-go=EACCES',
      CM_VERIFY_TEST_HANDOFF: 'pause:published,mark:child-withdrew',
      CM_VERIFY_TEST_HANDOFF_WAIT_SEC: '1',
    });
    await until(() => fs.existsSync(handoff('published.reached')));
    // #4288 PR1a-f impl-11 (codex P2-2): the child's withdrawal (its go refused, the mark written), then the runner.
    await until(() => fs.existsSync(handoff('child-withdrew.reached')));
    fs.writeFileSync(handoff('published.go'), '');
    await run.wait();
    // The runner's own signal then succeeds, but no ack ever came: not started.
    expect(run.stderr()).toContain('stage=ack');
    expect(sideCount()).toBe(0);
  }, 30000);

  it('handoff-watch=EPERM: a watchdog that cannot tell the group is empty keeps watching (and signals nothing); told ESRCH it ends', async () => {
    const faultFile = path.join(root, 'faults');
    fs.writeFileSync(faultFile, 'handoff-watch=EPERM\n');
    const run = runAsync([SIDE], { CM_VERIFY_TEST_OBS_FAULT_FILE: faultFile, CM_VERIFY_TEST_HANDOFF: 'pause:watchdog' });
    await until(() => fs.existsSync(handoff('watchdog.reached')));
    process.kill(run.pid, 'SIGKILL');
    await run.wait();
    // The child sees its runner gone, withdraws; the gate's group empties. The runner's group (the
    // watchdog's) is still there because the watchdog cannot read the gate's group as empty.
    await new Promise((r) => setTimeout(r, 1500));
    expect(groupAlive(run.pid), 'the watchdog is still watching').toBe(true);
    expect(sideCount()).toBe(0);
    fs.writeFileSync(faultFile, '');
    expect(waitSync(() => !groupAlive(run.pid), 5000), 'told ESRCH, the watchdog ends').toBe(true);
  }, 30000);
});

describe('§2.4 / §2.6: the watchdog counts the timeout from the ack', () => {
  it('a handoff held up past timeoutSec does not kill the waiting child: the gate runs once, then times out (124)', async () => {
    const run = runAsync([{ command: 'echo ran >> $MARK/side; sleep 5', timeoutSec: 1 }], { CM_VERIFY_TEST_HANDOFF: 'pause:published' });
    await until(() => fs.existsSync(handoff('published.reached')));
    await new Promise((r) => setTimeout(r, 2000));
    fs.writeFileSync(handoff('published.go'), '');
    await run.wait();
    expect(run.stdout()).toContain('GATE g TIMEOUT exit=124');
    expect(fs.readFileSync(mark('side'), 'utf8')).toBe('ran\n');
  }, 30000);
});

describe('§2.5: released only once the gate\'s group is empty', () => {
  const LEAVES_CHILD = { command: "(trap '' TERM; exec sleep 30) & echo $! > $MARK/bg; exit 0" };

  it('a gate that leaves a TERM-ignoring child: held while it lives, the child stopped (KILL after the grace), then released', async () => {
    const drainLog = mark('drain-steps');
    const run = runAsync([LEAVES_CHILD], { CM_VERIFY_TEST_DRAIN_LOG: drainLog });
    await until(() => fs.existsSync(mark('bg')) && fs.readFileSync(mark('bg'), 'utf8').trim() !== '');
    const bg = Number(fs.readFileSync(mark('bg'), 'utf8'));
    // The leader has exited; the run drains the group — nobody takes the lock meanwhile. #4288 PR1a-f impl-11:
    // read once the drain has sent its TERM (its record), not after 300 ms.
    await until(() => fs.existsSync(drainLog) && fs.readFileSync(drainLog, 'utf8').startsWith('term\n'));
    expect((await take('ts', locks, 'holder')).acquired).toBe(false);
    await run.wait();
    expect(fs.readFileSync(drainLog, 'utf8')).toBe('term\nkill\ndrained\n');
    expect(run.stdout()).toContain('GATE g PASS exit=0');
    expect(run.stderr()).toMatch(/gate g left processes in group \d+; stopped them before releasing/);
    expect(waitSync(() => spawnSync('kill', ['-0', String(bg)]).status !== 0, 3000)).toBe(true);
    expect(fs.existsSync(lockPath())).toBe(false);
  }, 30000);

  it('negative: a gate that leaves nothing is released without waiting out the grace', () => {
    // #4288 PR1a-f impl-11 (codex P2-2): "without waiting out the grace" is the drain's record — the group
    // seen empty at once (`empty`: no TERM, no grace, no KILL) — not a run shorter than 4 s.
    const drainLog = mark('drain-steps');
    const r = runSync([{ command: 'true' }], { CM_VERIFY_TEST_DRAIN_LOG: drainLog });
    expect(r.stdout).toContain('GATE g PASS');
    expect(fs.readFileSync(drainLog, 'utf8')).toBe('empty\n');
    expect(fs.existsSync(lockPath())).toBe(false);
    expect(r.stderr).not.toContain('left processes');
  });

  it('a group that does not empty (fault:drain) keeps the lock past the end of the run: owner T1 + pgid, no reader takes it; empty, all do', async () => {
    const run = runAsync([LEAVES_CHILD], { CM_VERIFY_TEST_HANDOFF: 'fault:drain' });
    await run.wait();
    expect(run.stderr()).toContain('machine-lock-release-deferred');
    const o = owner()!;
    const g = o.pgid as number;
    gateGroups.push(g);
    expect(String(o.token)).toMatch(/-g\d+$/);
    expect(groupAlive(g)).toBe(true);
    expect(await readers()).toEqual(NONE);
    process.kill(-g, 'SIGKILL');
    await until(() => !groupAlive(g));
    expect(await readers()).toEqual(ALL);
  }, 30000);

  it('the same mutex\'s next gate in the same run: skipped (mutex-wait), not run beside the live group', () => {
    const r = runSync(
      [
        { id: 'first', ...LEAVES_CHILD },
        { id: 'second', command: 'echo ran >> $MARK/second', timeoutSec: 1 },
      ],
      { CM_VERIFY_TEST_HANDOFF: 'fault:drain' },
    );
    expect(r.stdout).toContain('GATE second SKIP reason=mutex-wait');
    expect(fs.existsSync(mark('second'))).toBe(false);
    gateGroups.push(owner()!.pgid as number);
  }, 30000);

  it.each([
    ['both guards taken out', true, true, true],
    ['only the undrained record taken out (the release check still holds it)', true, false, false],
    ['only the release check taken out (the undrained record still holds it)', false, true, false],
  ])('positive control — %s: the lock goes while the group lives = %s', async (_label, dropUndrained, dropCheck, expectTaken) => {
    const legacy = mutatedBash(root, (s) => {
      let out = s;
      if (dropUndrained) out = out.replace('    lock_note_undrained "$RGA_LOCK_PATH" "$rga_lock_token" "$rgh_pid"\n', '    :\n');
      if (dropCheck) out = out.replace('  if ! lock_group_is_empty "$LOB_PGID"; then\n    echo "verify-run: machine-lock-release-deferred $1 pgid=$LOB_PGID" >&2', '  if false; then\n    echo "verify-run: machine-lock-release-deferred $1 pgid=$LOB_PGID" >&2');
      return out;
    });
    const run = runAsync([LEAVES_CHILD], { CM_VERIFY_TEST_HANDOFF: 'fault:drain' }, legacy);
    await until(() => fs.existsSync(mark('bg')) && fs.readFileSync(mark('bg'), 'utf8').trim() !== '');
    const bgGroup = Number(spawnSync('ps', ['-o', 'pgid=', '-p', fs.readFileSync(mark('bg'), 'utf8').trim()], { encoding: 'utf8' }).stdout.trim());
    gateGroups.push(bgGroup);
    await run.wait();
    expect(groupAlive(bgGroup)).toBe(true);
    expect((await take('ts', locks, 'holder', { keep: true })).acquired).toBe(expectTaken);
  }, 30000);

  describe('EPERM from the group (synthetic: kill -0\'s answer replaced, the formula kept — 4th review P1 / 5th review P2)', () => {
    const EXITS = { command: 'exit 0' };

    it('positive: every group check answers EPERM — the drain cannot show the group empty, and the lock is kept past the end of the run', () => {
      const r = runSync([EXITS], { CM_VERIFY_TEST_OBS_FAULT: 'group=EPERM' });
      expect(r.stdout).toContain('GATE g PASS');
      expect(r.stderr).toContain('machine-lock-release-deferred');
      expect(fs.existsSync(lockPath())).toBe(true);
    }, 40000);

    it('negative: the same run with the group really empty (ESRCH) — released at once', () => {
      const r = runSync([EXITS]);
      expect(r.stdout).toContain('GATE g PASS');
      expect(fs.existsSync(lockPath())).toBe(false);
    });

    it('positive control: the 4th version\'s formula (any kill -0 failure = empty) releases under the same EPERM', () => {
      const legacy = mutatedBash(root, (s) =>
        s.replace('lock_group_is_empty() { # <pgid>\n  [ "$(lock_group_state "$1")" = gone ]\n}', 'lock_group_is_empty() { # <pgid>\n  case "$1" in \'\'|*[!0-9]*) return 0;; esac\n  lock_kill0_raw group "-$1"\n  [ "$LKR_RC" -ne 0 ]\n}'),
      );
      runSync([EXITS], { CM_VERIFY_TEST_OBS_FAULT: 'group=EPERM' }, legacy);
      expect(fs.existsSync(lockPath())).toBe(false);
    });

    it('the real OS text: a group of another user (root) is EPERM, and lock_group_is_empty says "not empty"', () => {
      const ps = spawnSync('ps', ['-axo', 'pgid=,uid='], { encoding: 'utf8' });
      const rootGroup = (ps.stdout ?? '').split('\n').map((l) => l.trim().split(/\s+/).map(Number)).find(([pgid, uid]) => uid === 0 && pgid > 1);
      if (!rootGroup || process.getuid?.() === 0) return;
      const r = spawnSync('bash', ['-c', `eval "$(sed -n '/^# --- machine-wide gate lock/,/^# --- gate execution/p' "$1")"; lock_group_is_empty "$2" && echo empty || echo occupied`, 'bash', VERIFY_RUN, String(rootGroup[0])], {
        encoding: 'utf8',
        env: { ...process.env, CM_VERIFY_LOCK_ROOT: locks },
      });
      expect(r.stdout.trim()).toBe('occupied');
    });
  });
});

describe('§2.6: the runner stopped (TERM) during the handoff or the gate', () => {
  it('between the publish and the signal: the trap knows the T1 record is its own, empties the group and releases', async () => {
    const run = runAsync([{ command: 'echo ran >> $MARK/side' }], { CM_VERIFY_TEST_HANDOFF: 'pause:published' });
    await until(() => fs.existsSync(handoff('published.reached')));
    expect(String(owner()!.token)).toMatch(/-g\d+$/);
    const g = owner()!.pgid as number;
    process.kill(run.pid, 'SIGTERM');
    await run.wait();
    expect(fs.existsSync(lockPath())).toBe(false);
    expect(groupAlive(g)).toBe(false);
    expect(fs.existsSync(mark('side'))).toBe(false);
  }, 30000);

  it('while the gate runs: the trap stops the gate\'s group, then releases', async () => {
    const run = runAsync([{ command: 'touch $MARK/started; sleep 30' }]);
    await until(() => fs.existsSync(mark('started')));
    const g = owner()!.pgid as number;
    gateGroups.push(g);
    process.kill(run.pid, 'SIGTERM');
    await run.wait();
    expect(groupAlive(g)).toBe(false);
    expect(fs.existsSync(lockPath())).toBe(false);
  }, 30000);

  it('a gate that ignores TERM: KILL after the grace, then released', async () => {
    const run = runAsync([{ command: "trap '' TERM; touch $MARK/started; sleep 30" }]);
    await until(() => fs.existsSync(mark('started')));
    const g = owner()!.pgid as number;
    gateGroups.push(g);
    process.kill(run.pid, 'SIGTERM');
    await run.wait();
    expect(groupAlive(g)).toBe(false);
    expect(fs.existsSync(lockPath())).toBe(false);
  }, 30000);
});

describe('§2.6: a retry never reuses the first attempt\'s tokens', () => {
  it('each attempt publishes its own T1 over its own T0', () => {
    const r = runSync([{ command: 'cat $CM_VERIFY_LOCK_ROOT/holder.lock/owner >> $MARK/owners; [ -f $MARK/once ] || { touch $MARK/once; exit 1; }', retryOnFail: true }]);
    expect(r.stdout).toContain('GATE g FLAKY');
    const tokens = fs.readFileSync(mark('owners'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).token as string);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
    for (const t of tokens) expect(t).toMatch(/-g\d+$/);
    expect(tokens[0].replace(/-g\d+$/, '')).not.toBe(tokens[1].replace(/-g\d+$/, ''));
    expect(fs.existsSync(lockPath())).toBe(false);
  });
});

void started;
