import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TmuxControlRegistry } from '@/lib/tmux/tmux-control-registry';

describe('TmuxControlRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('should create one client per session and share it across subscribers', () => {
    const start = vi.fn();
    const stop = vi.fn();
    const onEvent = vi.fn(() => vi.fn());

    const registry = new TmuxControlRegistry({
      idleTimeoutMs: 1000,
      createClient: () => ({
        start,
        stop,
        onEvent,
        sendInput: vi.fn(),
        resize: vi.fn(),
      } as any),
    });

    const unsubA = registry.subscribe('s1', 'a', vi.fn());
    const unsubB = registry.subscribe('s1', 'b', vi.fn());

    expect(start).toHaveBeenCalledTimes(1);
    expect(registry.getSubscriberCount('s1')).toBe(2);

    unsubA();
    expect(registry.getSubscriberCount('s1')).toBe(1);

    unsubB();
    vi.advanceTimersByTime(1000);

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('should delegate sendInput and resize to the registered client', () => {
    const sendInput = vi.fn();
    const resize = vi.fn();

    const registry = new TmuxControlRegistry({
      idleTimeoutMs: 1000,
      createClient: () => ({
        start: vi.fn(),
        stop: vi.fn(),
        onEvent: vi.fn(() => vi.fn()),
        sendInput,
        resize,
      } as any),
    });

    registry.subscribe('s1', 'a', vi.fn());
    registry.sendInput('s1', 'hello');
    registry.resize('s1', 120, 40);

    expect(sendInput).toHaveBeenCalledWith('hello');
    expect(resize).toHaveBeenCalledWith(120, 40);
  });
});
