/**
 * Issue #1839: the upstream-fault signatures, now that `capture --json` and
 * `wait --fail-on-upstream-fault` read them and not only the canary.
 *
 * The frames here are the ones measured on 2026-08-20 against a stub upstream
 * answering 529 to a real `claude` 2.1.236 (see
 * docs/design/upstream-fault-turn-boundary-1839.md), plus the healthy banner the
 * canary's own patterns were once too loose for.
 */

import { describe, expect, it } from 'vitest';
import {
  findUpstreamFault,
  matchUpstreamFault,
  UPSTREAM_FAULTS,
  UPSTREAM_FAULT_EXCERPT_MAX_BYTES,
  UPSTREAM_FAULT_TRUNCATION_MARKER,
} from '@/lib/detection/upstream-faults';

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** The line Claude 2.1.236 prints once its retries are exhausted (measured). */
const MEASURED_529_LINE =
  '⏺ API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually ' +
  'temporary. Try again in a moment. If it persists, check your inference gateway ' +
  '(127.0.0.1:53892).';

describe('findUpstreamFault (Issue #1839)', () => {
  it('detects all four signatures', () => {
    const cases: Array<{ frame: string; id: string }> = [
      { frame: '✻ 529 Overloaded · Retrying in 34s · attempt 9/10', id: 'overloaded' },
      { frame: '✻ Working · Retrying in 8s · attempt 2/10', id: 'retrying' },
      { frame: 'Claude usage limit reached. Your limit will reset at 3pm.', id: 'limit-reached' },
      { frame: '⏺ API Error: Connection error.', id: 'api-error' },
    ];

    for (const { frame, id } of cases) {
      expect(findUpstreamFault(frame)?.id, frame).toBe(id);
    }
    // Every id in the table is reachable, so a signature cannot be shadowed into
    // permanent silence by one listed above it without this failing.
    expect(new Set(cases.map(c => c.id))).toEqual(new Set(UPSTREAM_FAULTS.map(f => f.id)));
  });

  it('does NOT match Claude’s healthy weekly-usage banner', () => {
    // The false positive that made the canary report every scenario as blocked
    // (measured 2026-08-06). "usage limit" alone is a promo, not a fault.
    const banner =
      'Claude Code can use up to 50% of your weekly usage limit on Fable 5 before falling back.';
    expect(findUpstreamFault(banner)).toBeNull();
    expect(matchUpstreamFault(banner)).toBeNull();
  });

  it('prefers the overload classification over the API Error catch-all', () => {
    // Both patterns are on the measured line. `overloaded` carries
    // selfRetrying: true, which is the actionable half of the answer.
    const match = matchUpstreamFault(MEASURED_529_LINE);
    expect(match?.fault.id).toBe('overloaded');
    expect(match?.fault.selfRetrying).toBe(true);
  });

  it('reports the whole matched line, not just the matched words', () => {
    const frame = ['❯ Say the single word: ping', MEASURED_529_LINE, '✻ Sautéed for 1s'].join('\n');
    const match = matchUpstreamFault(frame);

    expect(match?.matchedText).toContain('API Error: Repeated 529 Overloaded errors');
    // Neighbouring rows stay out: the excerpt is one line by construction.
    expect(match?.matchedText).not.toContain('Say the single word');
    expect(match?.matchedText).not.toContain('Sautéed');
  });

  it('publishes the measured 529 line whole — the budget is not tight on it', () => {
    // 187 UTF-8 bytes, measured. The bound exists for pathological frames, and a
    // regression that shrank it would silently cut the one line this feature was
    // built to show an operator.
    expect(utf8Bytes(MEASURED_529_LINE)).toBeLessThanOrEqual(UPSTREAM_FAULT_EXCERPT_MAX_BYTES);
    const excerpt = matchUpstreamFault(MEASURED_529_LINE)?.matchedText ?? '';
    expect(excerpt).toBe(MEASURED_529_LINE);
    expect(excerpt).not.toContain(UPSTREAM_FAULT_TRUNCATION_MARKER);
  });

  it('bounds an oversized line in UTF-8 bytes and says when it cut', () => {
    const excerpt =
      matchUpstreamFault(`API Error: ${'overflow '.repeat(80)}`)?.matchedText ?? '';

    expect(utf8Bytes(excerpt)).toBeLessThanOrEqual(UPSTREAM_FAULT_EXCERPT_MAX_BYTES);
    expect(excerpt.endsWith(UPSTREAM_FAULT_TRUNCATION_MARKER)).toBe(true);
  });

  it('measures the bound in bytes, not characters, and never splits a code point', () => {
    // 3 bytes per character: a character-counted bound would publish ~3x the
    // promised payload, which is the failure Issue #1694 documents for its own
    // excerpt.
    const japanese = `API Error: ${'上流障害'.repeat(40)}`;
    const excerpt = matchUpstreamFault(japanese)?.matchedText ?? '';

    expect(utf8Bytes(excerpt)).toBeLessThanOrEqual(UPSTREAM_FAULT_EXCERPT_MAX_BYTES);
    expect(excerpt.length).toBeLessThan(UPSTREAM_FAULT_EXCERPT_MAX_BYTES);
    // A split multi-byte character would show up as U+FFFD.
    expect(excerpt).not.toContain('�');
  });

  it('reads through ANSI colouring, which live panes always carry', () => {
    // The words of a signature are routinely split by an SGR sequence mid-line.
    const esc = String.fromCharCode(27);
    const coloured = `${esc}[31m\u23fa API Error: ${esc}[1m529 Overloaded${esc}[0m errors.`;
    const match = matchUpstreamFault(coloured);

    expect(match?.fault.id).toBe('overloaded');
    expect(match?.matchedText).toBe('\u23fa API Error: 529 Overloaded errors.');
    expect(match?.matchedText).not.toContain(esc);
  });

  it('returns null for a healthy idle composer', () => {
    expect(findUpstreamFault('❯ \n  ? for shortcuts')).toBeNull();
  });
});
