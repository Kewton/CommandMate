/**
 * Reading an agent's reply out of the chat ledger (Issue #2376 / #2386 / #3039)
 *
 * `ask` reads the reply after its own turn; `reply` (Issue #3039) reads the
 * latest reply of a turn somebody else sent — a worker told to "stop and
 * report" by a supervisor nudge. Both mean the same thing by "the reply", so
 * the rules live here once rather than in two commands that can drift:
 *
 * - only assistant rows in `GET /api/worktrees/:id/messages` are candidates,
 *   prompt rows excluded;
 * - CommandMate's own furniture (`relay-sys:` / `model-changed:`) is never an
 *   answer;
 * - a row a transcript reader wrote (`<tool>-turn:<id>`) wins over a scrape;
 * - ANSI escapes and control bytes are dropped before the text is returned.
 *
 * What differs between the two callers — how long to hold out for a turn row,
 * and whether an unmarked row may stand in for one — stays with the caller.
 */

import type { PromptMessageResponse } from '../types/api-responses';
import type { ApiClient } from './api-client';

/**
 * Chat rows read back per request.
 *
 * Bounded because only the tail matters and an unbounded read of a long-running
 * worktree's history is a large response for one line of answer. Generous
 * enough that a turn which wrote several assistant rows (a tool-use narration
 * followed by the summary) still has its last one inside the window.
 */
export const REPLY_LOOKBACK_MESSAGES = 30;

/**
 * The `request_id` namespace every transcript reader mints for a turn.
 *
 * `codex-turn:<turn_id>`, `claude-turn:<uuid>`, `antigravity-turn:<id>`,
 * `command-code-turn:<id>` and opencode's `oc-turn:<msg id>` — mirrored here as
 * a shape rather than imported: the CLI bundle keeps its own copies of API
 * strings instead of pulling `src/types/agent-transcript.ts` and its dependents
 * into `build:cli`. Matching the shape rather than a list of five literals is
 * also what stops the sixth reader from silently landing outside the filter.
 *
 * A `:` cannot appear in any of the ids themselves, so this cannot match a row
 * that merely CONTAINS the text.
 */
const TURN_REQUEST_ID_PATTERN = /-turn:/;

/**
 * Request-id namespaces CommandMate writes about a session, not for it.
 *
 * `chat_messages` has no `system` role, so "the model changed" (Issue #2357)
 * and "reply from X" (Issue #2377) are both stored as ASSISTANT rows and told
 * apart by their request id. Neither is anything the other session said, and
 * delivering the relay notice back as an answer is the smallest possible loop —
 * `findWorkerReply` steps over the same rows for the same reason.
 */
const SYSTEM_ROW_REQUEST_ID_PREFIXES = ['relay-sys:', 'model-changed:'] as const;

/**
 * Tools whose reply CommandMate reads out of a transcript rather than a screen.
 *
 * For these five the ledger is authoritative and a row with no turn marker is
 * by definition not the answer. For every other tool (copilot / gemini /
 * vibe-local) the scraper's row is the only record there will ever be.
 *
 * Mirrors the five readers that live under `src/lib/hooks/sources/`.
 */
export const TRANSCRIPT_READER_TOOLS: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'antigravity',
  'command-code',
  'opencode',
]);

/**
 * ANSI escape sequences, as a pattern built from escapes rather than literals.
 *
 * `scripts/check-control-chars.mjs` fails the build on a raw C0 byte in `src/`
 * (Issue #1432), and a raw ESC here would be one.
 */
const ANSI_ESCAPE_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-nqry=><]/g;

/** Remaining C0/C1 control bytes, once the sequences above are gone. */
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * A reply body fit to print, or `''` if nothing survived.
 *
 * Issue #2386 asked for this as a belt to the braces: the row the junk came
 * from held RAW ANSI, and a caller that pipes a reply into a report or a commit
 * message should never have to strip escape codes out of an agent's sentence.
 *
 * @param raw - Reply text as it arrived
 */
export function sanitizeReply(raw: string): string {
  return raw.replace(ANSI_ESCAPE_PATTERN, '').replace(CONTROL_CHAR_PATTERN, '').trim();
}

/** Whether a row's `request_id` says a transcript reader wrote it. */
function isTurnRow(requestId: string | undefined | null): boolean {
  return typeof requestId === 'string' && TURN_REQUEST_ID_PATTERN.test(requestId);
}

/** Whether a row is CommandMate's own furniture rather than the agent's words. */
function isSystemRow(requestId: string | undefined | null): boolean {
  return typeof requestId === 'string'
    && SYSTEM_ROW_REQUEST_ID_PREFIXES.some((prefix) => requestId.startsWith(prefix));
}

/** One assistant row that could be the reply. */
export interface ReplyCandidate {
  /** Sanitized body. Never empty — an empty one is not a candidate. */
  content: string;
  /** Whether a transcript reader wrote it (see {@link isTurnRow}). */
  fromTranscript: boolean;
  /** The row's `request_id`, or null when the producer had none. */
  requestId: string | null;
  /** The row's own timestamp, as the messages route serialized it. */
  at: string;
}

/**
 * The rows that could be a reply written at or after `since`, oldest first.
 *
 * @param messages - Rows as the messages route serialized them
 * @param since - Epoch ms; rows stamped earlier are not candidates
 */
export function replyCandidates(
  messages: PromptMessageResponse[],
  since: number,
): ReplyCandidate[] {
  const candidates: ReplyCandidate[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    if (m.messageType === 'prompt') continue;
    if (typeof m.content !== 'string') continue;
    if (!(Date.parse(m.timestamp) >= since)) continue;
    if (isSystemRow(m.requestId)) continue;
    const content = sanitizeReply(m.content);
    if (content === '') continue;
    candidates.push({
      content,
      fromTranscript: isTurnRow(m.requestId),
      requestId: typeof m.requestId === 'string' ? m.requestId : null,
      at: m.timestamp,
    });
  }
  return candidates;
}

/**
 * The newest reply among `candidates`, or null.
 *
 * Newest first among the rows a reader wrote: a turn that emitted several
 * assistant rows (a narration then the summary) still ends on its summary.
 * When `turnRowsOnly` is false and no reader wrote anything, the newest row of
 * any kind is taken — the only record a tool without a transcript has.
 *
 * @param candidates - Output of {@link replyCandidates}
 * @param turnRowsOnly - Whether an unmarked (scraped) row may stand in
 */
export function pickLatestReply(
  candidates: ReplyCandidate[],
  turnRowsOnly: boolean,
): ReplyCandidate | null {
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    if (candidates[i].fromTranscript) return candidates[i];
  }
  if (turnRowsOnly) return null;
  return candidates[candidates.length - 1] ?? null;
}

/**
 * The recent chat rows for this instance. Throws what the API client throws.
 *
 * @param client - API client
 * @param worktreeId - Worktree ID
 * @param instanceId - Resolved instance ID, or undefined for every instance
 */
export async function requestRecentMessages(
  client: ApiClient,
  worktreeId: string,
  instanceId: string | undefined,
): Promise<PromptMessageResponse[]> {
  const query = new URLSearchParams({ limit: String(REPLY_LOOKBACK_MESSAGES) });
  if (instanceId) query.set('instance', instanceId);
  // PromptMessageResponse is the CLI's mirror of a serialized chat row; the
  // `messageType: 'prompt'` filter is the caller's, not the type's, so it is
  // the right shape for reading normal rows too.
  const messages = await client.get<PromptMessageResponse[]>(
    `/api/worktrees/${worktreeId}/messages?${query.toString()}`,
  );
  return Array.isArray(messages) ? messages : [];
}

/**
 * {@link requestRecentMessages}, or null if the rows cannot be read.
 *
 * For a caller whose turn already completed: a daemon that cannot serve the
 * ledger is a reason to fall back, not a reason to lose the turn.
 */
export async function fetchRecentMessages(
  client: ApiClient,
  worktreeId: string,
  instanceId: string | undefined,
): Promise<PromptMessageResponse[] | null> {
  try {
    return await requestRecentMessages(client, worktreeId, instanceId);
  } catch {
    return null;
  }
}
