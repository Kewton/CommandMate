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
  { id: 'limit-reached', pattern: /\blimit reached\b/i, selfRetrying: false },
  { id: 'api-error', pattern: /\bAPI Error(?::|\s+\d{3})/i, selfRetrying: false },
];

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
 * Truncate to a UTF-8 byte budget on a code-point boundary.
 *
 * A local copy rather than `truncateToUtf8Bytes` from `lib/auto-yes-state`: that
 * module reaches the database and the Auto-Yes state machine, and this one is a
 * leaf the canary imports from outside Next. Accumulating code points (never
 * UTF-16 units) is what keeps a surrogate pair whole.
 */
function truncateExcerpt(text: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= UPSTREAM_FAULT_EXCERPT_MAX_BYTES) return text;

  // The marker is inside the budget, not on top of it: the bound is a promise
  // about the published field, and a caller sizing a log line by it must not be
  // handed twelve more characters than it asked for.
  const budget =
    UPSTREAM_FAULT_EXCERPT_MAX_BYTES - encoder.encode(UPSTREAM_FAULT_TRUNCATION_MARKER).length;
  let bytes = 0;
  let out = '';
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (bytes + size > budget) break;
    bytes += size;
    out += char;
  }
  return `${out}${UPSTREAM_FAULT_TRUNCATION_MARKER}`;
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
  const clean = stripAnsi(frame);
  for (const fault of UPSTREAM_FAULTS) {
    const match = fault.pattern.exec(clean);
    // The patterns are unanchored and stateless (no /g), so `exec` cannot carry
    // a lastIndex between calls — but reading `index` requires exec regardless.
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
