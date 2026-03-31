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
}));

vi.mock('@/lib/pasted-text-helper', () => ({
  detectAndResendIfPastedText: vi.fn().mockResolvedValue(undefined),
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
