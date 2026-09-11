/**
 * resolveSessionTarget() — the single resolution authority (Issue #1925).
 *
 * Design §3 P4 found four implementations of "which agent and which instance
 * does this request mean", and they did not agree. The one that mattered most
 * was `kill-session`'s inline expression, which put an explicit `?cliTool` ahead
 * of the roster and never reported the contradiction; the CLI's copy was missing
 * the primary-anchor stage entirely. Since the CLI tool id is half the tmux
 * session name, disagreeing meant addressing a different session.
 *
 * What these tests pin is the precedence of §4 D5 決定 2 — roster over explicit,
 * contradiction reported not resolved — and the two properties that are easy to
 * lose: the roster is not consulted at all without an instanceId (DR3-020), and
 * an instance belonging to another worktree does not resolve here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import {
  resolveSessionTarget,
  resolveSessionTargetStrict,
  describeSessionTargetConflict,
  DEFAULT_SESSION_CLI_TOOL,
  INSTANCE_TOOL_CONFLICT,
} from '@/lib/session/resolve-session-target';
import type { Worktree } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WORKTREE_ID = 'wt-resolve';
const OTHER_WORKTREE_ID = 'wt-other';

describe('resolveSessionTarget', () => {
  let db: Database.Database;

  function seedWorktree(id: string, cliToolId: CLIToolType): void {
    const worktree: Worktree = {
      id,
      name: id,
      path: `/path/to/${id}`,
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId,
    };
    upsertWorktree(db, worktree);
  }

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    seedWorktree(WORKTREE_ID, 'gemini');
    seedWorktree(OTHER_WORKTREE_ID, 'claude');
  });

  afterEach(() => {
    db.close();
  });

  function seedRoster(): void {
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 },
      { id: 'worker-a', cliTool: 'opencode', alias: 'Worker A', order: 1 },
    ]);
  }

  describe('without an instanceId', () => {
    /**
     * DR3-020. Looking at the roster here would let some unrelated instance's
     * agent answer a request that named no instance at all — the roster is
     * keyed by instance, and there is no instance to key it by.
     */
    it('does not consult the roster', () => {
      seedRoster();
      expect(resolveSessionTarget(db, WORKTREE_ID, {})).toEqual({
        cliToolId: 'gemini',
        instanceId: 'gemini',
        resolvedBy: 'worktree-default',
      });
    });

    it('takes the explicit request as given', () => {
      seedRoster();
      expect(resolveSessionTarget(db, WORKTREE_ID, { requestedCliTool: 'copilot' })).toEqual({
        cliToolId: 'copilot',
        instanceId: 'copilot',
        resolvedBy: 'explicit',
      });
    });

    it("falls back to the worktree's own agent when nothing was requested", () => {
      expect(resolveSessionTarget(db, WORKTREE_ID, {})).toMatchObject({
        cliToolId: 'gemini',
        resolvedBy: 'worktree-default',
      });
    });

    /**
     * 決定 5: the last stage is meant to be unreachable — `getWorktreeById`
     * already turns a NULL `cli_tool_id` into claude, so the only ways here are
     * a row naming an agent this build no longer has and a worktree that is not
     * there. Both are the shape of #1909 (a plausible-looking default that
     * nothing actually chose), so they get their own `resolvedBy` instead of
     * being indistinguishable from a real worktree setting.
     */
    it('reports the last-resort default as fallback when the stored agent is unknown', () => {
      seedWorktree('wt-bare', 'claude');
      db.prepare('UPDATE worktrees SET cli_tool_id = ? WHERE id = ?').run('retired-tool', 'wt-bare');
      expect(resolveSessionTarget(db, 'wt-bare', {})).toEqual({
        cliToolId: DEFAULT_SESSION_CLI_TOOL,
        instanceId: DEFAULT_SESSION_CLI_TOOL,
        resolvedBy: 'fallback',
      });
    });

    it('reports fallback for a worktree that does not exist at all', () => {
      expect(resolveSessionTarget(db, 'wt-missing', {})).toMatchObject({
        resolvedBy: 'fallback',
      });
    });
  });

  describe('with an instanceId', () => {
    it('takes the roster entry over the worktree default', () => {
      seedRoster();
      expect(resolveSessionTarget(db, WORKTREE_ID, { instanceId: 'worker-a' })).toEqual({
        cliToolId: 'opencode',
        instanceId: 'worker-a',
        resolvedBy: 'roster',
      });
    });

    /**
     * The #1629 order, which the design confirms against the implementation:
     * the roster is the user's own declaration of what a named instance is, so
     * it wins over a flag that may simply have been repeated out of habit.
     */
    it('takes the roster entry over an explicit request that agrees', () => {
      seedRoster();
      expect(resolveSessionTarget(db, WORKTREE_ID, {
        instanceId: 'codex',
        requestedCliTool: 'codex',
      })).toEqual({
        cliToolId: 'codex',
        instanceId: 'codex',
        resolvedBy: 'roster',
      });
    });

    it('resolves to the roster and reports the contradiction when they disagree', () => {
      seedRoster();
      expect(resolveSessionTarget(db, WORKTREE_ID, {
        instanceId: 'codex',
        requestedCliTool: 'claude',
      })).toEqual({
        cliToolId: 'codex',
        instanceId: 'codex',
        resolvedBy: 'roster',
        conflict: { instanceId: 'codex', rosterCliTool: 'codex', requestedCliTool: 'claude' },
      });
    });

    it('takes the explicit request for an instance the roster does not know', () => {
      seedRoster();
      expect(resolveSessionTarget(db, WORKTREE_ID, {
        instanceId: 'codex-9',
        requestedCliTool: 'codex',
      })).toEqual({
        cliToolId: 'codex',
        instanceId: 'codex-9',
        resolvedBy: 'explicit',
      });
    });

    /**
     * #868: an instance id that names a CLI tool IS that tool's primary
     * instance, with or without a roster row. This is the stage the CLI's own
     * copy never had (design §3 P4) — the reason the two implementations
     * answered differently and the reason the CLI now asks instead of guessing.
     */
    it('anchors an unregistered tool-named instance to that tool', () => {
      seedRoster();
      expect(resolveSessionTarget(db, WORKTREE_ID, { instanceId: 'copilot' })).toEqual({
        cliToolId: 'copilot',
        instanceId: 'copilot',
        resolvedBy: 'primary',
      });
    });

    /**
     * Issue #2487 (UAT 2026-09-11, TC-79-4B). The anchor is a declaration in
     * its own right — the id `antigravity` says which agent it is — so a
     * request for another tool contradicts it exactly as it would a roster
     * row, and has to be reported with no row at all: the UAT worktree had
     * none (the claude/codex/antigravity rows `instances --json` shows are
     * derived from selectedAgents, not registered). Taken as an ad-hoc
     * declaration instead, `ask --instance antigravity --agent command-code`
     * started `mcbd-command-code-<wt>-antigravity`, sent the message there,
     * and then waited on agy until exit 124.
     */
    it('reports a request that contradicts an unregistered tool-named instance', () => {
      expect(resolveSessionTarget(db, WORKTREE_ID, {
        instanceId: 'antigravity',
        requestedCliTool: 'command-code',
      })).toEqual({
        cliToolId: 'antigravity',
        instanceId: 'antigravity',
        resolvedBy: 'primary',
        conflict: {
          instanceId: 'antigravity',
          rosterCliTool: 'antigravity',
          requestedCliTool: 'command-code',
          primaryAnchor: true,
        },
      });
    });

    /**
     * Issue #2479's `ask --agent <tool>` alone resolves with the tool id as the
     * selector, so the request and the anchor agree and there is nothing to
     * report.
     */
    it('takes a request that agrees with an unregistered tool-named instance', () => {
      expect(resolveSessionTarget(db, WORKTREE_ID, {
        instanceId: 'command-code',
        requestedCliTool: 'command-code',
      })).toEqual({
        cliToolId: 'command-code',
        instanceId: 'command-code',
        resolvedBy: 'explicit',
      });
    });

    /**
     * The negative control for Issue #2487: only an id that IS a CLI tool id
     * declares a tool. `codex-3` merely looks like one, so the request is still
     * the only declaration there is — `send --agent … --instance …
     * --register` depends on that — even for a tool the name does not suggest.
     */
    it('still takes the request for an ad-hoc id that only resembles a tool id', () => {
      expect(resolveSessionTarget(db, WORKTREE_ID, {
        instanceId: 'codex-3',
        requestedCliTool: 'command-code',
      })).toEqual({
        cliToolId: 'command-code',
        instanceId: 'codex-3',
        resolvedBy: 'explicit',
      });
    });

    it("falls through to the worktree's agent for an unregistered, unnamed instance", () => {
      seedRoster();
      expect(resolveSessionTarget(db, WORKTREE_ID, { instanceId: 'worker-z' })).toEqual({
        cliToolId: 'gemini',
        instanceId: 'worker-z',
        resolvedBy: 'worktree-default',
      });
    });

    /**
     * S6. The roster lookup is scoped by worktree, so an instance registered
     * somewhere else is simply unknown here — it must not borrow that other
     * worktree's agent.
     */
    it('does not resolve an instance registered in a different worktree', () => {
      setAgentInstances(db, OTHER_WORKTREE_ID, [
        { id: 'worker-b', cliTool: 'copilot', alias: 'Worker B', order: 0 },
      ]);
      expect(resolveSessionTarget(db, WORKTREE_ID, { instanceId: 'worker-b' })).toEqual({
        cliToolId: 'gemini',
        instanceId: 'worker-b',
        resolvedBy: 'worktree-default',
      });
    });
  });

  describe('resolveSessionTargetStrict', () => {
    it('passes a resolution with no contradiction straight through', () => {
      seedRoster();
      expect(resolveSessionTargetStrict(db, WORKTREE_ID, { instanceId: 'codex' })).toEqual({
        ok: true,
        target: { cliToolId: 'codex', instanceId: 'codex', resolvedBy: 'roster' },
      });
    });

    it('refuses a contradiction with the shared reason code', () => {
      seedRoster();
      const result = resolveSessionTargetStrict(db, WORKTREE_ID, {
        instanceId: 'codex',
        requestedCliTool: 'claude',
      });
      expect(result).toEqual({
        ok: false,
        error: INSTANCE_TOOL_CONFLICT,
        conflict: { instanceId: 'codex', rosterCliTool: 'codex', requestedCliTool: 'claude' },
      });
    });

    /**
     * Issue #2487: a strict caller refuses on `conflict` alone, so a
     * primary-anchor contradiction is refused with the same reason code as a
     * roster one — 400 from the side-effect routes, and exit 2 from the CLI's
     * strict `resolveInstanceTarget` (`ask`, `send`, `respond`) before anything
     * is sent.
     */
    it('refuses a contradiction of the primary anchor the same way', () => {
      expect(resolveSessionTargetStrict(db, WORKTREE_ID, {
        instanceId: 'antigravity',
        requestedCliTool: 'command-code',
      })).toEqual({
        ok: false,
        error: INSTANCE_TOOL_CONFLICT,
        conflict: {
          instanceId: 'antigravity',
          rosterCliTool: 'antigravity',
          requestedCliTool: 'command-code',
          primaryAnchor: true,
        },
      });
    });

    it('names both declarations and the ways out', () => {
      const message = describeSessionTargetConflict({
        instanceId: 'codex',
        rosterCliTool: 'codex',
        requestedCliTool: 'claude',
      });
      expect(message).toContain("'codex'");
      expect(message).toContain('registered as codex');
      expect(message).toContain('claude was requested');
    });

    /**
     * No roster row stands behind a primary-anchor conflict, so "registered
     * as" would be untrue and "update the instance's roster entry" a dead end
     * (`instances add --id antigravity` answers "already exists").
     */
    it('does not point a primary-anchor conflict at a roster entry it does not have', () => {
      const message = describeSessionTargetConflict({
        instanceId: 'antigravity',
        rosterCliTool: 'antigravity',
        requestedCliTool: 'command-code',
        primaryAnchor: true,
      });
      expect(message).toContain("'antigravity' is the primary instance of antigravity");
      expect(message).toContain('command-code was requested');
      expect(message).toContain('pass antigravity');
      expect(message).not.toMatch(/registered|roster/);
    });
  });
});
