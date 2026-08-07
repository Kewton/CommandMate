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
 *   2. Removals are violations whoever they belonged to (#1739, #1624), and
 *      additions are violations unless they are demonstrably another worker's.
 *   3. Omitting every declaration leaves the gate off.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  attributeAnchor,
  attributeSessionName,
  diffEnvSnapshots,
  evaluateEnvClean,
  formatEnvCleanReport,
  REQUIRE_ENV_CLEAN_SOURCE_CONFIG,
  REQUIRE_ENV_CLEAN_SOURCE_CONTRACT,
  resolveRequireEnvClean,
} from '@/lib/verification/env-clean-gate';
import {
  ENV_SNAPSHOT_VERSION,
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
