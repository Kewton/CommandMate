/**
 * One tool-activity answer for every reader on the page (Issue #2821).
 *
 * Before this Issue each `ChatTranscript` read `commandmate:chatShowToolActivity`
 * once, at mount, and kept its own copy. That broke twice: two transcripts side
 * by side on the PC disagreed after one of them was toggled, and the phone's
 * control moved into the surface pill (`MobileTerminalTab`), which is not the
 * transcript at all. `useChatToolActivityPreference` is the one reader now.
 *
 * What this file pins:
 *
 *  1. the first render already has the stored answer (no folded-then-open
 *     flicker — the reason the old code read lazily instead of in an effect);
 *  2. a toggle writes the key with the same `'true'` / `'false'` representation
 *     and moves EVERY mounted reader;
 *  3. a write from another tab arrives through the `storage` event;
 *  4. a browser that refuses storage can still toggle, and a reader mounted
 *     later (the phone switching back to chat) agrees with one still mounted
 *     (the pill);
 *  5. once nothing is mounted, the next reader starts from storage again.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import {
  CHAT_TOOL_ACTIVITY_STORAGE_KEY,
  useChatToolActivityPreference,
} from '@/lib/chat/chat-tool-activity';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mountReader() {
  return renderHook(() => useChatToolActivityPreference());
}

describe('[#2821] the first render', () => {
  it('already carries the stored answer', () => {
    window.localStorage.setItem(CHAT_TOOL_ACTIVITY_STORAGE_KEY, 'true');
    const seen: boolean[] = [];
    function Probe() {
      const [showAll] = useChatToolActivityPreference();
      seen.push(showAll);
      return null;
    }

    render(<Probe />);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBe(true);
    expect(seen).not.toContain(false);
  });

  it('starts folded with nothing stored, or with anything but "true"', () => {
    expect(mountReader().result.current[0]).toBe(false);

    window.localStorage.setItem(CHAT_TOOL_ACTIVITY_STORAGE_KEY, '1');
    expect(mountReader().result.current[0]).toBe(false);
  });
});

describe('[#2821] a toggle', () => {
  it('writes the key and moves every mounted reader', () => {
    const a = mountReader();
    const b = mountReader();

    act(() => a.result.current[1]());

    expect(a.result.current[0]).toBe(true);
    expect(b.result.current[0]).toBe(true);
    expect(window.localStorage.getItem(CHAT_TOOL_ACTIVITY_STORAGE_KEY)).toBe('true');

    act(() => b.result.current[1]());

    expect(a.result.current[0]).toBe(false);
    expect(b.result.current[0]).toBe(false);
    expect(window.localStorage.getItem(CHAT_TOOL_ACTIVITY_STORAGE_KEY)).toBe('false');
  });

  it('is one stable function', () => {
    const { result, rerender } = mountReader();
    const first = result.current[1];

    act(() => first());
    rerender();

    expect(result.current[1]).toBe(first);
  });
});

describe('[#2821] another tab', () => {
  it('is followed when it writes the key', () => {
    const { result } = mountReader();

    act(() => {
      window.localStorage.setItem(CHAT_TOOL_ACTIVITY_STORAGE_KEY, 'true');
      window.dispatchEvent(
        new StorageEvent('storage', { key: CHAT_TOOL_ACTIVITY_STORAGE_KEY, newValue: 'true' }),
      );
    });

    expect(result.current[0]).toBe(true);
  });

  it('is ignored when it writes a different key', () => {
    const { result } = mountReader();

    act(() => {
      // Written without an event for this key: only a matching event may re-read it.
      window.localStorage.setItem(CHAT_TOOL_ACTIVITY_STORAGE_KEY, 'true');
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'commandmate:showArchived', newValue: 'true' }),
      );
    });

    expect(result.current[0]).toBe(false);
  });

  it('is followed when it clears storage (the event carries key === null)', () => {
    window.localStorage.setItem(CHAT_TOOL_ACTIVITY_STORAGE_KEY, 'true');
    const { result } = mountReader();
    expect(result.current[0]).toBe(true);

    act(() => {
      window.localStorage.clear();
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });

    expect(result.current[0]).toBe(false);
  });
});

describe('[#2821] the page copy', () => {
  it('still toggles where storage throws, and a later reader agrees', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('site data blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('site data blocked');
    });

    // Stays mounted throughout, the way the phone's pill does.
    const pill = mountReader();
    expect(pill.result.current[0]).toBe(false);

    act(() => pill.result.current[1]());
    expect(pill.result.current[0]).toBe(true);

    // Mounted afterwards, the way the transcript is when the surface returns to chat.
    const transcript = mountReader();
    expect(transcript.result.current[0]).toBe(true);
  });

  it('is dropped with the last reader, so the next mount reads storage again', () => {
    const first = mountReader();
    act(() => first.result.current[1]());
    expect(first.result.current[0]).toBe(true);
    first.unmount();

    // Changed while nothing was mounted to hear about it.
    window.localStorage.setItem(CHAT_TOOL_ACTIVITY_STORAGE_KEY, 'false');

    expect(mountReader().result.current[0]).toBe(false);
  });
});
