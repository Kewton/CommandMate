/**
 * Unit tests for push payload builders and notification dedup (Issue #1125).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildExcerpt, buildPushPayload } from '@/lib/push/push-sender';
import {
  shouldSendNotification,
  resetNotificationDedup,
} from '@/lib/push/notification-dedup';

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
      2000
    );
    expect(payload.kind).toBe('completion');
    expect(payload.body.startsWith('完了: ')).toBe(true);
    // Excerpt is truncated — the payload must stay minimal.
    expect(payload.body.length).toBeLessThan(140);
  });

  it('falls back to a generic body when excerpt is empty', () => {
    expect(buildPushPayload({ worktreeId: 'w', worktreeName: 'n', kind: 'prompt' }).body).toBe(
      '応答待ちです'
    );
    expect(buildPushPayload({ worktreeId: 'w', worktreeName: 'n', kind: 'completion' }).body).toBe(
      'セッションが完了しました'
    );
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
