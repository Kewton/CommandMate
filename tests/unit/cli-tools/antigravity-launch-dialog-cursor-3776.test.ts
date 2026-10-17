/**
 * Issue #3776: agy's folder-trust Enter — from the launch window and from the
 * next send's owed-Enter path (#3757) — is sent only while the cursor is on
 * `Yes, I trust this folder`.
 *
 * Positive control: before #3776 both paths sent the Enter whenever the
 * question was on screen, so the `> No, exit` frame got one — and an Enter
 * there exits agy.
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
import { AntigravityTool } from '@/lib/cli-tools/antigravity';
import { clearStartupTrust, isStartupTrustPending } from '@/lib/cli-tools/antigravity-startup-trust';

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

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

const { logInfo, logWarn } = vi.hoisted(() => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const self: Record<string, unknown> = { info: logInfo, warn: logWarn, error: vi.fn(), debug: vi.fn() };
    self.withContext = () => self;
    return self;
  },
}));

const SESSION = 'mcbd-antigravity-test-wt';
const TRUST = readFileSync(resolve(__dirname, '../../fixtures/antigravity-live-2364/trust-dialog.txt'), 'utf8');
/** The live trust screen with the cursor moved to `No, exit` (one ↓). */
const TRUST_ON_NO = TRUST
  .replace('> Yes, I trust this folder', '  Yes, I trust this folder')
  .replace('  \u001b[90mNo, exit', '\u001b[94m> No, exit');
const IDLE = readFileSync(resolve(__dirname, '../../fixtures/antigravity-live-2478/after-plain-turns.txt'), 'utf8');

async function tmux() {
  return import('@/lib/tmux/tmux');
}

async function entersSent(): Promise<number> {
  const { sendSpecialKey } = await tmux();
  return vi.mocked(sendSpecialKey).mock.calls.filter(([s, k]) => s === SESSION && k === 'Enter').length;
}

function warned(event: string): Array<Record<string, unknown>> {
  return logWarn.mock.calls.filter(([name]) => name === event).map(([, ctx]) => ctx as Record<string, unknown>);
}

describe('[#3776] agy trust Enter only with the cursor on Yes', () => {
  let tool: AntigravityTool;
  const tempHomes: string[] = [];

  beforeEach(async () => {
    vi.useFakeTimers();
    tool = new AntigravityTool();
    vi.clearAllMocks();
    clearStartupTrust();
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'antigravity-3776-home-')));
    tempHomes.push(home);
    vi.stubEnv('HOME', home);
    vi.spyOn(tool, 'isInstalled').mockResolvedValue(true);
    const { hasSession, sendSpecialKey } = await tmux();
    vi.mocked(hasSession).mockResolvedValue(false);
    vi.mocked(sendSpecialKey).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    clearStartupTrust();
    while (tempHomes.length > 0) {
      const home = tempHomes.pop();
      if (home) removeTempDir(home);
    }
  });

  it('fixture: the cursor really moved', () => {
    expect(TRUST_ON_NO).toContain('> No, exit');
    expect(TRUST_ON_NO).not.toContain('> Yes, I trust this folder');
  });

  it('positive: the launch window sends one Enter to the cursor on Yes', async () => {
    const { capturePane, sendSpecialKey } = await tmux();
    let trusted = false;
    vi.mocked(sendSpecialKey).mockImplementation(async () => {
      trusted = true;
    });
    vi.mocked(capturePane).mockImplementation(async () => (trusted ? IDLE : TRUST));
    const started = tool.startSession('test-wt', '/path/to/wt');
    await vi.advanceTimersByTimeAsync(40_000);
    await started;
    expect(await entersSent()).toBe(1);
  });

  it('negative: the launch window sends nothing to the cursor on No, logs it once, and leaves the Enter owed', async () => {
    const { capturePane } = await tmux();
    vi.mocked(capturePane).mockResolvedValue(TRUST_ON_NO);
    const started = tool.startSession('test-wt', '/path/to/wt');
    await vi.advanceTimersByTimeAsync(40_000);
    await started;

    expect(await entersSent()).toBe(0);
    expect(warned('launch-dialog-held')).toEqual([
      expect.objectContaining({ dialog: 'antigravity-folder-trust', cursorLabel: 'No, exit' }),
    ]);
    expect(isStartupTrustPending(SESSION)).toBe(true);
  });

  it('negative: the next send does not claim the owed Enter on the cursor on No; it claims it once the cursor is on Yes', async () => {
    const { capturePane, hasSession, sendSpecialKey } = await tmux();
    vi.mocked(capturePane).mockResolvedValue('');
    const started = tool.startSession('test-wt', '/path/to/wt');
    await vi.advanceTimersByTimeAsync(40_000);
    await started;
    expect(isStartupTrustPending(SESSION)).toBe(true);
    vi.mocked(hasSession).mockResolvedValue(true);

    // The cursor sits on No for a while, then the human moves it back to Yes.
    let screen = TRUST_ON_NO;
    vi.mocked(sendSpecialKey).mockImplementation(async () => {
      screen = IDLE;
    });
    vi.mocked(capturePane).mockImplementation(async () => screen);
    const sent = tool.sendMessage('test-wt', 'hello').then(() => 'sent', (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await entersSent()).toBe(0);
    expect(isStartupTrustPending(SESSION)).toBe(true);

    screen = TRUST;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await sent).toBe('sent');
    expect(await entersSent()).toBe(1);
  });
});
