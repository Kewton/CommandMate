/**
 * Issue #3757 (P1): agy's folder-trust screen drawn after the launch window.
 *
 * `waitForReady` gives up after ~34 s (3 s + 30 × 1 s) and agy's start-up was
 * measured at 1 s on one launch and 61 s on the next, with the trust screen
 * drawn only then. The launch reported success, and the next send's readiness
 * wait looked only for the input box: nothing ever confirmed the screen.
 *
 * The pane below is a clock: blank until `trustAt` ms after the launch, the
 * trust screen from then until an Enter reaches it, idle after that — the
 * timeline the Issue measured.
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
  isStartupTrustPending,
  isStartupWindowOpen,
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

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

const logInfo = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: logInfo,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withContext: () => ({ info: logInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));

const SESSION = 'mcbd-antigravity-test-wt';
const LIVE_2364 = resolve(__dirname, '../../fixtures/antigravity-live-2364');
const LIVE_2478 = resolve(__dirname, '../../fixtures/antigravity-live-2478');
/** The live trust screen (agy 1.1.27) and an idle agy 1.2.1 pane. */
const TRUST = readFileSync(join(LIVE_2364, 'trust-dialog.txt'), 'utf8');
const IDLE = readFileSync(join(LIVE_2478, 'after-plain-turns.txt'), 'utf8');

/** Measured: the trust screen 61 s after the launch (Issue #3757). */
const TRUST_AT_MS = 61_000;

async function tmux() {
  return import('@/lib/tmux/tmux');
}

/** Enter calls sent to the session. */
async function entersSent(): Promise<number> {
  const { sendSpecialKey } = await tmux();
  return vi.mocked(sendSpecialKey).mock.calls.filter(([s, k]) => s === SESSION && k === 'Enter').length;
}

/**
 * Drive the pane on the clock: blank, then the trust screen from `trustAt`,
 * then idle once an Enter has been sent at the trust screen.
 */
async function paneOnClock(launchAt: number, trustAt: number): Promise<void> {
  const { capturePane, sendSpecialKey } = await tmux();
  let trusted = false;
  vi.mocked(sendSpecialKey).mockImplementation(async (_s, key) => {
    if (key === 'Enter' && Date.now() - launchAt >= trustAt) trusted = true;
  });
  vi.mocked(capturePane).mockImplementation(async () => {
    if (trusted) return IDLE;
    return Date.now() - launchAt >= trustAt ? TRUST : '';
  });
}

function logged(event: string): Array<Record<string, unknown>> {
  return logInfo.mock.calls
    .filter(([name]) => name === event)
    .map(([, ctx]) => (ctx ?? {}) as Record<string, unknown>);
}

describe('Issue #3757: the trust screen drawn after the launch window', () => {
  let tool: AntigravityTool;
  const tempHomes: string[] = [];

  beforeEach(async () => {
    vi.useFakeTimers();
    tool = new AntigravityTool();
    vi.clearAllMocks();
    clearStartupTrust();
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'antigravity-3757-home-')));
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

  /** Launch and let the launch window run out on a blank pane. */
  async function launchPastWindow(trustAt = TRUST_AT_MS): Promise<number> {
    const launchAt = Date.now();
    await paneOnClock(launchAt, trustAt);
    const started = tool.startSession('test-wt', '/path/to/wt');
    await vi.advanceTimersByTimeAsync(40_000);
    await started;
    const { hasSession } = await tmux();
    vi.mocked(hasSession).mockResolvedValue(true);
    return launchAt;
  }

  it('positive: the next send confirms the late trust screen and goes through', async () => {
    await launchPastWindow();
    expect(await entersSent()).toBe(0);
    expect(isStartupTrustPending(SESSION)).toBe(true);

    const sent = tool.sendMessage('test-wt', 'hello');
    const settled = sent.then(() => 'sent', (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await settled).toBe('sent');
    expect(await entersSent()).toBe(1);
    expect(isStartupTrustPending(SESSION)).toBe(false);
    expect(logged('auto-trusted-folder-for-antigravity')).toContainEqual(
      expect.objectContaining({ afterLaunchWindow: true }),
    );
  });

  it('the launch window is open from the launch line until the window ends, and closed after', async () => {
    await paneOnClock(Date.now(), TRUST_AT_MS);
    const started = tool.startSession('test-wt', '/path/to/wt');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(isStartupWindowOpen(SESSION)).toBe(true);
    await vi.advanceTimersByTimeAsync(35_000);
    await started;
    expect(isStartupWindowOpen(SESSION)).toBe(false);
  });

  it('the launch timeout logs the screen it saw and the reason', async () => {
    await launchPastWindow();
    const [timeout] = logged('antigravity-prompt-detection-timeout');
    expect(timeout).toMatchObject({
      sessionName: SESSION,
      trustDialogHandled: false,
      reason: 'startup-trust-unhandled',
      screen: 'blank',
      captureErrors: 0,
    });
  });

  it('capture exceptions during the launch window are counted, with the last one', async () => {
    const { capturePane } = await tmux();
    vi.mocked(capturePane).mockRejectedValue(new Error("can't find pane"));
    const started = tool.startSession('test-wt', '/path/to/wt');
    await vi.advanceTimersByTimeAsync(40_000);
    await started;

    const [timeout] = logged('antigravity-prompt-detection-timeout');
    expect(timeout).toMatchObject({
      screen: 'no-capture',
      captureErrors: 30,
      lastCaptureError: "can't find pane",
    });
  });

  it('two sends waiting on one pane send ONE Enter between them', async () => {
    await launchPastWindow();

    const a = tool.sendMessage('test-wt', 'one').then(() => 'sent', (e: Error) => e.message);
    const b = tool.sendMessage('test-wt', 'two').then(() => 'sent', (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await a).toBe('sent');
    expect(await b).toBe('sent');
    expect(await entersSent()).toBe(1);
  });

  it('a launch window that sent its Enter owes none: a later send never sends a second', async () => {
    // The trust screen is up at the first poll and stays up whatever is sent:
    // the window's one Enter is spent, and the send must not add another.
    const { capturePane } = await tmux();
    vi.mocked(capturePane).mockResolvedValue(TRUST);
    const started = tool.startSession('test-wt', '/path/to/wt');
    await vi.advanceTimersByTimeAsync(40_000);
    await started;
    expect(await entersSent()).toBe(1);
    expect(isStartupTrustPending(SESSION)).toBe(false);
    const { hasSession } = await tmux();
    vi.mocked(hasSession).mockResolvedValue(true);

    const sent = tool.sendMessage('test-wt', 'hello').then(() => 'sent', (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(await sent).toMatch(/folder-trust confirmation .* is on screen and needs an answer/);
    expect(await entersSent()).toBe(1);
  });

  it('a send that times out before the screen appears says the trust is still unhandled', async () => {
    await launchPastWindow(10 * 60_000);

    const sent = tool.sendMessage('test-wt', 'hello').then(() => 'sent', (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(70_000);

    expect(await sent).toMatch(/prompt not ready.*startup-trust-unhandled/);
    expect(await entersSent()).toBe(0);
    expect(logged('antigravity-prompt-not-ready')).toContainEqual(
      expect.objectContaining({ reason: 'startup-trust-unhandled', screen: 'blank' }),
    );
  });

  it('negative: a session that reached its prompt owes nothing — a trust screen later gets no Enter', async () => {
    // The ordinary launch: idle within the window.
    const { capturePane } = await tmux();
    vi.mocked(capturePane).mockResolvedValue(IDLE);
    const started = tool.startSession('test-wt', '/path/to/wt');
    await vi.advanceTimersByTimeAsync(10_000);
    await started;
    expect(isStartupTrustPending(SESSION)).toBe(false);
    const { hasSession } = await tmux();
    vi.mocked(hasSession).mockResolvedValue(true);

    vi.mocked(capturePane).mockResolvedValue(TRUST);
    const sent = tool.sendMessage('test-wt', 'hello').then(() => 'sent', (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(await sent).toMatch(/prompt not ready/);
    expect(await entersSent()).toBe(0);
  });

  it('negative: killing the session drops the owed Enter', async () => {
    await launchPastWindow();
    expect(isStartupTrustPending(SESSION)).toBe(true);

    const killed = tool.killSession('test-wt');
    await vi.advanceTimersByTimeAsync(10_000);
    await killed;

    expect(isStartupTrustPending(SESSION)).toBe(false);
  });
});
