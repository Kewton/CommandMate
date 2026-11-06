/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const mockOpen = vi.fn();
const mockWrite = vi.fn();
const mockClear = vi.fn();
const mockDispose = vi.fn();
const mockLoadAddon = vi.fn();
const mockOnData = vi.fn();
const mockFit = vi.fn();
const mockIsTmuxControlModeEnabledForClient = vi.fn();

let webSocketInstances: MockWebSocket[] = [];

class MockTerminal {
  cols = 80;
  rows = 24;

  open = mockOpen;
  write = mockWrite;
  clear = mockClear;
  dispose = mockDispose;
  loadAddon = mockLoadAddon;
  onData = (handler: (data: string) => void) => {
    mockOnData(handler);
  };
}

class MockFitAddon {
  fit = mockFit;
}

class MockWebSocket {
  static OPEN = 1;

  readyState = MockWebSocket.OPEN;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    webSocketInstances.push(this);
  }
}

vi.mock('xterm', () => ({
  Terminal: MockTerminal,
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: MockFitAddon,
}));

vi.mock('xterm-addon-web-links', () => ({
  WebLinksAddon: class WebLinksAddon {},
}));

vi.mock('xterm/css/xterm.css', () => ({}));

vi.mock('@/lib/tmux/tmux-control-mode-flags', () => ({
  isTmuxControlModeEnabledForClient: () => mockIsTmuxControlModeEnabledForClient(),
}));


const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
}
async function switchTo(state: DocumentVisibilityState): Promise<void> {
  setVisibility(state);
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
  });
}
function restoreVisibility(): void {
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
  else delete (document as unknown as Record<string, unknown>).visibilityState;
  if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden);
  else delete (document as unknown as Record<string, unknown>).hidden;
}

describe('TerminalComponent reconnect vs hidden (Issue #4190)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cleanup();
    webSocketInstances = [];
    mockIsTmuxControlModeEnabledForClient.mockReturnValue(true);
    Object.defineProperty(window, 'WebSocket', { writable: true, value: MockWebSocket });
    setVisibility('visible');
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    restoreVisibility();
  });

  async function mountAndClose(): Promise<void> {
    const { TerminalComponent } = await import('@/components/Terminal');
    render(<TerminalComponent worktreeId="wt-1" cliToolId="codex" />);
    expect(webSocketInstances).toHaveLength(1);
  }

  it('control: closing while visible reconnects after the delay', async () => {
    await mountAndClose();
    await act(async () => { webSocketInstances[0].onclose?.(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(webSocketInstances).toHaveLength(2);
  });

  it('closing while hidden books nothing; one reconnect on visible', async () => {
    await mountAndClose();
    await switchTo('hidden');
    await act(async () => { webSocketInstances[0].onclose?.(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(webSocketInstances).toHaveLength(1);

    await switchTo('visible');
    expect(webSocketInstances).toHaveLength(2);
    await switchTo('hidden');
    await switchTo('visible');
    expect(webSocketInstances).toHaveLength(2);
  });

  it('a connection that never closed is not reconnected on visible', async () => {
    await mountAndClose();
    await switchTo('hidden');
    await switchTo('visible');
    expect(webSocketInstances).toHaveLength(1);
  });
});
