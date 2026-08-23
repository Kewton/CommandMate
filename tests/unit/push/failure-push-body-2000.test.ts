/**
 * A failure notification reads as a failure (Issue #2000).
 *
 * The acceptance criterion is that success and failure are told apart **from the
 * body**, on a lock screen, without opening the app. So these assert real
 * wording in both locales rather than key strings — `push-sender` imports the
 * dictionaries statically (it is compiled to CJS for `dist/server`, where
 * next-intl cannot be required), which is also why the global next-intl mock in
 * tests/setup.ts cannot mask a missing entry here: a wrong or absent key changes
 * `body` and fails.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { buildPushPayload, type FailurePushReason } from '@/lib/push/push-sender';
import { SUPPORTED_LOCALES } from '@/config/i18n-config';

const BASE = { worktreeId: 'wt-1', worktreeName: 'feature-x' } as const;

function failureBody(
  reason: FailurePushReason,
  locale: string,
  excerpt?: string
): string {
  return buildPushPayload(
    {
      ...BASE,
      kind: 'failure',
      excerpt,
      failure: { reason, signature: `sig:${reason}` },
    },
    locale,
    1000
  ).body;
}

const REASONS: FailurePushReason[] = [
  'verification-failed',
  'upstream-fault',
  'session-start-failed',
];

describe('failure notification bodies (Issue #2000)', () => {
  it('renders English wording that names the failure', () => {
    expect(failureBody('verification-failed', 'en', 'lint, unit')).toBe(
      'Verification failed: lint, unit'
    );
    expect(failureBody('verification-failed', 'en')).toBe('Verification failed');
    expect(failureBody('upstream-fault', 'en', 'API Error: 529 Overloaded')).toBe(
      'Stalled by an upstream API fault: API Error: 529 Overloaded'
    );
    expect(failureBody('upstream-fault', 'en')).toBe('Stalled by an upstream API fault');
    expect(failureBody('session-start-failed', 'en', 'Claude Code: cannot be launched')).toBe(
      'Could not start the session: Claude Code: cannot be launched'
    );
    expect(failureBody('session-start-failed', 'en')).toBe('Could not start the session');
  });

  it('renders Japanese wording that names the failure', () => {
    expect(failureBody('verification-failed', 'ja', 'lint, unit')).toBe(
      '検証ゲート不合格: lint, unit'
    );
    expect(failureBody('verification-failed', 'ja')).toBe('検証ゲートに不合格しました');
    expect(failureBody('upstream-fault', 'ja')).toBe('上流APIの障害で停止しています');
    expect(failureBody('session-start-failed', 'ja')).toBe('セッションを起動できませんでした');
  });

  it('never reads like a completion, in any locale', () => {
    // The criterion, stated as a property: whatever the wording ends up being,
    // a failure body must not be the success body.
    for (const locale of SUPPORTED_LOCALES) {
      const done = buildPushPayload({ ...BASE, kind: 'completion' }, locale).body;
      const doneWithExcerpt = buildPushPayload(
        { ...BASE, kind: 'completion', excerpt: 'lint, unit' },
        locale
      ).body;

      for (const reason of REASONS) {
        expect(failureBody(reason, locale)).not.toBe(done);
        expect(failureBody(reason, locale, 'lint, unit')).not.toBe(doneWithExcerpt);
      }
    }
  });

  it('substitutes every placeholder in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const reason of REASONS) {
        expect(failureBody(reason, locale, 'detail')).not.toContain('{excerpt}');
        expect(failureBody(reason, locale)).not.toContain('{excerpt}');
      }
    }
  });

  it('carries a tag of its own, so a failure never replaces a waiting prompt', () => {
    const failure = buildPushPayload(
      { ...BASE, kind: 'failure', failure: { reason: 'upstream-fault', signature: 's' } },
      'en'
    );
    const prompt = buildPushPayload({ ...BASE, kind: 'prompt' }, 'en');

    expect(failure.tag).toBe('wt-1:failure');
    expect(failure.tag).not.toBe(prompt.tag);
    expect(failure.kind).toBe('failure');
    expect(failure.url).toBe('/worktrees/wt-1');
  });

  it('falls back to generic failure copy when a producer omits the reason', () => {
    // Defensive: a `kind: 'failure'` event with no `failure` block is a producer
    // bug, and the reader must still get something that says "failed" rather
    // than an empty body or the wrong signal's wording.
    const body = buildPushPayload({ ...BASE, kind: 'failure', excerpt: 'boom' }, 'en').body;
    expect(body).toBe('Failed: boom');
    expect(buildPushPayload({ ...BASE, kind: 'failure' }, 'ja').body).toBe('失敗しました');
  });
});
