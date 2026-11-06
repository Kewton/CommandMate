/**
 * Issue #4192: env-clean's `tmux-sessions` attributed another worktree's
 * session (`commandmate-issue-4175-v2`) to `commandmate-issue-4175` because
 * `<id>-…` was always read as an instance suffix of `<id>`.
 *
 * The rule now: `<id>-…` is `other` only on positive evidence that a longer
 * hyphen-boundary prefix of the tail is another worktree (a sibling git
 * worktree on disk, or a row of this server's worktree table). Without it the
 * name stays `self`, so `-codex-2` and the other instance suffixes are still
 * this task's.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  attributeSessionName,
  defaultOtherWorktreeProbe,
  diffEnvSnapshots,
  evaluateEnvClean,
  readSiblingWorktreeIds,
} from '@/lib/verification/env-clean-gate';
import {
  ENV_SNAPSHOT_VERSION,
  type EnvProbeId,
  type EnvProbeResult,
  type EnvSnapshot,
} from '@/lib/verification/env-snapshot';

const WORKTREE_ID = 'commandmate-issue-4175';
const SIBLING_ID = 'commandmate-issue-4175-v2';
const OWN_EXTRA = `mcbd-codex-${WORKTREE_ID}-codex-2`;
const SIBLING_SESSION = `mcbd-claude-${SIBLING_ID}`;
const NS = '0a1b2c3d';

function probe(keys: string[]): EnvProbeResult {
  return { status: 'ok', reason: null, entries: keys.map((key) => ({ key, detail: null, anchor: null })) };
}

function snapshot(sessions: string[], worktreeId = WORKTREE_ID): EnvSnapshot {
  const empty = probe([]);
  const probes: Record<EnvProbeId, EnvProbeResult> = {
    listeners: empty,
    'tmux-sessions': probe(sessions),
    'home-entries': empty,
    'commandmate-entries': empty,
  };
  return { version: ENV_SNAPSHOT_VERSION, capturedAt: 1_700_000_000_000, worktreeId, probes };
}

const knows =
  (...ids: string[]) =>
  (id: string): boolean =>
    ids.includes(id);

describe('attributeSessionName with sibling-worktree evidence (#4192)', () => {
  it('attributes another worktree’s `-v2` session elsewhere when that worktree is known', () => {
    const probeFn = knows(SIBLING_ID);
    expect(attributeSessionName(SIBLING_SESSION, WORKTREE_ID, probeFn)).toBe('other');
    expect(attributeSessionName(`mcbd-codex-${SIBLING_ID}-codex-2`, WORKTREE_ID, probeFn)).toBe('other');
    expect(attributeSessionName(`mcbd-${NS}-claude-${SIBLING_ID}`, WORKTREE_ID, probeFn)).toBe('other');
  });

  it('keeps this worktree’s extra instances `self` with the same evidence present', () => {
    const probeFn = knows(SIBLING_ID);
    expect(attributeSessionName(`mcbd-claude-${WORKTREE_ID}`, WORKTREE_ID, probeFn)).toBe('self');
    expect(attributeSessionName(OWN_EXTRA, WORKTREE_ID, probeFn)).toBe('self');
    expect(attributeSessionName(`mcbd-${NS}-codex-${WORKTREE_ID}-2`, WORKTREE_ID, probeFn)).toBe('self');
    expect(attributeSessionName(`mcbd-claude-${WORKTREE_ID}-reviewer`, WORKTREE_ID, probeFn)).toBe('self');
  });

  it('stays `self` for an ambiguous name with no evidence (the strict direction)', () => {
    expect(attributeSessionName(SIBLING_SESSION, WORKTREE_ID)).toBe('self');
    expect(attributeSessionName(SIBLING_SESSION, WORKTREE_ID, knows())).toBe('self');
    expect(
      attributeSessionName(SIBLING_SESSION, WORKTREE_ID, () => {
        throw new Error('probe failed');
      })
    ).toBe('self');
  });

  it('asks only about ids longer than the task’s own', () => {
    const asked: string[] = [];
    attributeSessionName(`mcbd-codex-${WORKTREE_ID}-a-b`, WORKTREE_ID, (id) => {
      asked.push(id);
      return false;
    });
    expect(asked).toEqual([`${WORKTREE_ID}-a`, `${WORKTREE_ID}-a-b`]);
  });
});

describe('defaultOtherWorktreeProbe (#4192)', () => {
  let root: string;
  let worktreePath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'env-clean-4192-'));
    worktreePath = join(root, WORKTREE_ID);
    mkdirSync(worktreePath);
    writeFileSync(join(worktreePath, '.git'), 'gitdir: x\n');
    mkdirSync(join(root, SIBLING_ID));
    writeFileSync(join(root, SIBLING_ID, '.git'), 'gitdir: y\n');
    // A directory that is not a git worktree is no evidence.
    mkdirSync(join(root, `${WORKTREE_ID}-codex`));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads sibling git worktrees, not plain directories nor the worktree itself', () => {
    expect(readSiblingWorktreeIds(worktreePath)).toEqual(new Set([SIBLING_ID]));
    expect(readSiblingWorktreeIds(join(root, 'missing', 'x')).size).toBe(0);
  });

  it('answers from siblings first, then from the registered path', () => {
    const registered: Record<string, string> = {
      'commandmate-issue-4175-a1b2c3d4': join(root, 'elsewhere'),
      'commandmate-issue-4175-alias': worktreePath,
    };
    const probeFn = defaultOtherWorktreeProbe(worktreePath, (id) => registered[id] ?? null);
    expect(probeFn(SIBLING_ID)).toBe(true);
    expect(probeFn('commandmate-issue-4175-a1b2c3d4')).toBe(true);
    // A row pointing at the task's own worktree is not another worktree.
    expect(probeFn('commandmate-issue-4175-alias')).toBe(false);
    expect(probeFn(`${WORKTREE_ID}-codex`)).toBe(false);
    const failing = defaultOtherWorktreeProbe(worktreePath, () => {
      throw new Error('db down');
    });
    expect(failing(`${WORKTREE_ID}-codex`)).toBe(false);
  });

  it('diff: a sibling `-v2` session is excused, this worktree’s `-codex-2` is still judged', () => {
    const context = {
      worktreeId: WORKTREE_ID,
      worktreePath,
      isOtherWorktree: defaultOtherWorktreeProbe(worktreePath, () => null),
    };
    const diff = diffEnvSnapshots(snapshot([]), snapshot([SIBLING_SESSION, OWN_EXTRA]), context);
    const tmux = diff.probes.find((entry) => entry.probeId === 'tmux-sessions');
    expect(tmux?.ignoredAdded.map((change) => change.key)).toEqual([SIBLING_SESSION]);
    expect(tmux?.added.map((change) => [change.key, change.owner])).toEqual([[OWN_EXTRA, 'self']]);
    expect(diff.status).toBe('violated');
  });

  it('diff: a sibling’s session removed is still a violation (#1624 is unchanged)', () => {
    const context = {
      worktreeId: WORKTREE_ID,
      worktreePath,
      isOtherWorktree: defaultOtherWorktreeProbe(worktreePath, () => null),
    };
    const keep = `mcbd-claude-${WORKTREE_ID}`;
    const diff = diffEnvSnapshots(snapshot([keep, SIBLING_SESSION]), snapshot([keep]), context);
    const tmux = diff.probes.find((entry) => entry.probeId === 'tmux-sessions');
    expect(tmux?.removed.map((change) => [change.key, change.owner])).toEqual([[SIBLING_SESSION, 'other']]);
    expect(diff.status).toBe('violated');
  });

  it('evaluateEnvClean: the 2026-11-06 repro passes with the default probe', async () => {
    const outcome = await evaluateEnvClean({
      worktreeId: WORKTREE_ID,
      worktreePath,
      taskId: 'task-4192',
      baseline: snapshot([]),
      sources: ['test'],
      readSessionKills: () => [],
      capture: async () => snapshot([SIBLING_SESSION]),
    });
    expect(outcome.status).toBe('passed');
  });

  it('evaluateEnvClean: this worktree’s `-codex-2` still fails', async () => {
    const outcome = await evaluateEnvClean({
      worktreeId: WORKTREE_ID,
      worktreePath,
      taskId: 'task-4192',
      baseline: snapshot([]),
      sources: ['test'],
      readSessionKills: () => [],
      isOtherWorktree: defaultOtherWorktreeProbe(worktreePath, () => null),
      capture: async () => snapshot([OWN_EXTRA]),
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.logTail).toContain(OWN_EXTRA);
  });
});
