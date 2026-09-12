/**
 * `resolveRelaySession` resolves identically after moving onto the shared
 * resolver (Issue #2491).
 *
 * #2491 moved `POST /send` off `resolveInstanceCliTool` and onto
 * `resolveSessionTarget`, which left this module as the last caller of the
 * former and its header comment — "the same authority `POST /send` uses" —
 * false. It was moved too, and the claim this file has to back is that nothing
 * about a delivery changed: a relay never names a CLI tool, and with
 * `requestedCliTool` absent the two chains are the same four stages.
 *
 * So every case below is a characterization of the OLD behaviour, written from
 * `resolveInstanceCliTool`'s four steps plus the two fallback lines this
 * function used to spell out for itself, and each one must hold unchanged. The
 * one place the two resolvers could ever disagree — an explicit tool
 * contradicting the instance's declaration — is unreachable from here, and the
 * signature is what makes it unreachable: there is no argument to pass.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, setAgentInstances } from '@/lib/db';
import { resolveRelaySession, relayWorktreeExists } from '@/lib/relay/relay-session-ref';
import type { Worktree } from '@/types/models';

const WORKTREE_ID = 'wt-2491-relay';

describe('resolveRelaySession (Issue #2491: same answers, one resolver)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'Relay',
      path: '/path/to/wt-2491-relay',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'copilot',
    };
    upsertWorktree(db, worktree);
  });

  afterEach(() => {
    db.close();
  });

  it('takes the roster row over everything, and its alias', () => {
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'reviewer', cliTool: 'codex', alias: 'Reviewer', order: 0 },
    ]);

    expect(resolveRelaySession(db, { worktreeId: WORKTREE_ID, instanceId: 'reviewer' })).toEqual({
      worktreeId: WORKTREE_ID,
      instanceId: 'reviewer',
      cliToolId: 'codex',
      alias: 'Reviewer',
    });
  });

  it('takes the roster row even when the id itself names another tool', () => {
    // The #868 anchor is the stage BELOW the roster, in both resolvers.
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'gemini', cliTool: 'codex', alias: '', order: 0 },
    ]);

    const resolved = resolveRelaySession(db, { worktreeId: WORKTREE_ID, instanceId: 'gemini' });
    expect(resolved.cliToolId).toBe('codex');
    // Stored empty, so `getAgentInstance` already substitutes the tool's display
    // name and this function's own "fall back to the id" branch never runs. The
    // attribution header therefore reads Codex for an instance called `gemini` —
    // unchanged by #2491, and pinned here because it looks like a bug otherwise.
    expect(resolved.alias).toBe('Codex');
  });

  it('falls to the #868 primary anchor when the roster has no row', () => {
    const resolved = resolveRelaySession(db, { worktreeId: WORKTREE_ID, instanceId: 'gemini' });
    expect(resolved.cliToolId).toBe('gemini');
    expect(resolved.alias).toBe('gemini');
  });

  it('falls to the worktree default for an ad-hoc id the roster does not know', () => {
    const resolved = resolveRelaySession(db, { worktreeId: WORKTREE_ID, instanceId: 'helper-2' });
    expect(resolved.cliToolId).toBe('copilot');
  });

  it('falls to claude when the worktree itself declares nothing', () => {
    upsertWorktree(db, {
      id: 'wt-2491-bare',
      name: 'Bare',
      path: '/path/to/wt-2491-bare',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
    } as Worktree);

    const resolved = resolveRelaySession(db, { worktreeId: 'wt-2491-bare', instanceId: 'helper-2' });
    expect(resolved.cliToolId).toBe('claude');
  });

  it('still answers for a worktree that does not exist at all', () => {
    // A ledger row outlives the worktree it names, and a relay that throws here
    // is a delivery that never happens. Unchanged: both resolvers end at claude.
    const resolved = resolveRelaySession(db, { worktreeId: 'wt-gone', instanceId: 'helper-2' });
    expect(resolved).toEqual({
      worktreeId: 'wt-gone',
      instanceId: 'helper-2',
      cliToolId: 'claude',
      alias: 'helper-2',
    });
    expect(relayWorktreeExists(db, 'wt-gone')).toBe(false);
  });

  it('never throws when the roster cannot be read', () => {
    db.close();

    const resolved = resolveRelaySession(db, { worktreeId: WORKTREE_ID, instanceId: 'reviewer' });
    expect(resolved).toEqual({
      worktreeId: WORKTREE_ID,
      instanceId: 'reviewer',
      cliToolId: 'claude',
      alias: 'reviewer',
    });

    // `afterEach` closes it again; better-sqlite3 tolerates the second close.
    db = new Database(':memory:');
  });
});
