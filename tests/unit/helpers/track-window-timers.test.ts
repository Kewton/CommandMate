/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { trackWindowTimers } from '@tests/helpers/track-window-timers';

describe('trackWindowTimers (#3297)', () => {
  it('does not let a timer made while installed fire after the release', async () => {
    const fired = vi.fn();
    const release = trackWindowTimers();
    window.setTimeout(fired, 20);
    release();

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fired).not.toHaveBeenCalled();
  });

  it('puts window.setTimeout back, and leaves earlier timers alone', async () => {
    const before = window.setTimeout;
    const earlier = vi.fn();
    window.setTimeout(earlier, 20);

    const release = trackWindowTimers();
    expect(window.setTimeout).not.toBe(before);
    release();

    expect(window.setTimeout).toBe(before);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(earlier).toHaveBeenCalledTimes(1);
  });

  it('passes through a timer that has already run', async () => {
    const fired = vi.fn();
    const release = trackWindowTimers();
    window.setTimeout(fired, 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();

    expect(fired).toHaveBeenCalledTimes(1);
  });
});
