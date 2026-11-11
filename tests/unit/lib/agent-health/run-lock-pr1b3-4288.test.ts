/**
 * #4288 PR1b-3 (after the first implementation review): positive controls, each red before its fix.
 *  - drain_members sends KILL only to pids that are still in the group it was asked to empty (P2-2);
 *  - `down` reads the older form from the state file (no lock_token), whatever the lock holds (P2-4).
 * Everything runs in a directory under os.tmpdir(); nothing outside it is touched.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REAL_SHELL_SUBPROCESS_TIMEOUT_MS, REAL_SHELL_TEST_TIMEOUT_MS, assertSubprocessCompleted } from '@tests/helpers/real-shell-budget';
import { removeTempDir } from '@tests/helpers/temp-dir';

const RUN_SERVER = path.resolve(__dirname, '../../../../scripts/uat/run-server.sh');

let root: string;
const spawned: ChildProcess[] = [];
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (check: () => boolean, ms = 15_000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-rl-pr1b3-'));
});
afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
    try {
      if (child.pid) process.kill(child.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  removeTempDir(root);
});

describe('#4288 PR1b-3 P2-2: the KILL after TERM goes only to a pid that is still in the group', () => {
  it('a member that ended during the grace (its number seen in another group) is not sent KILL; the one that ignored TERM is', async () => {
    // a group (leader L): p ends on TERM, q ignores it
    const pf = path.join(root, 'p.pid');
    const qf = path.join(root, 'q.pid');
    const leader = spawn(
      'bash',
      ['-c', `sleep 60 & echo $! > '${pf}'; (trap '' TERM; exec sleep 60) & echo $! > '${qf}'; wait`],
      { detached: true, stdio: 'ignore' }
    );
    spawned.push(leader);
    expect(await waitFor(() => fs.existsSync(pf) && fs.existsSync(qf) && fs.readFileSync(qf, 'utf8').trim() !== '')).toBe(true);
    const p = Number(fs.readFileSync(pf, 'utf8').trim());
    const q = Number(fs.readFileSync(qf, 'utf8').trim());
    const g = leader.pid!;
    const klog = path.join(root, 'kill.log');
    const flag = path.join(root, 'termed');
    const script = [
      `. '${RUN_SERVER}'`,
      // After the first grace tick, p's number is "reused" by a process of another group (ps says so).
      `sleep() { : > '${flag}'; command sleep "$@"; }`,
      `ps() { if [ -f '${flag}' ] && [ "$1" = -o ] && [ "$2" = pgid= ] && [ "$3" = -p ] && [ "$4" = ${p} ]; then echo 1; else command ps "$@"; fi; }`,
      `kill() { printf '%s\\n' "$*" >> '${klog}'; builtin kill "$@"; }`,
      `drain_members ${g} ${p} ${q}; echo "rc=$?"`,
    ].join('\n');
    const r = spawnSync('bash', ['-c', script], {
      env: { ...process.env, CM_RUN_LOCK_DIR: path.join(root, 'lock') },
      encoding: 'utf8',
      timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
    });
    assertSubprocessCompleted(r, 'drain_members');
    const sent = fs.readFileSync(klog, 'utf8').split('\n').filter((line) => line.startsWith('-s KILL'));
    expect(sent).toContain(`-s KILL ${q}`);
    expect(sent).not.toContain(`-s KILL ${p}`);
    // the group is empty afterwards (leader L itself was killed with the group only by the test's cleanup, so L stays: rc is about members)
    expect(isAlive(q)).toBe(false);
  }, REAL_SHELL_TEST_TIMEOUT_MS);
});

describe('#4288 PR1b-3 P2-4: a state file without lock_token is the older form whatever the lock holds', () => {
  const stateFile = (runDir: string, pid: number, extra = ''): string => {
    const file = path.join(runDir, 'uat-run.state');
    fs.writeFileSync(file, `run_id=oldrun-1\nrun_dir=${runDir}\nport=59871\nserver_pid=${pid}\nstatus=running\n${extra}`);
    return file;
  };
  const down = (runDir: string, lockDir: string) =>
    spawnSync('bash', ['-c', `. '${RUN_SERVER}'; down_procedure '${path.join(runDir, 'uat-run.state')}'; echo "rc=$? status=$DOWN_STATUS"`], {
      env: { ...process.env, CM_RUN_LOCK_DIR: lockDir },
      encoding: 'utf8',
      timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
    });
  const startServer = async (runDir: string): Promise<number> => {
    // not a group leader of its own (the older `up` did not make one), CM_DB_PATH under the run dir
    // node, not /bin/sleep: ps does not show the environment of a system binary (SIP)
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', env: { ...process.env, CM_DB_PATH: path.join(runDir, 'cm.db') } });
    spawned.push(child);
    expect(await waitFor(() => child.pid !== undefined && isAlive(child.pid))).toBe(true);
    return child.pid!;
  };
  const writeOther = (lockDir: string): void => {
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'owner'), `pid=${process.pid}\nhost=${os.hostname()}\ntoken=another-run\nstarted_at=2026-01-01T00:00:00Z\nlabel=uat\n`);
  };

  it.each(['absent', 'other'])('lock %s: the server (not the leader of a group) is stopped by its pid', async (kind) => {
    const runDir = path.join(root, 'run');
    fs.mkdirSync(runDir);
    const lockDir = path.join(root, 'lock');
    const pid = await startServer(runDir);
    stateFile(runDir, pid);
    if (kind === 'other') writeOther(lockDir);
    const r = down(runDir, lockDir);
    assertSubprocessCompleted(r, 'down_procedure');
    expect(await waitFor(() => !isAlive(pid))).toBe(true);
    if (kind === 'absent') expect(r.stdout).toContain('rc=0 status=stopped');
    // another run's record is never removed
    if (kind === 'other') expect(fs.existsSync(path.join(lockDir, 'owner'))).toBe(true);
  }, REAL_SHELL_TEST_TIMEOUT_MS);

  it('negative control: a state WITH lock_token still asks the server to lead its group (the new form)', async () => {
    const runDir = path.join(root, 'run');
    fs.mkdirSync(runDir);
    const lockDir = path.join(root, 'lock');
    const pid = await startServer(runDir);
    stateFile(runDir, pid, 'lock_token=oldrun-1-g99999\n');
    const r = down(runDir, lockDir);
    assertSubprocessCompleted(r, 'down_procedure');
    expect(r.stdout).toContain('status=stop-refused');
    expect(isAlive(pid)).toBe(true);
  }, REAL_SHELL_TEST_TIMEOUT_MS);
});

const RUN_LOCK_SH = path.resolve(__dirname, '../../../../scripts/uat/run-lock.sh');

describe('#4288 PR1b-3 P3: run_lock_set_pid I-6 (stage=arg) and the wording of a pid refusal', () => {
  const sh = (lockDir: string, body: string) =>
    spawnSync('bash', ['-c', `. '${RUN_LOCK_SH}'; ${body}`], {
      env: { ...process.env, CM_RUN_LOCK_DIR: lockDir, CM_RUN_LOCK_TOKEN: '' },
      encoding: 'utf8',
      timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
    });

  it('a readable record of T0 whose pid is not this shell is not rewritten: stage=arg, the owner and <go> are untouched', () => {
    const lockDir = path.join(root, 'lock');
    fs.mkdirSync(lockDir);
    const owner = `pid=${process.pid}\nhost=${os.hostname()}\ntoken=t0-tok\nstarted_at=2026-01-01T00:00:00Z\nlabel=uat\n`;
    fs.writeFileSync(path.join(lockDir, 'owner'), owner);
    const go = path.join(root, 'go');
    const r = sh(lockDir, `set -m; sleep 30 & C=$!; set +m; run_lock_set_pid t0-tok $$ "$C" '${go}'; echo "rc=$? stage=$RUN_LOCK_STAGE g=\${RUN_LOCK_G:-}"; echo "err=$RUN_LOCK_ERROR"; kill -9 "$C"`);
    assertSubprocessCompleted(r, 'run_lock_set_pid');
    expect(r.stdout).toContain('rc=1 stage=arg g=');
    expect(r.stdout).toMatch(/err=run-lock: the recorded pid \d+ is not this shell/);
    expect(fs.readFileSync(path.join(lockDir, 'owner'), 'utf8')).toBe(owner);
    expect(fs.existsSync(go)).toBe(false);
  });

  it('bash: a pid that is not $$ is refused with the reason (the pid), not as another run’s lock; nothing is made', () => {
    const lockDir = path.join(root, 'lock');
    const r = sh(lockDir, `sleep 30 & P=$!; run_lock_acquire t "$P" some-tok; echo "rc=$?"; echo "err=$RUN_LOCK_ERROR"; kill $P`);
    assertSubprocessCompleted(r, 'run_lock_acquire');
    expect(r.stdout).toContain('rc=1');
    expect(r.stdout).toMatch(/err=run-lock: pid \d+ is not this shell \(\d+\)/);
    expect(r.stdout).not.toContain('another run holds');
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('the dead flag is gone: no RUN_LOCK_FOREIGN_PID in run-lock.sh', () => {
    expect(fs.readFileSync(RUN_LOCK_SH, 'utf8')).not.toContain('RUN_LOCK_FOREIGN_PID');
  });
});

describe('#4288 PR1b-3 P3: the note of a D5 release says released, a takeover still says took over', () => {
  const run = (body: string) =>
    spawnSync('bash', ['-c', `. '${RUN_LOCK_SH}'; sleep 0.05 & D=$!; wait $D; mkdir "$CM_RUN_LOCK_DIR"; printf 'pid=%s\\nhost=%s\\ntoken=%s\\nstarted_at=2026-01-01T00:00:00Z\\nlabel=uat\\n' "$D" "$(hostname)" dead-tok > "$CM_RUN_LOCK_DIR/owner"; ${body}`], {
      env: { ...process.env, CM_RUN_LOCK_DIR: path.join(root, 'lock'), CM_RUN_LOCK_TOKEN: '' },
      encoding: 'utf8',
      timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
    });

  it('run_lock_release_as_head over a gone holder: "released this run’s lock", not "took over a stale lock"', () => {
    const r = run('run_lock_release_as_head dead-tok; echo "result=$RUN_LOCK_RESULT"');
    assertSubprocessCompleted(r, 'run_lock_release_as_head');
    expect(r.stdout).toContain('result=released');
    expect(r.stderr).toContain("run-lock: released this run's lock");
    expect(r.stderr).not.toContain('took over a stale lock');
  });

  it('negative control: an acquisition that recovers the same gone holder still says "took over a stale lock"', () => {
    const r = run('run_lock_acquire t $$ new-tok; echo "rc=$?"; echo "note-after=${RUN_LOCK_RELEASING:-unset}"');
    assertSubprocessCompleted(r, 'run_lock_acquire');
    expect(r.stdout).toContain('rc=0');
    expect(r.stderr).toContain('took over a stale lock');
    expect(r.stdout).toContain('note-after=unset');
  });
});
