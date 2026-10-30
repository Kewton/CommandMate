/**
 * Which waiting instance a sidebar click opens (Issue #4001).
 */
import { describe, it, expect } from 'vitest';
import type { Worktree } from '@/types/models';
import { buildWorktreeOpenHref, pickWaitingInstanceId } from '@/lib/waiting-instance-pick';

type Entry = {
  isRunning?: boolean;
  isWaitingForResponse?: boolean;
  isProcessing?: boolean;
  waitingKind?: 'prompt' | 'menu' | 'unclassified' | null;
  waitingSince?: number | null;
};

const ROSTER = [
  { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
  { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
  { id: 'commandcode', cliTool: 'claude', alias: 'Command Code', order: 2 },
];

const waitingEntry = (extra: Entry = {}): Entry => ({
  isRunning: true,
  isWaitingForResponse: true,
  isProcessing: false,
  ...extra,
});
const readyEntry: Entry = { isRunning: true, isWaitingForResponse: false, isProcessing: false };

function wt(byInstance: Record<string, Entry> | undefined, roster: unknown[] = ROSTER): Worktree {
  return {
    id: 'wt-1',
    name: 'feature/one',
    path: '/repo/one',
    repositoryPath: '/repo',
    repositoryName: 'Repo',
    isWaitingForResponse: true,
    agentInstances: roster,
    sessionStatusByInstance: byInstance,
  } as unknown as Worktree;
}

describe('pickWaitingInstanceId (Issue #4001)', () => {
  it('picks the one waiting instance, even when it is not first in the roster (positive)', () => {
    const w = wt({
      claude: readyEntry,
      codex: readyEntry,
      commandcode: waitingEntry({ waitingKind: 'prompt', waitingSince: 1000 }),
    });
    expect(pickWaitingInstanceId(w)).toBe('commandcode');
    expect(buildWorktreeOpenHref(w)).toBe('/worktrees/wt-1?instance=commandcode');
  });

  it('prefers the kind the row stands for over an older wait of another kind', () => {
    // The row folds prompt > menu, so it says "answer here": the prompt wins
    // although the menu has waited longer.
    const w = wt({
      claude: waitingEntry({ waitingKind: 'menu', waitingSince: 100 }),
      codex: waitingEntry({ waitingKind: 'prompt', waitingSince: 500 }),
    });
    expect(pickWaitingInstanceId(w)).toBe('codex');
  });

  it('within the kind, the oldest waitingSince wins', () => {
    const w = wt({
      claude: waitingEntry({ waitingKind: 'prompt', waitingSince: 900 }),
      codex: waitingEntry({ waitingKind: 'prompt', waitingSince: 300 }),
      commandcode: waitingEntry({ waitingKind: 'prompt', waitingSince: 600 }),
    });
    expect(pickWaitingInstanceId(w)).toBe('codex');
  });

  it('an equal waitingSince goes by roster order (order, not object key order)', () => {
    const w = wt(
      {
        codex: waitingEntry({ waitingKind: 'prompt', waitingSince: 300 }),
        commandcode: waitingEntry({ waitingKind: 'prompt', waitingSince: 300 }),
      },
      [ROSTER[2], ROSTER[0], ROSTER[1]],
    );
    expect(pickWaitingInstanceId(w)).toBe('codex');
  });

  it('an instance without waitingSince ranks after one with it', () => {
    const w = wt({
      claude: waitingEntry({ waitingKind: 'prompt' }),
      codex: waitingEntry({ waitingKind: 'prompt', waitingSince: 300 }),
    });
    expect(pickWaitingInstanceId(w)).toBe('codex');
  });

  it('keeps every candidate when none matches the row kind (the row kind comes from outside the roster)', () => {
    const w = wt({
      claude: waitingEntry({ waitingKind: 'menu', waitingSince: 300 }),
      'claude-9': waitingEntry({ waitingKind: 'prompt', waitingSince: 100 }),
    });
    expect(pickWaitingInstanceId(w)).toBe('claude');
  });

  describe('falls back to the current rule (null, bare URL) — negative controls', () => {
    it('nothing waits', () => {
      const w = wt({ claude: readyEntry, codex: readyEntry });
      expect(pickWaitingInstanceId(w)).toBeNull();
      expect(buildWorktreeOpenHref(w)).toBe('/worktrees/wt-1');
    });

    it('the waiting instance is no longer in the roster', () => {
      const w = wt({
        claude: readyEntry,
        'codex-2': waitingEntry({ waitingKind: 'prompt', waitingSince: 100 }),
      });
      expect(pickWaitingInstanceId(w)).toBeNull();
    });

    it('no candidate carries waitingSince (a server older than #1786)', () => {
      const w = wt({
        claude: waitingEntry({ waitingKind: 'prompt' }),
        codex: waitingEntry({ waitingKind: 'prompt', waitingSince: null }),
      });
      expect(pickWaitingInstanceId(w)).toBeNull();
    });

    it('no per-instance payload at all', () => {
      expect(pickWaitingInstanceId(wt(undefined))).toBeNull();
    });
  });

  it('reads the selectedAgents roster when agentInstances is empty', () => {
    const w = {
      ...wt({ claude: readyEntry, codex: waitingEntry({ waitingSince: 5 }) }, []),
      selectedAgents: ['claude', 'codex'],
    } as Worktree;
    expect(pickWaitingInstanceId(w)).toBe('codex');
  });
});
