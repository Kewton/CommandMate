import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionTransport } from '@/lib/tmux/session-transport';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  sendSpecialKey: vi.fn(),
  capturePane: vi.fn(),
  killSession: vi.fn(),
}));

import { PollingTmuxTransport } from '@/lib/tmux/polling-tmux-transport';
import {
  capturePane,
  createSession,
  hasSession,
  killSession,
  sendKeys,
  sendSpecialKey,
} from '@/lib/tmux/tmux';

describe('PollingTmuxTransport', () => {
  let transport: PollingTmuxTransport;
  let sessionTransport: SessionTransport;

  beforeEach(() => {
    vi.clearAllMocks();
    transport = new PollingTmuxTransport();
    sessionTransport = transport;
  });

  it('should expose polling capabilities', () => {
    expect(transport.getCapabilities()).toEqual({
      streamingOutput: false,
      explicitResize: false,
      snapshotFallback: true,
    });
  });

  it('should create a session only when it does not exist', async () => {
    vi.mocked(hasSession).mockResolvedValueOnce(false);

    await transport.ensureSession('test-session', '/tmp/project');

    expect(createSession).toHaveBeenCalledWith('test-session', '/tmp/project');
  });

  it('should not create a session when it already exists', async () => {
    vi.mocked(hasSession).mockResolvedValueOnce(true);

    await transport.ensureSession('test-session', '/tmp/project');

    expect(createSession).not.toHaveBeenCalled();
  });

  it('should proxy sendInput to sendKeys', async () => {
    await transport.sendInput('test-session', 'echo hello');
    expect(sendKeys).toHaveBeenCalledWith('test-session', 'echo hello');
  });

  it('should proxy captureSnapshot to capturePane', async () => {
    vi.mocked(capturePane).mockResolvedValueOnce('captured output');

    const output = await transport.captureSnapshot('test-session', { startLine: -500 });

    expect(output).toBe('captured output');
    expect(capturePane).toHaveBeenCalledWith('test-session', { startLine: -500 });
  });

  it('should reject unsupported resize', async () => {
    await expect(sessionTransport.resize('test-session', 120, 40)).rejects.toThrow(
      'PollingTmuxTransport does not support explicit resize'
    );
  });

  it('should reject unsupported special keys', async () => {
    await expect(transport.sendSpecialKey('test-session', 'Down')).rejects.toThrow(
      'Unsupported special key for PollingTmuxTransport: Down'
    );
  });

  it('should proxy supported special keys', async () => {
    await transport.sendSpecialKey('test-session', 'C-m');
    expect(sendSpecialKey).toHaveBeenCalledWith('test-session', 'C-m');
  });

  it('should return a no-op subscription', async () => {
    const subscription = await sessionTransport.subscribe('test-session', {
      onOutput: vi.fn(),
      onError: vi.fn(),
    });

    await expect(subscription.unsubscribe()).resolves.toBeUndefined();
  });

  it('should proxy killSession', async () => {
    vi.mocked(killSession).mockResolvedValueOnce(true);

    await expect(transport.killSession('test-session')).resolves.toBe(true);
  });
});
