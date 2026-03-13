import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  sendSpecialKey: vi.fn(),
  killSession: vi.fn(),
  capturePane: vi.fn(),
}));

import { ControlModeTmuxTransport } from '@/lib/tmux/control-mode-tmux-transport';
import { capturePane, hasSession, sendKeys, sendSpecialKey } from '@/lib/tmux/tmux';

describe('ControlModeTmuxTransport', () => {
  const registry = {
    hasSession: vi.fn(),
    subscribe: vi.fn(),
    sendInput: vi.fn(),
    resize: vi.fn(),
  };

  let transport: ControlModeTmuxTransport;

  beforeEach(() => {
    vi.clearAllMocks();
    transport = new ControlModeTmuxTransport({ registry: registry as any });
  });

  it('should expose control mode capabilities', () => {
    expect(transport.getCapabilities()).toEqual({
      streamingOutput: true,
      explicitResize: true,
      snapshotFallback: true,
    });
  });

  it('should route input through registry when subscribed', async () => {
    registry.hasSession.mockReturnValueOnce(true);

    await transport.sendInput('session-1', 'hello');

    expect(registry.sendInput).toHaveBeenCalledWith('session-1', 'hello');
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('should fallback to sendKeys when registry has no session', async () => {
    registry.hasSession.mockReturnValueOnce(false);

    await transport.sendInput('session-1', 'hello');

    expect(sendKeys).toHaveBeenCalledWith('session-1', 'hello');
  });

  it('should proxy resize to registry', async () => {
    await transport.resize('session-1', 100, 30);
    expect(registry.resize).toHaveBeenCalledWith('session-1', 100, 30);
  });

  it('should fallback snapshot capture to capturePane', async () => {
    vi.mocked(capturePane).mockResolvedValueOnce('snapshot');

    await expect(transport.captureSnapshot('session-1', { startLine: -100 })).resolves.toBe('snapshot');
  });

  it('should convert registry events to transport handlers', async () => {
    const onOutput = vi.fn();
    const onError = vi.fn();
    const onExit = vi.fn();

    let eventHandler: ((event: any) => void) | null = null;
    registry.subscribe.mockImplementation((_sessionName, _subscriberId, handler) => {
      eventHandler = handler;
      return vi.fn();
    });

    const subscription = await transport.subscribe('session-1', {
      onOutput,
      onError,
      onExit,
    });

    expect(eventHandler).not.toBeNull();
    eventHandler!({ type: 'output', data: 'hello' });
    eventHandler!({ type: 'error', error: new Error('broken') });
    eventHandler!({ type: 'exit', exitCode: 0 });

    expect(onOutput).toHaveBeenCalledWith('hello');
    expect(onError).toHaveBeenCalled();
    expect(onExit).toHaveBeenCalledWith({ exitCode: 0 });
    await expect(subscription.unsubscribe()).resolves.toBeUndefined();
  });

  it('should reject unsupported special keys', async () => {
    await expect(transport.sendSpecialKey('session-1', 'Down')).rejects.toThrow(
      'Unsupported special key for ControlModeTmuxTransport: Down'
    );
    expect(sendSpecialKey).not.toHaveBeenCalled();
  });

  it('should send supported special keys via tmux helper', async () => {
    await transport.sendSpecialKey('session-1', 'C-m');
    expect(sendSpecialKey).toHaveBeenCalledWith('session-1', 'C-m');
  });

  it('should check session existence through tmux helper', async () => {
    vi.mocked(hasSession).mockResolvedValueOnce(true);
    await expect(transport.sessionExists('session-1')).resolves.toBe(true);
  });
});
