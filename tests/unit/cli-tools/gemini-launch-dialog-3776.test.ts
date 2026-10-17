/**
 * Issue #3776: `GeminiTool.waitForReady` sends its folder-trust Enter only
 * while the cursor is on `1. Trust folder`, and logs (without the screen) when
 * it leaves the dialog alone.
 *
 * Positive control: before #3776 the Enter went to any frame with the question
 * on it, so the `Don't trust` frame got one too.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

const { logWarn, logInfo } = vi.hoisted(() => ({ logWarn: vi.fn(), logInfo: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const self: Record<string, unknown> = {
      info: logInfo,
      warn: logWarn,
      error: vi.fn(),
      debug: vi.fn(),
    };
    self.withContext = () => self;
    return self;
  },
}));

import { GeminiTool } from '@/lib/cli-tools/gemini';
import { capturePane, sendSpecialKey } from '@/lib/tmux/tmux';

const LIVE = resolve(__dirname, '../../fixtures/gemini-live-3776');
const frame = (name: string): string => readFileSync(resolve(LIVE, `${name}.txt`), 'utf8');
const READY = '> Type your message or @path/to/file';

async function runWaitForReady(advanceMs: number): Promise<void> {
  const tool = new GeminiTool();
  const done = (tool as unknown as { waitForReady(s: string): Promise<void> }).waitForReady('s');
  await vi.advanceTimersByTimeAsync(advanceMs);
  await done;
}

describe('[#3776] GeminiTool.waitForReady checks the cursor before its Enter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendSpecialKey).mockResolvedValue();
    vi.useFakeTimers();
  });

  it('positive: the measured dialog (cursor on 1. Trust folder) gets exactly one Enter', async () => {
    try {
      vi.mocked(capturePane)
        .mockResolvedValueOnce(frame('trust-dialog'))
        .mockResolvedValueOnce(frame('trust-dialog'))
        .mockResolvedValueOnce(frame('after-enter-restarting'))
        .mockResolvedValueOnce(frame('after-enter-auth'))
        .mockResolvedValueOnce(frame('after-enter-auth'))
        .mockResolvedValue(READY);
      await runWaitForReady(10_000);
      expect(sendSpecialKey).toHaveBeenCalledTimes(1);
      expect(sendSpecialKey).toHaveBeenCalledWith('s', 'Enter');
      expect(logInfo).toHaveBeenCalledWith('auto-trusted-folder-for-gemini');
    } finally {
      vi.useRealTimers();
    }
  });

  it('negative: the cursor on Don\'t trust gets no Enter, and the hold is logged once', async () => {
    try {
      vi.mocked(capturePane)
        .mockResolvedValueOnce(frame('trust-dialog-cursor-dont-trust'))
        .mockResolvedValueOnce(frame('trust-dialog-cursor-dont-trust'))
        .mockResolvedValueOnce(frame('trust-dialog-cursor-dont-trust'))
        .mockResolvedValue(READY);
      await runWaitForReady(10_000);
      expect(sendSpecialKey).not.toHaveBeenCalled();
      const held = logWarn.mock.calls.filter(([event]) => event === 'launch-dialog-held');
      expect(held).toHaveLength(1);
      expect(held[0][1]).toMatchObject({
        sessionName: 's',
        dialog: 'gemini-folder-trust',
        reason: 'cursor-off-safe-row',
        cursorLabel: "3. Don't trust",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a changed wording gets no Enter and logs launch-dialog-unrecognized without the screen', async () => {
    try {
      const reworded = frame('trust-dialog').replace('Do you trust the files in this folder?', 'Trust this workspace?');
      vi.mocked(capturePane).mockResolvedValueOnce(reworded).mockResolvedValue(READY);
      await runWaitForReady(5_000);
      expect(sendSpecialKey).not.toHaveBeenCalled();
      const unrecognized = logWarn.mock.calls.filter(([event]) => event === 'launch-dialog-unrecognized');
      expect(unrecognized).toHaveLength(1);
      expect(unrecognized[0][1]).toEqual({
        sessionName: 's',
        dialog: 'gemini-folder-trust',
        action: 'unrecognized',
        reason: 'question-not-found',
        hint: expect.stringContaining('GEMINI_TRUST_LAUNCH_DIALOG'),
      });
      expect(JSON.stringify(unrecognized[0][1])).not.toContain('Trusting a folder allows');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a cursor drawn with another glyph gets no Enter, and the warn says where the declaration is', async () => {
    try {
      const redrawn = frame('trust-dialog').replace('● 1. Trust folder', '❯ 1. Trust folder');
      vi.mocked(capturePane).mockResolvedValueOnce(redrawn).mockResolvedValue(READY);
      await runWaitForReady(5_000);
      expect(sendSpecialKey).not.toHaveBeenCalled();
      const unrecognized = logWarn.mock.calls.filter(([event]) => event === 'launch-dialog-unrecognized');
      expect(unrecognized).toHaveLength(1);
      expect(unrecognized[0][1]).toMatchObject({
        reason: 'cursor-not-found',
        hint: expect.stringMatching(/cursor drawing.*src\/lib\/cli-tools\/launch-dialog\.ts/),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
