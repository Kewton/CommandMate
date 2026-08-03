/**
 * Issue #1621 / #1645 Phase 3: `reconcileWorktreeSessions` — make everything
 * keyed on a worktree ID *outside* SQLite follow that ID when it moves.
 *
 * What these tests are defending, in order of how badly it fails when broken:
 *
 * 1. **The two-stage rename.** A bulk renumbering moves every ID at once, so one
 *    worktree's new name can be another's old name. The pathological case is a
 *    straight swap (A→B, B→A), which has no valid one-at-a-time ordering: the
 *    fake tmux below throws `duplicate session` exactly like the real one, so a
 *    single-stage implementation cannot pass.
 * 2. **Roster-driven enumeration.** `mcbd-claude-<wt>` is a prefix of
 *    `mcbd-claude-<wt>-2`, so anything that greps by prefix renames a different
 *    instance's session (Issue #1156). A session that belongs to no roster entry
 *    and no primary instance must be left strictly alone.
 * 3. **Runtime key transfer, not invalidation.** Auto-Yes, the response poller,
 *    the control-mode attach and the WebSocket room are the four keys that make
 *    up "instructions still reach this agent". Dropping any one of them leaves
 *    the session alive and the UI healthy while nothing gets through.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, recordWorktreeAlias } from '@/lib/db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import {
  reconcileWorktreeSessions,
  reconcileWorktreeSessionsFromAliases,
  type ReconcileTmuxDeps,
} from '@/lib/session/worktree-session-reconcile';
import {
  setAutoYesEnabled,
  getAutoYesState,
  clearAllAutoYesStates,
  getAutoYesStateCompositeKeys,
  stopAllAutoYesPolling,
  getAutoYesPollerCompositeKeys,
  startAutoYesPolling,
} from '@/lib/polling/auto-yes-manager';
import {
  activePollers,
  pollingStartTimes,
  getPollerKey,
} from '@/lib/polling/response-poller-core';
import { stopAllPolling } from '@/lib/polling/response-poller';
import { isDuplicatePrompt } from '@/lib/polling/prompt-dedup';
import { isDuplicateResponse } from '@/lib/polling/response-dedup';
import {
  hasRoomSubscribers,
  __internal as wsInternal,
  migrateWorktreeRooms,
} from '@/lib/ws-server';
import type { WebSocket } from 'ws';
import type { Worktree } from '@/types/models';

// ---------------------------------------------------------------------------
// Fake tmux server
// ---------------------------------------------------------------------------

interface FakeTmux extends ReconcileTmuxDeps {
  /** Session names currently "running" */
  names(): string[];
  /** Every rename issued, in order — proves the two-stage path was taken */
  calls: Array<[string, string]>;
}

function makeFakeTmux(initial: string[]): FakeTmux {
  const sessions = new Set(initial);
  const calls: Array<[string, string]> = [];

  return {
    calls,
    names: () => Array.from(sessions).sort(),
    listSessions: async () =>
      Array.from(sessions).map((name) => ({ name, windows: 1, attached: false })),
    renameSession: async (oldName: string, newName: string) => {
      calls.push([oldName, newName]);
      if (!sessions.has(oldName)) return false;
      // The real tmux refuses this; so must the fake, or the test would pass
      // against a single-stage implementation.
      if (sessions.has(newName)) {
        throw new Error(`Failed to rename tmux session: duplicate session: ${newName}`);
      }
      sessions.delete(oldName);
      sessions.add(newName);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeWorktree(id: string, dir: string): Worktree {
  return {
    id,
    name: 'develop',
    branch: 'develop',
    path: `/repos/anvil/${dir}`,
    repositoryPath: '/repos/anvil',
    repositoryName: 'anvil',
  };
}

function fakeSocket(): WebSocket {
  return {
    readyState: 1, // WebSocket.OPEN
    send: vi.fn(),
  } as unknown as WebSocket;
}

/**
 * The migrated schema, built once and restored per test.
 *
 * Running all migrations 20+ times is real CPU in a parallel suite, and it
 * showed: the added load tipped a wall-clock-margin test in
 * `gate-runner-timestamps.test.ts` (which spawns a process and allows it 60ms
 * of slack). Serialising the schema once keeps this file cheap.
 */
let schemaSnapshot: Buffer | null = null;

function freshDatabase(): Database.Database {
  if (!schemaSnapshot) {
    const template = new Database(':memory:');
    runMigrations(template);
    schemaSnapshot = template.serialize();
    template.close();
  }
  return new Database(schemaSnapshot);
}

describe('reconcileWorktreeSessions (Issue #1621 Phase 3)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDatabase();
    db.pragma('foreign_keys = ON');
    clearAllAutoYesStates();
    stopAllAutoYesPolling();
    stopAllPolling();
    wsInternal.resetStateForTest();
  });

  afterEach(() => {
    // Both pollers arm real timers whose callbacks reach for tmux; leaving one
    // armed leaks into the next file as an unhandled rejection.
    stopAllAutoYesPolling();
    stopAllPolling();
    clearAllAutoYesStates();
    wsInternal.resetStateForTest();
    db.close();
  });

  // -------------------------------------------------------------------------
  // 1. Two-stage rename
  // -------------------------------------------------------------------------

  describe('two-stage rename', () => {
    it('completes an A→B / B→A swap without a collision', async () => {
      upsertWorktree(db, makeWorktree('alpha', 'alpha'));
      upsertWorktree(db, makeWorktree('beta', 'beta'));

      const tmux = makeFakeTmux(['mcbd-claude-alpha', 'mcbd-claude-beta']);

      const result = await reconcileWorktreeSessions(
        db,
        [
          { oldId: 'alpha', newId: 'beta' },
          { oldId: 'beta', newId: 'alpha' },
        ],
        { tmux }
      );

      expect(result.errors).toEqual([]);
      // Both sessions still exist, with their names exchanged.
      expect(tmux.names()).toEqual(['mcbd-claude-alpha', 'mcbd-claude-beta']);
      expect(result.renamedSessions).toEqual(
        expect.arrayContaining([
          { oldName: 'mcbd-claude-alpha', newName: 'mcbd-claude-beta' },
          { oldName: 'mcbd-claude-beta', newName: 'mcbd-claude-alpha' },
        ])
      );
      expect(result.renamedSessions).toHaveLength(2);
    });

    it('routes every rename through a temporary name', async () => {
      upsertWorktree(db, makeWorktree('alpha', 'alpha'));
      const tmux = makeFakeTmux(['mcbd-claude-alpha']);

      await reconcileWorktreeSessions(db, 'alpha', 'gamma', { tmux });

      expect(tmux.calls).toHaveLength(2);
      const [stage1, stage2] = tmux.calls;
      expect(stage1[0]).toBe('mcbd-claude-alpha');
      expect(stage1[1]).toMatch(/^cmate-renaming-/);
      expect(stage2[0]).toBe(stage1[1]);
      expect(stage2[1]).toBe('mcbd-claude-gamma');
      // The staging name must not look like a CommandMate session: the reading
      // mode binding fires on `mcbd-*` and a human scanning `tmux ls` should be
      // able to tell a leftover apart from a real session.
      expect(stage1[1].startsWith('mcbd-')).toBe(false);
    });

    it('never leaves a session parked on a temporary name', async () => {
      upsertWorktree(db, makeWorktree('alpha', 'alpha'));
      const tmux = makeFakeTmux(['mcbd-claude-alpha']);

      await reconcileWorktreeSessions(db, 'alpha', 'gamma', { tmux });

      expect(tmux.names().some((name) => name.startsWith('cmate-renaming-'))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Roster-driven enumeration (no prefix matching — Issue #1156)
  // -------------------------------------------------------------------------

  describe('target enumeration', () => {
    it('renames roster instances by exact name and leaves unrelated prefixes alone', async () => {
      upsertWorktree(db, makeWorktree('beta', 'beta'));
      // The roster lives under the NEW id after the DB migration has run.
      setAgentInstances(db, 'beta', [
        { id: 'claude', cliTool: 'claude', alias: '', order: 0 },
        { id: 'claude-2', cliTool: 'claude', alias: 'second', order: 1 },
      ]);

      const tmux = makeFakeTmux([
        'mcbd-claude-alpha',
        'mcbd-claude-alpha-2',
        // Belongs to nobody: not a primary instance, not in the roster. A
        // prefix sweep would drag it along.
        'mcbd-claude-alpha-legacy',
      ]);

      const result = await reconcileWorktreeSessions(db, 'alpha', 'beta', { tmux });

      expect(result.errors).toEqual([]);
      expect(tmux.names()).toEqual([
        'mcbd-claude-alpha-legacy',
        'mcbd-claude-beta',
        'mcbd-claude-beta-2',
      ]);
    });

    it('finds the roster under the old id too (reconciling ahead of the DB move)', async () => {
      upsertWorktree(db, makeWorktree('alpha', 'alpha'));
      setAgentInstances(db, 'alpha', [
        { id: 'codex-3', cliTool: 'codex', alias: '', order: 0 },
      ]);

      const tmux = makeFakeTmux(['mcbd-codex-alpha-3']);
      const result = await reconcileWorktreeSessions(db, 'alpha', 'beta', { tmux });

      expect(result.errors).toEqual([]);
      expect(tmux.names()).toEqual(['mcbd-codex-beta-3']);
    });

    it('covers the primary instance of every CLI tool without any roster row', async () => {
      upsertWorktree(db, makeWorktree('alpha', 'alpha'));
      const tmux = makeFakeTmux(['mcbd-claude-alpha', 'mcbd-codex-alpha', 'mcbd-gemini-alpha']);

      await reconcileWorktreeSessions(db, 'alpha', 'beta', { tmux });

      expect(tmux.names()).toEqual(['mcbd-claude-beta', 'mcbd-codex-beta', 'mcbd-gemini-beta']);
    });

    it('does nothing when no session is running', async () => {
      upsertWorktree(db, makeWorktree('alpha', 'alpha'));
      const tmux = makeFakeTmux([]);

      const result = await reconcileWorktreeSessions(db, 'alpha', 'beta', { tmux });

      expect(tmux.calls).toEqual([]);
      expect(result.renamedSessions).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it('refuses to clobber a destination owned by a session that is not moving', async () => {
      upsertWorktree(db, makeWorktree('alpha', 'alpha'));
      const tmux = makeFakeTmux(['mcbd-claude-alpha', 'mcbd-claude-beta']);

      const result = await reconcileWorktreeSessions(db, 'alpha', 'beta', { tmux });

      expect(result.renamedSessions).toEqual([]);
      expect(result.skippedSessions).toEqual([
        {
          oldName: 'mcbd-claude-alpha',
          newName: 'mcbd-claude-beta',
          reason: 'destination session already exists',
        },
      ]);
      // Both sessions survive untouched.
      expect(tmux.names()).toEqual(['mcbd-claude-alpha', 'mcbd-claude-beta']);
    });

    it('rejects an invalid new id before it reaches tmux', async () => {
      upsertWorktree(db, makeWorktree('alpha', 'alpha'));
      const tmux = makeFakeTmux(['mcbd-claude-alpha']);

      const result = await reconcileWorktreeSessions(db, 'alpha', 'bad id;rm -rf', { tmux });

      expect(tmux.calls).toEqual([]);
      expect(result.renamedSessions).toEqual([]);
      expect(tmux.names()).toEqual(['mcbd-claude-alpha']);
    });
  });

  // -------------------------------------------------------------------------
  // 3a. Auto-Yes: state transferred, poller restarted
  // -------------------------------------------------------------------------

  describe('Auto-Yes', () => {
    it('carries the state (and its deadline) to the new worktree id', async () => {
      upsertWorktree(db, makeWorktree('alpha', 'alpha'));
      const before = setAutoYesEnabled('alpha', 'claude', true, undefined, 'BOOM');

      const result = await reconcileWorktreeSessions(db, 'alpha', 'beta', {
        tmux: makeFakeTmux([]),
      });

      expect(result.movedAutoYesKeys).toEqual(['beta:claude']);
      expect(getAutoYesState('alpha', 'claude')).toBeNull();

      const after = getAutoYesState('beta', 'claude');
      expect(after?.enabled).toBe(true);
      // Not merely "still enabled": the same countdown, so a 3h window a user
      // started does not silently restart at the migration.
      expect(after?.expiresAt).toBe(before.expiresAt);
      expect(after?.stopPattern).toBe('BOOM');
    });

    it('moves an alias instance state without touching the primary', async () => {
      upsertWorktree(db, makeWorktree('alpha', 'alpha'));
      setAutoYesEnabled('alpha', 'claude', true);
      setAutoYesEnabled('alpha', 'claude', true, undefined, undefined, 'claude-2');

      await reconcileWorktreeSessions(db, 'alpha', 'beta', { tmux: makeFakeTmux([]) });

      expect(getAutoYesStateCompositeKeys().sort()).toEqual(['beta:claude', 'beta:claude:claude-2']);
    });

    it('swaps two worktrees without either state clobbering the other', async () => {
      upsertWorktree(db, makeWorktree('alpha', 'alpha'));
      upsertWorktree(db, makeWorktree('beta', 'beta'));
      setAutoYesEnabled('alpha', 'claude', true, undefined, 'FROM-ALPHA');
      setAutoYesEnabled('beta', 'claude', true, undefined, 'FROM-BETA');

      await reconcileWorktreeSessions(
        db,
        [
          { oldId: 'alpha', newId: 'beta' },
          { oldId: 'beta', newId: 'alpha' },
        ],
        { tmux: makeFakeTmux([]) }
      );

      expect(getAutoYesState('beta', 'claude')?.stopPattern).toBe('FROM-ALPHA');
      expect(getAutoYesState('alpha', 'claude')?.stopPattern).toBe('FROM-BETA');
    });

    it('restarts a running poller under the new id', async () => {
      upsertWorktree(db, makeWorktree('alpha', 'alpha'));
      setAutoYesEnabled('alpha', 'claude', true);
      expect(startAutoYesPolling('alpha', 'claude').started).toBe(true);
      expect(getAutoYesPollerCompositeKeys()).toEqual(['alpha:claude']);

      const result = await reconcileWorktreeSessions(db, 'alpha', 'beta', {
        tmux: makeFakeTmux([]),
      });

      // Moving the state without restarting the poller looks identical in the
      // state map and is exactly the "Auto-Yes silently stopped" failure.
      expect(getAutoYesPollerCompositeKeys()).toEqual(['beta:claude']);
      expect(result.restartedAutoYesPollers).toEqual(['beta:claude']);
      expect(result.errors).toEqual([]);
    });

    it('does not start a poller for a worktree that had none', async () => {
      upsertWorktree(db, makeWorktree('alpha', 'alpha'));
      setAutoYesEnabled('alpha', 'claude', true);

      await reconcileWorktreeSessions(db, 'alpha', 'beta', { tmux: makeFakeTmux([]) });

      expect(getAutoYesPollerCompositeKeys()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 3b. Response poller
  // -------------------------------------------------------------------------

  describe('response poller', () => {
    it('re-keys the poller and preserves its start time and dedup hashes', async () => {
      upsertWorktree(db, makeWorktree('alpha', 'alpha'));

      const oldKey = getPollerKey('alpha', 'claude');
      const newKey = getPollerKey('beta', 'claude');
      const startedAt = Date.now() - 60_000;
      activePollers.set(oldKey, setTimeout(() => {}, 60_000));
      pollingStartTimes.set(oldKey, startedAt);
      // Seed both dedup caches so the "already saved" answer can be checked
      // after the move.
      expect(isDuplicatePrompt(oldKey, 'Proceed?')).toBe(false);
      expect(isDuplicateResponse(oldKey, 'done')).toBe(false);

      const result = await reconcileWorktreeSessions(db, 'alpha', 'beta', {
        tmux: makeFakeTmux([]),
      });

      expect(result.movedPollerKeys).toEqual([newKey]);
      expect(activePollers.has(oldKey)).toBe(false);
      expect(activePollers.has(newKey)).toBe(true);
      // The 30-minute budget measures from the turn's real start, not from the
      // migration.
      expect(pollingStartTimes.get(newKey)).toBe(startedAt);
      expect(pollingStartTimes.has(oldKey)).toBe(false);
      // Carried, not cleared: a cleared cache re-saves the screen on display.
      expect(isDuplicatePrompt(newKey, 'Proceed?')).toBe(true);
      expect(isDuplicateResponse(newKey, 'done')).toBe(true);
    });

    it('resolves an alias instance CLI tool from the roster', async () => {
      upsertWorktree(db, makeWorktree('beta', 'beta'));
      setAgentInstances(db, 'beta', [
        { id: 'codex-3', cliTool: 'codex', alias: '', order: 0 },
      ]);

      const oldKey = getPollerKey('alpha', 'codex', 'codex-3');
      activePollers.set(oldKey, setTimeout(() => {}, 60_000));
      pollingStartTimes.set(oldKey, Date.now());

      const result = await reconcileWorktreeSessions(db, 'alpha', 'beta', {
        tmux: makeFakeTmux([]),
      });

      expect(result.movedPollerKeys).toEqual([getPollerKey('beta', 'codex', 'codex-3')]);
      expect(activePollers.has(oldKey)).toBe(false);
    });

    it('leaves pollers of other worktrees alone', async () => {
      upsertWorktree(db, makeWorktree('alpha', 'alpha'));
      const otherKey = getPollerKey('unrelated', 'claude');
      activePollers.set(otherKey, setTimeout(() => {}, 60_000));

      await reconcileWorktreeSessions(db, 'alpha', 'beta', { tmux: makeFakeTmux([]) });

      expect(activePollers.has(otherKey)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 3c. WebSocket rooms and terminal subscriptions
  // -------------------------------------------------------------------------

  describe('websocket', () => {
    it('moves the room and notifies the subscriber', async () => {
      upsertWorktree(db, makeWorktree('alpha', 'alpha'));
      const ws = fakeSocket();
      wsInternal.registerClientForTest(ws);
      wsInternal.handleMessage(ws, { type: 'subscribe', worktreeId: 'alpha' });
      expect(hasRoomSubscribers('alpha')).toBe(true);

      const result = await reconcileWorktreeSessions(db, 'alpha', 'beta', {
        tmux: makeFakeTmux([]),
      });

      expect(hasRoomSubscribers('alpha')).toBe(false);
      expect(hasRoomSubscribers('beta')).toBe(true);
      expect(wsInternal.getClientInfoForTest(ws)?.worktreeIds).toEqual(new Set(['beta']));
      expect(result.movedRooms).toEqual([{ oldId: 'alpha', newId: 'beta', subscribers: 1 }]);

      const sent = (ws.send as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => JSON.parse(String(call[0]))
      );
      expect(sent).toContainEqual({
        type: 'worktree_renamed',
        worktreeId: 'beta',
        previousWorktreeId: 'alpha',
      });
    });

    it('re-points a live terminal subscription at the new session name', async () => {
      upsertWorktree(db, makeWorktree('alpha', 'alpha'));
      const ws = fakeSocket();
      wsInternal.registerClientForTest(ws);
      const clientInfo = wsInternal.getClientInfoForTest(ws)!;
      clientInfo.terminalSubscription = {
        worktreeId: 'alpha',
        cliToolId: 'claude',
        sessionName: 'mcbd-claude-alpha',
        startedAt: Date.now(),
        unsubscribe: async () => {},
      };

      await reconcileWorktreeSessions(db, 'alpha', 'beta', {
        tmux: makeFakeTmux(['mcbd-claude-alpha']),
      });

      // terminal_input/terminal_resize address this cached name; leaving it
      // stale means keystrokes go to a session that no longer answers.
      expect(clientInfo.terminalSubscription?.sessionName).toBe('mcbd-claude-beta');
      expect(clientInfo.terminalSubscription?.worktreeId).toBe('beta');
    });

    it('merges rather than replaces when both rooms have subscribers (swap)', () => {
      const a = fakeSocket();
      const b = fakeSocket();
      wsInternal.registerClientForTest(a);
      wsInternal.registerClientForTest(b);
      wsInternal.handleMessage(a, { type: 'subscribe', worktreeId: 'alpha' });
      wsInternal.handleMessage(b, { type: 'subscribe', worktreeId: 'beta' });

      migrateWorktreeRooms([
        { oldId: 'alpha', newId: 'beta' },
        { oldId: 'beta', newId: 'alpha' },
      ]);

      expect(hasRoomSubscribers('alpha')).toBe(true);
      expect(hasRoomSubscribers('beta')).toBe(true);
      expect(wsInternal.getClientInfoForTest(a)?.worktreeIds).toEqual(new Set(['beta']));
      expect(wsInternal.getClientInfoForTest(b)?.worktreeIds).toEqual(new Set(['alpha']));
    });
  });

  // -------------------------------------------------------------------------
  // 4. Alias-driven startup pass
  // -------------------------------------------------------------------------

  describe('reconcileWorktreeSessionsFromAliases', () => {
    it('renames sessions still sitting under an id recorded in worktree_aliases', async () => {
      upsertWorktree(db, makeWorktree('commandmate-main', 'commandmate-main'));
      recordWorktreeAlias(db, 'mycodebranchdesk-main', 'commandmate-main');

      const tmux = makeFakeTmux(['mcbd-claude-mycodebranchdesk-main']);
      const result = await reconcileWorktreeSessionsFromAliases(db, { tmux });

      expect(result.errors).toEqual([]);
      expect(tmux.names()).toEqual(['mcbd-claude-commandmate-main']);
    });

    it('is a no-op (one listing, no renames) when nothing is stale', async () => {
      upsertWorktree(db, makeWorktree('commandmate-main', 'commandmate-main'));
      recordWorktreeAlias(db, 'mycodebranchdesk-main', 'commandmate-main');

      const tmux = makeFakeTmux(['mcbd-claude-commandmate-main']);
      const result = await reconcileWorktreeSessionsFromAliases(db, { tmux });

      expect(tmux.calls).toEqual([]);
      expect(result.renamedSessions).toEqual([]);
    });

    it('returns an empty result when there are no aliases at all', async () => {
      const tmux = makeFakeTmux(['mcbd-claude-anything']);
      const result = await reconcileWorktreeSessionsFromAliases(db, { tmux });

      expect(result.renamedSessions).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(tmux.names()).toEqual(['mcbd-claude-anything']);
    });
  });
});
