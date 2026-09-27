/**
 * tmux session ownership (Issue #2865)
 *
 * Session names (`mcbd-{cli}-{worktreeId}`) carry nothing that identifies the
 * CommandMate server that created them, and worktree IDs are derived from the
 * directory name — so two servers with different DBs and different worktree
 * paths can resolve the SAME session name on the shared default tmux socket.
 * Deciding "is it running?" by name alone then shows, types into, kills and
 * adopts the OTHER server's session.
 *
 * CommandMate always creates sessions with `tmux new-session -c <worktree.path>`,
 * so `#{session_path}` records which worktree a session belongs to. A session is
 * "owned" only when the realpath of its `#{session_path}` equals the realpath of
 * the worktree's path; anything else under the same name is "foreign" and is
 * excluded from display, input, stop and reuse.
 *
 * A worktree whose directory has since moved therefore sees its old session as
 * foreign. That is intentional (fail safe).
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { hasSession, getSessionWorkingDirectory } from './tmux';

const logger = createLogger('session-ownership');

export type SessionOwnershipVerdict = 'owned' | 'foreign' | 'absent';

export interface SessionOwnership {
  verdict: SessionOwnershipVerdict;
  /** tmux が返した #{session_path}。absent と取得失敗では null */
  sessionPath: string | null;
}

export const FOREIGN_SESSION_ERROR_CODE = 'session_owned_by_other_server';

/**
 * Thrown when a code path would adopt / drive a session another server owns.
 */
export class ForeignSessionError extends Error {
  readonly code = FOREIGN_SESSION_ERROR_CODE;

  constructor(
    readonly sessionName: string,
    readonly sessionPath: string | null,
    readonly worktreePath: string
  ) {
    super(
      `tmux session "${sessionName}" belongs to another server ` +
        `(session_path=${sessionPath ?? 'unknown'}, worktree=${worktreePath})`
    );
    this.name = 'ForeignSessionError';
  }
}

/**
 * Normalize a path for ownership comparison: realpath when it resolves,
 * otherwise `path.resolve()`; trailing `/` removed; case preserved.
 */
export function normalizeOwnershipPath(p: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(p);
  } catch {
    resolved = path.resolve(p);
  }
  if (resolved.length > 1) {
    resolved = resolved.replace(/\/+$/, '');
  }
  return resolved === '' ? '/' : resolved;
}

/**
 * Pure comparison: is a session created in `sessionPath` owned by the worktree
 * at `worktreePath`? `null` (tmux could not say) is never owned.
 *
 * @param normalize - Path normalizer; {@link createCachedOwnershipMatcher}
 *   passes a memoized one. Defaults to {@link normalizeOwnershipPath}.
 */
export function isSessionPathOwnedBy(
  sessionPath: string | null,
  worktreePath: string,
  normalize: (p: string) => string = normalizeOwnershipPath
): boolean {
  if (sessionPath === null || sessionPath === '') return false;
  return normalize(sessionPath) === normalize(worktreePath);
}

/**
 * Build an `isSessionPathOwnedBy` that memoizes realpath per input path. Meant
 * to live for one request (e.g. the batch status listing), so a moved/created
 * directory is picked up on the next request.
 */
export function createCachedOwnershipMatcher(): (sessionPath: string | null, worktreePath: string) => boolean {
  const cache = new Map<string, string>();
  const norm = (p: string): string => {
    let v = cache.get(p);
    if (v === undefined) {
      v = normalizeOwnershipPath(p);
      cache.set(p, v);
    }
    return v;
  };
  return (sessionPath, worktreePath) => isSessionPathOwnedBy(sessionPath, worktreePath, norm);
}

const warnedForeignSessions = new Set<string>();

/**
 * Log `session:foreign-detected` once per session name for the process lifetime.
 */
export function reportForeignSession(sessionName: string, sessionPath: string | null, worktreePath: string): void {
  if (warnedForeignSessions.has(sessionName)) return;
  warnedForeignSessions.add(sessionName);
  logger.warn('session:foreign-detected', { sessionName, sessionPath, worktreePath });
}

/** Test-only: forget which foreign sessions were already reported. */
export function resetForeignSessionWarningsForTesting(): void {
  warnedForeignSessions.clear();
}

/**
 * Decide whether `sessionName` is absent, owned by the worktree at
 * `worktreePath`, or foreign. A session that exists but whose
 * `#{session_path}` cannot be read is treated as foreign (fail safe).
 */
export async function checkSessionOwnership(sessionName: string, worktreePath: string): Promise<SessionOwnership> {
  if (!(await hasSession(sessionName))) {
    return { verdict: 'absent', sessionPath: null };
  }
  const sessionPath = await getSessionWorkingDirectory(sessionName);
  if (sessionPath !== null && isSessionPathOwnedBy(sessionPath, worktreePath)) {
    return { verdict: 'owned', sessionPath };
  }
  reportForeignSession(sessionName, sessionPath, worktreePath);
  return { verdict: 'foreign', sessionPath };
}

/**
 * Throw `ForeignSessionError` when `sessionName` is foreign; otherwise return
 * the ownership verdict (`owned` or `absent`).
 */
export async function assertSessionNotForeign(sessionName: string, worktreePath: string): Promise<SessionOwnership> {
  const ownership = await checkSessionOwnership(sessionName, worktreePath);
  if (ownership.verdict === 'foreign') {
    throw new ForeignSessionError(sessionName, ownership.sessionPath, worktreePath);
  }
  return ownership;
}

/**
 * JSON body for the HTTP 409 an API route returns for a foreign session.
 */
export function foreignSessionErrorBody(
  sessionName: string,
  sessionPath: string | null
): { error: string; code: typeof FOREIGN_SESSION_ERROR_CODE; sessionName: string; sessionPath: string | null } {
  return {
    error: `tmux session "${sessionName}" belongs to another CommandMate server`,
    code: FOREIGN_SESSION_ERROR_CODE,
    sessionName,
    sessionPath,
  };
}

/**
 * From one batch `listSessions()` result, the names of the sessions the worktree
 * at `worktreePath` owns. Feed this — not the raw name set — to status detection
 * so a same-named foreign session never reads as "running". Other worktrees'
 * sessions drop out too, which is harmless: status detection only looks up the
 * worktree's own session names.
 *
 * @param matcher - Pass one `createCachedOwnershipMatcher()` across all worktrees
 *   of a request so each realpath is resolved once.
 */
export function ownedSessionNameSet(
  tmuxSessions: ReadonlyArray<{ name: string; path?: string }>,
  worktreePath: string,
  matcher: (sessionPath: string | null, worktreePath: string) => boolean = createCachedOwnershipMatcher()
): Set<string> {
  const owned = new Set<string>();
  for (const session of tmuxSessions) {
    if (matcher(session.path ?? null, worktreePath)) owned.add(session.name);
  }
  return owned;
}
