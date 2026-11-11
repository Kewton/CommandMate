/**
 * #4288 PR1b-4 (the second time of the same kind, team.md §6-6): a member of a group is sent TERM or KILL only
 * through signal_member, which looks again (alive, in group G now) just before the send.
 *  - a scan of the sources: no send line outside signal_member, except to the shell's own child or the leader
 *    stop_recorded has just verified;
 *  - the body is driven: a live pid that ps calls G at the first look and another group afterwards, and a pid that
 *    is alive at the first look and gone afterwards (while ps still calls it G), are sent neither TERM nor KILL;
 *    a real member that ignores TERM is still sent TERM and then KILL (negative control).
 * Everything runs in a directory under os.tmpdir(); nothing outside it is touched.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REAL_SHELL_SUBPROCESS_TIMEOUT_MS, REAL_SHELL_TEST_TIMEOUT_MS, assertSubprocessCompleted } from '@tests/helpers/real-shell-budget';
import { removeTempDir } from '@tests/helpers/temp-dir';

const REPO = path.resolve(__dirname, '../../../..');
const RUN_SERVER = path.join(REPO, 'scripts/uat/run-server.sh');
const DAILY = path.join(REPO, 'scripts/agent-health/daily.sh');

/** The lines of a function's body (`name() {` to the first `}` at column 0). */
const bodyOf = (src: string, name: string): string => {
  const start = src.indexOf(`\n${name}() {`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('\n}', start + 1);
  return src.slice(start, end + 2);
};
/** Lines that send a signal: `kill` (or `builtin kill`, `/bin/kill`, `pkill`) other than `kill -0`; comments dropped. */
const sendLines = (src: string): { line: number; text: string }[] =>
  src
    .split('\n')
    .map((text, i) => ({ line: i + 1, text: text.replace(/(^|\s)#.*$/, '') }))
    .filter(({ text }) => /(^|[\s;&|(])(builtin\s+|\/bin\/|p)?kill(?![\w-])(?!\s+-0\b)/.test(text));

describe('#4288 PR1b-4: the sends of run-server.sh and daily.sh (scan)', () => {
  it('run-server.sh: signal_member holds the one send to a group member; every other send is to its own child or the verified leader', () => {
    const src = fs.readFileSync(RUN_SERVER, 'utf8');
    const signalMember = bodyOf(src, 'signal_member');
    expect(sendLines(signalMember).map((l) => l.text.trim())).toEqual(['kill -s "$2" "$3" 2>/dev/null']);
    expect(signalMember).toContain('member_in_group "$1" "$3" || return 1');
    const member = bodyOf(src, 'member_in_group');
    expect(member).toContain('kill -0 "$2" 2>/dev/null || return 1');
    expect(member).toContain(`[ "$(ps -o pgid= -p "$2" 2>/dev/null | tr -d ' ')" = "$1" ] || return 1`);
    const drain = bodyOf(src, 'drain_members');
    expect(sendLines(drain)).toEqual([]);
    expect(drain).toContain('signal_member "$g" TERM "$p"');
    expect(drain).toContain('signal_member "$g" KILL "$p"');

    const signalStart = src.indexOf('\nsignal_member() {');
    const signalEnd = signalStart + signalMember.length;
    const stopRecorded = bodyOf(src, 'stop_recorded');
    const stopStart = src.indexOf('\nstop_recorded() {');
    const offsetOf = (line: number): number => src.split('\n').slice(0, line - 1).join('\n').length;
    const outside = sendLines(src).filter(({ line }) => {
      const at = offsetOf(line);
      return !(at >= signalStart && at < signalEnd);
    });
    expect(outside.length).toBeGreaterThan(0);
    for (const { line, text } of outside) {
      const at = offsetOf(line);
      const toOwnChild = /kill -s KILL (-- )?"-?\$UP_SERVER_PID" 2>\/dev\/null/.test(text);
      const toVerifiedLeader = text.trim() === 'kill "$pid" 2>/dev/null || true' && at >= stopStart && at < stopStart + stopRecorded.length;
      expect(toOwnChild || toVerifiedLeader, `run-server.sh:${line}: ${text.trim()}`).toBe(true);
    }
  });

  it('daily.sh: every send is to its own child (its pid, or its group once it is shown to lead it)', () => {
    const src = fs.readFileSync(DAILY, 'utf8');
    const lines = sendLines(src);
    expect(lines.length).toBeGreaterThan(0);
    for (const { line, text } of lines) expect(/kill -s KILL (-- )?"-?\$CHILD" 2>\/dev\/null/.test(text), `daily.sh:${line}: ${text.trim()}`).toBe(true);
  });
});

describe('#4288 PR1b-4: drain_members sends nothing to a pid that is not in the group just before the send (driven)', () => {
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
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-rl-pr1b4-'));
  });
  afterEach(() => {
    for (const child of spawned.splice(0)) {
      for (const target of child.pid ? [-child.pid, child.pid] : []) {
        try {
          process.kill(target, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    }
    removeTempDir(root);
  });

  /** A group G (leader L, member q that ignores TERM) and r, a live process of a group of its own. */
  const setUp = async (): Promise<{ g: number; q: number; r: number }> => {
    const qf = path.join(root, 'q.pid');
    const leader = spawn('bash', ['-c', `(trap '' TERM; exec sleep 60) & echo $! > '${qf}'; wait`], { detached: true, stdio: 'ignore' });
    spawned.push(leader);
    const other = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    spawned.push(other);
    expect(await waitFor(() => fs.existsSync(qf) && fs.readFileSync(qf, 'utf8').trim() !== '')).toBe(true);
    const r = other.pid!;
    expect(spawnSync('ps', ['-o', 'pgid=', '-p', String(r)], { encoding: 'utf8' }).stdout.trim()).toBe(String(r));
    return { g: leader.pid!, q: Number(fs.readFileSync(qf, 'utf8').trim()), r };
  };
  /** Runs drain_members G q r with a ps shim and, before the logging kill, an optional answer for `kill -0 r`. */
  const drive = (g: number, q: number, r: number, psShim: string, kill0Shim = ''): string[] => {
    const klog = path.join(root, 'kill.log');
    fs.writeFileSync(klog, '');
    const script = [
      `. '${RUN_SERVER}'`,
      psShim,
      `kill() { ${kill0Shim} [ "$1" = -0 ] || printf '%s\\n' "$*" >> '${klog}'; builtin kill "$@"; }`,
      `drain_members ${g} ${q} ${r}; echo "rc=$?"`,
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], {
      env: { ...process.env, CM_RUN_LOCK_DIR: path.join(root, 'lock') },
      encoding: 'utf8',
      timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
    });
    assertSubprocessCompleted(result, 'drain_members');
    return fs.readFileSync(klog, 'utf8').split('\n').filter((line) => /^-s (TERM|KILL) /.test(line));
  };

  it('pgid: a live pid ps calls G at the first look and another group afterwards is sent neither TERM nor KILL; q is sent both', async () => {
    const { g, q, r } = await setUp();
    const count = path.join(root, 'ps.count');
    // ps -o pgid= -p r: G at the first call (the choice), r's own group at every later one (the number reused)
    const sent = drive(
      g,
      q,
      r,
      `ps() { if [ "$1" = -o ] && [ "$2" = pgid= ] && [ "$3" = -p ] && [ "$4" = ${r} ]; then n=$(cat '${count}' 2>/dev/null || echo 0); echo $((n + 1)) > '${count}'; if [ "$n" = 0 ]; then echo ${g}; else command ps "$@"; fi; else command ps "$@"; fi; }`
    );
    // the choice, the look before TERM and the look before KILL
    expect(Number(fs.readFileSync(count, 'utf8').trim())).toBeGreaterThanOrEqual(3);
    expect(sent).not.toContain(`-s TERM ${r}`);
    expect(sent).not.toContain(`-s KILL ${r}`);
    expect(isAlive(r)).toBe(true);
    // negative control: a real member that ignores TERM is still sent TERM, then KILL
    expect(sent).toContain(`-s TERM ${q}`);
    expect(sent).toContain(`-s KILL ${q}`);
    expect(await waitFor(() => !isAlive(q))).toBe(true);
  }, REAL_SHELL_TEST_TIMEOUT_MS);

  it('alive: a pid alive at the first look and gone afterwards (ps still calls it G) is sent neither TERM nor KILL; q is sent both', async () => {
    const { g, q, r } = await setUp();
    const count = path.join(root, 'kill0.count');
    const sent = drive(
      g,
      q,
      r,
      // ps calls r a member of G every time: only the "alive" look can keep a send from it
      `ps() { if [ "$1" = -o ] && [ "$2" = pgid= ] && [ "$3" = -p ] && [ "$4" = ${r} ]; then echo ${g}; else command ps "$@"; fi; }`,
      // kill -0 r: alive at the first call (the choice), gone at every later one
      `if [ "$1" = -0 ] && [ "$2" = ${r} ]; then n=$(cat '${count}' 2>/dev/null || echo 0); echo $((n + 1)) > '${count}'; [ "$n" = 0 ]; return; fi;`
    );
    expect(Number(fs.readFileSync(count, 'utf8').trim())).toBeGreaterThanOrEqual(3);
    expect(sent).not.toContain(`-s TERM ${r}`);
    expect(sent).not.toContain(`-s KILL ${r}`);
    expect(isAlive(r)).toBe(true);
    expect(sent).toContain(`-s TERM ${q}`);
    expect(sent).toContain(`-s KILL ${q}`);
    expect(await waitFor(() => !isAlive(q))).toBe(true);
  }, REAL_SHELL_TEST_TIMEOUT_MS);
});
