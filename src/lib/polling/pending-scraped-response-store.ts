/**
 * The map of held scrapes (Issue #2436), and the batch re-key that moves it
 * with a worktree-ID rename (Issue #3663).
 *
 * Split out of `./pending-scraped-response` so `response-poller-core` can move
 * holds without importing the module that writes them — that one pulls in the
 * database, the WebSocket server and the transcript reader, none of which the
 * migration needs.
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { getOrInitGlobal } from '../global-state';

/**
 * A scraped reply the poller has read but not written yet (Issue #2436).
 *
 * Everything `checkForResponse` would have passed to `createMessage`, plus the
 * instant it decided to and the instant it stops waiting. The timestamp is the
 * one taken when the turn was JUDGED finished rather than when the row is
 * finally written: History sorts on it, and a row dated seven seconds late would
 * sort under the next turn's prompt.
 */
export interface PendingScrapedResponse {
  readonly worktreeId: string;
  readonly cliToolId: CLIToolType;
  readonly instanceId: string;
  /** The pane's copy of the reply, cleaned. Replaced if the frame moves on. */
  content: string;
  readonly timestamp: Date;
  readonly summary?: string;
  readonly logFileName?: string;
  readonly requestId?: string;
  /** `transcriptPathHint` for the last-chance re-ask; see `settleExpiredPendingScrapedResponse`. */
  readonly worktreePath: string;
  readonly transcriptPathHint: string | null;
  /** `Date.now()` after which the hold is over and the row is written. */
  readonly expiresAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __pendingScrapedResponses: Map<string, PendingScrapedResponse> | undefined;
}

/**
 * Held scrapes, by poller key.
 *
 * **Deliberately not in `./response-dedup`.** That module's two caches are
 * cleared by `stopPollingByKey` — `clearResponseHashCache` is called from
 * inside it — so a held reply parked beside them would be dropped by the very
 * event that has to write it (Issue #2436, requirement B).
 * `flushPendingScrapedResponse` is what the poller calls before it clears
 * anything.
 *
 * On `globalThis` for the reason every shared map in this subsystem is (#1736):
 * under `next dev` the poller's bundle and each route's bundle would otherwise
 * hold a private copy, and a held reply only one bundle can see is a lost one.
 */
export const pendingScrapedResponses = getOrInitGlobal('__pendingScrapedResponses', () => new Map<
  string,
  PendingScrapedResponse
>());

/**
 * Answers whether the code running now is a tick of a poller chain that a
 * worktree-ID migration retired from `pollerKey` (Issue #3663).
 *
 * Installed by `response-poller-core`, which owns the chains and their
 * ownership tokens; until it is, nothing is stale. Kept as an injected check so
 * this module stays free of the poller's import graph.
 */
let staleWriterCheck: (pollerKey: string) => boolean = () => false;

/** Install the stale-writer check. Called once by `response-poller-core`. */
export function setPendingScrapeStaleWriterCheck(check: (pollerKey: string) => boolean): void {
  staleWriterCheck = check;
}

/**
 * Whether the caller must leave the hold at `pollerKey` alone (Issue #3663).
 *
 * A tick that was inside `checkForResponse()` when a migrate retired its chain
 * comes back holding a key that now belongs to another chain — after a swap,
 * with another worktree's hold under it. Whatever it would hold, replace or
 * drop there is about a turn that key no longer stands for.
 */
export function isStalePendingScrapeWriter(pollerKey: string): boolean {
  return staleWriterCheck(pollerKey);
}

/** A held scrape's move, as {@link renamePendingScrapedResponseKeys} takes it. */
export interface PendingScrapedResponseRename {
  oldKey: string;
  newKey: string;
  /** Worktree ID the moved hold is written against */
  newWorktreeId: string;
}

/**
 * Move the held scrapes of a whole batch of pollerKeys (Issue #3663).
 *
 * Same shape as `renameResponseHashCacheKeys` (#3553): every source is lifted
 * before any destination is written, so a swap (A→B, B→A) or a chain (A→B→C)
 * neither loses nor mixes a hold. The hold's `worktreeId` is rewritten to the
 * new ID — it is what the row is finally written against, and the old ID no
 * longer names a worktree. Its deadline and content are kept as they were.
 *
 * A hold already at a destination is REPLACED, as the dedup state there is: the
 * moved poller restarts at that key carrying its source's response hash, so the
 * hold that belongs with it is the source's. A replaced hold is returned so the
 * caller can log it.
 *
 * Pairs with `oldKey === newKey` are ignored.
 *
 * @returns The held scrapes that were overwritten at a destination
 */
export function renamePendingScrapedResponseKeys(
  renames: ReadonlyArray<PendingScrapedResponseRename>
): PendingScrapedResponse[] {
  const lifted: Array<{ newKey: string; pending: PendingScrapedResponse }> = [];
  for (const { oldKey, newKey, newWorktreeId } of renames) {
    if (oldKey === newKey) continue;
    const pending = pendingScrapedResponses.get(oldKey);
    if (!pending) continue;
    pendingScrapedResponses.delete(oldKey);
    lifted.push({ newKey, pending: { ...pending, worktreeId: newWorktreeId } });
  }

  const replaced: PendingScrapedResponse[] = [];
  for (const { newKey, pending } of lifted) {
    const existing = pendingScrapedResponses.get(newKey);
    if (existing) replaced.push(existing);
    pendingScrapedResponses.set(newKey, pending);
  }
  return replaced;
}
