/**
 * Issue #3771 (item 5): the launch window does not send its trust Enter while a
 * strict `respond` holds the session, and sends it once the hold is released.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('@/lib/tmux/session-ownership', () => ({
  assertSessionNotForeign: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
import { mkdtempSync, readFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { AntigravityTool } from '@/lib/cli-tools/antigravity';
import {
  clearStartupTrust,
  holdStartupTrust,
  isStartupTrustPending,
} from '@/lib/cli-tools/antigravity-startup-trust';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(false),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(true),
  capturePane: vi.fn().mockResolvedValue(''),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/logger', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { createLogger: () => ({ ...log, withContext: () => log }) };
});

const SESSION = 'mcbd-antigravity-test-wt';
const FIXTURES = resolve(__dirname, '../../fixtures');
const TRUST = readFileSync(join(FIXTURES, 'antigravity-live-2364/trust-dialog.txt'), 'utf8');
const IDLE = readFileSync(join(FIXTURES, 'antigravity-live-2478/after-plain-turns.txt'), 'utf8');

async function tmux() {
  return import('@/lib/tmux/tmux');
}

async function entersSent(): Promise<number> {
  const { sendSpecialKey } = await tmux();
  return vi.mocked(sendSpecialKey).mock.calls.filter(([s, k]) => s === SESSION && k === 'Enter').length;
}

describe('Issue #3771: the launch window and the strict hold', () => {
  let tool: AntigravityTool;
  let home: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    tool = new AntigravityTool();
    vi.clearAllMocks();
    clearStartupTrust();
    home = realpathSync(mkdtempSync(join(tmpdir(), 'antigravity-3771-home-')));
    vi.stubEnv('HOME', home);
    vi.spyOn(tool, 'isInstalled').mockResolvedValue(true);
    const { hasSession, sendSpecialKey, capturePane } = await tmux();
    vi.mocked(hasSession).mockResolvedValue(false);
    let trusted = false;
    vi.mocked(sendSpecialKey).mockImplementation(async (_s, key) => {
      if (key === 'Enter') trusted = true;
    });
    // The trust screen is up from the start, idle once an Enter reaches it.
    vi.mocked(capturePane).mockImplementation(async () => (trusted ? IDLE : TRUST));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    clearStartupTrust();
    removeTempDir(home);
  });

  it('positive: while held, the window sends no Enter; once released, it sends exactly one', async () => {
    const release = holdStartupTrust(SESSION);
    const started = tool.startSession('test-wt', '/path/to/wt');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await entersSent()).toBe(0);

    release();
    await vi.advanceTimersByTimeAsync(10_000);
    await started;
    expect(await entersSent()).toBe(1);
    expect(isStartupTrustPending(SESSION)).toBe(false);
  });

  it('a hold that outlasts the window leaves the Enter owed, not sent', async () => {
    holdStartupTrust(SESSION);
    const started = tool.startSession('test-wt', '/path/to/wt');
    await vi.advanceTimersByTimeAsync(40_000);
    await started;
    expect(await entersSent()).toBe(0);
    expect(isStartupTrustPending(SESSION)).toBe(true);
  });

  it('negative control: without a hold the window confirms the screen at once', async () => {
    const started = tool.startSession('test-wt', '/path/to/wt');
    await vi.advanceTimersByTimeAsync(10_000);
    await started;
    expect(await entersSent()).toBe(1);
  });
});
