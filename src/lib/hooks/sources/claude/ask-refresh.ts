/**
 * One synchronous read of a claude instance's transcript for a pending ask
 * (Issue #4344, design `docs/design/ask-attribution-4344.md` §3.5).
 *
 * The server's poller runs the reader when a turn ends, but its owner may be
 * another process, or stopped. `GET /api/asks/:askId` calls this once for a
 * `pending` row so the ask can settle inside the CLI's grace without it. The
 * reader is idempotent (rows are keyed by the prompt's uuid, the ledger's
 * terminal states are never rewritten), so a second read changes nothing.
 *
 * Never throws.
 */

import type Database from 'better-sqlite3';
import { getWorktreeById } from '@/lib/db';
import type { AskCorrelation } from '@/types/ask-correlation';
import { captureClaudeTranscriptTurn } from './history';

/** Read the transcript of the row's destination once. `homeDir` is a test seam. */
export async function refreshClaudeAsk(
  db: Database.Database,
  row: AskCorrelation,
  options: { homeDir?: string } = {},
): Promise<void> {
  if (row.cliToolId !== 'claude') return;
  const worktree = getWorktreeById(db, row.worktreeId);
  if (!worktree?.path) return;
  await captureClaudeTranscriptTurn(
    { worktreeId: row.worktreeId, cliToolId: 'claude', instanceId: row.instanceId },
    { worktreePath: worktree.path, ...(options.homeDir ? { homeDir: options.homeDir } : {}) },
  );
}
