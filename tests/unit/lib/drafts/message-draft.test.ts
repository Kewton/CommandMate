/**
 * Issue #4419: the composer's draft keys — split scope (the worktree screen, #728, unchanged) and
 * instance scope (the `/sessions` tile) — and the append used for an instance not on screen.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  appendToStoredDraft,
  getInstanceDraftKey,
  getSplitDraftKey,
} from '@/lib/drafts/message-draft';

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe('[#4419] message draft keys', () => {
  it('negative control: the split key is the #728 key, byte for byte', () => {
    expect(getSplitDraftKey('wt-1', 0)).toBe('commandmate:draft-message:wt-1:0');
    expect(getSplitDraftKey('wt-1', 2)).toBe('commandmate:draft-message:wt-1:2');
  });

  it('one key per (worktree, instance), never a split key', () => {
    const agy = getInstanceDraftKey('wt-1', 'antigravity');
    const claude = getInstanceDraftKey('wt-1', 'claude');
    expect(agy).not.toBe(claude);
    expect(agy).not.toBe(getSplitDraftKey('wt-1', 0));
    expect(getInstanceDraftKey('wt-2', 'claude')).not.toBe(claude);
  });

  it('appends after a blank line, or fills an empty draft', () => {
    const key = getInstanceDraftKey('wt-1', 'antigravity');
    appendToStoredDraft(key, 'first');
    expect(window.localStorage.getItem(key)).toBe('first');
    appendToStoredDraft(key, 'second');
    expect(window.localStorage.getItem(key)).toBe('first\n\nsecond');
    appendToStoredDraft(key, '');
    expect(window.localStorage.getItem(key)).toBe('first\n\nsecond');
  });
});
