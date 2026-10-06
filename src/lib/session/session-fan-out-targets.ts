/**
 * Fan-out target list shared by the routes that act on several sessions at once
 * (kill-session, interrupt).
 */

import type Database from 'better-sqlite3';
import { getAgentInstances } from '@/lib/db';
import type { CLIToolType } from '@/lib/cli-tools/types';

export function collectFanOutTargets(
  db: Database.Database,
  worktreeId: string,
  toolsToTarget: readonly CLIToolType[]
): Array<{ cliToolId: CLIToolType; instanceId: string }> {
  const targets: Array<{ cliToolId: CLIToolType; instanceId: string }> = [];
  const seen = new Set<string>();
  for (const tool of toolsToTarget) {
    const key = `${tool}:${tool}`;
    if (!seen.has(key)) {
      seen.add(key);
      targets.push({ cliToolId: tool, instanceId: tool });
    }
  }
  // Include any additional registered instances of the targeted tools so
  // their sessions are not orphaned.
  for (const ai of getAgentInstances(db, worktreeId)) {
    if (toolsToTarget.includes(ai.cliTool)) {
      const key = `${ai.cliTool}:${ai.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        targets.push({ cliToolId: ai.cliTool, instanceId: ai.id });
      }
    }
  }
  return targets;
}
