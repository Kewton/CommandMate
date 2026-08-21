/**
 * Issue #1908: opencode's launch waits for evidence, not for a clock.
 *
 * `startSession` used to sleep `OPENCODE_INIT_WAIT_MS = 15000` between typing
 * the launch command and attaching the event stream. Measured on 1.18.21 the
 * composer is painted at 2.9-3.6 s on an idle machine and at 24.1 s under the
 * load of six parallel agents, so the fixed wait was simultaneously ~11 s of
 * dead time inside the HTTP request that started the session and too short to
 * be safe. It is now a poll for opencode's own composer.
 *
 * Every frame here comes from `tests/fixtures/opencode-launch-boot-11821.ts`,
 * which is a real recording. The one that matters most is the shell frame: with
 * the blind sleep gone the first poll sees the shell that has just echoed the
 * launch command, and that is exactly what turned into a false ready for
 * copilot in #1907 (`^[>❯]\s` matches starship / pure / agnoster). The
 * assertions below are what says it does not happen here.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import {
  OpenCodeTool,
  OPENCODE_READY_MAX_ATTEMPTS,
  OPENCODE_READY_POLL_INTERVAL_MS,
} from '@/lib/cli-tools/opencode';
import { TUI_SESSION_CREATE_WAIT_MS } from '@/config/cli-tool-timing-config';
import {
  SHELL_PROMPT_CHEVRON,
  buildOpencodeClearedFrame,
  buildOpencodeComposerFrame,
  buildOpencodeConnectProviderFrame,
  buildOpencodeShellEchoFrame,
  buildOpencodeTypedComposerFrame,
} from '@tests/fixtures/opencode-launch-boot-11821';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  capturePane: vi.fn(),
  sendKeys: vi.fn(),
  sendSpecialKey: vi.fn(),
  killSession: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/cli-tools/opencode-config', () => ({
  ensureOpencodeConfig: vi.fn(),
}));

vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return {
    ...actual,
    promisify: () => vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@/lib/hooks/sources/opencode/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode/runtime')>();
  return {
    ...actual,
    reserveOpencodeServerPort: vi.fn().mockResolvedValue(null),
    attachOpencodeEventStream: vi.fn().mockResolvedValue(false),
    resumeOpencodeEventStream: vi.fn().mockResolvedValue(false),
    releaseOpencodeEventStream: vi.fn().mockResolvedValue(undefined),
  };
});

import { capturePane, createSession, hasSession, sendKeys } from '@/lib/tmux/tmux';
import { ensureOpencodeConfig } from '@/lib/cli-tools/opencode-config';
import {
  attachOpencodeEventStream,
  releaseOpencodeEventStream,
  reserveOpencodeServerPort,
  resumeOpencodeEventStream,
} from '@/lib/hooks/sources/opencode/runtime';
import { resetOpencodePortAssignments } from '@/lib/hooks/sources/opencode/ports';

let sandbox: string;

beforeAll(() => {
  sandbox = makeTempDir('opencode-readiness-');
});

afterAll(() => {
  removeTempDir(sandbox);
});

/**
 * Run a launch to completion on fake timers, and report both what the pane was
 * asked for and how much simulated time the launch consumed.
 */
async function runLaunch(): Promise<{ elapsedMs: number; attachElapsedMs: number | null }> {
  const tool = new OpenCodeTool();
  vi.useFakeTimers();
  let attachElapsedMs: number | null = null;
  const startedAt = Date.now();
  vi.mocked(attachOpencodeEventStream).mockImplementation(async () => {
    attachElapsedMs = Date.now() - startedAt;
    return false;
  });
  const launch = tool.startSession('wt-1908', '/test/path');
  await vi.runAllTimersAsync();
  await launch;
  const elapsedMs = Date.now() - startedAt;
  vi.useRealTimers();
  return { elapsedMs, attachElapsedMs };
}

describe('opencode launch readiness (Issue #1908)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOpencodePortAssignments();
    vi.stubEnv('CM_OPENCODE_PORT_FILE', join(sandbox, 'opencode-ports.json'));
    vi.mocked(hasSession).mockResolvedValue(false);
    vi.mocked(createSession).mockResolvedValue(undefined);
    vi.mocked(sendKeys).mockResolvedValue(undefined);
    vi.mocked(ensureOpencodeConfig).mockResolvedValue({
      written: false,
      configPath: null,
      reason: 'disabled',
    });
    vi.mocked(reserveOpencodeServerPort).mockResolvedValue(null);
    vi.mocked(attachOpencodeEventStream).mockResolvedValue(false);
    vi.mocked(resumeOpencodeEventStream).mockResolvedValue(false);
    vi.mocked(releaseOpencodeEventStream).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe('the frames it accepts', () => {
    it('stops on the first frame that shows the idle composer', async () => {
      vi.mocked(capturePane).mockResolvedValue(buildOpencodeComposerFrame());

      const { elapsedMs, attachElapsedMs } = await runLaunch();

      expect(capturePane).toHaveBeenCalledTimes(1);
      // The only simulated time spent is the shared post-createSession wait; the
      // readiness poll cost nothing because the very first frame was evidence.
      expect(attachElapsedMs).toBe(TUI_SESSION_CREATE_WAIT_MS);
      expect(elapsedMs).toBe(TUI_SESSION_CREATE_WAIT_MS);
    });

    it('stops on the "Connect a provider" overlay without answering it', async () => {
      // The overlay removes the composer from the frame entirely (measured:
      // zero occurrences of `Ask anything` while it is up), so a rule that only
      // knew the composer would burn the whole 30-second window on a pane that
      // is demonstrably up. Answering it is a different matter — every option
      // writes provider credentials into the operator's config, so CommandMate
      // reads it and leaves it alone.
      vi.mocked(capturePane).mockResolvedValue(buildOpencodeConnectProviderFrame());

      await runLaunch();

      expect(capturePane).toHaveBeenCalledTimes(1);
      // The launch command, and nothing after it.
      expect(vi.mocked(sendKeys).mock.calls).toHaveLength(1);
    });
  });

  describe('the frames it refuses', () => {
    /** Serve `frame` for `count` polls, then the composer. */
    function serveThen(frame: string, count: number): void {
      let seen = 0;
      vi.mocked(capturePane).mockImplementation(async () => {
        seen += 1;
        return seen <= count ? frame : buildOpencodeComposerFrame();
      });
    }

    it('does not accept the shell that just echoed the launch command', async () => {
      // Issue #1907's lesson, applied to opencode. The recording has the shell
      // on screen for the first ~0.9 s under a `❯` prompt, which is the exact
      // shape that made copilot's `^[>❯]\s` readiness rule accept a shell once
      // its own blind sleep stopped hiding the frame.
      //
      // MUTATION CHECK: relax `waitForReady` to `OPENCODE_PROMPT_PATTERN`, or
      // drop the gutter from `OPENCODE_IDLE_COMPOSER_PATTERN`, and this goes to
      // one poll.
      serveThen(buildOpencodeShellEchoFrame(SHELL_PROMPT_CHEVRON), 2);

      const { attachElapsedMs } = await runLaunch();

      expect(capturePane).toHaveBeenCalledTimes(3);
      expect(attachElapsedMs).toBe(TUI_SESSION_CREATE_WAIT_MS + 2 * OPENCODE_READY_POLL_INTERVAL_MS);
    });

    it('does not accept the cleared screen before anything is painted', async () => {
      // Two full poll intervals land on a pane with 200 blank rows.
      serveThen(buildOpencodeClearedFrame(), 2);

      await runLaunch();

      expect(capturePane).toHaveBeenCalledTimes(3);
    });

    it('does not accept a composer with something typed into it', async () => {
      // The placeholder is painted only while the input buffer is empty
      // (Issue #1883), so "the input box exists" is not the signal — "the input
      // box is empty" is.
      serveThen(buildOpencodeTypedComposerFrame(), 1);

      await runLaunch();

      expect(capturePane).toHaveBeenCalledTimes(2);
    });

    it('does not accept the placeholder printed outside the input box', async () => {
      // D1: `Ask anything...` reaching the pane inside a response body is the
      // "the phrase is on screen somewhere" inference, not evidence of an idle
      // composer. The gutter is what separates them, which is why the frame
      // handed to the check must NOT be `stripBoxDrawing`ed.
      const unguttered = buildOpencodeComposerFrame().replace(/┃/g, ' ');
      serveThen(unguttered, 2);

      await runLaunch();

      expect(capturePane).toHaveBeenCalledTimes(3);
    });
  });

  describe('when readiness never arrives', () => {
    it('gives up after the full window and lets the launch continue', async () => {
      // Fail-open, exactly as the sleep did: a session slower than the window is
      // still a session, and the screen scraper decides for it from there.
      vi.mocked(capturePane).mockResolvedValue(buildOpencodeShellEchoFrame());

      const { attachElapsedMs } = await runLaunch();

      expect(capturePane).toHaveBeenCalledTimes(OPENCODE_READY_MAX_ATTEMPTS);
      expect(attachElapsedMs).toBe(
        TUI_SESSION_CREATE_WAIT_MS + OPENCODE_READY_MAX_ATTEMPTS * OPENCODE_READY_POLL_INTERVAL_MS
      );
      expect(attachOpencodeEventStream).toHaveBeenCalled();
    });

    it('keeps polling when the capture itself fails', async () => {
      // The pane can refuse a capture while it is still coming up.
      let seen = 0;
      vi.mocked(capturePane).mockImplementation(async () => {
        seen += 1;
        if (seen <= 2) throw new Error('no server running');
        return buildOpencodeComposerFrame();
      });

      await expect(runLaunch()).resolves.toBeDefined();
      expect(capturePane).toHaveBeenCalledTimes(3);
    });
  });

  it('never spends the old fixed 15 seconds on a launch that is ready at once', async () => {
    // The regression this issue is about, stated as a number: the first `send`
    // to a fresh worktree held its HTTP call open for 15 s.
    vi.mocked(capturePane).mockResolvedValue(buildOpencodeComposerFrame());

    const { elapsedMs } = await runLaunch();

    expect(elapsedMs).toBeLessThan(15_000);
  });

  it('reads the pane, not a stripped one, and includes the whole visible pane', async () => {
    vi.mocked(capturePane).mockResolvedValue(buildOpencodeComposerFrame());

    await runLaunch();

    expect(capturePane).toHaveBeenCalledWith('mcbd-opencode-wt-1908', 50);
  });
});
