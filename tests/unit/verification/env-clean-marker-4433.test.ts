/**
 * Issue #4433 — env-clean excuses a CommandMate listener as another worktree's
 * only on the evidence of a launch mark, never on a guess.
 *
 * Before: a listener whose cwd sat in a *sibling directory* of the task's
 * worktree was `other` and ignored. That excused the worker's own
 * `commandmatedev start --daemon` (detached, cwd = the package root = the main
 * checkout, a sibling) and could not excuse the judge's isolated server when it
 * ran anywhere else. Sprint 7 tried reading ancestors instead and drew four P1s.
 *
 * Now the launcher (DaemonManager, scripts/uat/run-server.sh) gives the server
 * `CM_SERVER_MARK=<record path>` and writes a record naming the process group it
 * started, the group leader's start time and where it was launched from. The
 * probe checks, at capture time, that the listener's group is the recorded one
 * and that its leader is the recorded process; only then does the record's
 * owner count. Everything below asserts the direction of each failure: a mark
 * that is missing, unreadable, copied, stale or ambiguous leaves the listener
 * judged.
 *
 * Fixtures are real directories and record files under `os.tmpdir()` (removed in
 * afterEach); every process lookup is a stub, so no real `ps`/`lsof` is read.
 *
 * @vitest-environment node
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diffEnvSnapshots, formatEnvCleanReport } from '@/lib/verification/env-clean-gate';
import {
  ENV_SNAPSHOT_VERSION,
  probeListeners,
  type CommandResult,
  type EnvEntry,
  type EnvProbeDeps,
  type EnvProbeResult,
  type EnvSnapshot,
} from '@/lib/verification/env-snapshot';
import { envCleanItems } from '../../../scripts/orchestrate/wait-verify.mjs';

const UID = process.getuid ? process.getuid() : 0;
const MARK_ENV = 'CM_SERVER_MARK';
const LSTART = 'Thu Nov 20 03:04:05 2026';

let root: string;
/** The task's worktree. Its parent is `root/lane`, so `root/pkg` is NOT a sibling. */
let self: string;
/** A sibling of the task's worktree (where the main checkout sits). */
let sibling: string;
/** Another worktree, not a sibling: the judge's checkout. */
let other: string;
/** The package root a detached daemon runs in. */
let pkg: string;
let markDir: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cm4433-')));
  self = join(root, 'lane', 'commandmate-issue-4433');
  sibling = join(root, 'lane', 'commandmate-main');
  other = join(root, 'judge', 'commandmate-judge');
  pkg = join(root, 'pkg');
  for (const dir of [self, sibling, other, pkg]) mkdirSync(dir, { recursive: true });
  markDir = join(root, 'marks', `commandmate-server-marks-${UID}`);
  mkdirSync(markDir, { recursive: true });
  chmodSync(markDir, 0o700);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const CONTEXT = (): { worktreeId: string; worktreePath: string } => ({
  worktreeId: 'commandmate-issue-4433',
  worktreePath: self,
});

interface RecordFields {
  pgid?: number;
  leaderStartTime?: string;
  launcherCwd?: string;
  worktreeRoot?: string | null;
  repoRoot?: string | null;
  session?: string;
}

function writeRecord(name: string, fields: RecordFields = {}): string {
  const path = join(markDir, `${name}.json`);
  const record = {
    v: 1,
    launcher: 'daemon',
    pgid: fields.pgid ?? 4300,
    leaderStartTime: fields.leaderStartTime ?? LSTART,
    launcherCwd: fields.launcherCwd ?? other,
    worktreeRoot: fields.worktreeRoot === undefined ? other : fields.worktreeRoot,
    repoRoot: fields.repoRoot === undefined ? null : fields.repoRoot,
    session: fields.session ?? 'mcbd-claude-commandmate-judge',
    launchedAt: '2026-11-20T03:04:05.000Z',
  };
  writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '', failure: null });

interface ProbeFixture {
  /** pid → [port, cwd, command line, pgid, environment tokens]. */
  pids: Array<{ pid: number; port: number; cwd: string; command?: string; pgid?: number; env?: string }>;
  leaders?: Record<number, string>;
  platform?: NodeJS.Platform;
  procEnviron?: Record<number, string | null>;
  extra?: Record<string, CommandResult>;
  omit?: string[];
}

interface Recorded {
  calls: Array<{ key: string; env?: Record<string, string> }>;
}

function probeDeps(fixture: ProbeFixture, recorded: Recorded = { calls: [] }): EnvProbeDeps {
  const pidList = fixture.pids.map((p) => p.pid).join(',');
  const listen = fixture.pids.flatMap((p) => [`p${p.pid}`, 'cnode', `n127.0.0.1:${p.port}`]).join('\n');
  const table = fixture.pids
    .map((p) => `${p.pid} ${p.command ?? `node ${pkg}/dist/server/server.js`}`)
    .join('\n');
  const cwds = fixture.pids.flatMap((p) => [`p${p.pid}`, `n${p.cwd}`]).join('\n');
  const pgids = fixture.pids.map((p) => `${p.pid} ${p.pgid ?? 4300}`).join('\n');
  const envs = fixture.pids
    .map((p) => `${p.pid} ${p.command ?? `node ${pkg}/dist/server/server.js`} ${p.env ?? ''}`)
    .join('\n');
  const leaders = fixture.leaders ?? { 4300: LSTART };
  const leaderPids = [...new Set(fixture.pids.map((p) => p.pgid ?? 4300))];
  const lstartOut = leaderPids
    .filter((pid) => leaders[pid] !== undefined)
    .map((pid) => `${pid} ${leaders[pid]}`)
    .join('\n');
  const commands: Record<string, CommandResult> = {
    'lsof -nP -iTCP -sTCP:LISTEN -F pcn': ok(listen),
    'ps -A -o pid=,command=': ok(table),
    [`lsof -a -d cwd -p ${pidList} -F pn`]: ok(cwds),
    [`ps -o pid=,pgid= -p ${pidList}`]: ok(pgids),
    [`ps -E -ww -o pid=,command= -p ${pidList}`]: ok(envs),
    [`ps -o pid=,lstart= -p ${leaderPids.join(',')}`]: ok(lstartOut),
    ...fixture.extra,
  };
  for (const key of fixture.omit ?? []) delete commands[key];
  return {
    run: async (command, args, options) => {
      const key = [command, ...args].join(' ');
      recorded.calls.push({ key, env: options?.env });
      return commands[key] ?? { code: null, stdout: '', stderr: '', failure: `not stubbed (${key})` };
    },
    readDir: () => [],
    homeDir: () => root,
    platform: () => fixture.platform ?? 'darwin',
    readProcEnviron: (pid: number) => fixture.procEnviron?.[pid] ?? null,
    getuid: () => UID,
  };
}

function listenerSnapshot(entries: EnvEntry[]): EnvSnapshot {
  const empty: EnvProbeResult = { status: 'ok', entries: [], reason: null };
  return {
    version: ENV_SNAPSHOT_VERSION,
    capturedAt: 1_700_000_000_000,
    worktreeId: 'commandmate-issue-4433',
    probes: {
      listeners: { status: 'ok', entries, reason: null },
      'tmux-sessions': empty,
      'home-entries': empty,
      'commandmate-entries': empty,
    },
  };
}

/** A listener entry carrying marks, as the probe stores it. */
function marked(key: string, marks: Array<Record<string, unknown>>, anchor: string | null = pkg): EnvEntry {
  return { key, detail: 'node pid=4321', anchor, marks } as unknown as EnvEntry;
}

function verifiedMark(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: 4321,
    pgid: 4300,
    anchor: pkg,
    status: 'verified',
    reason: null,
    launcherCwd: other,
    worktreeRoot: other,
    repoRoot: null,
    session: 'mcbd-claude-commandmate-judge',
    ...fields,
  };
}

function judge(after: EnvEntry[], before: EnvEntry[] = []) {
  const diff = diffEnvSnapshots(listenerSnapshot(before), listenerSnapshot(after), CONTEXT());
  const listeners = diff.probes.find((probe) => probe.probeId === 'listeners')!;
  return { diff, listeners, report: formatEnvCleanReport(diff) };
}

// =============================================================================
// Acceptance: another worktree's marked server passes and is named
// =============================================================================

describe('acceptance: a marked server of another worktree started mid-task (#4433)', () => {
  it('passes, and the clean report names it on the ignored line', () => {
    const { diff, listeners, report } = judge([marked('tcp/3871', [verifiedMark()])]);
    expect(diff.status).toBe('clean');
    expect(listeners.added).toEqual([]);
    expect(listeners.ignoredAdded.map((change) => change.key)).toEqual(['tcp/3871']);
    expect(listeners.ignoredAdded[0].owner).toBe('other');
    expect(report).toContain('ignored (attributed to another worktree): tcp/3871');
  });

  it('end to end: what the probe observes is what the gate excuses', async () => {
    const path = writeRecord('a'.repeat(32));
    const probe = await probeListeners(
      probeDeps({ pids: [{ pid: 4321, port: 3871, cwd: pkg, env: `A=1 ${MARK_ENV}=${path}` }] })
    );
    expect(probe.status).toBe('ok');
    const { diff, listeners } = judge(probe.entries);
    expect(diff.status).toBe('clean');
    expect(listeners.ignoredAdded.map((change) => change.key)).toEqual(['tcp/3871']);
  });
});

// =============================================================================
// I3: the worker's own server stays a violation, marked or not
// =============================================================================

describe('I3 positive control: the worker’s own server', () => {
  it('is a violation when the mark names this worktree as the launch root', () => {
    const { diff, listeners } = judge([
      marked('tcp/3901', [verifiedMark({ launcherCwd: self, worktreeRoot: self })]),
    ]);
    expect(diff.status).toBe('violated');
    expect(listeners.added.map((change) => [change.key, change.owner])).toEqual([['tcp/3901', 'self']]);
  });

  it('is a violation when launched from elsewhere but inside this worktree’s tmux session', () => {
    const { diff, listeners } = judge([
      marked('tcp/3902', [verifiedMark({ session: 'mcbd-claude-commandmate-issue-4433' })]),
    ]);
    expect(diff.status).toBe('violated');
    expect(listeners.added[0].owner).toBe('self');
  });

  it('is a violation when unmarked and running inside this worktree', () => {
    const { diff, listeners } = judge([marked('tcp/3903', [], self)]);
    expect(diff.status).toBe('violated');
    expect(listeners.added[0].owner).toBe('self');
  });
});

// =============================================================================
// I4 negative controls: forged or missing marks
// =============================================================================

describe('I4 negative control: forged and missing marks stay violations', () => {
  it('a server pointing at another launch’s record (copied mark) is a violation', async () => {
    const path = writeRecord('b'.repeat(32), { pgid: 9100 });
    const probe = await probeListeners(
      probeDeps({ pids: [{ pid: 4321, port: 3871, cwd: pkg, env: `${MARK_ENV}=${path}` }] })
    );
    expect(probe.entries[0].marks?.[0]).toMatchObject({ status: 'invalid', reason: 'pgid-mismatch' });
    const { diff, listeners } = judge(probe.entries);
    expect(diff.status).toBe('violated');
    expect(listeners.added[0].owner).toBe('unattributed');
  });

  it('an unmarked detached server running in a sibling directory (the package root) is a violation', () => {
    const { diff, listeners } = judge([marked('tcp/3904', [], sibling)]);
    expect(diff.status).toBe('violated');
    expect(listeners.added.map((change) => [change.key, change.owner])).toEqual([['tcp/3904', 'unattributed']]);
  });

  it('a listener entry with no marks field at all (a baseline from before #4433) is not excused by its cwd', () => {
    const { diff } = judge([{ key: 'tcp/3905', detail: 'node pid=1', anchor: sibling }]);
    expect(diff.status).toBe('violated');
  });
});

// =============================================================================
// Owner rules (R4, R6, R11)
// =============================================================================

describe('owner of a verified mark', () => {
  it.each([
    ['no-tmux', 'no-tmux'],
    ['lookup-failed', 'lookup-failed'],
    ['a non-CommandMate tmux session', 'my-editor'],
  ])('is not excused when the session is %s', (_label, session) => {
    expect(judge([marked('tcp/3910', [verifiedMark({ session })])]).diff.status).toBe('violated');
  });

  it('is not excused when the mark names no worktree root and no session (launched from /tmp outside tmux)', () => {
    const { diff, listeners } = judge([
      marked('tcp/3911', [verifiedMark({ launcherCwd: root, worktreeRoot: null, session: 'no-tmux' })]),
    ]);
    expect(diff.status).toBe('violated');
    expect(listeners.added[0].owner).toBe('unattributed');
  });

  it('is not excused when only the worktree root is missing', () => {
    expect(judge([marked('tcp/3912', [verifiedMark({ worktreeRoot: null })])]).diff.status).toBe('violated');
  });

  it('is this task’s when this worktree is given through a symlink and the record holds the real path', () => {
    const link = join(root, 'link-to-lane');
    symlinkSync(join(root, 'lane'), link);
    const viaLink = join(link, 'commandmate-issue-4433');
    const diff = diffEnvSnapshots(
      listenerSnapshot([]),
      listenerSnapshot([marked('tcp/3913', [verifiedMark({ launcherCwd: self, worktreeRoot: self })])]),
      { worktreeId: 'commandmate-issue-4433', worktreePath: viaLink }
    );
    const listeners = diff.probes.find((probe) => probe.probeId === 'listeners')!;
    expect(diff.status).toBe('violated');
    expect(listeners.added[0].owner).toBe('self');
  });

  it('is this task’s when the run-server repo root is this worktree', () => {
    const { diff, listeners } = judge([marked('tcp/3914', [verifiedMark({ repoRoot: self })])]);
    expect(diff.status).toBe('violated');
    expect(listeners.added[0].owner).toBe('self');
  });

  it('is not excused when a recorded path no longer resolves (realpath fails)', () => {
    const gone = join(root, 'gone', 'wt');
    const { diff } = judge([marked('tcp/3915', [verifiedMark({ launcherCwd: gone, worktreeRoot: gone })])]);
    expect(diff.status).toBe('violated');
  });

  it('does not take a path that merely shares the worktree’s name as a prefix for this worktree', () => {
    const lookalike = `${self}-2`;
    mkdirSync(lookalike);
    const { diff, listeners } = judge([
      marked('tcp/3916', [verifiedMark({ launcherCwd: lookalike, worktreeRoot: lookalike })]),
    ]);
    expect(diff.status).toBe('clean');
    expect(listeners.ignoredAdded[0].owner).toBe('other');
  });
});

describe('several processes on one port', () => {
  it('is excused only when every process carries a verified mark of another owner', () => {
    const { diff } = judge([
      marked('tcp/3920', [verifiedMark(), verifiedMark({ pid: 4322 })]),
    ]);
    expect(diff.status).toBe('clean');
  });

  it('is judged when one of them is unmarked', () => {
    const { diff, listeners } = judge([
      marked('tcp/3921', [verifiedMark(), { pid: 4322, pgid: 4322, anchor: root, status: 'absent', reason: 'no-mark' }]),
    ]);
    expect(diff.status).toBe('violated');
    expect(listeners.added[0].owner).toBe('unattributed');
  });

  it('is this task’s when the second process (not the first) runs inside this worktree', () => {
    const { listeners } = judge([
      marked('tcp/3922', [verifiedMark(), { pid: 4322, pgid: 4322, anchor: self, status: 'absent', reason: 'no-mark' }]),
    ]);
    expect(listeners.added[0].owner).toBe('self');
  });

  it('the probe keeps one mark per pid on the port', async () => {
    const path = writeRecord('c'.repeat(32));
    const probe = await probeListeners(
      probeDeps({
        pids: [
          { pid: 4321, port: 3923, cwd: pkg, env: `${MARK_ENV}=${path}` },
          { pid: 4322, port: 3923, cwd: self, pgid: 4322, env: '' },
        ],
        leaders: { 4300: LSTART, 4322: LSTART },
      })
    );
    expect(probe.entries).toHaveLength(1);
    expect(probe.entries[0].marks?.map((mark) => [mark.pid, mark.status, mark.anchor])).toEqual([
      [4321, 'verified', pkg],
      [4322, 'absent', self],
    ]);
  });
});

// =============================================================================
// "-": a listener that was there at task start and is gone (decision B)
// =============================================================================

describe('a listener that disappeared', () => {
  it('stays a violation even when the baseline verified it as another worktree’s, and says so', () => {
    const { diff, listeners, report } = judge([], [marked('tcp/3483', [verifiedMark()])]);
    expect(diff.status).toBe('violated');
    expect(listeners.removed.map((change) => change.key)).toEqual(['tcp/3483']);
    expect(report).toMatch(/- tcp\/3483 node pid=4321 mark=verified \[other\]/);
  });
});

// =============================================================================
// The report line (R11, R12)
// =============================================================================

describe('the mark on a report line', () => {
  it('keeps the owner as the last bracket, readable by wait-verify', () => {
    const { report } = judge([
      marked('tcp/3930', [verifiedMark({ status: 'invalid', reason: 'pgid-mismatch' })]),
    ]);
    const line = report.split('\n').find((text) => text.includes('tcp/3930'))!;
    expect(line).toBe('    + tcp/3930 node pid=4321 mark=pgid-mismatch [unattributed]');
    const match = /^ {4}([+-]) (.+) \[([^\]]+)\]$/.exec(line);
    expect(match?.[3]).toBe('unattributed');
    expect(envCleanItems(`GATE env-clean FAIL\n${report}\n`)).toEqual(['listeners:+tcp/3930']);
  });

  it('lists each process’s reason in order', () => {
    const { report } = judge([
      marked('tcp/3931', [verifiedMark(), { pid: 4322, pgid: 4322, anchor: root, status: 'absent', reason: 'no-mark' }]),
    ]);
    expect(report).toContain('+ tcp/3931 node pid=4321 mark=verified,no-mark [unattributed]');
  });
});

// =============================================================================
// The probe's reading of a mark (R1, R2, R7, R9, R11)
// =============================================================================

describe('probeListeners reading the mark', () => {
  it('verifies a daemon-shaped launch (leader npm ≠ listener node) against the leader’s start time', async () => {
    const path = writeRecord('d'.repeat(32));
    const recorded: Recorded = { calls: [] };
    const probe = await probeListeners(
      probeDeps(
        {
          pids: [{ pid: 4321, port: 3871, cwd: pkg, env: `${MARK_ENV}=${path}` }],
          // The listener's own start time differs; only the leader's counts.
          extra: { 'ps -o pid=,lstart= -p 4321': ok(`4321 Fri Nov 21 09:09:09 2026`) },
        },
        recorded
      )
    );
    expect(probe.entries[0]).toMatchObject({ key: 'tcp/3871', detail: 'node pid=4321', anchor: pkg });
    expect(probe.entries[0].marks?.[0]).toMatchObject({
      pid: 4321,
      pgid: 4300,
      status: 'verified',
      reason: null,
      launcherCwd: other,
      worktreeRoot: other,
      session: 'mcbd-claude-commandmate-judge',
    });
    const lstart = recorded.calls.find((call) => call.key.startsWith('ps -o pid=,lstart='));
    expect(lstart?.key).toBe('ps -o pid=,lstart= -p 4300');
    expect(lstart?.env).toMatchObject({ LC_ALL: 'C', TZ: 'UTC0' });
  });

  it('rejects a leader whose start time is not the recorded one, even when the listener’s matches (pid reuse)', async () => {
    const path = writeRecord('e'.repeat(32));
    const probe = await probeListeners(
      probeDeps({
        pids: [{ pid: 4321, port: 3871, cwd: pkg, env: `${MARK_ENV}=${path}` }],
        leaders: { 4300: 'Mon Nov 17 01:01:01 2026' },
        extra: { 'ps -o pid=,lstart= -p 4321': ok(`4321 ${LSTART}`) },
      })
    );
    expect(probe.entries[0].marks?.[0]).toMatchObject({ status: 'invalid', reason: 'leader-start-mismatch' });
  });

  it('rejects a mark whose group leader is gone', async () => {
    const path = writeRecord('f'.repeat(32));
    const probe = await probeListeners(
      probeDeps({ pids: [{ pid: 4321, port: 3871, cwd: pkg, env: `${MARK_ENV}=${path}` }], leaders: {} })
    );
    expect(probe.entries[0].marks?.[0]).toMatchObject({ status: 'invalid', reason: 'leader-gone' });
  });

  it('compares start times with whitespace collapsed (ps pads the day)', async () => {
    const path = writeRecord('0'.repeat(32), { leaderStartTime: 'Thu Nov  6 03:04:05 2026' });
    const probe = await probeListeners(
      probeDeps({
        pids: [{ pid: 4321, port: 3871, cwd: pkg, env: `${MARK_ENV}=${path}` }],
        leaders: { 4300: 'Thu Nov 6 03:04:05 2026' },
      })
    );
    expect(probe.entries[0].marks?.[0].status).toBe('verified');
  });

  it('is absent when the process carries no mark', async () => {
    const probe = await probeListeners(probeDeps({ pids: [{ pid: 4321, port: 3871, cwd: pkg, env: 'A=1' }] }));
    expect(probe.entries[0].marks?.[0]).toMatchObject({ status: 'absent', reason: 'no-mark' });
  });

  it('is absent — and the listing still ok — when the environment cannot be read', async () => {
    const probe = await probeListeners(
      probeDeps({ pids: [{ pid: 4321, port: 3871, cwd: pkg }], omit: ['ps -E -ww -o pid=,command= -p 4321'] })
    );
    expect(probe.status).toBe('ok');
    expect(probe.entries[0]).toMatchObject({ key: 'tcp/3871', detail: 'node pid=4321' });
    expect(probe.entries[0].marks?.[0]).toMatchObject({ status: 'absent', reason: 'env-unreadable' });
  });

  it('is absent when the process group cannot be read', async () => {
    const path = writeRecord('1'.repeat(32));
    const probe = await probeListeners(
      probeDeps({
        pids: [{ pid: 4321, port: 3871, cwd: pkg, env: `${MARK_ENV}=${path}` }],
        omit: ['ps -o pid=,pgid= -p 4321'],
      })
    );
    expect(probe.entries[0].marks?.[0]).toMatchObject({ status: 'absent', reason: 'pgid-unreadable' });
  });

  it('is invalid when the name appears twice (an argument cannot be told from the environment)', async () => {
    const path = writeRecord('2'.repeat(32));
    const probe = await probeListeners(
      probeDeps({
        pids: [{ pid: 4321, port: 3871, cwd: pkg, env: `${MARK_ENV}=${path} ${MARK_ENV}=${path}` }],
      })
    );
    expect(probe.entries[0].marks?.[0]).toMatchObject({ status: 'invalid', reason: 'duplicate-mark' });
  });

  it('reads only past the command line: a mark-shaped argument is not the environment', async () => {
    const path = writeRecord('3'.repeat(32));
    const command = `node ${pkg}/dist/server/server.js ${MARK_ENV}=${path}`;
    const probe = await probeListeners(
      probeDeps({ pids: [{ pid: 4321, port: 3871, cwd: pkg, command, env: 'A=1' }] })
    );
    expect(probe.entries[0].marks?.[0]).toMatchObject({ status: 'absent', reason: 'no-mark' });
  });

  it('is invalid when the record is larger than 4 KiB', async () => {
    const path = join(markDir, `${'4'.repeat(32)}.json`);
    writeFileSync(path, JSON.stringify({ pad: 'x'.repeat(5000) }), { mode: 0o600 });
    const probe = await probeListeners(
      probeDeps({ pids: [{ pid: 4321, port: 3871, cwd: pkg, env: `${MARK_ENV}=${path}` }] })
    );
    expect(probe.entries[0].marks?.[0]).toMatchObject({ status: 'invalid', reason: 'record-too-large' });
  });

  it('is invalid when the record is not a v1 record', async () => {
    const path = join(markDir, `${'5'.repeat(32)}.json`);
    writeFileSync(path, '{"v":1,"pgid":"4300"}', { mode: 0o600 });
    const probe = await probeListeners(
      probeDeps({ pids: [{ pid: 4321, port: 3871, cwd: pkg, env: `${MARK_ENV}=${path}` }] })
    );
    expect(probe.entries[0].marks?.[0]).toMatchObject({ status: 'invalid', reason: 'record-malformed' });
  });

  it('is invalid when the record directory is readable by others', async () => {
    const path = writeRecord('6'.repeat(32));
    chmodSync(markDir, 0o755);
    const probe = await probeListeners(
      probeDeps({ pids: [{ pid: 4321, port: 3871, cwd: pkg, env: `${MARK_ENV}=${path}` }] })
    );
    expect(probe.entries[0].marks?.[0]).toMatchObject({ status: 'invalid', reason: 'dir-not-private' });
  });

  it('is invalid when the record directory is not named for this user', async () => {
    const strange = join(root, 'marks', 'somewhere-else');
    mkdirSync(strange, { mode: 0o700 });
    chmodSync(strange, 0o700);
    const path = join(strange, `${'7'.repeat(32)}.json`);
    writeFileSync(path, readFileSync(writeRecord('8'.repeat(32))), { mode: 0o600 });
    const probe = await probeListeners(
      probeDeps({ pids: [{ pid: 4321, port: 3871, cwd: pkg, env: `${MARK_ENV}=${path}` }] })
    );
    expect(probe.entries[0].marks?.[0]).toMatchObject({ status: 'invalid', reason: 'bad-path' });
  });

  it('is invalid when the record is a symlink', async () => {
    const real = writeRecord('9'.repeat(32));
    const link = join(markDir, `${'a'.repeat(31)}b.json`);
    symlinkSync(real, link);
    const probe = await probeListeners(
      probeDeps({ pids: [{ pid: 4321, port: 3871, cwd: pkg, env: `${MARK_ENV}=${link}` }] })
    );
    expect(probe.entries[0].marks?.[0]).toMatchObject({ status: 'invalid', reason: 'record-unreadable' });
  });

  it('reads /proc/<pid>/environ on linux (NUL separated) instead of ps -E', async () => {
    const path = writeRecord('b'.repeat(32));
    const probe = await probeListeners(
      probeDeps({
        pids: [{ pid: 4321, port: 3871, cwd: pkg }],
        platform: 'linux',
        procEnviron: { 4321: `A=1 B\0${MARK_ENV}=${path}\0` },
        omit: ['ps -E -ww -o pid=,command= -p 4321'],
      })
    );
    expect(probe.entries[0].marks?.[0].status).toBe('verified');
  });

  it('is absent on linux when /proc/<pid>/environ cannot be read', async () => {
    const probe = await probeListeners(
      probeDeps({ pids: [{ pid: 4321, port: 3871, cwd: pkg }], platform: 'linux', procEnviron: { 4321: null } })
    );
    expect(probe.entries[0].marks?.[0]).toMatchObject({ status: 'absent', reason: 'env-unreadable' });
  });
});

// =============================================================================
// Q1: the children of a marked server do not inherit the mark (server.ts)
// =============================================================================

describe('server.ts drops CM_SERVER_MARK before anything else runs (Q1)', () => {
  const source = readFileSync(join(__dirname, '../../../server.ts'), 'utf8');
  const isDrop = (text: string): boolean => /^delete process\.env\.CM_SERVER_MARK;?$/.test(text.trim());

  it('its first statement deletes the mark from its own environment', () => {
    const file = ts.createSourceFile('server.ts', source, ts.ScriptTarget.ES2022, true);
    expect(isDrop(file.statements[0].getText(file))).toBe(true);
  });

  it('the compiled server runs the delete before its first require', () => {
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const drop = output.indexOf('delete process.env.CM_SERVER_MARK');
    const firstRequire = output.indexOf('require(');
    expect(drop).toBeGreaterThan(-1);
    expect(firstRequire).toBeGreaterThan(-1);
    expect(drop).toBeLessThan(firstRequire);
  });
});
