/**
 * Signatures of an upstream (model API) fault, as they appear on an agent's
 * terminal frame (Issue #1839).
 *
 * Moved here from `scripts/canary/expectations.ts`, where Issue #1727 first
 * wrote them, because the canary is no longer the only reader: `capture --json`
 * publishes the match as `upstreamFault` and `wait --fail-on-upstream-fault`
 * branches on it. Two copies of a pattern list whose whole job is *not* to be
 * over-eager would drift, and the drift would be silent on both sides.
 *
 * A leaf module by design — it imports nothing but {@link stripAnsi}, so the
 * canary (which runs outside Next) and the server payload builder can share it
 * without either pulling in the other's dependencies.
 *
 * ## What a match means, and what it does not
 *
 * A match means the signature was on the frame. A **non**-match means nothing at
 * all about upstream health: the pane may have scrolled, the agent may render a
 * failure with wording nobody has seen yet, and Issue #1834 measured a case
 * where the pane went blank instead of carrying a banner. Nothing in this
 * module — and nothing reading it — may report "no fault" as "upstream is
 * healthy".
 *
 * @module lib/detection/upstream-faults
 */

import { stripAnsi } from './ansi';
import { truncateToByteBudget } from './excerpt';

/**
 * An upstream condition that stalls an agent without saying anything about the
 * detection layer: API overload, rate/usage limits, transport errors.
 *
 * Observed for real on 2026-08-06 — a `529 Overloaded · Retrying in 34s ·
 * attempt 9/10` banner kept a canary scenario "running" past its timeout.
 * Reporting that as a detection regression would train everyone to ignore the
 * canary, so those frames get their own outcome (`blocked`) and buy extra
 * waiting time.
 */
export interface UpstreamFault {
  id: string;
  pattern: RegExp;
  /** Whether the agent retries on its own, so waiting longer is worthwhile. */
  selfRetrying: boolean;
}

/**
 * Patterns are anchored on ERROR wording, not on the words "usage limit".
 * Claude's own banner advertises "up to 50% of your weekly usage limit on
 * Fable 5" on a perfectly healthy frame — a looser pattern marked every
 * scenario of a run as `blocked` (measured 2026-08-06), which would have hidden
 * real regressions behind a fake infrastructure excuse.
 *
 * Order is precedence: the first match wins, so the specific overload wording
 * is listed ahead of the generic `API Error` catch-all. The line Claude 2.1.236
 * prints on a 529 storm contains both (`API Error: Repeated 529 Overloaded
 * errors …`, measured for Issue #1839), and `overloaded` is the more useful of
 * the two answers because it carries `selfRetrying: true`.
 */
export const UPSTREAM_FAULTS: readonly UpstreamFault[] = [
  { id: 'overloaded', pattern: /\b5\d{2}\s+Overloaded\b/i, selfRetrying: true },
  { id: 'retrying', pattern: /Retrying in \d+s\s*[·•]\s*attempt \d+\/\d+/i, selfRetrying: true },
  {
    // The conversation outgrew the model's window (Issue #3011). Command Code
    // prints `400 This model's maximum context length is N tokens. However, you
    // requested M tokens`; retrying the same session cannot succeed.
    id: 'context-limit',
    pattern: /\bmaximum context length is \d+ tokens\b/i,
    selfRetrying: false,
  },
  {
    // codex ends the turn with `Selected model is at capacity` and does not
    // answer (Issue #3936); the same model will not, so the cue is to switch
    // instance or model. Anchored on the sentence, not on "at capacity": the
    // 529 line above says "The API is at capacity" and is `overloaded`.
    //
    // And on codex's own error row, not on the sentence alone: `■ ` at column
    // 0, the shape codex 0.160.0 draws its errors in (measured on
    // `■ Conversation interrupted`). A reply that names or quotes the error —
    // this Issue, its review — is indented (`• ` / `  `), and an input echo
    // starts with `› `; matching those would fail a healthy turn with exit 11.
    // The capacity row itself is unmeasured (the fixture is synthetic).
    id: 'model-capacity',
    pattern: /^■ Selected model is at capacity\b/im,
    selfRetrying: false,
  },
  { id: 'limit-reached', pattern: /\blimit reached\b/i, selfRetrying: false },
  {
    // Anchored to a line start (Issue #3946), like `model-capacity`: only the two
    // shapes measured for the fault itself are accepted — claude's `⏺ API Error: …`
    // row (Issue #1839) and a bare `API Error: …` at column 0. Unanchored, it
    // matched a healthy codex reply that quoted `• API Error: 500` on an indented
    // continuation line, and `ask` exited 11 — twice, because the quoting turn was
    // still inside the 100-row window when the next turn ended. A codex `• ` row,
    // an indented continuation and a `› ` input echo are not accepted.
    //
    // Known limit: a claude reply that itself begins with `⏺ API Error: …` is
    // indistinguishable from the fault, because nothing here knows who wrote a row
    // (reply, echo, tool error) — only its leading shape.
    id: 'api-error',
    pattern: /^(?:⏺ )?API Error(?::|\s+\d{3})/im,
    selfRetrying: false,
  },
];

/**
 * The faults whose pattern is anchored to codex's own error row (`■ ` at column
 * 0), and so the only ones safe to apply to a row outside `realtimeSnippet`
 * (Issue #3946, {@link matchCodexErrorRowFault}). An unanchored pattern on such a
 * row would read a quote in an old reply as a fault happening now.
 */
export const CODEX_ERROR_ROW_FAULT_IDS: readonly string[] = ['model-capacity'];

/**
 * Bound on {@link UpstreamFaultMatch.matchedText}, in UTF-8 **bytes**.
 *
 * Bytes rather than characters for the reason Issue #1694 gives for its own
 * excerpt: a Japanese frame runs three bytes to the character, so a
 * character-counted bound publishes three times the payload it promises. The
 * excerpt rides every `current-output` response of a faulted session, and those
 * responses are polled every few seconds.
 */
export const UPSTREAM_FAULT_EXCERPT_MAX_BYTES = 200;

/** Appended when {@link UPSTREAM_FAULT_EXCERPT_MAX_BYTES} cut the excerpt. */
export const UPSTREAM_FAULT_TRUNCATION_MARKER = '…[truncated]';

/**
 * Truncate to this module's UTF-8 byte budget.
 *
 * The arithmetic moved to `./excerpt` when Issue #2095 published a second
 * screen-read excerpt under the same rules; still not `truncateToUtf8Bytes`
 * from `lib/auto-yes-state`, which reaches the database and the Auto-Yes state
 * machine, because this module is a leaf the canary imports from outside Next.
 */
function truncateExcerpt(text: string): string {
  return truncateToByteBudget(
    text,
    UPSTREAM_FAULT_EXCERPT_MAX_BYTES,
    UPSTREAM_FAULT_TRUNCATION_MARKER,
  );
}

/** A signature that was found, with the text that carried it. */
export interface UpstreamFaultMatch {
  fault: UpstreamFault;
  /**
   * The whole line the pattern matched, trimmed and bounded.
   *
   * The line rather than the match: `api-error` matches the four characters
   * `API Error:`, which cannot tell an operator whether the agent hit a 529
   * storm or a 401 from a mistyped key. The line says which
   * (`API Error: Repeated 529 Overloaded errors. …`), and that distinction is
   * the entire reason this field exists.
   */
  matchedText: string;
}

/**
 * The first upstream fault visible in the frame, with its line.
 *
 * ANSI is stripped first: the signature words are routinely split by colour
 * sequences on a live pane.
 */
export function matchUpstreamFault(frame: string): UpstreamFaultMatch | null {
  return matchFaults(frame, UPSTREAM_FAULTS);
}

/**
 * {@link matchUpstreamFault} restricted to {@link CODEX_ERROR_ROW_FAULT_IDS}
 * (Issue #3946): for the one codex transcript row read from outside the window,
 * where a quote must not count.
 */
export function matchCodexErrorRowFault(row: string): UpstreamFaultMatch | null {
  return matchFaults(
    row,
    UPSTREAM_FAULTS.filter((fault) => CODEX_ERROR_ROW_FAULT_IDS.includes(fault.id)),
  );
}

function matchFaults(frame: string, faults: readonly UpstreamFault[]): UpstreamFaultMatch | null {
  const clean = stripAnsi(frame);
  for (const fault of faults) {
    const match = fault.pattern.exec(clean);
    // The patterns are stateless (no /g; `model-capacity` and `api-error` are
    // anchored to a line start with /m), so `exec` cannot carry a lastIndex
    // between calls — but reading `index` requires exec regardless.
    if (!match) continue;
    const lineStart = clean.lastIndexOf('\n', match.index) + 1;
    const lineEnd = clean.indexOf('\n', match.index);
    const line = clean.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
    return { fault, matchedText: truncateExcerpt(line || match[0]) };
  }
  return null;
}

/**
 * First upstream fault visible in the frame, if any.
 *
 * Kept alongside {@link matchUpstreamFault} because the canary only ever wanted
 * the classification (`id` / `selfRetrying`), and a caller that does not need
 * the excerpt should not have to reach through a wrapper for it.
 */
export function findUpstreamFault(frame: string): UpstreamFault | null {
  return matchUpstreamFault(frame)?.fault ?? null;
}
