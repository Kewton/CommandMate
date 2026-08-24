/**
 * Whether a status verdict rests on something positive, and what the last
 * positively confirmed verdict was (Issue #1926, 方針書 §4 D1 / §7).
 *
 * Two things live here, for one reason: they are the pair a surface needs in
 * order to say "I cannot read this frame, and here is what it last was".
 *
 *  1. {@link isUnclassifiedFrame} — the ONE expression that decides whether the
 *     detector could classify a frame at all. Issue #1924 introduced the reading
 *     inline in `current-output-builder`; §4 D1 決定 2 says in as many words that
 *     two expressions for one fact is how consumers come apart, so it lives here
 *     and the producer calls it.
 *  2. {@link observeStatusEvidence} / {@link getLastKnownStatus} — the server-side
 *     latch of the last verdict that WAS positive, which is what §7's row
 *     「直前の確定状態（証拠なしの間の表示）」 asks a surface to show while the
 *     current frame carries no evidence.
 *
 * ## The two facts, and why Issue #2011 had to pull them apart again
 *
 * Until #1927 this module also held `deriveScraperEvidence`, which computed
 * {@link StatusEvidence} from `(status, reason)` — and, because the two sets
 * coincided at the time, doubled as the definition of "unclassified frame".
 * #1927 moved the evidence producer into the detector (only the detector knows
 * which rule answered) and left `current-output-builder` deriving the flag from
 * `evidence === 'none'`. That silently redefined the flag: `'none'` means "I
 * could not prove this pane is idle", which an ordinary Claude composer frame
 * satisfies, while the flag's consumers — `TerminalEscapeHatch`, `wait`'s
 * completion rule, `unclassified_frames` — were all written against "nobody
 * could read this frame at all". Every idle Claude pane then raised the hatch
 * and stalled `wait` (#2011).
 *
 * So they are two facts now, and both are published:
 *
 *  - `statusEvidence` — does the verdict rest on something positive? Produced by
 *    the detector, per tool, and deliberately widened by the §4 D1 rollout.
 *  - `isUnclassifiedActive` — could the frame be classified at all? That is
 *    {@link isUnclassifiedFrame}, and it is a statement about the reason
 *    vocabulary, not about the strength of the evidence behind it.
 *
 * A frame can be `evidence: 'none'` and classified (an idle composer no idle
 * rule vouches for), and — since #2011's second half — `evidence: 'positive'`
 * and unclassified (an unreadable pane whose agent reported `Stop`).
 */

// From the leaf module rather than the `status-detector` facade that re-exports
// it: this Set is built at module evaluation, and a suite that partially mocks
// the facade to stub `detectSessionStatus` would leave `STATUS_REASON` undefined
// at exactly that moment (`worktree-status-helper.test.ts` does).
import { STATUS_REASON } from '@/lib/detection/status-reason';
import type { SessionStatus } from '@/lib/detection/status-detector';
import { STRUCTURED_STATE_MAX_AGE_MS } from '@/lib/session/agent-event-state';

/**
 * Whether a status rests on something positive, or on the absence of a negative
 * (Issue #1924, §4 D1 決定 2).
 *
 * `'positive'` — a marker, a tool-specific idle-composer rule, or a structured
 * event said so. `'none'` — nothing on the frame could be read either way, and
 * the status is a fallback.
 *
 * The design policy adds this rather than a fifth `SessionStatus`: the value
 * domain stays four wide, because `src/cli/types/api-responses.ts` enumerates it
 * and a new member is a breaking change for every consumer older than the server
 * — including `commandmate-skills`' `orchestrate-monitor`, which reads
 * `capture --json` as its primary signal.
 */
export type StatusEvidence = 'positive' | 'none';

/**
 * The reasons that mean "no rule could read this frame" (Issue #2011).
 *
 * These are exactly the three verdicts `tools/run-detection.ts` reaches when its
 * chain has run out: the five-second staleness fallback (`no_recent_output`) and
 * the two floors (`unknown_frame` for a tool whose own rules looked and found
 * nothing, `default` for the generic "no pattern matched anywhere"). Every other
 * reason names something the detector recognised — a completion marker, a
 * thinking indicator, a parsed dialog, a selection list, a composer row.
 *
 * `input_prompt` is deliberately NOT here, and that is the whole of #2011: an
 * idle composer whose tool-specific idle rule declined to vouch for it is a
 * frame that WAS classified, published with `evidence: 'none'`. Putting it in
 * this set is what opened `TerminalEscapeHatch` on every idle Claude pane and
 * stopped `wait` completing on one.
 */
const UNCLASSIFIED_FRAME_REASONS: ReadonlySet<string> = new Set<string>([
  STATUS_REASON.NO_RECENT_OUTPUT,
  STATUS_REASON.UNKNOWN_FRAME,
  STATUS_REASON.DEFAULT,
]);

/**
 * Whether the detection layer failed to classify this frame (Issue #1497 /
 * #1708, restated as its own expression by #2011).
 *
 * This is the published `isUnclassifiedActive` contract: `capture --json` sends
 * it, `wait` suppresses its completion check while it holds and exits 10 after
 * {@link https://github.com/Kewton/CommandMate/issues/1708 60 s} of it, and both
 * terminal surfaces open the navigation hatch on it. All three are asking the
 * same question — "is a human looking at something nothing here can drive?" —
 * and none of them is asking how strong the evidence behind a readable verdict
 * is.
 *
 * The status is checked as well as the reason for the reason the pre-#1924
 * expression did: `default` on anything but `running` is not the floor. Since
 * #1927 all three reasons are only ever produced with `running` (§4 D1 決定 3
 * abolished the `ready` the staleness heuristic used to publish), so this is a
 * guard against a future producer rather than a live discriminator.
 *
 * Pure and total, and the single producer: `current-output-builder` calls it
 * rather than restating it, and `mergeStructuredStatus` carries its answer
 * through rather than recomputing one.
 */
export function isUnclassifiedFrame(status: SessionStatus, reason: string): boolean {
  return status === 'running' && UNCLASSIFIED_FRAME_REASONS.has(reason);
}

/**
 * How long a latched verdict is still worth showing.
 *
 * §7 fixes this at `turnStaleAfterMs`, which §4 D3 決定 2 defines as the current
 * staleness bound — so it is imported rather than restated. A second literal
 * here would be the "value の二重定義" S2 exists to forbid, in a field whose
 * whole job is to be honest about age.
 */
export const LAST_KNOWN_STATUS_TTL_MS = STRUCTURED_STATE_MAX_AGE_MS;

/** The last verdict this server could positively confirm for one session. */
export interface LastKnownStatus {
  /** The `SessionStatus` that was confirmed. */
  status: SessionStatus;
  /** The reason token that confirmed it — the scraper's or a `hook_` one. */
  reason: string;
  /** Epoch ms it was confirmed. */
  at: number;
}

/**
 * globalThis pattern for hot-reload persistence — Issue #153, as used by
 * `auto-yes-state.ts` and `unclassified-frame-tracker.ts`.
 *
 * Without it `npm run dev` drops every latch whenever this module is
 * re-evaluated, and `lastKnownStatus` would read `null` on a session that has
 * been confirmed a hundred times — the exact "nothing knows" the field exists to
 * replace.
 */
declare global {
  // eslint-disable-next-line no-var
  var __lastKnownStatusByKey: Map<string, LastKnownStatus> | undefined;
}

const latches =
  globalThis.__lastKnownStatusByKey ??
  (globalThis.__lastKnownStatusByKey = new Map<string, LastKnownStatus>());

/**
 * Cap on retained latches, so a long-lived server cannot grow one per worktree
 * per tool per instance forever.
 *
 * The TTL below already drops anything half an hour old, and
 * {@link forgetLastKnownStatus} drops a session the moment it is seen not
 * running, so this is the backstop for neither of those happening — a server
 * that is polled about thousands of worktrees and restarted before any of them
 * expires. Map iterates in insertion order, so the head is the oldest write.
 */
export const MAX_LATCHES = 512;

function expired(latch: LastKnownStatus, now: number): boolean {
  return now - latch.at >= LAST_KNOWN_STATUS_TTL_MS;
}

/**
 * Sweep, called on WRITE only.
 *
 * Reads are O(1) (they age out their own entry) because they are the hot path:
 * `GET /api/worktrees` probes every tool of every worktree on every poll, so a
 * full-map walk per read would be quadratic in the number of sessions for no
 * benefit. Writes happen only for a session that positively confirmed something,
 * which is at most the number of live sessions.
 */
function prune(now: number): void {
  for (const [key, latch] of latches) {
    if (expired(latch, now)) latches.delete(key);
  }
  while (latches.size > MAX_LATCHES) {
    const oldest = latches.keys().next();
    if (oldest.done) break;
    latches.delete(oldest.value);
  }
}

/**
 * Fold one poll's verdict into the latch for `key`.
 *
 * Only a `'positive'` verdict is latched — that is the whole definition of the
 * field. A frame with no evidence leaves the previous answer standing, which is
 * what makes "here is what it last was" mean anything.
 *
 * ## Two producers, on purpose
 *
 * `current-output-builder` latches the MERGED verdict (scraper folded with the
 * agent's own events); `worktree-status-helper` latches the scraper's, because
 * that is all the list API computes today. On a session with hooks the two can
 * name different statuses for the same moment — but that divergence is the
 * pre-existing gap between `capture --json` and the sidebar, not something this
 * latch introduces, and both readings are genuinely "something confirmed this".
 * Feeding it from both is what keeps the field warm for the surface that needs
 * it most: the header chip and `commandmate ls` are driven by the list API, and
 * a latch only `capture --json` could fill would be null on every one of their
 * polls.
 *
 * @param key - Session identity; use the same composite key the pollers use
 *   (`worktree:cliTool:instance`) so instances of one agent latch separately
 * @param verdict - The status as published by the caller
 * @param now - Epoch ms, injectable for tests
 */
export function observeStatusEvidence(
  key: string,
  verdict: { status: SessionStatus; reason: string; evidence: StatusEvidence },
  now: number = Date.now(),
): void {
  prune(now);
  if (verdict.evidence !== 'positive') return;
  // Deleted first so the re-insert moves the entry to the tail of the insertion
  // order the eviction above walks; otherwise a session that is polled forever
  // would be evicted ahead of one nobody has asked about since it was created.
  latches.delete(key);
  latches.set(key, { status: verdict.status, reason: verdict.reason, at: now });
}

/**
 * The last positively confirmed verdict for `key`, or null.
 *
 * Null covers three situations a caller does not have to tell apart: nothing has
 * ever been confirmed, the last confirmation is older than
 * {@link LAST_KNOWN_STATUS_TTL_MS}, or the server restarted (§7: 「サーバ再起動で
 * クリア」 — the latch is in-memory by design).
 */
export function getLastKnownStatus(key: string, now: number = Date.now()): LastKnownStatus | null {
  const latch = latches.get(key);
  if (latch === undefined) return null;
  if (expired(latch, now)) {
    latches.delete(key);
    return null;
  }
  return latch;
}

/**
 * Drop the latch for a session that is no longer running.
 *
 * A dead session's last confirmed status describes a process that is gone, and
 * reporting `running` from twenty minutes ago next to `isRunning: false` would
 * be the same false confidence `model` is nulled to avoid (#1785). The next
 * session on the same key starts with no history, which is the truth.
 */
export function forgetLastKnownStatus(key: string): void {
  latches.delete(key);
}

/** Drop every latch. Test seam. */
export function clearLastKnownStatuses(): void {
  latches.clear();
}
