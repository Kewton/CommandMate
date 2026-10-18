/**
 * Issue #3790: gemini's launch records the trust Enter it pressed, so the
 * Auto-Yes poller leaves the answered dialog alone for
 * `LAUNCH_DIALOG_PRESS_SETTLE_MS` even when the launch window closes before
 * gemini draws its restart line (the 5 s `GEMINI_TRUST_SETTLE_MS` of #3776 left
 * that race open for a restart slower than 5 s).
 *
 * Positive control: before #3790 nothing outlived the window.
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
import {
  LAUNCH_DIALOG_PRESS_SETTLE_MS,
  beginLaunchWindow,
  clearLaunchWindows,
  endLaunchWindow,
  isLaunchDialogPressSettling,
  isLaunchWindowOpen,
  recordLaunchDialogPress,
} from '@/lib/cli-tools/launch-window';

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

describe('[#3790] gemini launch: the trust Enter outlives the window', () => {
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

  it('records the Enter, and the record outlives the window by the settle time', async () => {
    const { capturePane, sendSpecialKey } = await import('@/lib/tmux/tmux');
    const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'gemini-3790-wt-')));
    temps.push(worktree);
    let pressedAt: number | null = null;
    vi.mocked(sendSpecialKey).mockImplementation(async () => {
      pressedAt = Date.now();
    });
    vi.mocked(capturePane).mockImplementation(async () => (pressedAt !== null ? READY : TRUST));

    const started = tool.startSession('test-wt', worktree);
    await vi.advanceTimersByTimeAsync(10_000);
    await started;

    expect(sendSpecialKey).toHaveBeenCalledTimes(1);
    expect(isLaunchWindowOpen(SESSION)).toBe(false);
    expect(isLaunchDialogPressSettling(SESSION)).toBe(true);
    expect(isLaunchDialogPressSettling(SESSION, pressedAt! + LAUNCH_DIALOG_PRESS_SETTLE_MS)).toBe(false);
  });

  it('negative control: a launch that pressed nothing records nothing', async () => {
    const { capturePane, sendSpecialKey } = await import('@/lib/tmux/tmux');
    const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'gemini-3790-wt-')));
    temps.push(worktree);
    vi.mocked(capturePane).mockResolvedValue(READY);

    const started = tool.startSession('test-wt', worktree);
    await vi.advanceTimersByTimeAsync(10_000);
    await started;

    expect(sendSpecialKey).not.toHaveBeenCalled();
    expect(isLaunchDialogPressSettling(SESSION)).toBe(false);
  });
});

describe('[#3790] launch-window: the recorded key', () => {
  beforeEach(() => clearLaunchWindows());
  afterEach(() => clearLaunchWindows());

  it('settles for LAUNCH_DIALOG_PRESS_SETTLE_MS after the key', () => {
    recordLaunchDialogPress('s', 1_000);
    expect(isLaunchDialogPressSettling('s', 1_000)).toBe(true);
    expect(isLaunchDialogPressSettling('s', 1_000 + LAUNCH_DIALOG_PRESS_SETTLE_MS - 1)).toBe(true);
    expect(isLaunchDialogPressSettling('s', 1_000 + LAUNCH_DIALOG_PRESS_SETTLE_MS)).toBe(false);
    expect(isLaunchDialogPressSettling('other', 1_000)).toBe(false);
  });

  it('is forgotten when the session is launched again, and by clearLaunchWindows', () => {
    recordLaunchDialogPress('s');
    beginLaunchWindow('s');
    endLaunchWindow('s');
    expect(isLaunchDialogPressSettling('s')).toBe(false);

    recordLaunchDialogPress('s');
    clearLaunchWindows();
    expect(isLaunchDialogPressSettling('s')).toBe(false);
  });

  it('is independent of the window: closing the window keeps it', () => {
    beginLaunchWindow('s');
    recordLaunchDialogPress('s');
    endLaunchWindow('s');
    expect(isLaunchWindowOpen('s')).toBe(false);
    expect(isLaunchDialogPressSettling('s')).toBe(true);
  });
});
