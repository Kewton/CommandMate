/**
 * The read API's synchronous refresh, by the ask's tool (Issue #4344, design
 * `docs/design/ask-attribution-4344.md` §3.5, F5 of the PR2 prereview).
 *
 * `GET /api/asks/:askId` hands this to `readAskAttribution`, which calls it once
 * for a `pending` row. It runs the reader of the tool the ask was sent to —
 * claude's or codex's — and nothing for a tool without one (no other tool's
 * capability is true, so no other tool has rows).
 *
 * Never throws (each reader never throws).
 */

import type Database from 'better-sqlite3';
import type { AskCorrelation } from '@/types/ask-correlation';
import { refreshClaudeAsk } from '@/lib/hooks/sources/claude/ask-refresh';
import { refreshCodexAsk } from '@/lib/hooks/sources/codex/ask-refresh';

/** Run the destination tool's reader once for `row`. */
export async function refreshAskFromReader(db: Database.Database, row: AskCorrelation): Promise<void> {
  if (row.cliToolId === 'claude') return refreshClaudeAsk(db, row);
  if (row.cliToolId === 'codex') return refreshCodexAsk(db, row);
}
