/**
 * The `env-clean` gate's verdict logic (Issue #1740).
 *
 * Three properties are asserted here, and they are the whole reason the gate
 * exists:
 *
 *   1. An unmeasured probe is UNKNOWN and never a pass. Every "could not
 *      measure" case below asserts `status !== 'passed'` explicitly, not just
 *      the message, because the defect being prevented is a green verdict —
 *      wording is secondary.
 *   2. Removals are violations whoever they belonged to (#1739, #1624) — except
 *      a tmux session the baseline recorded as another CommandMate server's
 *      (#2627) while the tmux server itself survived — and
 *      additions are violations unless they are demonstrably another worker's —
 *      or are the one agent session the delegation itself started, named in the
 *      baseline and excused by that exact name (#2472).
 *   3. Omitting every declaration leaves the gate off.
 *
 * @vitest-environment node
 */

import { afterEach, describe, it, expect } from 'vitest';
import { setActiveSessionNamespace } from '@/lib/cli-tools/session-name';
import { clearLegacyAliasesForTests, registerLegacyAlias } from '@/lib/tmux/legacy-session-alias';
import {
  attributeAnchor,
  attributeSessionName,
  currentSessionServer,
  diffEnvSnapshots,
  evaluateEnvClean,
  formatEnvCleanReport,
  isOtherServerSession,
  readOtherServerSessions,
  readTaskSession,
  recordTaskSession,
  REQUIRE_ENV_CLEAN_SOURCE_CONFIG,
  REQUIRE_ENV_CLEAN_SOURCE_CONTRACT,
  resolveRequireEnvClean,
  resolveTaskSessionName,
  type SessionServerIdentity,
  type TaskSessionOwner,
} from '@/lib/verification/env-clean-gate';
import {
  ENV_SNAPSHOT_VERSION,
  isEnvSnapshot,
  type EnvEntry,
  type EnvProbeId,
  type EnvProbeResult,
  type EnvSnapshot,
} from '@/lib/verification/env-snapshot';
import { parseTaskContract, type TaskContract } from '@/lib/tasks/contract-parser';
import {
  DEFAULT_MAX_LOG_TAIL_BYTES,
  DEFAULT_TIMEOUT_SEC,
  type VerifyConfig,
} from '@/lib/verification/verify-config';

const WORKTREE_ID = 'commandmate-issue-1740';
const WORKTREE_PATH = '/Users/dev/work/commandmate-issue-1740';
const CONTEXT = { worktreeId: WORKTREE_ID, worktreePath: WORKTREE_PATH };

function entry(key: string, anchor: string | null = null): EnvEntry {
  return { key, detail: null, anchor };
}

function probe(entries: EnvEntry[]): EnvProbeResult {
  return { status: 'ok', entries, reason: null };
}

const EMPTY = probe([]);

function snapshot(overrides: Partial<Record<EnvProbeId, EnvProbeResult>> = {}): EnvSnapshot {
  return {
    version: ENV_SNAPSHOT_VERSION,
    capturedAt: 1_700_000_000_000,
    worktreeId: WORKTREE_ID,
    probes: {
      listeners: EMPTY,
      'tmux-sessions': EMPTY,
      'home-entries': EMPTY,
      'commandmate-entries': EMPTY,
      ...overrides,
    },
  };
}

function probeDiff(snapshotBefore: EnvSnapshot, snapshotAfter: EnvSnapshot, id: EnvProbeId) {
  const diff = diffEnvSnapshots(snapshotBefore, snapshotAfter, CONTEXT);
  return { diff, probe: diff.probes.find((entry) => entry.probeId === id) };
}

// =============================================================================
// Attribution
// =============================================================================

describe('attributeSessionName', () => {
  it('claims this worktree’s primary and extra-instance sessions', () => {
    expect(attributeSessionName(`mcbd-claude-${WORKTREE_ID}`, WORKTREE_ID)).toBe('self');
    expect(attributeSessionName(`mcbd-codex-${WORKTREE_ID}-codex-2`, WORKTREE_ID)).toBe('self');
  });

  it('attributes another worktree’s session elsewhere', () => {
    expect(attributeSessionName('mcbd-claude-commandmate-issue-1726', WORKTREE_ID)).toBe('other');
    expect(attributeSessionName('mcbd-claude-__global__', WORKTREE_ID)).toBe('other');
  });

  it('splits a hyphenated CLI tool id correctly', () => {
    expect(attributeSessionName(`mcbd-vibe-local-${WORKTREE_ID}`, WORKTREE_ID)).toBe('self');
    expect(attributeSessionName('mcbd-vibe-local-other-wt', WORKTREE_ID)).toBe('other');
  });

  it('attributes namespaced names whatever the namespace (Issue #2866)', () => {
    expect(attributeSessionName(`mcbd-0a1b2c3d-claude-${WORKTREE_ID}`, WORKTREE_ID)).toBe('self');
    expect(attributeSessionName(`mcbd-deadbeef-codex-${WORKTREE_ID}-2`, WORKTREE_ID)).toBe('self');
    expect(attributeSessionName('mcbd-deadbeef-claude-other-wt', WORKTREE_ID)).toBe('other');
    expect(attributeSessionName('mcbd-deadbeef-unknowncli-wt', WORKTREE_ID)).toBe('unattributed');
  });

  it('leaves a name it cannot parse unattributed, which is the strict answer', () => {
    expect(attributeSessionName('my-editor', WORKTREE_ID)).toBe('unattributed');
    expect(attributeSessionName('mcbd-unknowncli', WORKTREE_ID)).toBe('unattributed');
  });
});

describe('attributeAnchor', () => {
  it('claims a process running inside this worktree', () => {
    expect(attributeAnchor(WORKTREE_PATH, WORKTREE_PATH)).toBe('self');
    expect(attributeAnchor(`${WORKTREE_PATH}/src`, WORKTREE_PATH)).toBe('self');
  });

  it('attributes a sibling checkout elsewhere — parallel workers and the user’s own server', () => {
    expect(attributeAnchor('/Users/dev/work/commandmate-main', WORKTREE_PATH)).toBe('other');
    expect(attributeAnchor('/Users/dev/work/commandmate-issue-1726/src', WORKTREE_PATH)).toBe('other');
  });

  it('does not treat the parent directory itself as a sibling', () => {
    expect(attributeAnchor('/Users/dev/work', WORKTREE_PATH)).toBe('unattributed');
  });

  it('leaves an unknown or missing cwd unattributed', () => {
    expect(attributeAnchor('/opt/somewhere', WORKTREE_PATH)).toBe('unattributed');
    expect(attributeAnchor(null, WORKTREE_PATH)).toBe('unattributed');
  });
});

// =============================================================================
// Diff
// =============================================================================

describe('diffEnvSnapshots', () => {
  it('is clean when nothing moved', () => {
    const before = snapshot({ listeners: probe([entry('tcp/3000')]) });
    expect(diffEnvSnapshots(before, snapshot({ listeners: probe([entry('tcp/3000')]) }), CONTEXT).status).toBe(
      'clean'
    );
  });

  it('reports a listener that was started and left behind', () => {
    const { diff, probe: listeners } = probeDiff(
      snapshot(),
      snapshot({ listeners: probe([entry('tcp/3779', `${WORKTREE_PATH}`)]) }),
      'listeners'
    );
    expect(diff.status).toBe('violated');
    expect(listeners?.added.map((change) => change.key)).toEqual(['tcp/3779']);
    expect(listeners?.added[0].owner).toBe('self');
    expect(listeners?.removed).toEqual([]);
  });

  it('reports the production server disappearing, even though it is not this task’s', () => {
    const { diff, probe: listeners } = probeDiff(
      snapshot({ listeners: probe([entry('tcp/3000', '/Users/dev/work/commandmate-main')]) }),
      snapshot(),
      'listeners'
    );
    expect(diff.status).toBe('violated');
    expect(listeners?.removed.map((change) => change.key)).toEqual(['tcp/3000']);
    // Attribution excuses additions, never removals.
    expect(listeners?.removed[0].owner).toBe('other');
  });

  it('ignores a parallel worker’s new server and its new session', () => {
    const before = snapshot();
    const after = snapshot({
      listeners: probe([entry('tcp/3778', '/Users/dev/work/commandmate-issue-1726')]),
      'tmux-sessions': probe([entry('mcbd-claude-commandmate-issue-1726')]),
    });
    const diff = diffEnvSnapshots(before, after, CONTEXT);
    expect(diff.status).toBe('clean');
    expect(diff.probes.flatMap((entry) => entry.ignoredAdded).map((change) => change.key)).toEqual([
      'tcp/3778',
      'mcbd-claude-commandmate-issue-1726',
    ]);
  });

  it('reports a sibling worker’s session being killed — the #1624 failure', () => {
    const { diff, probe: sessions } = probeDiff(
      snapshot({
        'tmux-sessions': probe([
          entry(`mcbd-claude-${WORKTREE_ID}`),
          entry('mcbd-claude-commandmate-issue-1726'),
        ]),
      }),
      snapshot({ 'tmux-sessions': probe([entry(`mcbd-claude-${WORKTREE_ID}`)]) }),
      'tmux-sessions'
    );
    expect(diff.status).toBe('violated');
    expect(sessions?.removed.map((change) => change.key)).toEqual([
      'mcbd-claude-commandmate-issue-1726',
    ]);
  });

  it('reports a directory left in $HOME, which has no owner to excuse it', () => {
    const { diff, probe: home } = probeDiff(
      snapshot({ 'home-entries': probe([entry('Documents')]) }),
      snapshot({ 'home-entries': probe([entry('Documents'), entry('.commandmate-uat-1726')]) }),
      'home-entries'
    );
    expect(diff.status).toBe('violated');
    expect(home?.added.map((change) => change.key)).toEqual(['.commandmate-uat-1726']);
    expect(home?.added[0].owner).toBe('unattributed');
  });

  it('marks a probe unknown when the baseline could not measure it', () => {
    const before = snapshot({
      listeners: { status: 'unavailable', entries: [], reason: 'lsof could not be run' },
    });
    const { diff, probe: listeners } = probeDiff(before, snapshot(), 'listeners');
    expect(diff.status).toBe('unknown');
    expect(listeners?.status).toBe('unknown');
    expect(listeners?.reason).toContain('baseline');
    expect(listeners?.added).toEqual([]);
    expect(listeners?.removed).toEqual([]);
  });

  it('marks a probe unknown when the current snapshot could not measure it', () => {
    const after = snapshot({
      'tmux-sessions': { status: 'unavailable', entries: [], reason: 'tmux could not be run' },
    });
    const { diff, probe: sessions } = probeDiff(snapshot(), after, 'tmux-sessions');
    expect(diff.status).toBe('unknown');
    expect(sessions?.reason).toContain('current');
  });

  it('lets a measured violation outrank an unmeasured probe', () => {
    const before = snapshot({ 'home-entries': probe([entry('Documents')]) });
    const after = snapshot({
      'home-entries': probe([entry('Documents'), entry('leftover')]),
      listeners: { status: 'unavailable', entries: [], reason: 'lsof could not be run' },
    });
    const diff = diffEnvSnapshots(before, after, CONTEXT);
    expect(diff.status).toBe('violated');
    // ...and the unmeasured probe is still reported, not swallowed by the verdict.
    expect(formatEnvCleanReport(diff)).toContain('listeners UNKNOWN');
  });
});

// =============================================================================
// options.envCleanIgnoreHomeEntries (Issue #2890)
// =============================================================================

describe('options.envCleanIgnoreHomeEntries (#2890)', () => {
  const IGNORED_LINE = 'ignored (options.envCleanIgnoreHomeEntries)';

  /** The report of a diff judged with `ignoreHomeEntries`, or without the option at all. */
  function homeDiff(
    before: EnvEntry[],
    after: EnvEntry[],
    ignoreHomeEntries?: readonly string[]
  ) {
    const diff = diffEnvSnapshots(
      snapshot({ 'home-entries': probe(before) }),
      snapshot({ 'home-entries': probe(after) }),
      CONTEXT,
      ignoreHomeEntries ? { ignoreHomeEntries } : undefined
    );
    return { diff, home: diff.probes.find((entry) => entry.probeId === 'home-entries') };
  }

  describe('diffEnvSnapshots', () => {
    it('counts a new $HOME entry as a violation when nothing is listed', () => {
      const { diff, home } = homeDiff([], [entry('.semgrep')]);
      expect(diff.status).toBe('violated');
      expect(home?.added.map((change) => change.key)).toEqual(['.semgrep']);
      expect(home?.ignoredByConfig).toEqual([]);

      // An empty list is the same as no list.
      expect(homeDiff([], [entry('.semgrep')], []).diff.status).toBe('violated');
    });

    it('does not count a new entry whose name is listed', () => {
      const { diff, home } = homeDiff([], [entry('.semgrep')], ['.semgrep']);
      expect(diff.status).toBe('clean');
      expect(home?.status).toBe('clean');
      expect(home?.added).toEqual([]);
      expect(home?.removed).toEqual([]);
      expect(home?.ignoredByConfig.map((change) => change.key)).toEqual(['.semgrep']);
    });

    it('matches the whole name only: neither a prefix, a suffix nor another case', () => {
      for (const name of ['.semgrep-x', 'x.semgrep', '.semgrep.bak', '.Semgrep', '.semgre']) {
        const { diff, home } = homeDiff([], [entry(name)], ['.semgrep']);
        expect(diff.status, name).toBe('violated');
        expect(home?.added.map((change) => change.key), name).toEqual([name]);
        expect(home?.ignoredByConfig, name).toEqual([]);
      }
    });

    it('treats a listed name as a literal, not a pattern', () => {
      // `*` and `.` are ordinary characters here; a pattern would let one line
      // switch the whole probe off.
      for (const listed of ['*', '.*', '.semgr?p', '.sem*']) {
        expect(homeDiff([], [entry('.semgrep')], [listed]).diff.status, listed).toBe('violated');
      }
    });

    it('does not count a listed entry that disappeared either', () => {
      const removed = homeDiff([entry('.semgrep'), entry('Documents')], [entry('Documents')]);
      expect(removed.diff.status).toBe('violated');
      expect(removed.home?.removed.map((change) => change.key)).toEqual(['.semgrep']);

      const listed = homeDiff(
        [entry('.semgrep'), entry('Documents')],
        [entry('Documents')],
        ['.semgrep']
      );
      expect(listed.diff.status).toBe('clean');
      expect(listed.home?.removed).toEqual([]);
      expect(listed.home?.ignoredByConfig.map((change) => change.key)).toEqual(['.semgrep']);
    });

    it('still counts every unlisted entry next to a listed one', () => {
      const { diff, home } = homeDiff(
        [entry('Documents'), entry('gone')],
        [entry('Documents'), entry('.semgrep'), entry('.leftover')],
        ['.semgrep']
      );
      expect(diff.status).toBe('violated');
      expect(home?.added.map((change) => change.key)).toEqual(['.leftover']);
      expect(home?.removed.map((change) => change.key)).toEqual(['gone']);
      expect(home?.ignoredByConfig.map((change) => change.key)).toEqual(['.semgrep']);
    });

    it('does not apply to the ~/.commandmate probe, where the same name is a different directory', () => {
      const diff = diffEnvSnapshots(
        snapshot(),
        snapshot({ 'commandmate-entries': probe([entry('.semgrep')]) }),
        CONTEXT,
        { ignoreHomeEntries: ['.semgrep'] }
      );
      const commandmate = diff.probes.find((entry) => entry.probeId === 'commandmate-entries');
      expect(diff.status).toBe('violated');
      expect(commandmate?.added.map((change) => change.key)).toEqual(['.semgrep']);
      expect(commandmate?.ignoredByConfig).toEqual([]);
    });

    it('does not apply to listeners or tmux sessions', () => {
      const diff = diffEnvSnapshots(
        snapshot(),
        snapshot({
          listeners: probe([entry('.semgrep', WORKTREE_PATH)]),
          'tmux-sessions': probe([entry('.semgrep')]),
        }),
        CONTEXT,
        { ignoreHomeEntries: ['.semgrep'] }
      );
      expect(diff.status).toBe('violated');
      expect(diff.probes.flatMap((entry) => entry.ignoredByConfig)).toEqual([]);
    });

    it('never turns an unmeasured $HOME probe into a measured one', () => {
      const diff = diffEnvSnapshots(
        snapshot({ 'home-entries': { status: 'unavailable', entries: [], reason: 'EACCES' } }),
        snapshot({ 'home-entries': probe([entry('.semgrep')]) }),
        CONTEXT,
        { ignoreHomeEntries: ['.semgrep'] }
      );
      expect(diff.status).toBe('unknown');
      expect(diff.probes.find((entry) => entry.probeId === 'home-entries')?.ignoredByConfig).toEqual(
        []
      );
    });

    it('compares only: the baseline handed in is not edited', () => {
      const before = snapshot({ 'home-entries': probe([entry('.semgrep'), entry('Documents')]) });
      const frozen = JSON.parse(JSON.stringify(before));
      diffEnvSnapshots(
        before,
        snapshot({ 'home-entries': probe([entry('Documents')]) }),
        CONTEXT,
        { ignoreHomeEntries: ['.semgrep'] }
      );
      expect(before).toEqual(frozen);
    });

    it('applies to a baseline recorded before the name was listed', () => {
      // The baseline is the same file either way; only the comparison differs.
      const before = snapshot({ 'home-entries': probe([entry('Documents')]) });
      const after = snapshot({ 'home-entries': probe([entry('Documents'), entry('.commandagent')]) });
      expect(diffEnvSnapshots(before, after, CONTEXT).status).toBe('violated');
      expect(
        diffEnvSnapshots(before, after, CONTEXT, { ignoreHomeEntries: ['.commandagent'] }).status
      ).toBe('clean');
    });
  });

  describe('formatEnvCleanReport', () => {
    it('names what it did not count, on a passing probe', () => {
      const { diff } = homeDiff([], [entry('.semgrep')], ['.semgrep']);
      const report = formatEnvCleanReport(diff);
      expect(report).toContain('home-entries clean');
      expect(report).toContain(`${IGNORED_LINE}: .semgrep`);
    });

    it('lists several names on one line, in the order they were found', () => {
      const { diff } = homeDiff(
        [],
        [entry('.semgrep'), entry('.commandagent')],
        ['.commandagent', '.semgrep']
      );
      const lines = formatEnvCleanReport(diff)
        .split('\n')
        .filter((line) => line.includes(IGNORED_LINE));
      expect(lines).toEqual([`    ${IGNORED_LINE}: .semgrep, .commandagent`]);
    });

    it('names it next to the violations that are still counted', () => {
      const { diff } = homeDiff([], [entry('.semgrep'), entry('.leftover')], ['.semgrep']);
      const report = formatEnvCleanReport(diff);
      expect(report).toContain('home-entries VIOLATED ($HOME entries): +1 -0');
      expect(report).toContain('+ .leftover [unattributed]');
      expect(report).not.toContain('+ .semgrep');
      expect(report).toContain(`${IGNORED_LINE}: .semgrep`);
    });

    it('says nothing when nothing listed actually changed', () => {
      // Listed but present at both ends: there is nothing to report as skipped.
      const { diff } = homeDiff([entry('.semgrep')], [entry('.semgrep')], ['.semgrep']);
      expect(formatEnvCleanReport(diff)).not.toContain(IGNORED_LINE);
      expect(formatEnvCleanReport(homeDiff([], [entry('x')]).diff)).not.toContain(IGNORED_LINE);
    });
  });

  describe('evaluateEnvClean', () => {
    const base = { ...CONTEXT, taskId: 'task-2890', sources: [REQUIRE_ENV_CLEAN_SOURCE_CONFIG] };
    const capture = async () => snapshot({ 'home-entries': probe([entry('.semgrep')]) });

    it('fails on the new entry when it is not listed', async () => {
      const outcome = await evaluateEnvClean({ ...base, baseline: snapshot(), capture });
      expect(outcome.status).toBe('failed');
      expect(outcome.logTail).toContain('+ .semgrep [unattributed]');
      expect(outcome.logTail).not.toContain(IGNORED_LINE);
    });

    it('passes when it is listed, and says which entry it did not count', async () => {
      const outcome = await evaluateEnvClean({
        ...base,
        baseline: snapshot(),
        ignoreHomeEntries: ['.semgrep'],
        capture,
      });
      expect(outcome.status).toBe('passed');
      expect(outcome.exitCode).toBe(0);
      expect(outcome.logTail).toContain(`${IGNORED_LINE}: .semgrep`);
    });

    it('does not let the list rescue a run that is unknown for another reason', async () => {
      const outcome = await evaluateEnvClean({
        ...base,
        baseline: snapshot(),
        ignoreHomeEntries: ['.semgrep'],
        capture: async () =>
          snapshot({
            'home-entries': probe([entry('.semgrep')]),
            listeners: { status: 'unavailable', entries: [], reason: 'lsof could not be run' },
          }),
      });
      expect(outcome.status).toBe('error');
      expect(outcome.logTail).toContain('listeners UNKNOWN');
    });
  });
});

// =============================================================================
// Gate evaluation
// =============================================================================

describe('evaluateEnvClean', () => {
  const base = { ...CONTEXT, taskId: 'task-1', sources: [REQUIRE_ENV_CLEAN_SOURCE_CONFIG] };

  it('passes only when every probe was compared and matched', async () => {
    const outcome = await evaluateEnvClean({
      ...base,
      baseline: snapshot({ listeners: probe([entry('tcp/3000')]) }),
      capture: async () => snapshot({ listeners: probe([entry('tcp/3000')]) }),
    });
    expect(outcome.status).toBe('passed');
    expect(outcome.exitCode).toBe(0);
  });

  it('fails on a measured violation and says what to do about it', async () => {
    const outcome = await evaluateEnvClean({
      ...base,
      baseline: snapshot(),
      capture: async () => snapshot({ listeners: probe([entry('tcp/3779', WORKTREE_PATH)]) }),
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.exitCode).toBe(1);
    expect(outcome.logTail).toContain('+ tcp/3779');
    expect(outcome.logTail).toContain('pkill -f');
  });

  it('reports UNKNOWN — not a pass — when there is no baseline', async () => {
    const outcome = await evaluateEnvClean({
      ...base,
      baseline: null,
      capture: async () => snapshot(),
    });
    expect(outcome.status).not.toBe('passed');
    expect(outcome.status).toBe('error');
    expect(outcome.exitCode).toBeNull();
    expect(outcome.logTail).toContain('UNKNOWN');
    expect(outcome.logTail).toContain(REQUIRE_ENV_CLEAN_SOURCE_CONFIG);
  });

  it('reports UNKNOWN — not a pass — when a probe could not be compared', async () => {
    const outcome = await evaluateEnvClean({
      ...base,
      baseline: snapshot(),
      capture: async () =>
        snapshot({
          'commandmate-entries': { status: 'unavailable', entries: [], reason: 'EACCES' },
        }),
    });
    expect(outcome.status).not.toBe('passed');
    expect(outcome.status).toBe('error');
    expect(outcome.logTail).toContain('commandmate-entries UNKNOWN');
    expect(outcome.logTail).toContain('UNKNOWN is not a pass');
  });

  it('reports UNKNOWN — not a pass — when the current snapshot throws', async () => {
    const outcome = await evaluateEnvClean({
      ...base,
      baseline: snapshot(),
      capture: async () => {
        throw new Error('probe host exploded');
      },
    });
    expect(outcome.status).not.toBe('passed');
    expect(outcome.logTail).toContain('probe host exploded');
  });

  it('records the interval it measured', async () => {
    const outcome = await evaluateEnvClean({
      ...base,
      baseline: snapshot(),
      capture: async () => snapshot(),
    });
    expect(outcome.startedAt).toBeGreaterThan(0);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// =============================================================================
// The task's own agent session (Issue #2472)
// =============================================================================

describe('the task’s own agent session (#2472)', () => {
  /** The row `send --contract` creates for the primary Claude instance. */
  const PRIMARY_TASK: TaskSessionOwner = {
    worktreeId: WORKTREE_ID,
    cliToolId: 'claude',
    instanceId: null,
  };
  /**
   * Spelled out rather than derived: the code derives the name, the test pins
   * the format — deriving both would pass with any naming rule at all.
   */
  const PRIMARY_SESSION = `mcbd-claude-${WORKTREE_ID}`;

  function sessions(names: string[]): EnvProbeResult {
    return probe(names.map((name) => entry(name)));
  }

  /** A baseline as the route writes it: captured, then stamped with the task. */
  function taskBaseline(names: string[], task: TaskSessionOwner = PRIMARY_TASK) {
    return recordTaskSession(snapshot({ 'tmux-sessions': sessions(names) }), task);
  }

  function atVerification(names: string[]): EnvSnapshot {
    return snapshot({ 'tmux-sessions': sessions(names) });
  }

  describe('resolveTaskSessionName', () => {
    it('names the primary instance the way the session is started', () => {
      expect(resolveTaskSessionName(PRIMARY_TASK)).toBe(PRIMARY_SESSION);
      // The primary instance may also be recorded under the tool id itself.
      expect(resolveTaskSessionName({ ...PRIMARY_TASK, instanceId: 'claude' })).toBe(
        PRIMARY_SESSION
      );
    });

    it('names an additional instance with its suffix', () => {
      expect(resolveTaskSessionName({ ...PRIMARY_TASK, instanceId: 'claude-2' })).toBe(
        `${PRIMARY_SESSION}-2`
      );
      expect(
        resolveTaskSessionName({ worktreeId: WORKTREE_ID, cliToolId: 'vibe-local', instanceId: null })
      ).toBe(`mcbd-vibe-local-${WORKTREE_ID}`);
    });

    it('answers null for a row it cannot name, rather than guessing one', () => {
      expect(resolveTaskSessionName({ ...PRIMARY_TASK, cliToolId: 'not-a-tool' })).toBeNull();
      expect(resolveTaskSessionName({ ...PRIMARY_TASK, worktreeId: 'bad;id' })).toBeNull();
    });
  });

  describe('recordTaskSession / readTaskSession', () => {
    it('stamps the baseline without touching the snapshot it was given', () => {
      const captured = snapshot();
      expect(recordTaskSession(captured, PRIMARY_TASK).taskSession).toBe(PRIMARY_SESSION);
      expect('taskSession' in captured).toBe(false);
    });

    it('survives the JSON round trip as a snapshot the loader still accepts', () => {
      // The field rides on a file whose shape env-snapshot owns. A loader that
      // refused it would turn every new baseline into UNKNOWN.
      const stored: unknown = JSON.parse(JSON.stringify(taskBaseline([])));
      expect(isEnvSnapshot(stored)).toBe(true);
      expect(readTaskSession(stored as EnvSnapshot)).toBe(PRIMARY_SESSION);
    });

    it('tells a baseline written before #2472 from one recorded as unresolvable', () => {
      expect(readTaskSession(snapshot())).toBeUndefined();
      expect(
        readTaskSession(recordTaskSession(snapshot(), { ...PRIMARY_TASK, cliToolId: 'nope' }))
      ).toBeNull();
      expect(readTaskSession({ ...snapshot(), taskSession: 42 } as unknown as EnvSnapshot)).toBeNull();
    });
  });

  describe('diffEnvSnapshots', () => {
    it('excuses the session the send started, and lists it as excused', () => {
      const { diff, probe: tmux } = probeDiff(
        taskBaseline([]),
        atVerification([PRIMARY_SESSION]),
        'tmux-sessions'
      );
      expect(diff.status).toBe('clean');
      expect(tmux?.added).toEqual([]);
      expect(tmux?.taskSessionAdded.map((change) => change.key)).toEqual([PRIMARY_SESSION]);
      expect(formatEnvCleanReport(diff)).toContain(`+ ${PRIMARY_SESSION} [task session, excused]`);
    });

    it('excuses only the instance the task was sent to', () => {
      const { diff, probe: tmux } = probeDiff(
        taskBaseline([], { ...PRIMARY_TASK, instanceId: 'claude-2' }),
        atVerification([`${PRIMARY_SESSION}-2`, PRIMARY_SESSION]),
        'tmux-sessions'
      );
      expect(diff.status).toBe('violated');
      expect(tmux?.taskSessionAdded.map((change) => change.key)).toEqual([`${PRIMARY_SESSION}-2`]);
      expect(tmux?.added.map((change) => change.key)).toEqual([PRIMARY_SESSION]);
      expect(tmux?.added[0].owner).toBe('self');
    });

    it('still reports every other session of the same worktree', () => {
      // A worker-started codex session and a test-created suffix both parse as
      // `self`; only the exact recorded name is excused.
      const { diff, probe: tmux } = probeDiff(
        taskBaseline([]),
        atVerification([
          PRIMARY_SESSION,
          `mcbd-codex-${WORKTREE_ID}`,
          `mcbd-claude-${WORKTREE_ID}-x`,
        ]),
        'tmux-sessions'
      );
      expect(diff.status).toBe('violated');
      expect(tmux?.added.map((change) => change.key)).toEqual([
        `mcbd-codex-${WORKTREE_ID}`,
        `mcbd-claude-${WORKTREE_ID}-x`,
      ]);
      expect(tmux?.taskSessionAdded.map((change) => change.key)).toEqual([PRIMARY_SESSION]);
    });

    it('reports the task’s session disappearing — excusing an addition never excuses a removal', () => {
      const { diff, probe: tmux } = probeDiff(
        taskBaseline([PRIMARY_SESSION]),
        atVerification([]),
        'tmux-sessions'
      );
      expect(diff.status).toBe('violated');
      expect(tmux?.removed.map((change) => change.key)).toEqual([PRIMARY_SESSION]);
      expect(tmux?.taskSessionAdded).toEqual([]);
    });

    it('excuses nothing from a baseline written before #2472', () => {
      // Backward compatibility, and the standing control for the first case in
      // this block: the same addition without the record is the #2470 verdict.
      const { diff, probe: tmux } = probeDiff(
        snapshot(),
        atVerification([PRIMARY_SESSION]),
        'tmux-sessions'
      );
      expect(diff.status).toBe('violated');
      expect(tmux?.added.map((change) => change.key)).toEqual([PRIMARY_SESSION]);
      expect(formatEnvCleanReport(diff)).toContain(`+ ${PRIMARY_SESSION} [self]`);
    });

    it('excuses nothing when the task could not be named', () => {
      const baseline = recordTaskSession(snapshot(), { ...PRIMARY_TASK, cliToolId: 'not-a-tool' });
      expect(diffEnvSnapshots(baseline, atVerification([PRIMARY_SESSION]), CONTEXT).status).toBe(
        'violated'
      );
    });

    it('excuses the name in tmux-sessions only', () => {
      // A directory in $HOME that happens to spell the session name is still a
      // directory left in $HOME.
      const { diff, probe: home } = probeDiff(
        taskBaseline([]),
        snapshot({ 'home-entries': probe([entry(PRIMARY_SESSION)]) }),
        'home-entries'
      );
      expect(diff.status).toBe('violated');
      expect(home?.added.map((change) => change.key)).toEqual([PRIMARY_SESSION]);
    });
  });

  describe('evaluateEnvClean', () => {
    const base = { ...CONTEXT, taskId: 'task-2472', sources: [REQUIRE_ENV_CLEAN_SOURCE_CONFIG] };

    it('passes a delegation whose only new session is its own, and names it', async () => {
      const outcome = await evaluateEnvClean({
        ...base,
        baseline: taskBaseline([]),
        capture: async () => atVerification([PRIMARY_SESSION]),
      });
      expect(outcome.status).toBe('passed');
      expect(outcome.exitCode).toBe(0);
      expect(outcome.logTail).toContain(`task-session=${PRIMARY_SESSION}`);
      expect(outcome.logTail).toContain(`+ ${PRIMARY_SESSION} [task session, excused]`);
    });

    it('fails on anything else left behind, without counting the excused session', async () => {
      const outcome = await evaluateEnvClean({
        ...base,
        baseline: taskBaseline([]),
        capture: async () => atVerification([PRIMARY_SESSION, `mcbd-codex-${WORKTREE_ID}`]),
      });
      expect(outcome.status).toBe('failed');
      expect(outcome.logTail).toContain('tmux-sessions VIOLATED (mcbd-* tmux sessions): +1 -0');
      expect(outcome.logTail).toContain(`+ mcbd-codex-${WORKTREE_ID} [self]`);
      expect(outcome.logTail).toContain(`+ ${PRIMARY_SESSION} [task session, excused]`);
    });

    it('says why nothing was excused when the baseline predates the record', async () => {
      const outcome = await evaluateEnvClean({
        ...base,
        baseline: snapshot(),
        capture: async () => atVerification([PRIMARY_SESSION]),
      });
      expect(outcome.status).toBe('failed');
      expect(outcome.logTail).toContain('task-session=unrecorded');
    });
  });
});

// =============================================================================
// Another CommandMate server's sessions (Issue #2627)
// =============================================================================

describe('another CommandMate server’s sessions (#2627)', () => {
  /** This server: namespaced, with one legacy session adopted under its alias. */
  const NS = '0a1b2c3d';
  const ADOPTED_LEGACY = 'mcbd-claude-commandmate-issue-1500';
  const SERVER: SessionServerIdentity = {
    namespace: NS,
    legacyAliasOf: (newName) =>
      newName === `mcbd-${NS}-claude-commandmate-issue-1500` ? ADOPTED_LEGACY : undefined,
  };
  const TASK: TaskSessionOwner = { worktreeId: WORKTREE_ID, cliToolId: 'claude', instanceId: null };
  /** The name the send starts; spelled out as `resolveSessionName` produces it in tests. */
  const TASK_SESSION = `mcbd-claude-${WORKTREE_ID}`;
  /** The incident of 2026-09-17: a global-install server's orchestrate in another repository. */
  const FOREIGN_107 = 'mcbd-command-code-other-repo-issue-107';
  const FOREIGN_108 = 'mcbd-command-code-other-repo-issue-108';
  /** A sibling worker of *this* server, as #2866 names it. */
  const SIBLING = `mcbd-${NS}-claude-commandmate-issue-1726`;

  function sessions(names: string[]): EnvProbeResult {
    return probe(names.map((name) => entry(name)));
  }

  function baselineOf(names: string[], server: SessionServerIdentity = SERVER) {
    return recordTaskSession(snapshot({ 'tmux-sessions': sessions(names) }), TASK, server);
  }

  function atVerification(names: string[]): EnvSnapshot {
    return snapshot({ 'tmux-sessions': sessions(names) });
  }

  describe('isOtherServerSession', () => {
    it('claims this server’s namespace and its adopted legacy sessions', () => {
      expect(isOtherServerSession(SIBLING, SERVER)).toBe(false);
      expect(isOtherServerSession(`mcbd-${NS}-codex-${WORKTREE_ID}-2`, SERVER)).toBe(false);
      expect(isOtherServerSession(ADOPTED_LEGACY, SERVER)).toBe(false);
    });

    it('attributes another namespace and an unadopted legacy name to another server', () => {
      expect(isOtherServerSession('mcbd-deadbeef-claude-commandmate-issue-1726', SERVER)).toBe(true);
      expect(isOtherServerSession(FOREIGN_107, SERVER)).toBe(true);
    });

    it('claims nothing as foreign when this server has no namespace, or the name is not ours to parse', () => {
      const legacyServer: SessionServerIdentity = { namespace: null, legacyAliasOf: () => undefined };
      expect(isOtherServerSession(FOREIGN_107, legacyServer)).toBe(false);
      expect(isOtherServerSession('mcbd-deadbeef-claude-x', legacyServer)).toBe(false);
      expect(isOtherServerSession('mcbd-unknowncli-x', SERVER)).toBe(false);
    });
  });

  describe('currentSessionServer', () => {
    afterEach(() => {
      clearLegacyAliasesForTests();
      setActiveSessionNamespace(null);
    });

    it('reads this process’s namespace and adoption table', () => {
      expect(currentSessionServer().namespace).toBeNull();
      setActiveSessionNamespace(NS);
      registerLegacyAlias(`mcbd-${NS}-claude-commandmate-issue-1500`, ADOPTED_LEGACY);
      const server = currentSessionServer();
      expect(server.namespace).toBe(NS);
      expect(isOtherServerSession(ADOPTED_LEGACY, server)).toBe(false);
      expect(isOtherServerSession(SIBLING, server)).toBe(false);
      expect(isOtherServerSession(FOREIGN_107, server)).toBe(true);
    });
  });

  describe('recordTaskSession', () => {
    it('records the baseline’s other-server sessions at task creation', () => {
      const baseline = baselineOf([SIBLING, FOREIGN_107, ADOPTED_LEGACY]);
      expect(baseline.otherServerSessions).toEqual([FOREIGN_107]);
      expect(readOtherServerSessions(baseline)).toEqual(new Set([FOREIGN_107]));
      // It rides the same JSON file as the rest of the baseline.
      const stored: unknown = JSON.parse(JSON.stringify(baseline));
      expect(isEnvSnapshot(stored)).toBe(true);
      expect(readOtherServerSessions(stored as EnvSnapshot)).toEqual(new Set([FOREIGN_107]));
    });

    it('records null — nothing excusable — when this server has no namespace', () => {
      const baseline = baselineOf([FOREIGN_107], { namespace: null, legacyAliasOf: () => undefined });
      expect(baseline.otherServerSessions).toBeNull();
      expect(readOtherServerSessions(baseline).size).toBe(0);
      expect(readOtherServerSessions(snapshot()).size).toBe(0);
    });
  });

  describe('diffEnvSnapshots', () => {
    it('does not fail the 2026-09-17 repro: another server closed its own session', () => {
      const { diff, probe: tmux } = probeDiff(
        baselineOf([FOREIGN_107]),
        atVerification([TASK_SESSION, FOREIGN_108]),
        'tmux-sessions'
      );
      expect(diff.status).toBe('clean');
      expect(tmux?.removed).toEqual([]);
      expect(tmux?.removedByOtherServer.map((change) => change.key)).toEqual([FOREIGN_107]);
      expect(tmux?.ignoredAdded.map((change) => change.key)).toEqual([FOREIGN_108]);
      expect(formatEnvCleanReport(diff)).toContain(
        `· - ${FOREIGN_107} (ignored: another CommandMate server's session`
      );
    });

    it('still reports a sibling session of this server being killed (#1624, namespaced)', () => {
      const { diff, probe: tmux } = probeDiff(
        baselineOf([`mcbd-${NS}-claude-${WORKTREE_ID}`, SIBLING]),
        atVerification([`mcbd-${NS}-claude-${WORKTREE_ID}`]),
        'tmux-sessions'
      );
      expect(diff.status).toBe('violated');
      expect(tmux?.removed.map((change) => change.key)).toEqual([SIBLING]);
      expect(tmux?.removedByOtherServer).toEqual([]);
    });

    it('still reports this server’s adopted legacy session being killed', () => {
      const { diff, probe: tmux } = probeDiff(
        baselineOf([TASK_SESSION, ADOPTED_LEGACY]),
        atVerification([TASK_SESSION]),
        'tmux-sessions'
      );
      expect(diff.status).toBe('violated');
      expect(tmux?.removed.map((change) => change.key)).toEqual([ADOPTED_LEGACY]);
    });

    it('excuses nothing when the tmux server looks killed — every session gone (#1624: the whole tmux server stopped)', () => {
      const { diff, probe: tmux } = probeDiff(
        baselineOf([FOREIGN_107, SIBLING]),
        atVerification([]),
        'tmux-sessions'
      );
      expect(diff.status).toBe('violated');
      expect(tmux?.removed.map((change) => change.key)).toEqual([FOREIGN_107, SIBLING]);
      expect(tmux?.removedByOtherServer).toEqual([]);
    });

    it('excuses nothing from a baseline that did not record other servers', () => {
      const { diff } = probeDiff(
        snapshot({ 'tmux-sessions': sessions([FOREIGN_107]) }),
        atVerification([TASK_SESSION]),
        'tmux-sessions'
      );
      expect(diff.status).toBe('violated');
    });

    it('never excuses a removal in any other probe', () => {
      const baseline = baselineOf([FOREIGN_107]);
      const withListener = {
        ...baseline,
        probes: { ...baseline.probes, listeners: probe([entry('tcp/3000', '/opt/elsewhere')]) },
      };
      const { diff, probe: listeners } = probeDiff(
        withListener,
        atVerification([TASK_SESSION, FOREIGN_107]),
        'listeners'
      );
      expect(diff.status).toBe('violated');
      expect(listeners?.removed.map((change) => change.key)).toEqual(['tcp/3000']);
    });
  });

  describe('evaluateEnvClean', () => {
    it('passes the repro and says what it excused', async () => {
      const outcome = await evaluateEnvClean({
        ...CONTEXT,
        taskId: 'task-2627',
        sources: [REQUIRE_ENV_CLEAN_SOURCE_CONFIG],
        baseline: baselineOf([FOREIGN_107]),
        capture: async () => atVerification([TASK_SESSION, FOREIGN_108]),
      });
      expect(outcome.status).toBe('passed');
      expect(outcome.logTail).toContain('tmux-sessions clean');
      expect(outcome.logTail).toContain(`- ${FOREIGN_107} (ignored: another CommandMate server's`);
    });
  });
});

// =============================================================================
// Opt-in
// =============================================================================

describe('resolveRequireEnvClean', () => {
  const CONFIG: VerifyConfig = {
    version: 1,
    gates: [{ id: 'lint', command: 'npm run lint', timeoutSec: DEFAULT_TIMEOUT_SEC }],
    options: {
      baseRef: 'origin/develop',
      skipInPrimaryCheckout: true,
      maxLogTailBytes: DEFAULT_MAX_LOG_TAIL_BYTES,
      requireCommit: false,
      requireEnvClean: false,
    },
  };

  const CONTRACT = parseTaskContract(
    ['version: 1', 'title: "t"', 'goal: "g"', 'scope:', '  allow: ["src/**"]'].join('\n'),
    'contract.yaml'
  );

  /**
   * A contract that declares `success.requireEnvClean: true`.
   *
   * Built by hand rather than parsed: `SUCCESS_KEYS` in
   * `lib/tasks/contract-parser.ts` is a closed set and that file is outside this
   * delegation's `scope.allow`, so the key cannot be spelled in YAML yet. The
   * resolver reads it structurally for exactly that reason, and this fixture is
   * what fixes the behaviour ahead of the parser change.
   */
  const CONTRACT_REQUIRING_ENV_CLEAN = {
    ...CONTRACT,
    success: { ...CONTRACT.success, requireEnvClean: true },
  } as TaskContract;

  it('is off when neither declaration says anything', () => {
    expect(resolveRequireEnvClean(null, null)).toEqual({ required: false, sources: [] });
    expect(resolveRequireEnvClean(CONTRACT, CONFIG)).toEqual({ required: false, sources: [] });
  });

  it('is on from the repository-wide switch', () => {
    const config = { ...CONFIG, options: { ...CONFIG.options, requireEnvClean: true } };
    expect(resolveRequireEnvClean(CONTRACT, config)).toEqual({
      required: true,
      sources: [REQUIRE_ENV_CLEAN_SOURCE_CONFIG],
    });
  });

  it('is on from the contract alone', () => {
    expect(resolveRequireEnvClean(CONTRACT_REQUIRING_ENV_CLEAN, CONFIG)).toEqual({
      required: true,
      sources: [REQUIRE_ENV_CLEAN_SOURCE_CONTRACT],
    });
  });

  it('names both declarations when both switched it on', () => {
    const config = { ...CONFIG, options: { ...CONFIG.options, requireEnvClean: true } };
    expect(resolveRequireEnvClean(CONTRACT_REQUIRING_ENV_CLEAN, config).sources).toEqual([
      REQUIRE_ENV_CLEAN_SOURCE_CONFIG,
      REQUIRE_ENV_CLEAN_SOURCE_CONTRACT,
    ]);
  });

  it('cannot be switched off by a contract once the repository declared it', () => {
    const config = { ...CONFIG, options: { ...CONFIG.options, requireEnvClean: true } };
    const relaxing = {
      ...CONTRACT,
      success: { ...CONTRACT.success, requireEnvClean: false },
    } as TaskContract;
    expect(resolveRequireEnvClean(relaxing, config).required).toBe(true);
  });
});
