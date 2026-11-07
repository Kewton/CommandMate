/**
 * Issue #4104: a dialog open over opencode's first frame does not hold the
 * launch for its whole readiness window.
 *
 * Measured (opencode 1.18.35, new pane, palette opened just before the input
 * box was painted): `opencode-ready-detection-timeout`, 32.9 s for a send whose
 * refusal itself took 2 s — the palette hides `Ask anything`, and only that and
 * the picker headings ended the wait. The launch now also ends on a modal overlay
 * seen for as long as the send's own wait requires (`createDialogConfirmation`).
 *
 * The palette frame is a real capture (`opencode-live-2047/w80/command-palette`),
 * its SGR intact: the overlay is read from the layout, so a stripped frame says
 * nothing (`opencode-modal-overlay.ts`).
 *
 * Controls:
 * - positive (each fails before #4104): a palette that stays ends the launch
 *   well inside the window, the stream is attached after that, and the send
 *   that follows is refused with no key and `not-sent`.
 * - negative (unchanged): a palette that closes lets the composer end the wait;
 *   one overlay frame, or a run broken by a failed capture, does not end it;
 *   the shell and the cleared screen still use the whole window.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import {
  OpenCodeTool,
  OPENCODE_READY_MAX_ATTEMPTS,
  OPENCODE_READY_POLL_INTERVAL_MS,
} from '@/lib/cli-tools/opencode';
import { PROMPT_WAIT_DIALOG_CONFIRM_MS } from '@/lib/cli-tools/prompt-wait-dialog';
import { TUI_SESSION_CREATE_WAIT_MS } from '@/config/cli-tool-timing-config';
import { stripAnsi } from '@/lib/detection/ansi';
import { detectOpenCodeModalOverlay } from '@/lib/detection/opencode-modal-overlay';
import { OPENCODE_IDLE_COMPOSER_PATTERN } from '@/lib/detection/tools/opencode/patterns';
import { classifySendFailure } from '@/lib/session/send-attempt-state';
import {
  buildOpencodeClearedFrame,
  buildOpencodeComposerFrame,
  buildOpencodeShellEchoFrame,
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

vi.mock('@/lib/cli-tools/opencode-executable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cli-tools/opencode-executable')>();
  return {
    ...actual,
    resolveOpencodeV1Executable: vi.fn(async () => ({
      executable: { path: 'opencode', version: '1.18.35', generation: 'v1' as const },
      probed: [],
    })),
  };
});

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
import { sendMessageWithSubmitVerification } from '@/lib/cli-tools/submit-verified-sender';
import { attachOpencodeEventStream, reserveOpencodeServerPort } from '@/lib/hooks/sources/opencode/runtime';
import { resetOpencodePortAssignments } from '@/lib/hooks/sources/opencode/ports';

const PALETTE = readFileSync(
  resolve(process.cwd(), 'tests/fixtures/opencode-live-2047/w80/command-palette.txt'),
  'utf8',
);

/** The whole readiness window, with the launch's own create wait. */
const WINDOW_MS = TUI_SESSION_CREATE_WAIT_MS + OPENCODE_READY_MAX_ATTEMPTS * OPENCODE_READY_POLL_INTERVAL_MS;

/** Serve `frames` poll by poll; the last one stays. An `Error` is a failed capture. */
function serve(...frames: Array<string | Error>): void {
  let call = 0;
  vi.mocked(capturePane).mockImplementation(async () => {
    const frame = frames[Math.min(call++, frames.length - 1)];
    if (frame instanceof Error) throw frame;
    return frame;
  });
}

let sandbox: string;
let tool: OpenCodeTool;

beforeAll(() => {
  sandbox = makeTempDir('opencode-launch-dialog-');
});

afterAll(() => {
  removeTempDir(sandbox);
});

/** Run a launch on fake timers; how long until the stream was attached. */
async function launch(): Promise<number> {
  vi.useFakeTimers();
  const startedAt = Date.now();
  let attachedAfter = -1;
  vi.mocked(attachOpencodeEventStream).mockImplementation(async () => {
    attachedAfter = Date.now() - startedAt;
    return false;
  });
  const started = tool.startSession('wt-4104', '/test/path');
  await vi.runAllTimersAsync();
  await started;
  vi.useRealTimers();
  return attachedAfter;
}

describe('opencode launch: a dialog over the first frame (Issue #4104)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOpencodePortAssignments();
    vi.stubEnv('CM_OPENCODE_PORT_FILE', join(sandbox, 'opencode-ports.json'));
    tool = new OpenCodeTool();
    vi.mocked(hasSession).mockResolvedValue(false);
    vi.mocked(createSession).mockResolvedValue(undefined);
    vi.mocked(sendKeys).mockResolvedValue(undefined);
    vi.mocked(ensureOpencodeConfig).mockResolvedValue({ written: false, configPath: null, reason: 'disabled' });
    vi.mocked(reserveOpencodeServerPort).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('the frame is what the measurement saw: an overlay, no placeholder, and only with its SGR', () => {
    expect(detectOpenCodeModalOverlay(PALETTE)).not.toBeNull();
    expect(OPENCODE_IDLE_COMPOSER_PATTERN.test(stripAnsi(PALETTE))).toBe(false);
    expect(detectOpenCodeModalOverlay(stripAnsi(PALETTE))).toBeNull();
  });

  it('positive: a palette that stays ends the launch once confirmed, then attaches the stream', async () => {
    serve(PALETTE);
    const attachedAfter = await launch();
    expect(attachedAfter).toBe(TUI_SESSION_CREATE_WAIT_MS + PROMPT_WAIT_DIALOG_CONFIRM_MS);
    expect(attachedAfter).toBeLessThan(WINDOW_MS / 2);
    // The launch line, and nothing typed at the dialog.
    expect(vi.mocked(sendKeys).mock.calls).toHaveLength(1);
  });

  it('positive: the send after it is refused with no key, not-sent, about 4 s after the box would be', async () => {
    serve(PALETTE);
    const attachedAfter = await launch();
    vi.mocked(sendKeys).mockClear();
    (tool as unknown as Record<string, unknown>).requireSession = vi.fn(async () => undefined);
    (tool as unknown as Record<string, unknown>).dispatchViaServer = vi.fn(async () => 'skipped');

    vi.useFakeTimers();
    const startedAt = Date.now();
    const sending = tool.sendMessage('wt-4104', 'secret body 4104').catch((error: Error) => error);
    await vi.runAllTimersAsync();
    const error = (await sending) as Error;
    const refusedAfter = Date.now() - startedAt;
    vi.useRealTimers();

    expect(error.message).toMatch(/opencode_modal_overlay/);
    expect(error.message).not.toContain('secret body 4104');
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
    expect(vi.mocked(sendKeys)).not.toHaveBeenCalled();
    expect(vi.mocked(sendMessageWithSubmitVerification)).not.toHaveBeenCalled();
    expect(attachedAfter + refusedAfter).toBe(TUI_SESSION_CREATE_WAIT_MS + 2 * PROMPT_WAIT_DIALOG_CONFIRM_MS);
  });

  it('negative: a palette that closes inside the confirmation lets the composer end the wait, and the send goes', async () => {
    serve(PALETTE, PALETTE, buildOpencodeComposerFrame());
    const attachedAfter = await launch();
    expect(attachedAfter).toBe(TUI_SESSION_CREATE_WAIT_MS + 2 * OPENCODE_READY_POLL_INTERVAL_MS);

    (tool as unknown as Record<string, unknown>).requireSession = vi.fn(async () => undefined);
    (tool as unknown as Record<string, unknown>).dispatchViaServer = vi.fn(async () => 'skipped');
    await tool.sendMessage('wt-4104', 'hello');
    expect(vi.mocked(sendMessageWithSubmitVerification)).toHaveBeenCalledTimes(1);
  });

  it('negative: one overlay frame among others does not end the wait', async () => {
    const cleared = buildOpencodeClearedFrame();
    serve(PALETTE, cleared, PALETTE, cleared, PALETTE, cleared, PALETTE, cleared);
    expect(await launch()).toBe(WINDOW_MS);
  });

  it('negative: a failed capture starts the confirmation again', async () => {
    const failed = new Error('capture failed');
    serve(PALETTE, PALETTE, PALETTE, failed, PALETTE, PALETTE, PALETTE, failed, buildOpencodeClearedFrame());
    expect(await launch()).toBe(WINDOW_MS);
  });

  it.each([
    ['the shell that echoed the launch line', buildOpencodeShellEchoFrame()],
    ['the cleared screen', buildOpencodeClearedFrame()],
    // The same screen without its SGR cannot be read, and says nothing.
    ['a palette frame stripped of its SGR', stripAnsi(PALETTE)],
  ])('negative: %s uses the whole window, as before', async (_name, frame) => {
    serve(frame);
    expect(await launch()).toBe(WINDOW_MS);
  });
});
