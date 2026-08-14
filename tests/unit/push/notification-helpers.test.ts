/**
 * Unit tests for push payload builders and notification dedup (Issue #1125).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildExcerpt,
  buildPushPayload,
  resolvePushLocale,
  type NotificationEvent,
} from '@/lib/push/push-sender';
import {
  shouldSendNotification,
  resetNotificationDedup,
} from '@/lib/push/notification-dedup';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/config/i18n-config';

describe('buildExcerpt', () => {
  it('returns empty string for undefined', () => {
    expect(buildExcerpt(undefined)).toBe('');
  });

  it('collapses whitespace/newlines into a single line', () => {
    expect(buildExcerpt('line one\n  line   two\ttab')).toBe('line one line two tab');
  });

  it('truncates long text with an ellipsis', () => {
    const long = 'a'.repeat(200);
    const out = buildExcerpt(long, 20);
    expect(out.length).toBe(20);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('buildPushPayload', () => {
  it('builds a minimal prompt payload with deep-link url and tag', () => {
    const payload = buildPushPayload(
      { worktreeId: 'wt-1', worktreeName: 'feature-x', kind: 'prompt', agentName: 'claude', excerpt: 'Continue?' },
      'ja',
      1000
    );
    expect(payload).toEqual({
      kind: 'prompt',
      title: 'feature-x (claude)',
      body: '応答待ち: Continue?',
      worktreeId: 'wt-1',
      url: '/worktrees/wt-1',
      tag: 'wt-1:prompt',
      timestamp: 1000,
    });
  });

  it('builds a completion payload and never includes full terminal text', () => {
    const payload = buildPushPayload(
      { worktreeId: 'wt-2', worktreeName: 'bugfix', kind: 'completion', excerpt: 'x'.repeat(500) },
      'ja',
      2000
    );
    expect(payload.kind).toBe('completion');
    expect(payload.body.startsWith('完了: ')).toBe(true);
    // Excerpt is truncated — the payload must stay minimal.
    expect(payload.body.length).toBeLessThan(140);
  });

  it('falls back to a generic body when excerpt is empty', () => {
    expect(
      buildPushPayload({ worktreeId: 'w', worktreeName: 'n', kind: 'prompt' }, 'ja').body
    ).toBe('応答待ちです');
    expect(
      buildPushPayload({ worktreeId: 'w', worktreeName: 'n', kind: 'completion' }, 'ja').body
    ).toBe('セッションが完了しました');
  });
});

/**
 * Locale selection (Issue #1308).
 *
 * These assert real wording, not key strings: push-sender imports the
 * dictionaries directly rather than through next-intl, so the global mock in
 * tests/setup.ts cannot mask a missing key here — a wrong or absent entry
 * changes `body` and fails.
 */
describe('buildPushPayload locale selection', () => {
  const prompt: NotificationEvent = {
    worktreeId: 'w',
    worktreeName: 'n',
    kind: 'prompt',
    excerpt: 'Continue?',
  };
  const completion: NotificationEvent = { worktreeId: 'w', worktreeName: 'n', kind: 'completion' };

  it('renders English bodies for an en subscription', () => {
    expect(buildPushPayload(prompt, 'en').body).toBe('Waiting for reply: Continue?');
    expect(buildPushPayload({ ...prompt, excerpt: undefined }, 'en').body).toBe(
      'Waiting for your reply'
    );
    expect(buildPushPayload({ ...completion, excerpt: 'Built' }, 'en').body).toBe('Done: Built');
    expect(buildPushPayload(completion, 'en').body).toBe('Session complete');
  });

  it('renders Japanese bodies for a ja subscription', () => {
    expect(buildPushPayload(prompt, 'ja').body).toBe('応答待ち: Continue?');
    expect(buildPushPayload({ ...prompt, excerpt: undefined }, 'ja').body).toBe('応答待ちです');
    expect(buildPushPayload({ ...completion, excerpt: 'Built' }, 'ja').body).toBe('完了: Built');
    expect(buildPushPayload(completion, 'ja').body).toBe('セッションが完了しました');
  });

  it('never leaves the {excerpt} placeholder unsubstituted', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(buildPushPayload(prompt, locale).body).not.toContain('{excerpt}');
      expect(buildPushPayload({ ...completion, excerpt: 'x' }, locale).body).not.toContain(
        '{excerpt}'
      );
    }
  });

  it('falls back to English for subscriptions predating the locale column', () => {
    // v42 added `locale` with no backfill, so existing rows read back as NULL.
    expect(buildPushPayload(prompt, null).body).toBe('Waiting for reply: Continue?');
    expect(buildPushPayload(prompt, undefined).body).toBe('Waiting for reply: Continue?');
  });

  it('falls back to English for an unsupported stored locale', () => {
    expect(buildPushPayload(prompt, 'fr').body).toBe('Waiting for reply: Continue?');
    expect(buildPushPayload(prompt, '').body).toBe('Waiting for reply: Continue?');
  });

  it('defaults to English when no locale is passed at all', () => {
    expect(buildPushPayload(prompt).body).toBe('Waiting for reply: Continue?');
  });
});

/**
 * The waiting taxonomy in the payload (Issue #1790).
 *
 * `kind` still answers "which toggle gates this", so it stays `'prompt'` for
 * every wait; `waitingKind` is what tells the reader whether tapping the
 * notification will present something to answer.
 */
describe('buildPushPayload waiting kinds', () => {
  const base = { worktreeId: 'w', worktreeName: 'n', kind: 'prompt' as const };

  it('keeps the reply wording for an answerable prompt', () => {
    expect(buildPushPayload({ ...base, waitingKind: 'prompt' }, 'en').body).toBe(
      'Waiting for your reply'
    );
    expect(
      buildPushPayload({ ...base, waitingKind: 'prompt', excerpt: 'Continue?' }, 'en').body
    ).toBe('Waiting for reply: Continue?');
  });

  it.each(['menu', 'unclassified'] as const)(
    'points a %s wait at the terminal instead',
    (waitingKind) => {
      expect(buildPushPayload({ ...base, waitingKind }, 'en').body).toBe(
        'Needs attention in the terminal'
      );
      expect(buildPushPayload({ ...base, waitingKind, excerpt: 'Select a file' }, 'en').body).toBe(
        'Needs attention in the terminal: Select a file'
      );
    }
  );

  it('publishes waitingKind, and only for waits', () => {
    expect(buildPushPayload({ ...base, waitingKind: 'menu' }, 'en').waitingKind).toBe('menu');
    // Omitted rather than null, so a #1125 completion payload is unchanged.
    expect('waitingKind' in buildPushPayload({ ...base, kind: 'completion' }, 'en')).toBe(false);
    expect('waitingKind' in buildPushPayload(base, 'en')).toBe(false);
  });

  it('quotes the elapsed minutes in the reminder and drops the excerpt', () => {
    const since = 1_000_000;
    const payload = buildPushPayload(
      { ...base, waitingKind: 'prompt', waitingSince: since, escalated: true, excerpt: 'Continue?' },
      'en',
      since + 11 * 60_000
    );
    expect(payload.body).toBe('Still waiting for your reply (11 min)');

    expect(
      buildPushPayload(
        { ...base, waitingKind: 'menu', waitingSince: since, escalated: true },
        'ja',
        since + 25 * 60_000
      ).body
    ).toBe('まだ端末の確認が必要です（25分経過）');
  });

  it('never reports a reminder as zero minutes old', () => {
    // Rounding down a threshold that fired a few seconds early would read as
    // "still waiting (0 min)", which says nothing.
    expect(
      buildPushPayload(
        { ...base, waitingSince: 500, escalated: true },
        'en',
        500 + 59_000
      ).body
    ).toBe('Still waiting for your reply (1 min)');
  });

  it('keeps the tag stable so the reminder replaces the first notification', () => {
    const first = buildPushPayload({ ...base, waitingKind: 'prompt', waitingSince: 1 }, 'en');
    const reminder = buildPushPayload(
      { ...base, waitingKind: 'prompt', waitingSince: 1, escalated: true },
      'en'
    );
    expect(reminder.tag).toBe(first.tag);
  });
});

describe('resolvePushLocale', () => {
  it('passes through supported locales', () => {
    expect(resolvePushLocale('en')).toBe('en');
    expect(resolvePushLocale('ja')).toBe('ja');
  });

  it('collapses NULL/unknown to the default locale', () => {
    expect(resolvePushLocale(null)).toBe(DEFAULT_LOCALE);
    expect(resolvePushLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(resolvePushLocale('de')).toBe(DEFAULT_LOCALE);
  });
});

describe('shouldSendNotification (dedup)', () => {
  beforeEach(() => {
    resetNotificationDedup();
  });

  it('allows a first event', () => {
    expect(shouldSendNotification({ worktreeId: 'w', kind: 'prompt', content: 'Continue?' }, 0)).toBe(
      true
    );
  });

  it('suppresses an identical event within the window', () => {
    shouldSendNotification({ worktreeId: 'w', kind: 'prompt', content: 'Continue?' }, 0);
    expect(
      shouldSendNotification({ worktreeId: 'w', kind: 'prompt', content: 'Continue?' }, 1000)
    ).toBe(false);
  });

  it('allows the same content again after the window elapses', () => {
    shouldSendNotification({ worktreeId: 'w', kind: 'prompt', content: 'Continue?' }, 0);
    expect(
      shouldSendNotification({ worktreeId: 'w', kind: 'prompt', content: 'Continue?' }, 40_000)
    ).toBe(true);
  });

  it('allows different content for the same worktree/kind', () => {
    shouldSendNotification({ worktreeId: 'w', kind: 'prompt', content: 'Continue?' }, 0);
    expect(
      shouldSendNotification({ worktreeId: 'w', kind: 'prompt', content: 'Overwrite file?' }, 100)
    ).toBe(true);
  });

  it('tracks prompt and completion kinds independently', () => {
    shouldSendNotification({ worktreeId: 'w', kind: 'prompt', content: 'same' }, 0);
    expect(shouldSendNotification({ worktreeId: 'w', kind: 'completion', content: 'same' }, 0)).toBe(
      true
    );
  });
});
