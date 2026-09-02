/**
 * Real `GET /api/worktrees/<id>/messages` rows, for Issue #2245.
 *
 * Captured 2026-09-02 from the running server on develop `966b40f8`:
 *
 *   curl -s http://127.0.0.1:3000/api/worktrees/harness-pack-uat-sandbox-uatrun1/messages
 *   curl -s http://127.0.0.1:3000/api/worktrees/commandagent-develop/messages
 *
 * A contiguous slice of each is stored VERBATIM in the JSON beside this file —
 * `role`, `messageType`, `summary`, `promptData`, `requestId` and the whole of
 * `content`, escape sequences included. Nothing is trimmed, because the
 * defect under test is precisely that these bodies are 1.6–2.8 KB of pane and
 * that some of them carry raw `ESC`. A fixture with the escapes cleaned or the
 * bodies shortened would let the fix pass without doing anything.
 *
 * The JSON is written with `ensure_ascii`, so an `ESC` byte is stored as the
 * six-character escape `\u001b`: `JSON.parse` restores the exact byte, and the
 * file stays greppable and diffable rather than being classified as data.
 *
 * ## What each slice contains
 *
 * `agy` (antigravity) — a user turn, a transcript-reader reply (Markdown), an
 * `ESC`-bearing composer scrape, a second user turn, then five approval rows:
 * two scraped dialogs whose bodies start with the shell prompt line
 * `CM_HOOK_URL='…' 'agy'`, the permission hook's audit row, and the
 * `terminal` + `auto` PAIR for one dialog (13:57:00.931Z / 13:57:01.917Z, same
 * `question`, same `approvalTarget`) that Issue #2245 folds into one chip. It
 * ends on an `ESC`-bearing tool-output scrape.
 *
 * `codex` — a user turn, a `claude-turn:` Markdown reply, `ESC`-bearing
 * composer and status scrapes, a `/compact` user row, and four consecutive
 * `PermissionRequest allow · tool=Bash` audit rows.
 */

import type { ChatMessage } from '@/types/models';
import agyRaw from './agy-messages.json';
import codexRaw from './codex-messages.json';

/** A row as the API serializes it: `timestamp` is an ISO string, not a `Date`. */
type RawMessage = Omit<ChatMessage, 'timestamp'> & { timestamp: string };

function hydrate(rows: unknown): ChatMessage[] {
  return (rows as RawMessage[]).map((row) => ({
    ...row,
    timestamp: new Date(row.timestamp),
  }));
}

/** The antigravity slice, hydrated the way the chat surface receives it. */
export function agyMessages(): ChatMessage[] {
  return hydrate(agyRaw);
}

/** The codex slice, hydrated the way the chat surface receives it. */
export function codexMessages(): ChatMessage[] {
  return hydrate(codexRaw);
}

/**
 * The two rows that record ONE dialog: the status sweep's inferred `terminal`
 * row and the Auto-Yes poller's `auto` row 986 ms later.
 */
export const AGY_DUPLICATE_PAIR_INDEXES = [7, 8] as const;

/** The permission hook's audit row in the antigravity slice. */
export const AGY_AUDIT_INDEX = 6;
