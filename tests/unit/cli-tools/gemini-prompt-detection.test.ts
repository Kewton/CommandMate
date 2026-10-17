/**
 * Unit tests for Gemini prompt detection depth.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  sendSpecialKey: vi.fn(),
  killSession: vi.fn(),
  capturePane: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/cli-tools/validation', () => ({
  validateSessionName: vi.fn(),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

import { GeminiTool, GEMINI_PANE_HEIGHT } from '@/lib/cli-tools/gemini';
import { capturePane, hasSession, sendKeys, sendSpecialKey } from '@/lib/tmux/tmux';

describe('GeminiTool prompt detection depth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasSession).mockResolvedValue(true);
    vi.mocked(capturePane).mockResolvedValue('> Type your message or @path/to/file');
    vi.mocked(sendKeys).mockResolvedValue();
    vi.mocked(sendSpecialKey).mockResolvedValue();
  });

  it('uses the full Gemini pane height before sending a message', async () => {
    const tool = new GeminiTool();

    await tool.sendMessage('test-wt', 'hello');

    expect(capturePane).toHaveBeenCalledWith('mcbd-gemini-test-wt', GEMINI_PANE_HEIGHT);
  });
});

describe('[#3770] GeminiTool folder-trust dialog during launch', () => {
  const TRUST_V062 = ' │ Do you trust the files in this folder?\n │ ● 1. Trust folder (work)\n │   2. Trust parent folder';
  const TRUST_OLD = ' Do you trust this folder?';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendSpecialKey).mockResolvedValue();
  });

  it.each([
    ['v0.62.0 wording (measured)', TRUST_V062],
    ['earlier wording (negative control)', TRUST_OLD],
  ])('confirms it once with Enter: %s', async (_label, dialog) => {
    vi.useFakeTimers();
    try {
      vi.mocked(capturePane)
        .mockResolvedValueOnce(dialog)
        .mockResolvedValue('> Type your message or @path/to/file');
      const tool = new GeminiTool();
      const done = (tool as unknown as { waitForReady(s: string): Promise<void> }).waitForReady('s');
      await vi.advanceTimersByTimeAsync(5_000);
      await done;
      expect(sendSpecialKey).toHaveBeenCalledTimes(1);
      expect(sendSpecialKey).toHaveBeenCalledWith('s', 'Enter');
    } finally {
      vi.useRealTimers();
    }
  });

  it('negative: an unrelated screen is not answered', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(capturePane).mockResolvedValue('> Type your message or @path/to/file');
      const tool = new GeminiTool();
      const done = (tool as unknown as { waitForReady(s: string): Promise<void> }).waitForReady('s');
      await vi.advanceTimersByTimeAsync(2_000);
      await done;
      expect(sendSpecialKey).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
