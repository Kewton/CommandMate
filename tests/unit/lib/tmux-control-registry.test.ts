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

  /**
   * Issue #1621 Phase 3. `rename-session` does not disturb an attached control
   * client — the child process, its pipe and its scrollback all survive — so
   * the fix is to re-file the entry, not to tear the attach down. What breaks
   * without it is subtle: the session is alive and streaming, but every lookup
   * by name misses, so terminal input stops arriving with no error anywhere.
   */
  describe('renameSession (worktree ID migration)', () => {
    function makeRegistry() {
      const sendInput = vi.fn();
      const setSessionName = vi.fn();
      let emit: (event: unknown) => void = () => {};
      const registry = new TmuxControlRegistry({
        idleTimeoutMs: 1000,
        createClient: () => ({
          start: vi.fn(),
          stop: vi.fn(),
          onEvent: vi.fn((handler: (event: unknown) => void) => {
            emit = handler;
            return vi.fn();
          }),
          sendInput,
          resize: vi.fn(),
          setSessionName,
        } as any),
      });
      return { registry, sendInput, setSessionName, emitEvent: (event: unknown) => emit(event) };
    }

    it('keeps the live attach reachable under the new name', () => {
      const { registry, sendInput, setSessionName } = makeRegistry();
      registry.subscribe('mcbd-claude-old', 'a', vi.fn());

      expect(registry.renameSession('mcbd-claude-old', 'mcbd-claude-new')).toBe(true);

      expect(registry.hasSession('mcbd-claude-old')).toBe(false);
      expect(registry.hasSession('mcbd-claude-new')).toBe(true);
      expect(registry.getSubscriberCount('mcbd-claude-new')).toBe(1);
      expect(setSessionName).toHaveBeenCalledWith('mcbd-claude-new');

      registry.sendInput('mcbd-claude-new', 'ls\n');
      expect(sendInput).toHaveBeenCalledWith('ls\n');
    });

    it('still delivers client output to the subscriber after the rename', () => {
      const { registry, emitEvent } = makeRegistry();
      const handler = vi.fn();
      registry.subscribe('mcbd-claude-old', 'a', handler);

      registry.renameSession('mcbd-claude-old', 'mcbd-claude-new');
      emitEvent({ type: 'output', data: 'hello' });

      // The client's event callback is created once, before any rename; if it
      // captured the name instead of reading it off the entry, this is where
      // output silently stops.
      expect(handler).toHaveBeenCalledWith({ type: 'output', data: 'hello' });
    });

    it('cleans the entry up under its current name when the client exits', () => {
      const { registry, emitEvent } = makeRegistry();
      registry.subscribe('mcbd-claude-old', 'a', vi.fn());
      registry.renameSession('mcbd-claude-old', 'mcbd-claude-new');

      emitEvent({ type: 'exit', exitCode: 0 });

      expect(registry.getSessionCount()).toBe(0);
    });

    it('refuses to clobber an attach already registered under the new name', () => {
      const { registry } = makeRegistry();
      registry.subscribe('mcbd-claude-old', 'a', vi.fn());
      registry.subscribe('mcbd-claude-new', 'b', vi.fn());

      expect(registry.renameSession('mcbd-claude-old', 'mcbd-claude-new')).toBe(false);
      expect(registry.hasSession('mcbd-claude-old')).toBe(true);
      expect(registry.getSubscriberCount('mcbd-claude-new')).toBe(1);
    });

    it('reports false when nothing is registered under the old name', () => {
      const { registry } = makeRegistry();
      expect(registry.renameSession('mcbd-claude-old', 'mcbd-claude-new')).toBe(false);
    });
  });
});
