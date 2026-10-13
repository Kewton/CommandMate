/**
 * New task's destinations, read off the worktree list (Issue #3511).
 */

import { describe, it, expect } from 'vitest';
import {
  buildRepositoryOptions,
  describeTargetState,
  findTarget,
  isAutoYesActive,
  resolveInitialTarget,
  resolveModelAvailability,
  resolveWorktreeInstances,
} from '@/lib/new-task/new-task-targets';
import type { Worktree } from '@/types/models';
import { AUTO_YES_EXPIRES_AT, buildRepositories, buildWorktrees } from './new-task-fixtures';

const worktrees = buildWorktrees();
const repositories = buildRepositories();

describe('[#3511] buildRepositoryOptions', () => {
  it('groups branches under their repository, labelled by display name', () => {
    const options = buildRepositoryOptions(worktrees, repositories);
    expect(options.map((o) => o.name)).toEqual(['Alpha', 'beta']);
    expect(options[0].worktrees.map((wt) => wt.id)).toEqual(['wt-a-feat', 'wt-a-main']);
  });

  it('falls back to the worktree repositoryName without a summary', () => {
    expect(buildRepositoryOptions(worktrees).map((o) => o.name)).toEqual(['alpha', 'beta']);
  });
});

describe('[#3511] resolveWorktreeInstances', () => {
  it('orders the roster', () => {
    expect(resolveWorktreeInstances(worktrees[0]).map((i) => i.id)).toEqual(['claude', 'codex-2']);
  });

  it('derives primaries from selectedAgents / cliToolId for an older payload', () => {
    const legacy = { ...worktrees[1], agentInstances: undefined, selectedAgents: ['codex', 'gemini'] } as Worktree;
    expect(resolveWorktreeInstances(legacy).map((i) => i.id)).toEqual(['codex', 'gemini']);
    const bare = { ...worktrees[1], agentInstances: [], selectedAgents: undefined, cliToolId: 'codex' } as Worktree;
    expect(resolveWorktreeInstances(bare).map((i) => i.id)).toEqual(['codex']);
  });
});

describe('[#3511] describeTargetState', () => {
  it('reads running state and armed Auto-Yes per instance', () => {
    const [wt] = worktrees;
    const instances = resolveWorktreeInstances(wt);
    expect(describeTargetState(wt, instances[0])).toMatchObject({
      label: 'Claude',
      running: true,
      starting: false,
      autoYes: { enabled: true, expiresAt: AUTO_YES_EXPIRES_AT },
    });
    expect(describeTargetState(wt, instances[1])).toMatchObject({
      label: 'Reviewer',
      running: false,
      autoYes: null,
    });
  });

  it('reads a launching session as starting', () => {
    const wt = worktrees[2];
    const antigravity = resolveWorktreeInstances(wt)[1];
    expect(describeTargetState(wt, antigravity)).toMatchObject({ running: true, starting: true });
  });
});

describe('[#3511] resolveInitialTarget', () => {
  it('takes the first candidate that exists', () => {
    expect(
      resolveInitialTarget(worktrees, [null, { worktreeId: 'wt-b-main', instanceId: 'gemini' }]),
    ).toEqual({ worktreeId: 'wt-b-main', instanceId: 'gemini' });
  });

  it('keeps the worktree when only the instance is gone', () => {
    expect(resolveInitialTarget(worktrees, [{ worktreeId: 'wt-a-main', instanceId: 'removed' }])).toEqual({
      worktreeId: 'wt-a-main',
      instanceId: 'claude',
    });
  });

  it('falls back to the first agent of the first branch', () => {
    expect(resolveInitialTarget(worktrees, [{ worktreeId: 'gone', instanceId: 'x' }], repositories)).toEqual({
      worktreeId: 'wt-a-feat',
      instanceId: 'claude',
    });
    expect(resolveInitialTarget([], [])).toBeNull();
  });

  it('findTarget needs both halves', () => {
    expect(findTarget(worktrees, { worktreeId: 'wt-a-main', instanceId: 'codex-2' })?.instance.alias).toBe('Reviewer');
    expect(findTarget(worktrees, { worktreeId: 'wt-a-main', instanceId: 'nope' })).toBeNull();
  });
});

describe('[#3511] resolveModelAvailability — mirrors the send route', () => {
  const stopped = { running: false, starting: false };
  const running = { running: true, starting: false };
  const starting = { running: true, starting: true };

  it('copilot switches models in a running session', () => {
    expect(resolveModelAvailability('copilot', running)).toEqual({ selectable: true });
    expect(resolveModelAvailability('copilot', stopped)).toEqual({ selectable: true });
  });

  it('claude and antigravity take a model only when the send starts them', () => {
    for (const tool of ['claude', 'antigravity'] as const) {
      expect(resolveModelAvailability(tool, stopped)).toEqual({ selectable: true });
      expect(resolveModelAvailability(tool, running)).toEqual({ selectable: false, reason: 'running' });
      expect(resolveModelAvailability(tool, starting)).toEqual({ selectable: false, reason: 'running' });
    }
  });

  it('every other tool takes none', () => {
    for (const tool of ['codex', 'gemini', 'opencode', 'vibe-local'] as const) {
      expect(resolveModelAvailability(tool, stopped)).toEqual({ selectable: false, reason: 'unsupported' });
    }
  });
});

describe('[#3511] isAutoYesActive — AutoYesToggle\'s expiry test', () => {
  const now = 1_000_000;
  it('is on only while time is left', () => {
    expect(isAutoYesActive({ enabled: true, expiresAt: now + 1 }, now)).toBe(true);
    expect(isAutoYesActive({ enabled: true, expiresAt: now }, now)).toBe(false);
    expect(isAutoYesActive({ enabled: true, expiresAt: now - 1 }, now)).toBe(false);
    expect(isAutoYesActive({ enabled: true, expiresAt: null }, now)).toBe(false);
    expect(isAutoYesActive({ enabled: false, expiresAt: now + 1 }, now)).toBe(false);
    expect(isAutoYesActive(null, now)).toBe(false);
  });
});
