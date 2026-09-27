/**
 * The tmux session-name namespace of this server (Issue #2866).
 *
 * Two CommandMate servers with different databases resolve the same
 * `mcbd-{cli}-{worktreeId}` whenever their worktree directories share a name,
 * because worktree IDs are derived from the directory name. Each server
 * therefore mints a random namespace once, keeps it in `app_settings`
 * (`tmux_session_namespace`), and puts it into every session name it creates:
 * `mcbd-{ns}-{cli}-{worktreeId}[-{suffix}]` (`session-name.ts`).
 *
 * Initialized once at server startup, before the startup session reconcile.
 * Until then — and in the CLI, in tests, or when initialization failed — the
 * namespace is unset and names keep the legacy form.
 */

import type Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import {
  getTmuxSessionNamespace,
  setTmuxSessionNamespace,
} from '@/lib/db/app-settings-db';
import { createLogger } from '@/lib/logger';
import {
  SESSION_NAMESPACE_PATTERN,
  getActiveSessionNamespace,
  setActiveSessionNamespace,
} from './session-name';

const logger = createLogger('session-namespace');

/**
 * Read the namespace from the DB, minting and saving one when it is absent or
 * ill-formed, and make it the namespace every later session name uses.
 *
 * @param db - The server's database
 * @returns The namespace now in effect
 * @throws when the DB cannot be written; the namespace then stays unset
 */
export function initSessionNamespace(db: Database.Database): string {
  const stored = getTmuxSessionNamespace(db);
  if (stored !== null && SESSION_NAMESPACE_PATTERN.test(stored)) {
    setActiveSessionNamespace(stored);
    return stored;
  }

  const namespace = randomBytes(4).toString('hex');
  if (stored !== null) {
    logger.warn('session-namespace:invalid-stored-value', { stored, replacement: namespace });
  }
  setTmuxSessionNamespace(db, namespace);
  setActiveSessionNamespace(namespace);
  logger.info('session-namespace:initialized', { namespace, minted: true });
  return namespace;
}

/** The namespace in effect, or null when not initialized. */
export function getSessionNamespace(): string | null {
  return getActiveSessionNamespace();
}

/** Test-only: back to "not initialized". */
export function resetSessionNamespaceForTests(): void {
  setActiveSessionNamespace(null);
}
