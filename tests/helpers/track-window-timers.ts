/**
 * Test helper: clear the timers a test leaves on `window` (Issue #3297).
 *
 * `@tanstack/virtual-core` debounces the end of a scroll with a 150 ms
 * `window.setTimeout` (`isScrollingResetDelay`), and its unmount cleanup removes
 * the scroll listener without clearing that timer. When the file finishes first
 * — typically under load — jsdom is torn down and the timer then fires
 * `Virtualizer.notify` -> react-dom -> `window is not defined`, an unhandled
 * error that fails the whole shard even though every test passed.
 *
 * `trackWindowTimers()` wraps `window.setTimeout` and records the ids it hands
 * out; the returned function restores the original and clears whatever is still
 * pending. Call it from `afterEach`, after unmounting (`cleanup()`), in any file
 * that fires scroll events at a real virtualizer.
 *
 * Do not combine with `vi.useFakeTimers()`: faking replaces `window.setTimeout`
 * itself, so the wrapper would record fake ids and restore the wrong function.
 */
export function trackWindowTimers(): () => void {
  const original = window.setTimeout;
  const call = original as unknown as (...args: unknown[]) => number;
  const pending = new Set<number>();

  window.setTimeout = ((...args: unknown[]) => {
    const id = call.apply(window, args);
    pending.add(id);
    return id;
  }) as unknown as typeof window.setTimeout;

  return () => {
    window.setTimeout = original;
    for (const id of pending) window.clearTimeout(id);
    pending.clear();
  };
}
