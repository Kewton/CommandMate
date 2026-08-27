import { describe, expect, it } from 'vitest';

import {
  NO_DIAGNOSTIC_PREFIX,
  expectDiagnostic,
  expectDiagnosticLines,
} from '@tests/helpers/hooks-git-diagnostics';

/**
 * Issue #2089, request 3: a failure has to say which of two things went wrong.
 *
 * `expect(stderr).toContain('…')` reports `expected '' to contain '…'` when the
 * diagnostic was suppressed and `expected 'monitor hooks WARN: …' to contain
 * '…'` when it was merely reworded. Only the second is ever attributable to the
 * diff under review, and the first is what a stale once-per-worker marker
 * produces — but the two read almost alike, so every occurrence cost a human an
 * adjudication. The counted form has the same flaw: `expected [] to have a
 * length of 1 but got +0` is emitted for both.
 *
 * The wording is the deliverable here, so it is asserted rather than trusted.
 * Without this file, neutralising the empty-stderr branch in
 * tests/helpers/hooks-git-diagnostics.ts changes nothing any test can see.
 */
function messageOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the assertion to fail, but it passed');
}

describe('expectDiagnostic separates "nothing was printed" from "the wording changed"', () => {
  it('says no diagnostic was printed at all when stderr is empty', () => {
    const message = messageOf(() => expectDiagnostic('', "failed (exit 130)", 'git status'));

    expect(message).toContain(NO_DIAGNOSTIC_PREFIX);
    expect(message).toContain('stderr is empty (0 lines)');
    expect(message).toContain('git status');
    // The distinction, stated in the message itself rather than left to the reader.
    expect(message).toContain('the diagnostic never happened');
    // And the lead the reader needs next.
    expect(message).toContain('MONITOR_HOOKS_STATE_DIR');
  });

  it('treats whitespace-only stderr as nothing printed', () => {
    // `\n` alone is what a shell that flushed an empty line leaves behind; it is
    // not a diagnostic and must not be reported as one that said the wrong thing.
    expect(messageOf(() => expectDiagnostic('\n  \n', 'anything', 'blank'))).toContain(
      NO_DIAGNOSTIC_PREFIX,
    );
  });

  it('does NOT claim silence when a diagnostic was printed with other wording', () => {
    const printed = 'monitor hooks WARN: base ref does not resolve\n';
    const message = messageOf(() => expectDiagnostic(printed, 'failed (exit 130)', 'git status'));

    expect(message).not.toContain(NO_DIAGNOSTIC_PREFIX);
    // The other half of the contract: a real wording diff still reads as one.
    expect(message).toContain('a diagnostic WAS printed');
    expect(message).toContain('base ref does not resolve');
  });

  it('passes silently when the expected diagnostic is present', () => {
    expect(() =>
      expectDiagnostic("monitor hooks WARN: 'git status --porcelain' failed (exit 130)\n",
        'failed (exit 130)', 'git status'),
    ).not.toThrow();
  });
});

describe('expectDiagnosticLines makes the counted form say the same thing', () => {
  it('says no diagnostic was printed at all when stderr is empty', () => {
    const message = messageOf(() => expectDiagnosticLines('', () => true, 1, 'four polls'));

    expect(message).toContain(NO_DIAGNOSTIC_PREFIX);
    expect(message).toContain('four polls');
  });

  it('prints what stderr DID carry when nothing matched', () => {
    const message = messageOf(() =>
      expectDiagnosticLines('monitor hooks WARN: something else\n', (l) => l.includes('nope'), 1,
        'four polls'),
    );

    expect(message).not.toContain(NO_DIAGNOSTIC_PREFIX);
    expect(message).toContain('stderr carried 1 line(s), none of which matched');
    expect(message).toContain('monitor hooks WARN: something else');
  });

  it('still fails on the wrong COUNT when lines did match', () => {
    // The once-per-worker rule is a count, not a presence check: two copies of
    // the line is the per-poll regression #1614 removed.
    const twice = 'monitor hooks ERROR: boom\nmonitor hooks ERROR: boom\n';
    const message = messageOf(() =>
      expectDiagnosticLines(twice, (l) => l.includes('boom'), 1, 'four polls'),
    );

    expect(message).not.toContain(NO_DIAGNOSTIC_PREFIX);
    expect(message).toContain('four polls');
  });

  it('returns the matched lines so a caller can assert on their content', () => {
    const matched = expectDiagnosticLines(
      'monitor hooks ERROR: [nope-nope] no checkout resolved\nunrelated\n',
      (line) => line.includes('[nope-nope]'),
      1,
      'unresolvable id',
    );

    expect(matched).toEqual(['monitor hooks ERROR: [nope-nope] no checkout resolved']);
  });

  it('accepts an expected count of zero without inventing a failure', () => {
    expect(() => expectDiagnosticLines('', () => true, 0, 'silence')).not.toThrow();
  });
});
