/**
 * CommandMate startup sweep for OpenCode V2 instances (Issue #2934).
 *
 * The role v1's `../opencode/reattach` plays, plus the password files:
 *
 *  - an instance whose tmux session is still alive gets its subscription back,
 *    from the persisted port and the password file on disk (D5, last row);
 *  - an instance whose session is gone has its password file deleted and its
 *    port assignment dropped (D3). Nothing can use them any more — the server
 *    they belonged to died with the pane, because `launch.sh` stops it on every
 *    way out.
 *
 * Candidates are the union of the password files and the persisted ports, so
 * a password left behind by a crash is swept even when its port entry is not.
 *
 * Fail-open and never rejects.
 *
 * @module lib/hooks/sources/opencode-v2/reattach
 */

import { extractCliToolId, extractInstanceId, extractWorktreeId } from '@/lib/auto-yes-state';
import { createLogger } from '@/lib/logger';
import type { AgentInstanceRef } from '../types';
import { forgetOpencodeV2PortByKey, readPersistedOpencodeV2Ports } from './ports';
import { resumeOpencodeV2EventStream } from './runtime';
import { listOpencodeV2PasswordKeys, removeOpencodeV2PasswordByKey } from './secrets';
import { OPENCODE_V2_CLI_TOOL_ID } from './tool-id';

const logger = createLogger('lib/hooks/sources/opencode-v2/reattach');

/** What one sweep did. */
export interface OpencodeV2ReattachReport {
  /** Instances with a password file or a persisted port. */
  known: number;
  /** Of those, instances whose tmux session is alive. */
  candidates: number;
  /** Of the candidates, instances whose subscription is open again. */
  reattached: number;
  /** Instances whose leftovers were deleted because their session is gone. */
  swept: number;
}

/** Collaborators, replaceable in tests. */
export interface OpencodeV2ReattachDeps {
  isPaneRunning: (target: AgentInstanceRef) => Promise<boolean>;
  resolveWorktreePath: (worktreeId: string) => string | null;
  resume: (target: AgentInstanceRef, worktreePath: string) => Promise<boolean>;
}

/** The instance a composite key names, when it is an OpenCode V2 key. */
export function opencodeV2TargetOfKey(key: string): AgentInstanceRef | null {
  if (extractCliToolId(key) !== OPENCODE_V2_CLI_TOOL_ID) return null;
  const worktreeId = extractWorktreeId(key);
  const instanceId = extractInstanceId(key);
  if (worktreeId.length === 0 || instanceId === null || instanceId.length === 0) return null;
  return { worktreeId, cliToolId: OPENCODE_V2_CLI_TOOL_ID, instanceId };
}

async function defaultDeps(): Promise<OpencodeV2ReattachDeps> {
  const { CLIToolManager } = await import('@/lib/cli-tools/manager');
  const tool = CLIToolManager.getInstance().getTool(OPENCODE_V2_CLI_TOOL_ID);
  let resolveWorktreePath: (worktreeId: string) => string | null = () => null;
  try {
    const [{ getDbInstance }, { getWorktreeById }] = await Promise.all([
      import('@/lib/db/db-instance'),
      import('@/lib/db'),
    ]);
    const db = getDbInstance();
    resolveWorktreePath = (worktreeId) => getWorktreeById(db, worktreeId)?.path ?? null;
  } catch (error) {
    logger.warn('opencode-v2-reattach-worktree-lookup-unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    isPaneRunning: (target) => tool.isRunning(target.worktreeId, target.instanceId),
    resolveWorktreePath,
    resume: resumeOpencodeV2EventStream,
  };
}

/**
 * Re-subscribe live instances and sweep dead ones.
 *
 * @param deps - Collaborators; production passes none
 */
export async function reattachOpencodeV2EventStreams(
  deps?: OpencodeV2ReattachDeps
): Promise<OpencodeV2ReattachReport> {
  const report: OpencodeV2ReattachReport = { known: 0, candidates: 0, reattached: 0, swept: 0 };
  try {
    const keys = new Set<string>([
      ...listOpencodeV2PasswordKeys(),
      ...Object.keys(readPersistedOpencodeV2Ports()),
    ]);
    const entries: { key: string; target: AgentInstanceRef }[] = [];
    for (const key of keys) {
      const target = opencodeV2TargetOfKey(key);
      if (target !== null) entries.push({ key, target });
    }
    report.known = entries.length;
    if (entries.length === 0) return report;

    const resolved = deps ?? (await defaultDeps());
    await Promise.all(
      entries.map(async ({ key, target }) => {
        let running = false;
        try {
          running = await resolved.isPaneRunning(target);
        } catch {
          running = false;
        }
        if (!running) {
          removeOpencodeV2PasswordByKey(key);
          forgetOpencodeV2PortByKey(key);
          report.swept += 1;
          return;
        }
        report.candidates += 1;
        const worktreePath = resolved.resolveWorktreePath(target.worktreeId);
        if (worktreePath === null) return;
        if (await resolved.resume(target, worktreePath)) report.reattached += 1;
      })
    );
    logger.info('opencode-v2-reattach-complete', { ...report });
    return report;
  } catch (error) {
    logger.warn('opencode-v2-reattach-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return report;
  }
}
