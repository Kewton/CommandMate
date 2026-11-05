/**
 * The report status poll rests while the tab is hidden (Issue #4160, after #4145 did
 * this for the detail screen's parent poll) and reads at once on coming back.
 *
 * Positive controls: the hidden tests fail on the code before this Issue.
 * Negative controls: the visible ticks, and a disabled hook asks nothing on coming back.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGenerationStatus } from '@/hooks/useGenerationStatus';

const TICK_MS = 5000;
const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

async function comeBack(): Promise<void> {
  setVisibility('visible');
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
  });
}

const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility('visible');
  fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ generating: false }) });
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
  else delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe('[#4160] useGenerationStatus while the tab is hidden', () => {
  it('visible: every tick asks (negative control)', async () => {
    renderHook(() => useGenerationStatus(true));
    await tick(0);
    fetchSpy.mockClear();
    await tick(TICK_MS * 2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('hidden: no tick asks', async () => {
    renderHook(() => useGenerationStatus(true));
    await tick(0);
    fetchSpy.mockClear();
    setVisibility('hidden');
    await tick(TICK_MS * 3);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('back: it reads at once, and what it reads is shown, and the ticks go on', async () => {
    const { result } = renderHook(() => useGenerationStatus(true));
    await tick(0);
    setVisibility('hidden');
    await tick(TICK_MS);
    fetchSpy.mockClear();
    fetchSpy.mockResolvedValue({ ok: true, json: () => Promise.resolve({ generating: true, tool: 'claude' }) });
    await comeBack();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.current.generating).toBe(true);
    fetchSpy.mockClear();
    await tick(TICK_MS);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('mounted hidden: nothing until it is shown', async () => {
    setVisibility('hidden');
    renderHook(() => useGenerationStatus(true));
    await tick(TICK_MS);
    expect(fetchSpy).not.toHaveBeenCalled();
    await comeBack();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('going hidden does not read (negative control)', async () => {
    renderHook(() => useGenerationStatus(true));
    await tick(0);
    fetchSpy.mockClear();
    setVisibility('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('disabled, or unmounted: coming back asks nothing (negative control)', async () => {
    const { rerender, unmount } = renderHook(({ on }) => useGenerationStatus(on), { initialProps: { on: false } });
    setVisibility('hidden');
    await comeBack();
    expect(fetchSpy).not.toHaveBeenCalled();
    rerender({ on: true });
    await tick(0);
    unmount();
    fetchSpy.mockClear();
    await comeBack();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('[#4160] useGenerationStatus when answers arrive out of order', () => {
  const answer = (body: object) => ({ ok: true, json: () => Promise.resolve(body) });

  /** Each read stays pending until the test answers it, by the order they were asked in. */
  function holdReads(): Array<(reply: unknown) => void> {
    const answers: Array<(reply: unknown) => void> = [];
    fetchSpy.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    return answers;
  }
  const settle = (reply: () => void) => act(async () => {
    reply();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('asked before hiding, answered after the read on coming back: the newer one stays', async () => {
    const answers = holdReads();
    const { result } = renderHook(() => useGenerationStatus(true));
    await tick(0);
    setVisibility('hidden');
    await tick(TICK_MS);
    await comeBack();
    expect(answers).toHaveLength(2);
    await settle(() => answers[1](answer({ generating: false })));
    expect(result.current.generating).toBe(false);
    await settle(() => answers[0](answer({ generating: true, tool: 'claude' })));
    expect(result.current.generating).toBe(false);
    expect(result.current.tool).toBeUndefined();
  });

  it('answered in order: each is taken, and the last one stands (negative control)', async () => {
    const answers = holdReads();
    const { result } = renderHook(() => useGenerationStatus(true));
    await tick(0);
    setVisibility('hidden');
    await tick(TICK_MS);
    await comeBack();
    await settle(() => answers[0](answer({ generating: true, tool: 'claude' })));
    expect(result.current.tool).toBe('claude');
    await settle(() => answers[1](answer({ generating: true, tool: 'codex' })));
    expect(result.current.tool).toBe('codex');
  });

  it('the newer read failed: the older answer is still the latest word (negative control)', async () => {
    const answers = holdReads();
    const { result } = renderHook(() => useGenerationStatus(true));
    await tick(0);
    setVisibility('hidden');
    await tick(TICK_MS);
    await comeBack();
    await settle(() => answers[1]({ ok: false }));
    await settle(() => answers[0](answer({ generating: true, tool: 'claude' })));
    expect(result.current.tool).toBe('claude');
  });
});
