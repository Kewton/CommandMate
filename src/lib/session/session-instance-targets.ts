/**
 * Every (CLI tool, instance) pair whose tmux session could belong to a worktree
 * (Issue #1621, extracted for #2866).
 *
 * Shared by the startup passes that predict session names from the database —
 * `worktree-session-reconcile.ts` (ID moves) and `adopt-legacy-sessions.ts`
 * (legacy-name adoption) — so both enumerate the same set.
 */

import type Database from 'better-sqlite3';
import { CLI_TOOL_IDS, isCliToolType, type CLIToolType } from '@/lib/cli-tools/types';
import { getAgentInstances } from '@/lib/db/agent-instances-db';

export interface InstanceTarget {
  cliToolId: CLIToolType;
  instanceId: string;
}

/**
 * The primary instance of every CLI tool, plus every roster row under any of
 * `worktreeIds`.
 *
 * The primary instance of every CLI tool is always included — a worktree that
 * predates the roster (#1000) has no `agent_instances` rows at all yet can
 * absolutely have a running `mcbd-claude-<id>` session.
 *
 * @param db - Database instance (read for the agent roster)
 * @param worktreeIds - The worktree IDs whose roster rows to include
 */
export function collectInstanceTargets(
  db: Database.Database,
  worktreeIds: ReadonlyArray<string>
): InstanceTarget[] {
  const seen = new Set<string>();
  const targets: InstanceTarget[] = [];

  const add = (cliToolId: CLIToolType, instanceId: string): void => {
    const key = `${cliToolId}|${instanceId}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ cliToolId, instanceId });
  };

  for (const cliToolId of CLI_TOOL_IDS) add(cliToolId, cliToolId);

  for (const worktreeId of worktreeIds) {
    let instances;
    try {
      instances = getAgentInstances(db, worktreeId);
    } catch {
      // No agent_instances table (older database) — the primary instances above
      // already cover the pre-roster shape.
      continue;
    }
    for (const instance of instances) {
      if (isCliToolType(instance.cliTool)) add(instance.cliTool, instance.id);
    }
  }

  return targets;
}
