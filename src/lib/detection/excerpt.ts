/**
 * Byte-budgeted excerpt truncation for published detection fields (Issue #2095).
 *
 * Extracted from `upstream-faults.ts`, which has carried this since Issue #1839,
 * because #2095 publishes a second screen-read excerpt (`paneObstruction`) under
 * the same rules. Two copies of a bound whose whole job is to be exact is how the
 * two fields would come to promise different things while claiming the same
 * limit — the same argument `status-evidence.ts` makes for keeping one
 * expression per fact.
 *
 * A leaf module by design: it imports nothing, so the canary (which runs outside
 * Next), the server payload builder and the client components can all share it.
 *
 * @module lib/detection/excerpt
 */

/**
 * Truncate to a UTF-8 **byte** budget on a code-point boundary.
 *
 * Bytes rather than characters for the reason Issue #1694 gives for its own
 * excerpt: a Japanese frame runs three bytes to the character, so a
 * character-counted bound publishes three times the payload it promises. These
 * excerpts ride every `current-output` response of an affected session, and
 * those responses are polled every few seconds.
 *
 * The marker is inside the budget, not on top of it: the bound is a promise
 * about the published field, and a caller sizing a log line by it must not be
 * handed twelve more characters than it asked for. Accumulating code points
 * (never UTF-16 units) is what keeps a surrogate pair whole.
 */
export function truncateToByteBudget(text: string, maxBytes: number, marker: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;

  const budget = maxBytes - encoder.encode(marker).length;
  let bytes = 0;
  let out = '';
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (bytes + size > budget) break;
    bytes += size;
    out += char;
  }
  return `${out}${marker}`;
}
