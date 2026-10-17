/**
 * Review of Issue #3776: gemini's launch holds its launch window open from the
 * launch line to the end of `waitForReady`, so the Auto-Yes poller leaves the
 * folder-trust dialog to it then — and only then (`cli-tools/launch-window`).
 *
 * Positive control: before the review the launch opened no window, so the
 * poller could not tell its own launch's dialog from one drawn after it.
 *
 * @vitest-environment node
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('@/lib/tmux/session-ownership', () => ({
  assertSessionNotForeign: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
import { mkdtempSync, readFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { GeminiTool } from '@/lib/cli-tools/gemini';
import { clearLaunchWindows, isLaunchWindowOpen } from '@/lib/cli-tools/launch-window';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(false),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(true),
  capturePane: vi.fn().mockResolvedValue(''),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

const SESSION = 'mcbd-gemini-test-wt';
const TRUST = readFileSync(resolve(__dirname, '../../fixtures/gemini-live-3776/trust-dialog.txt'), 'utf8');
const READY = '> Type your message or @path/to/file';

describe('[#3776] gemini launch window', () => {
  let tool: GeminiTool;
  const temps: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    clearLaunchWindows();
    tool = new GeminiTool();
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'gemini-3776-home-')));
    temps.push(home);
    vi.stubEnv('HOME', home);
    vi.spyOn(tool, 'isInstalled').mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    clearLaunchWindows();
    while (temps.length > 0) {
      const dir = temps.pop();
      if (dir) removeTempDir(dir);
    }
  });

  it('is open while the launch answers the dialog, and closed once the launch returns', async () => {
    const { capturePane, sendSpecialKey } = await import('@/lib/tmux/tmux');
    const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'gemini-3776-wt-')));
    temps.push(worktree);
    let trusted = false;
    let openAtEnter: boolean | null = null;
    vi.mocked(sendSpecialKey).mockImplementation(async () => {
      openAtEnter = isLaunchWindowOpen(SESSION);
      trusted = true;
    });
    vi.mocked(capturePane).mockImplementation(async () => (trusted ? READY : TRUST));

    const started = tool.startSession('test-wt', worktree);
    await vi.advanceTimersByTimeAsync(40_000);
    await started;

    expect(openAtEnter).toBe(true);
    expect(isLaunchWindowOpen(SESSION)).toBe(false);
  });

  it('closes when the wait runs out without the prompt, so a late dialog is no longer the launch\'s', async () => {
    const { capturePane, sendSpecialKey } = await import('@/lib/tmux/tmux');
    const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'gemini-3776-wt-')));
    temps.push(worktree);
    vi.mocked(capturePane).mockResolvedValue('');

    const started = tool.startSession('test-wt', worktree);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(isLaunchWindowOpen(SESSION)).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await started;

    expect(isLaunchWindowOpen(SESSION)).toBe(false);
    expect(sendSpecialKey).not.toHaveBeenCalled();
  });

  it('an Enter on the wait\'s last attempts keeps the window open long enough for the restart line', async () => {
    const { capturePane, sendSpecialKey } = await import('@/lib/tmux/tmux');
    const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'gemini-3776-wt-')));
    temps.push(worktree);
    // The dialog is drawn late: only the wait's last capture sees it, and it
    // stays drawn (gemini has not drawn its restart line yet).
    let captures = 0;
    vi.mocked(capturePane).mockImplementation(async () => (++captures >= 30 ? TRUST : ''));
    let pressedAt: number | null = null;
    vi.mocked(sendSpecialKey).mockImplementation(async () => {
      pressedAt = Date.now();
    });

    const started = tool.startSession('test-wt', worktree);
    let closedAt: number | null = null;
    for (let i = 0; i < 200 && closedAt === null; i++) {
      await vi.advanceTimersByTimeAsync(500);
      if (pressedAt !== null && !isLaunchWindowOpen(SESSION)) closedAt = Date.now();
    }
    await started;

    expect(pressedAt).not.toBeNull();
    expect(closedAt).not.toBeNull();
    expect(closedAt! - pressedAt!).toBeGreaterThanOrEqual(5_000);
  });
});
