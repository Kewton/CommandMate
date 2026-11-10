/**
 * "Updates confirmed without a proposal" (the read-only list of the hand-off, design
 * `mem-ui-4227.md` §4.1 ④・G2) reads the request's own items only (Issue #4227 pr2c, codex
 * review-4227-pr2 P2-3). A detached HEAD's items are one worktree's (mem's lists,
 * `mem-db.ts` `scopeClause`: `branch IS NULL AND origin_worktree_id = ?`), so another
 * detached worktree of the same repository is not listed; a branch is shared by the
 * worktrees on it, so both are (the control).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({}) };
  },
}));

import { getHandoffRequest, listDirectItemChanges } from '@/lib/db/handoff-db';
import { readView } from '@/lib/handoff/common';
import { makeHandoffWorld, WT, type HandoffWorld } from './handoff-harness';

let w: HandoffWorld;
beforeEach(() => {
  w = makeHandoffWorld('handoff-direct-4227-');
  w.makeWorktree();
  w.setMode('on', true);
  w.openLaunch();
});
afterEach(() => w.close());

/** An item an agent wrote on `branch` (null: detached) from `worktreeId`, at `at`. */
function agentItem(id: string, branch: string | null, worktreeId: string, at: number) {
  w.db
    .prepare(
      `INSERT INTO mem_items (id, repository_id, branch, kind, state, text, origin_worktree_id, origin_worktree_incarnation, origin_instance_id,
         origin_cli_tool_id, origin_incarnation, created_by, updated_by, updated_by_instance, version, checked_rules_version, created_at, updated_at)
       VALUES (?, ?, ?, 'note', 'open', ?, ?, 'inc', 'claude', 'claude', 'inc-i', 'agent', 'agent', 'claude', 1, 1, ?, ?)`
    )
    .run(id, w.repoId, branch, `text of ${id}`, worktreeId, at, at);
}

describe('[#4227] codex P2-3: the direct updates of a detached request are its worktree’s only', () => {
  it('two detached worktrees of one repository: each lists its own items, not the other’s', () => {
    const since = w.clock.now;
    agentItem('item-a', null, 'wt-a', since + 1);
    agentItem('item-b', null, 'wt-b', since + 2);
    const ids = (worktreeId: string) => listDirectItemChanges(w.db, w.repoId, null, worktreeId, since, new Set()).map((change) => change.id);
    expect(ids('wt-a')).toEqual(['item-a']);
    expect(ids('wt-b')).toEqual(['item-b']);
  });

  it('(control) a branch is shared: the items of both worktrees on it are listed', () => {
    const since = w.clock.now;
    agentItem('item-a', 'feature/x', 'wt-a', since + 1);
    agentItem('item-b', 'feature/x', 'wt-b', since + 2);
    expect(listDirectItemChanges(w.db, w.repoId, 'feature/x', 'wt-a', since, new Set()).map((change) => change.id)).toEqual(['item-b', 'item-a']);
  });

  it('the request’s view passes its target worktree: a detached request of WT lists WT’s item, not another detached worktree’s', async () => {
    const created = await w.create();
    const stored = getHandoffRequest(w.db, created.request.id)!;
    // The same request read as a detached one (the branch is pinned by v71, so the row is read as it would be).
    const detached = { ...stored, branch: null, detached: true };
    agentItem('item-own', null, WT, stored.createdAt + 1);
    agentItem('item-other', null, 'wt-other', stored.createdAt + 2);
    expect(readView(w.db, detached, w.clock.now).direct.map((change) => change.id)).toEqual(['item-own']);
  });
});
