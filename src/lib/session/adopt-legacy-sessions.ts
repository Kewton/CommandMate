/**
 * Keep using this server's pre-namespace tmux sessions (Issue #2866).
 *
 * Once a namespace is set, `resolveSessionName` names a session
 * `mcbd-{ns}-{cli}-{worktreeId}[-{suffix}]`. A session the same server started
 * before that is still running under `mcbd-{cli}-{worktreeId}[-{suffix}]`, and
 * would vanish from the UI while its agent keeps running. It is NOT renamed —
 * an older CommandMate running beside this one, or this one after a downgrade,
 * must still find it — but adopted: the new-format name is aliased to the
 * legacy one (`legacy-session-alias.ts`), and the alias is dropped once the
 * legacy session is killed or found gone.
 *
 * Only a session whose `#{session_path}` is the worktree's own directory is
 * adopted (Issue #2865): the same legacy name may be another server's session.
 *
 * Runs once at startup, after `initSessionNamespace` and the worktree-ID
 * session reconcile.
 */

import type Database from 'better-sqlite3';
import {
  resolveLegacySessionName,
  resolveNamespacedSessionName,
} from '@/lib/cli-tools/session-name';
import { getSessionNamespace } from '@/lib/cli-tools/session-namespace';
import { isSessionPathOwnedBy } from '@/lib/cli-tools/session-ownership';
import {
  listSessions,
  registerLegacyAlias,
  type TmuxSession,
} from '@/lib/cli-tools/legacy-session-adoption';
import { createLogger } from '@/lib/logger';
import { collectInstanceTargets } from './session-instance-targets';

const logger = createLogger('adopt-legacy-sessions');

export interface AdoptedLegacySession {
  worktreeId: string;
  /** The name `resolveSessionName` would otherwise have returned */
  newName: string;
  /** The live legacy session it now returns instead */
  legacyName: string;
}

export interface AdoptLegacySessionsResult {
  adopted: AdoptedLegacySession[];
  errors: string[];
}

export interface AdoptLegacySessionsOptions {
  /** Injection seam for tests */
  tmux?: {
    listSessions?: () => Promise<TmuxSession[]>;
    isSessionOwnedBy?: (sessionPath: string | null, worktreePath: string) => boolean;
  };
  /** Defaults to the namespace in effect (`getSessionNamespace()`) */
  namespace?: string | null;
}

/**
 * Every worktree row. Queried directly rather than through `worktree-db`, for
 * the same reason `worktree-session-reconcile.ts` does: suites mock that module.
 */
function readWorktrees(db: Database.Database): Array<{ id: string; path: string }> {
  return db.prepare('SELECT id, path FROM worktrees').all() as Array<{ id: string; path: string }>;
}

/**
 * Alias each worktree instance's new-format session name to its live legacy
 * session, when the legacy session is this worktree's own and no new-format
 * session exists yet.
 *
 * Never throws — a startup pass must not be able to stop the server.
 *
 * @param db - Database instance (worktrees and the agent roster)
 */
export async function adoptLegacySessions(
  db: Database.Database,
  options?: AdoptLegacySessionsOptions
): Promise<AdoptLegacySessionsResult> {
  const result: AdoptLegacySessionsResult = { adopted: [], errors: [] };
  const namespace = options?.namespace !== undefined ? options.namespace : getSessionNamespace();
  // No namespace: the current name IS the legacy name, nothing to adopt.
  if (namespace === null) return result;

  const list = options?.tmux?.listSessions ?? listSessions;
  const isOwnedBy = options?.tmux?.isSessionOwnedBy ?? isSessionPathOwnedBy;

  let livePaths: Map<string, string>;
  let worktrees: Array<{ id: string; path: string }>;
  try {
    const sessions = await list();
    livePaths = new Map(sessions.map((session) => [session.name, session.path]));
    worktrees = livePaths.size === 0 ? [] : readWorktrees(db);
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    logger.warn('adopt-legacy:failed', { error: result.errors[0] });
    return result;
  }

  for (const worktree of worktrees) {
    for (const { cliToolId, instanceId } of collectInstanceTargets(db, [worktree.id])) {
      try {
        const legacyName = resolveLegacySessionName(cliToolId, worktree.id, instanceId);
        if (!livePaths.has(legacyName)) continue;
        const newName = resolveNamespacedSessionName(namespace, cliToolId, worktree.id, instanceId);
        if (livePaths.has(newName)) continue;
        if (!isOwnedBy(livePaths.get(legacyName) ?? null, worktree.path)) continue;
        registerLegacyAlias(newName, legacyName);
        result.adopted.push({ worktreeId: worktree.id, newName, legacyName });
      } catch (error) {
        result.errors.push(
          `${worktree.id}/${instanceId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  logger.info('adopt-legacy:complete', {
    adopted: result.adopted.length,
    errors: result.errors.length,
  });
  return result;
}
