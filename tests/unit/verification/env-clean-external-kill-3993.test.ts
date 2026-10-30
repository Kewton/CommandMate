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

function kill(overrides: Partial<SessionKillRecord> = {}): SessionKillRecord {
  return {
    version: 1,
    at: STARTED + 10 * 60 * 1000,
    api: 'kill-session',
    worktreeId: SIBLING_ID,
    instanceId: 'claude',
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

  it('covers every session of the worktree the kill was for (cleanup kills each instance)', () => {
    const { diff, tmux: probe } = tmuxDiff(
      [kill({ instanceId: 'claude' })],
      [TASK_SESSION, SIBLING_SESSION, SIBLING_CODEX]
    );
    expect(diff.status).toBe('clean');
    expect(probe.removedExternal.map((c) => c.key)).toEqual([SIBLING_SESSION, SIBLING_CODEX]);
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
