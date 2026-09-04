/**
 * Issue #2032: the special-keys API vocabulary must stay deliverable by tmux.
 *
 * `NAVIGATION_KEY_VALUES` (what `POST /api/worktrees/[id]/special-keys` accepts)
 * had contained `BTab` since Issue #473, but `ALLOWED_SPECIAL_KEYS` (what
 * `sendSpecialKeys()` will actually hand to `tmux send-keys`) never did. The route
 * therefore accepted `["BTab"]`, then threw inside the transport and answered 500.
 *
 * The invariant pinned here is one-way containment
 * (`NAVIGATION_KEY_VALUES` ⊆ `ALLOWED_SPECIAL_KEYS`), not set equality: `Space`,
 * `BSpace` and `DC` are sendable on purpose while staying out of the navigation
 * vocabulary, so an equality assertion would be red for three pre-existing keys.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { execFileAsyncMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('util', () => ({
  promisify: vi.fn(() => execFileAsyncMock),
}));

import {
  CLAUDE_NAVIGATION_KEY_VALUES,
  SESSION_SCOPE_KEY,
} from '@/types/terminal-keys';
import {
  NAVIGATION_KEY_VALUES,
  isAllowedSpecialKey,
  isSendableSpecialKey,
  sendSpecialKeys,
  sendSpecialKeysAndInvalidate,
  exactTarget,
} from '@/lib/tmux/tmux';

describe('NAVIGATION_KEY_VALUES ⊆ ALLOWED_SPECIAL_KEYS (Issue #2032)', () => {
  it('leaves an empty difference set — every navigation key is deliverable by sendSpecialKeys() (red if BTab is dropped from ALLOWED_SPECIAL_KEYS)', () => {
    const undeliverable = NAVIGATION_KEY_VALUES.filter((key) => !isSendableSpecialKey(key));

    expect(undeliverable).toEqual([]);
  });

  it('names BTab explicitly, because that is the key the two allow-lists disagreed on', () => {
    expect(NAVIGATION_KEY_VALUES).toContain('BTab');
    expect(isSendableSpecialKey('BTab')).toBe(true);
    expect(isAllowedSpecialKey('BTab')).toBe(true);
  });

  it('is containment and NOT equality: Space/BSpace/DC are sendable but intentionally outside the navigation vocabulary', () => {
    for (const key of ['Space', 'BSpace', 'DC']) {
      expect(isSendableSpecialKey(key)).toBe(true);
      expect(NAVIGATION_KEY_VALUES as readonly string[]).not.toContain(key);
      // The API vocabulary is the narrower set, so these stay rejected at the route.
      expect(isAllowedSpecialKey(key)).toBe(false);
    }
  });

  it('keeps arbitrary tmux key names out of both sets (command-injection guard)', () => {
    for (const key of ['C-c', 'F1', 'rm -rf /', '']) {
      expect(isSendableSpecialKey(key)).toBe(false);
      expect(isAllowedSpecialKey(key)).toBe(false);
    }
  });
});

describe('the session-scope key `s` is deliverable but not universal (Issue #2297)', () => {
  it('is in the transport allow-list — red the moment `s` is dropped from it', () => {
    // The mutation this pins: delete `'s'` from ALLOWED_SPECIAL_KEYS and the
    // chat surface's "This session only" button becomes a 400, silently, with
    // the button still on screen. Exactly #2032's shape, for a new key.
    expect(isSendableSpecialKey(SESSION_SCOPE_KEY)).toBe(true);
  });

  it('leaves an empty difference set for the claude-family vocabulary too', () => {
    const undeliverable = CLAUDE_NAVIGATION_KEY_VALUES.filter((key) => !isSendableSpecialKey(key));

    expect(undeliverable).toEqual([]);
  });

  it('is accepted for a tool that declares it and refused for one that does not', () => {
    // `isAllowedSpecialKey` is the route's check: vocabulary ∩ transport. Both
    // directions matter — `s` is `sort:relevance` on copilot's session picker,
    // so handing it to every tool would be a button that does something else.
    expect(isAllowedSpecialKey(SESSION_SCOPE_KEY, CLAUDE_NAVIGATION_KEY_VALUES)).toBe(true);
    expect(isAllowedSpecialKey(SESSION_SCOPE_KEY, NAVIGATION_KEY_VALUES)).toBe(false);
    // …and the default vocabulary IS the base pad, so an unqualified call
    // refuses it as well.
    expect(isAllowedSpecialKey(SESSION_SCOPE_KEY)).toBe(false);
  });

  it('does not smuggle `s`s neighbours in with it', () => {
    for (const key of ['S', 'sort', 'so']) {
      expect(isSendableSpecialKey(key), key).toBe(false);
      expect(isAllowedSpecialKey(key, CLAUDE_NAVIGATION_KEY_VALUES), key).toBe(false);
    }
  });
});

describe('sendSpecialKeys delivery of BTab (Issue #2032)', () => {
  beforeEach(() => {
    execFileAsyncMock.mockClear();
  });

  it('issues `tmux send-keys -t <exact target> BTab` instead of throwing', async () => {
    await expect(sendSpecialKeys('mcbd-claude-wt-1', ['BTab'])).resolves.toBeUndefined();

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'tmux',
      ['send-keys', '-t', exactTarget('mcbd-claude-wt-1'), 'BTab'],
      expect.objectContaining({ timeout: expect.any(Number) })
    );
  });

  it('delivers BTab through sendSpecialKeysAndInvalidate — the exact entry point the route calls', async () => {
    await expect(
      sendSpecialKeysAndInvalidate('mcbd-codex-wt-9', ['BTab'])
    ).resolves.toBeUndefined();

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'tmux',
      ['send-keys', '-t', exactTarget('mcbd-codex-wt-9'), 'BTab'],
      expect.objectContaining({ timeout: expect.any(Number) })
    );
  });

  it('delivers `s` verbatim, the way `q` has been delivered since #1017', async () => {
    // Issue #2297. A literal character on the wire: `tmux send-keys -- s` types
    // an `s`, which is what claude's `/model` overlay reads as "this session
    // only". Asserted through the route's own entry point.
    await expect(
      sendSpecialKeysAndInvalidate('mcbd-claude-wt-1', [SESSION_SCOPE_KEY])
    ).resolves.toBeUndefined();

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'tmux',
      ['send-keys', '-t', exactTarget('mcbd-claude-wt-1'), 's'],
      expect.objectContaining({ timeout: expect.any(Number) })
    );
  });

  it('sends every navigation key without rejecting any of them', async () => {
    // One call per key rather than one batched call: batched sends sleep
    // SPECIAL_KEY_DELAY_MS between presses, which would make this test wall-clock
    // bound (and flaky under parallel load) for no extra coverage.
    for (const key of NAVIGATION_KEY_VALUES) {
      await expect(sendSpecialKeys('mcbd-claude-wt-1', [key])).resolves.toBeUndefined();
    }

    expect(execFileAsyncMock).toHaveBeenCalledTimes(NAVIGATION_KEY_VALUES.length);
  });
});
