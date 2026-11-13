/**
 * One synchronous read of a codex instance's rollout for a pending ask (Issue
 * #4344, design `docs/design/ask-attribution-4344.md` §3.5, F5 of the PR2
 * prereview).
 *
 * The same contract as claude's `../claude/ask-refresh`: `GET /api/asks/:askId`
 * calls this once for a `pending` row so the ask can settle while no poller is
 * reading (another process owns it, or it is stopped). The reader is
 * idempotent — History rows are keyed by codex's own item and turn ids, and the
 * ledger's terminal states are never rewritten — so a read that races the
 * poller's or the Stop receiver's changes nothing twice.
 *
 * Never throws.
 */

import type Database from 'better-sqlite3';
import type { AskCorrelation } from '@/types/ask-correlation';
import { captureCodexTranscriptTurn } from './history';

/** Read the rollout of the row's destination once. `codexHome` is a test seam. */
export async function refreshCodexAsk(
  _db: Database.Database,
  row: AskCorrelation,
  options: { codexHome?: string } = {},
): Promise<void> {
  if (row.cliToolId !== 'codex') return;
  await captureCodexTranscriptTurn(
    { worktreeId: row.worktreeId, cliToolId: 'codex', instanceId: row.instanceId },
    options.codexHome ? { codexHome: options.codexHome } : {},
  );
}
