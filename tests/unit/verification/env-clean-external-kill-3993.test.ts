/**
 * env-clean: sibling sessions stopped by someone else are `external` (Issue #3993).
 *
 * On 2026-10-29 every verification of #3957 (runs 2401–2404) failed on
 * `- mcbd-…-<another worktree> [other]` because the orchestrator cleaned that
 * worktree up (`instances <wt> kill`) during the window. The session-kill
 * ledger records such kills with their caller; a recorded kill by anyone other
 * than this task's worker sets the removal apart as `external`. #1624 — a worker
 * killing its neighbour — must still fail, which the negative controls pin.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  diffEnvSnapshots,
  evaluateEnvClean,
  formatEnvCleanReport,
  recordTaskSession,
  REQUIRE_ENV_CLEAN_SOURCE_CONFIG,
  type SessionServerIdentity,
} from '@/lib/verification/env-clean-gate';
import {
  ENV_SNAPSHOT_VERSION,
  probeCommandmateEntries,
  type EnvProbeId,
  type EnvProbeResult,
  type EnvSnapshot,
} from '@/lib/verification/env-snapshot';
import {
  appendSessionKillRecord,
  readSessionKillRecords,
  SESSION_KILL_LEDGER_DIR_NAME,
  SESSION_KILL_LEDGER_RETENTION_MS,
  type SessionKillRecord,
} from '@/lib/verification/session-kill-ledger';

const NS = 'e7375aa6';
const WORKTREE_ID = 'commandmate-issue-3957';
const WORKTREE_PATH = '/Users/dev/work/commandmate-issue-3957';
const SIBLING_ID = 'commandmate-issue-3985';
/** The orchestrator runs in the primary checkout, a sibling directory of the worktrees. */
const ORCHESTRATOR_CWD = '/Users/dev/work/MyCodeBranchDesk';
const ORCHESTRATOR_SESSION = `mcbd-${NS}-claude-mycodebranchdesk`;
const CONTEXT = { worktreeId: WORKTREE_ID, worktreePath: WORKTREE_PATH };
const SERVER: SessionServerIdentity = { namespace: NS, legacyAliasOf: () => undefined };

const TASK_SESSION = `mcbd-${NS}-claude-${WORKTREE_ID}`;
const SIBLING_SESSION = `mcbd-${NS}-claude-${SIBLING_ID}`;
const SIBLING_CODEX = `mcbd-${NS}-codex-${SIBLING_ID}-codex-2`;

const STARTED = 1_761_700_000_000;
const VERIFIED = STARTED + 60 * 60 * 1000;

function tmux(names: string[]): EnvProbeResult {
  return { status: 'ok', entries: names.map((key) => ({ key, detail: null, anchor: null })), reason: null };
}

function snapshot(names: string[], capturedAt: number): EnvSnapshot {
  const empty: EnvProbeResult = { status: 'ok', entries: [], reason: null };
  const probes: Record<EnvProbeId, EnvProbeResult> = {
    listeners: empty,
    'tmux-sessions': tmux(names),
    'home-entries': empty,
    'commandmate-entries': empty,
  };
  return { version: ENV_SNAPSHOT_VERSION, capturedAt, worktreeId: WORKTREE_ID, probes };
}

function baselineOf(names: string[]): EnvSnapshot {
  return recordTaskSession(
    snapshot(names, STARTED),
    { worktreeId: WORKTREE_ID, cliToolId: 'claude', instanceId: null },
    SERVER,
    () => false
  );
}

/** By default the record names the claude session of the worktree it was for, as the route reports it. */
function kill(overrides: Partial<SessionKillRecord> = {}): SessionKillRecord {
  const worktreeId = overrides.worktreeId ?? SIBLING_ID;
  return {
    version: 1,
    at: STARTED + 10 * 60 * 1000,
    api: 'kill-session',
    origin: 'cli',
    worktreeId,
    instanceId: 'claude',
    sessionNames: [`mcbd-${NS}-claude-${worktreeId}`],
    callerCwd: ORCHESTRATOR_CWD,
    callerSession: ORCHESTRATOR_SESSION,
    ...overrides,
  };
}

function tmuxDiff(sessionKills: SessionKillRecord[], before = [TASK_SESSION, SIBLING_SESSION], after = [TASK_SESSION]) {
  const diff = diffEnvSnapshots(baselineOf(before), snapshot(after, VERIFIED), CONTEXT, {
    resolvePidCwd: () => null,
    sessionKills,
  });
  return { diff, tmux: diff.probes.find((p) => p.probeId === 'tmux-sessions')! };
}

describe('diffEnvSnapshots: removals explained by a recorded kill (#3993)', () => {
  it('reproduces 2026-10-29 without a record: the cleaned-up sibling fails the run', () => {
    const { diff, tmux: probe } = tmuxDiff([]);
    expect(diff.status).toBe('violated');
    expect(probe.removed.map((c) => c.key)).toEqual([SIBLING_SESSION]);
    expect(formatEnvCleanReport(diff)).toContain(`- ${SIBLING_SESSION} [other]`);
  });

  it('sets a sibling stopped by the orchestrator’s `instances <wt> kill` apart as external (positive)', () => {
    const { diff, tmux: probe } = tmuxDiff([kill()]);
    expect(diff.status).toBe('clean');
    expect(probe.removed).toEqual([]);
    expect(probe.removedExternal.map((c) => c.key)).toEqual([SIBLING_SESSION]);
    const report = formatEnvCleanReport(diff);
    expect(report).toContain('tmux-sessions clean');
    expect(report).toContain(
      `· - ${SIBLING_SESSION} [external] (not counted: kill-session for ${SIBLING_ID} instance claude ` +
        `at ${new Date(kill().at).toISOString()} from ${ORCHESTRATOR_CWD} in ${ORCHESTRATOR_SESSION}, not this task)`
    );
  });

  // Third contract (P2-4): matched by the exact session name, not by worktree.
  it('excuses only the session the kill names; another instance of the same worktree stays counted', () => {
    const { diff, tmux: probe } = tmuxDiff(
      [kill({ instanceId: 'claude' })],
      [TASK_SESSION, SIBLING_SESSION, SIBLING_CODEX]
    );
    expect(diff.status).toBe('violated');
    expect(probe.removedExternal.map((c) => c.key)).toEqual([SIBLING_SESSION]);
    expect(probe.removed.map((c) => c.key)).toEqual([SIBLING_CODEX]);
  });

  it('excuses every session a whole-worktree kill names', () => {
    const { diff, tmux: probe } = tmuxDiff(
      [kill({ instanceId: null, sessionNames: [SIBLING_SESSION, SIBLING_CODEX] })],
      [TASK_SESSION, SIBLING_SESSION, SIBLING_CODEX]
    );
    expect(diff.status).toBe('clean');
    expect(probe.removedExternal.map((c) => c.key)).toEqual([SIBLING_SESSION, SIBLING_CODEX]);
  });

  it('accepts a caller in another worktree’s tmux session whatever its cwd (/tmp)', () => {
    expect(tmuxDiff([kill({ callerCwd: '/tmp' })]).diff.status).toBe('clean');
    expect(
      tmuxDiff([kill({ callerCwd: null, callerSession: `mcbd-${NS}-claude-${SIBLING_ID}` })]).diff.status
    ).toBe('clean');
  });

  it('accepts a caller outside tmux (a plain shell in the primary checkout)', () => {
    const { diff } = tmuxDiff([kill({ callerSession: null })]);
    expect(diff.status).toBe('clean');
    expect(formatEnvCleanReport(diff)).toContain(`from ${ORCHESTRATOR_CWD}, not this task)`);
  });

  describe('#1624 stays a violation (negative controls)', () => {
    it('the worker itself killed the sibling through the same command (cwd in the task worktree)', () => {
      const { diff, tmux: probe } = tmuxDiff([
        kill({ callerCwd: `${WORKTREE_PATH}/src`, callerSession: null }),
      ]);
      expect(diff.status).toBe('violated');
      expect(probe.removed.map((c) => c.key)).toEqual([SIBLING_SESSION]);
      expect(probe.removedExternal).toEqual([]);
    });

    it('the caller ran inside the task’s own session, whatever its cwd', () => {
      expect(tmuxDiff([kill({ callerSession: TASK_SESSION })]).diff.status).toBe('violated');
      expect(
        tmuxDiff([kill({ callerSession: `mcbd-${NS}-codex-${WORKTREE_ID}-codex-2` })]).diff.status
      ).toBe('violated');
    });

    it('the caller is unknown (no cwd recorded)', () => {
      expect(tmuxDiff([kill({ callerCwd: null, callerSession: null })]).diff.status).toBe('violated');
    });

    it('the session went around CommandMate (`tmux kill-session`): nothing was recorded', () => {
      const { diff, tmux: probe } = tmuxDiff([]);
      expect(diff.status).toBe('violated');
      expect(probe.removedExternal).toEqual([]);
    });

    it('the recorded kill was for another worktree', () => {
      expect(tmuxDiff([kill({ worktreeId: 'commandmate-issue-4000' })]).diff.status).toBe('violated');
      // A prefix of the session's worktree id is a different worktree.
      expect(tmuxDiff([kill({ worktreeId: 'commandmate-issue-39' })]).diff.status).toBe('violated');
    });

    it('the recorded kill is outside the task window', () => {
      expect(tmuxDiff([kill({ at: STARTED - 1 })]).diff.status).toBe('violated');
      expect(tmuxDiff([kill({ at: VERIFIED + 1 })]).diff.status).toBe('violated');
    });

    it('the caller ran nowhere in particular (/tmp, $HOME, the parent directory) outside tmux (P2-1)', () => {
      for (const callerCwd of ['/tmp', '/Users/dev', '/Users/dev/work', '/']) {
        const { diff, tmux: probe } = tmuxDiff([kill({ callerCwd, callerSession: null })]);
        expect(diff.status, callerCwd).toBe('violated');
        expect(probe.removedExternal).toEqual([]);
      }
    });

    it('the caller’s tmux session is not a CommandMate session and its cwd is nowhere (P2-1)', () => {
      expect(tmuxDiff([kill({ callerCwd: '/tmp', callerSession: 'main' })]).diff.status).toBe('violated');
    });

    it('the caller’s cwd is a sibling but it ran in the task’s session (self wins)', () => {
      expect(tmuxDiff([kill({ callerSession: TASK_SESSION })]).diff.status).toBe('violated');
    });

    it('a worker’s unrecorded kill of another instance is not excused by a cleanup line in the window (P2-4)', () => {
      // 10:00 the worker kills codex-2 of the sibling with `tmux kill-session` (nothing recorded);
      // 11:00 the orchestrator cleans the sibling's claude session up (recorded).
      const { diff, tmux: probe } = tmuxDiff(
        [kill({ at: STARTED + 30 * 60 * 1000 })],
        [TASK_SESSION, SIBLING_SESSION, SIBLING_CODEX]
      );
      expect(diff.status).toBe('violated');
      expect(probe.removed.map((c) => c.key)).toEqual([SIBLING_CODEX]);
    });

    it('a kill of a worktree whose id is a prefix of the vanished session’s worktree (P2-4)', () => {
      const child = `mcbd-${NS}-claude-commandmate-skills-3944`;
      const { diff, tmux: probe } = tmuxDiff(
        [kill({ worktreeId: 'commandmate-skills' })],
        [TASK_SESSION, child],
        [TASK_SESSION]
      );
      expect(diff.status).toBe('violated');
      expect(probe.removed.map((c) => c.key)).toEqual([child]);
    });

    it('a record that names no session excuses nothing', () => {
      expect(tmuxDiff([kill({ sessionNames: [] })]).diff.status).toBe('violated');
    });

    it('the tmux server looks killed: every removal counts', () => {
      const { diff, tmux: probe } = tmuxDiff([kill()], [TASK_SESSION, SIBLING_SESSION], []);
      expect(diff.status).toBe('violated');
      expect(probe.removed.map((c) => c.key)).toEqual([TASK_SESSION, SIBLING_SESSION]);
      expect(probe.removedExternal).toEqual([]);
    });

    it('the task’s own session vanished: a record does not excuse `self`', () => {
      const { diff } = tmuxDiff(
        [kill({ worktreeId: WORKTREE_ID })],
        [TASK_SESSION, `mcbd-${NS}-codex-${WORKTREE_ID}-codex-2`, SIBLING_SESSION],
        [TASK_SESSION, SIBLING_SESSION]
      );
      expect(diff.status).toBe('violated');
    });
  });
});

describe('diffEnvSnapshots: kills the server recorded (#3993, second contract)', () => {
  const serverKill = (overrides: Partial<SessionKillRecord>) =>
    kill({ callerCwd: null, callerSession: null, instanceId: null, ...overrides });

  // Third contract (P2-2, P2-3): a worker can drive the UI and trigger sync, so
  // these lines are shown next to the violation and never excuse it.
  it('a sibling stopped from the UI is counted, with the recorded kill shown (P2-3)', () => {
    const { diff, tmux: probe } = tmuxDiff([serverKill({ origin: 'browser' })]);
    expect(diff.status).toBe('violated');
    expect(probe.removed.map((c) => c.key)).toEqual([SIBLING_SESSION]);
    expect(probe.removedExternal).toEqual([]);
    expect(probe.removedKillNotExcused.map((c) => c.key)).toEqual([SIBLING_SESSION]);
    expect(formatEnvCleanReport(diff)).toContain(
      `· ${SIBLING_SESSION}: kill recorded but counted (kill-session for ${SIBLING_ID} ` +
        `at ${new Date(kill().at).toISOString()} from the UI; not excused: a browser kill a worker can also cause)`
    );
  });

  it('a sibling stopped by the server’s cleanup (sync / repository removal) is counted, with the kill shown (P2-2)', () => {
    const { diff, tmux: probe } = tmuxDiff([
      serverKill({ origin: 'server', api: 'session-cleanup', instanceId: 'claude' }),
    ]);
    expect(diff.status).toBe('violated');
    expect(probe.removedExternal).toEqual([]);
    expect(formatEnvCleanReport(diff)).toContain(
      `· ${SIBLING_SESSION}: kill recorded but counted (session-cleanup for ${SIBLING_ID} instance claude at ` +
        `${new Date(kill().at).toISOString()} from the server; not excused: a server kill a worker can also cause)`
    );
  });

  it('a bare HTTP kill names no caller and stays a violation (negative: a worker’s curl)', () => {
    const { diff, tmux: probe } = tmuxDiff([serverKill({ origin: 'http' })]);
    expect(diff.status).toBe('violated');
    expect(probe.removed.map((c) => c.key)).toEqual([SIBLING_SESSION]);
    expect(probe.removedExternal).toEqual([]);
    expect(formatEnvCleanReport(diff)).toContain(
      'from an HTTP request with no caller; not excused: the caller is not known to be someone else)'
    );
  });

  it('a worker’s CLI kill recorded twice (CLI line + route line) is still a violation (#1624)', () => {
    const { diff } = tmuxDiff([
      kill({ callerCwd: WORKTREE_PATH, callerSession: TASK_SESSION }),
      serverKill({ origin: 'http', instanceId: 'claude' }),
    ]);
    expect(diff.status).toBe('violated');
  });

  it('the orchestrator’s CLI kill recorded twice is still external (the duplicate changes nothing)', () => {
    const { diff } = tmuxDiff([kill(), serverKill({ origin: 'http', instanceId: 'claude' })]);
    expect(diff.status).toBe('clean');
  });

  it('a server record for another worktree excuses nothing', () => {
    expect(
      tmuxDiff([serverKill({ origin: 'server', worktreeId: 'commandmate-issue-4000' })]).diff.status
    ).toBe('violated');
  });

  it('a removal with no recorded kill shows no recorded-kill line', () => {
    const { diff, tmux: probe } = tmuxDiff([]);
    expect(probe.removedKillNotExcused).toEqual([]);
    expect(formatEnvCleanReport(diff)).not.toContain('kill recorded but counted');
  });
});

describe('evaluateEnvClean reads the ledger for the task window (#3993)', () => {
  const base = { ...CONTEXT, taskId: 'task-3993', sources: [REQUIRE_ENV_CLEAN_SOURCE_CONFIG] };

  it('passes the 2026-10-29 shape and asks the ledger for [baseline, verification]', async () => {
    const asked: Array<[number, number]> = [];
    const outcome = await evaluateEnvClean({
      ...base,
      baseline: baselineOf([TASK_SESSION, SIBLING_SESSION]),
      capture: async () => snapshot([TASK_SESSION], VERIFIED),
      resolvePidCwd: () => null,
      readSessionKills: (since, until) => {
        asked.push([since, until]);
        return [kill()];
      },
    });
    expect(asked).toEqual([[STARTED, VERIFIED]]);
    expect(outcome.status).toBe('passed');
    expect(outcome.logTail).toContain(`- ${SIBLING_SESSION} [external]`);
  });

  it('still fails when the ledger has nothing, and when it cannot be read', async () => {
    for (const readSessionKills of [() => [], () => { throw new Error('EACCES'); }]) {
      const outcome = await evaluateEnvClean({
        ...base,
        baseline: baselineOf([TASK_SESSION, SIBLING_SESSION]),
        capture: async () => snapshot([TASK_SESSION], VERIFIED),
        resolvePidCwd: () => null,
        readSessionKills,
      });
      expect(outcome.status).toBe('failed');
      expect(outcome.logTail).toContain(`- ${SIBLING_SESSION} [other]`);
    }
  });
});

describe('session-kill ledger (#3993)', () => {
  const roots: string[] = [];
  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'cm-session-kill-ledger-3993-'));
    roots.push(root);
    return join(root, SESSION_KILL_LEDGER_DIR_NAME);
  }
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('round-trips records and reads only the window', () => {
    const root = makeRoot();
    const day = 24 * 60 * 60 * 1000;
    expect(appendSessionKillRecord(kill({ at: STARTED }), root)).toBe(true);
    expect(appendSessionKillRecord(kill({ at: STARTED + day, instanceId: null }), root)).toBe(true);
    expect(appendSessionKillRecord(kill({ at: STARTED + 3 * day }), root)).toBe(true);

    expect(readSessionKillRecords(STARTED, STARTED + 2 * day, root).map((r) => r.at)).toEqual([
      STARTED,
      STARTED + day,
    ]);
    expect(readSessionKillRecords(STARTED + 1, STARTED + day - 1, root)).toEqual([]);
  });

  it('skips malformed lines and reads a missing directory as no record', () => {
    const root = makeRoot();
    expect(readSessionKillRecords(0, STARTED, root)).toEqual([]);
    appendSessionKillRecord(kill(), root);
    const file = join(root, `${new Date(kill().at).toISOString().slice(0, 10)}.jsonl`);
    writeFileSync(
      file,
      `${readFileSync(file, 'utf8')}not json\n${JSON.stringify({ ...kill(), version: 2 })}\n` +
        `${JSON.stringify({ ...kill(), callerCwd: 42 })}\n`
    );
    expect(readSessionKillRecords(STARTED, VERIFIED, root)).toEqual([kill()]);
  });

  it('skips lines with an unknown api or origin, or none (#3993, second contract)', () => {
    const root = makeRoot();
    appendSessionKillRecord(kill({ origin: 'server', api: 'session-cleanup' }), root);
    const file = join(root, `${new Date(kill().at).toISOString().slice(0, 10)}.jsonl`);
    const withoutOrigin: Record<string, unknown> = { ...kill() };
    delete withoutOrigin.origin;
    writeFileSync(
      file,
      `${readFileSync(file, 'utf8')}${JSON.stringify({ ...kill(), api: 'tmux-direct' })}\n` +
        `${JSON.stringify({ ...kill(), origin: 'ui' })}\n${JSON.stringify(withoutOrigin)}\n`
    );
    expect(readSessionKillRecords(STARTED, VERIFIED, root)).toEqual([
      kill({ origin: 'server', api: 'session-cleanup' }),
    ]);
  });

  it('prunes day files past the retention when it writes', () => {
    const root = makeRoot();
    const old = STARTED - SESSION_KILL_LEDGER_RETENTION_MS - 2 * 24 * 60 * 60 * 1000;
    appendSessionKillRecord(kill({ at: old }), root);
    appendSessionKillRecord(kill({ at: STARTED }), root);
    expect(readSessionKillRecords(old, STARTED, root).map((r) => r.at)).toEqual([STARTED]);
  });

  it('is not counted as an entry under ~/.commandmate', () => {
    const result = probeCommandmateEntries({
      run: async () => ({ code: 0, stdout: '', stderr: '', failure: null }),
      readDir: () => [SESSION_KILL_LEDGER_DIR_NAME, 'locks', 'worktree-index', 'something-new'],
      homeDir: () => '/Users/dev',
    });
    expect(result.entries.map((e) => e.key)).toEqual(['something-new']);
  });
});

describe('ledger line validation and origin gate (#4033)', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function writeLines(lines: unknown[]): string {
    const base = mkdtempSync(join(tmpdir(), 'cm-session-kill-ledger-4033-'));
    roots.push(base);
    const root = join(base, SESSION_KILL_LEDGER_DIR_NAME);
    appendSessionKillRecord(kill(), root);
    const file = join(root, `${new Date(kill().at).toISOString().slice(0, 10)}.jsonl`);
    writeFileSync(file, `${readFileSync(file, 'utf8')}${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    return root;
  }

  it('skips lines whose sessionNames is missing or not an array of strings (positive)', () => {
    const withoutNames: Record<string, unknown> = { ...kill() };
    delete withoutNames.sessionNames;
    const root = writeLines([
      withoutNames,
      { ...kill(), sessionNames: 'x' },
      { ...kill(), sessionNames: [1] },
      { ...kill(), sessionNames: null },
    ]);
    expect(readSessionKillRecords(STARTED, VERIFIED, root)).toEqual([kill()]);
  });

  it('still reads a line with an empty or multi-name sessionNames (negative)', () => {
    const empty = kill({ sessionNames: [] });
    const many = kill({ sessionNames: [SIBLING_SESSION, SIBLING_CODEX] });
    const root = writeLines([empty, many]);
    expect(readSessionKillRecords(STARTED, VERIFIED, root)).toEqual([kill(), empty, many]);
  });

  // A route line never names a caller today; the gate must not depend on that.
  it.each(['browser', 'server', 'http'] as const)(
    'a %s line that names a sibling caller still does not excuse the removal (positive)',
    (origin) => {
      const { diff, tmux: probe } = tmuxDiff([
        kill({ origin, callerCwd: ORCHESTRATOR_CWD, callerSession: null }),
      ]);
      expect(diff.status).toBe('violated');
      expect(probe.removedExternal).toEqual([]);
      expect(probe.removed.map((c) => c.key)).toEqual([SIBLING_SESSION]);
    }
  );

  it('the same caller on a cli line is excused (negative)', () => {
    const { diff, tmux: probe } = tmuxDiff([kill({ origin: 'cli', callerCwd: ORCHESTRATOR_CWD, callerSession: null })]);
    expect(diff.status).toBe('clean');
    expect(probe.removedExternal.map((c) => c.key)).toEqual([SIBLING_SESSION]);
  });

  it('a cwd that is a sibling directory but no worktree is excused, as the docs now say', () => {
    const { diff } = tmuxDiff([kill({ callerCwd: '/Users/dev/work/scratch-xyz', callerSession: null })]);
    expect(diff.status).toBe('clean');
  });
});
