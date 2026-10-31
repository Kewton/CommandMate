/**
 * Issue #4040: copilot, vibe-local and opencode (v1) type a message only into
 * an input prompt that is up — checked before the input lock (the tool's own
 * 15 s wait) and again under it (`readiness` of the shared sender) — and refuse
 * with nothing typed, `not-sent` / `prompt-not-ready`, when it is not.
 *
 * The shared sender is the real one; tmux is mocked and every key is logged.
 * The frames are real captures (`tests/fixtures/vibe-local-readiness-4040/`,
 * `opencode-live-2047/`, `opencode-launch-boot-11821.ts`, the copilot 2623 /
 * 1885 captures).
 *
 * Controls:
 * - positive (each fails on the code before #4040): no prompt for the whole
 *   window → no key, `not-sent` / `prompt-not-ready`, also after the tool's
 *   `Failed to send message to …` wrap; a "ready" that goes stale while the
 *   send waits for the lock → no key; vibe-local's old `ctx:N% ❯` row above a
 *   loading screen → not ready; opencode's `Connect a provider` overlay → not
 *   ready; an opencode dispatch that ended `unknown` keeps the send
 *   `indeterminate` when the keyboard then refuses (image dispatch included).
 * - negative (unchanged behaviour): a prompt on screen is typed into once
 *   (vibe-local's two Enters, copilot while Working); opencode's `delivered`
 *   send neither reads the pane nor types; a dialog under the lock is still
 *   `prompt-waiting`, refused at once.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: vi.fn() };
});

vi.mock('@/lib/cli-tools/copilot-executable', () => ({
  resolveCopilotExecutable: vi.fn(),
}));

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(true),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn(),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn(),
  clearInputLine: vi.fn().mockResolvedValue(undefined),
  clearComposerLine: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(true),
  capturePane: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  exactTarget: (name: string) => `=${name}:`,
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CopilotTool } from '@/lib/cli-tools/copilot';
import { VibeLocalTool } from '@/lib/cli-tools/vibe-local';
import { OpenCodeTool } from '@/lib/cli-tools/opencode';
import { INPUT_READINESS_UNDER_LOCK_WAIT_MS } from '@/lib/cli-tools/submit-verified-sender';
import { isVibeLocalComposerReady } from '@/lib/detection/tools/vibe-local/readiness';
import { isOpenCodeComposerReady } from '@/lib/detection/tools/opencode/readiness';
import { VIBE_LOCAL_PROMPT_PATTERN } from '@/lib/detection/tools/vibe-local/patterns';
import { OPENCODE_IDLE_COMPOSER_PATTERN } from '@/lib/detection/tools/opencode/patterns';
import { classifySendFailure } from '@/lib/session/send-attempt-state';
import { resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import { capturePane, sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import { COPILOT_MODEL_SWITCH_2623_FRAMES as COPILOT } from '@tests/fixtures/copilot-model-switch-2623';
import {
  buildOpencodeClearedFrame,
  buildOpencodeComposerFrame,
  buildOpencodeConnectProviderFrame,
  buildOpencodeShellEchoFrame,
  buildOpencodeTypedComposerFrame,
} from '@tests/fixtures/opencode-launch-boot-11821';

const FIXTURES = path.resolve(__dirname, '../../fixtures');
const readFixture = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

const VL = {
  bootReady: readFixture('vibe-local-readiness-4040/boot-ready.txt'),
  bootLoading: readFixture('vibe-local-readiness-4040/boot-loading.txt'),
  generating: readFixture('vibe-local-readiness-4040/generating.txt'),
  turnDone: readFixture('vibe-local-readiness-4040/turn-done.txt'),
};

/**
 * #2070's relaunch into the same pane: the dead process's transcript — its
 * empty `ctx:4% ❯` row and footer — is still above, and the new launch is only
 * as far as the wrapper's banner.
 */
const VL_RELAUNCH_LOADING = `${VL.turnDone}\ndev@host work % vibe-local -y\n${VL.bootLoading.trim()}\n`;

/** The composer holding typed text that quotes a generation word. */
const VL_COMPOSER_HOLDS_TEXT = VL.bootReady.replace(/^ctx:4% ❯$/m, 'ctx:4% ❯ Thinking — ESC: stop...');

const OC = {
  w80: (name: string) => readFixture(`opencode-live-2047/w80/${name}.txt`),
  twoTurnIdle: readFixture('opencode-live-2049/two-turn-idle-11822.txt'),
};

const COPILOT_DIALOG = readFileSync(
  path.resolve(__dirname, '../lib/detection/fixtures/copilot-live-1885/permission-dialog.txt'),
  'utf8'
);

/** A copilot pane with no composer at all: the shell, before the TUI drew anything. */
const COPILOT_NO_COMPOSER = 'dev@host repo % copilot\n\n';

let keys: string[] = [];

/** Every capture answers from `frames` in turn; the last one repeats. */
function framesInTurn(...frames: string[]): void {
  let call = 0;
  vi.mocked(capturePane).mockImplementation((async () => frames[Math.min(call++, frames.length - 1)]) as never);
}

function stubSession(tool: object): void {
  (tool as Record<string, unknown>).requireSession = vi.fn(async () => undefined);
}

/** Run a send to completion under fake timers and return what it threw. */
async function settle(send: Promise<void>): Promise<Error | undefined> {
  let failure: Error | undefined;
  const done = send.catch((error: Error) => {
    failure = error;
  });
  await vi.runAllTimersAsync();
  await done;
  return failure;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetInstanceInputLocks();
  keys = [];
  vi.mocked(sendKeys).mockImplementation((async (_s: string, text: string) => {
    keys.push(`type:${text}`);
  }) as never);
  vi.mocked(sendSpecialKeys).mockImplementation((async (_s: string, k: string[]) => {
    keys.push(k.join('+'));
  }) as never);
});

afterEach(() => {
  vi.useRealTimers();
  resetInstanceInputLocks();
});

describe('isVibeLocalComposerReady (Issue #4040)', () => {
  it.each([
    ['the boot screen, empty prompt over the footer', VL.bootReady],
    ['a finished turn, new empty prompt', VL.turnDone],
    ['a turn being generated below the echo (type-ahead)', VL.generating],
  ])('positive: %s', (_name, frame) => {
    expect(isVibeLocalComposerReady(frame)).toBe(true);
  });

  it.each([
    ['the wrapper banner, no prompt yet', VL.bootLoading],
    ['a relaunch: an old empty prompt above, the new launch still loading', VL_RELAUNCH_LOADING],
    ['the composer holds text (quoting `Thinking`)', VL_COMPOSER_HOLDS_TEXT],
    ['an empty pane', ''],
  ])('negative: %s', (_name, frame) => {
    expect(isVibeLocalComposerReady(frame)).toBe(false);
  });

  it('positive control: the "row anywhere" pattern accepts the relaunch frame this rule refuses', () => {
    expect(VIBE_LOCAL_PROMPT_PATTERN.test(VL_RELAUNCH_LOADING)).toBe(true);
  });
});

describe('isOpenCodeComposerReady (Issue #4040)', () => {
  it.each([
    ['the first-launch composer with its placeholder (centred)', buildOpencodeComposerFrame()],
    ['the boot screen, raw ANSI', OC.w80('boot-idle')],
    ['a finished turn: empty box, no placeholder', OC.w80('turn-complete')],
    ['two finished turns', OC.twoTurnIdle],
    ['a turn being generated: the empty box stays', OC.w80('turn-running')],
  ])('positive: %s', (_name, frame) => {
    expect(isOpenCodeComposerReady(frame)).toBe(true);
  });

  it.each([
    ['the `Connect a provider` overlay', buildOpencodeConnectProviderFrame()],
    ['typed text in the box', buildOpencodeTypedComposerFrame()],
    ['a previous body left in the box (live)', OC.w80('composer-residual')],
    ['the permission dialog', OC.w80('permission-bash')],
    ['the command palette over the box', OC.w80('command-palette')],
    ['the shell before opencode drew', buildOpencodeShellEchoFrame()],
    ['the cleared screen before the first paint', buildOpencodeClearedFrame()],
  ])('negative: %s', (_name, frame) => {
    expect(isOpenCodeComposerReady(frame)).toBe(false);
  });

  it('control: the placeholder pattern alone never sees a post-turn composer', () => {
    expect(OPENCODE_IDLE_COMPOSER_PATTERN.test(OC.w80('turn-complete'))).toBe(false);
  });
});

describe('copilot: the normal send (Issue #4040)', () => {
  let tool: CopilotTool;

  beforeEach(() => {
    tool = new CopilotTool();
    stubSession(tool);
  });

  it.each([
    ['still loading (#2623)', COPILOT.BOOT_LOADING()],
    ['no composer on screen', COPILOT_NO_COMPOSER],
  ])('positive: %s for the whole window — nothing typed, not-sent / prompt-not-ready', async (_name, frame) => {
    framesInTurn(frame);
    const error = await settle(tool.sendMessage('wt-1', 'secret body 4040'));
    expect(error).toBeDefined();
    expect(keys).toEqual([]);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
    expect(error!.message).toMatch(/copilot prompt not ready within 15000ms, so the message was not sent; nothing was typed/);
    expect(error!.message).not.toContain('secret body 4040');
    expect(error!.message).not.toContain('Loading');
  });

  it('positive: ready before the lock, loading by the time it is held — nothing typed', async () => {
    framesInTurn(COPILOT.BOOT_IDLE(), COPILOT.BOOT_LOADING());
    const error = await settle(tool.sendMessage('wt-1', 'hello'));
    expect(keys).toEqual([]);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
    expect(error!.message).toContain(`no input prompt within ${INPUT_READINESS_UNDER_LOCK_WAIT_MS}ms`);
  });

  it('negative: loading under the lock, then the composer — typed once', async () => {
    framesInTurn(COPILOT.BOOT_IDLE(), COPILOT.BOOT_LOADING(), COPILOT.BOOT_IDLE());
    const error = await settle(tool.sendMessage('wt-1', 'hello'));
    expect(error).toBeUndefined();
    expect(keys.filter((k) => k === 'type:hello')).toHaveLength(1);
  });

  it('negative: a dialog under the lock is refused at once as prompt-waiting', async () => {
    framesInTurn(COPILOT.BOOT_IDLE(), COPILOT_DIALOG);
    const send = tool.sendMessage('wt-1', 'hello');
    const error = await settle(send);
    expect(keys).toEqual([]);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-waiting' });
    // One read before the lock, one under it: no readiness re-reads behind a dialog.
    expect(vi.mocked(capturePane)).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['idle', COPILOT.BOOT_IDLE()],
    ['Working, `❯` still drawn (not idle)', COPILOT.WORKING_SWITCHED_SILENTLY()],
  ])('negative: %s — typed as before', async (_name, frame) => {
    framesInTurn(frame);
    const error = await settle(tool.sendMessage('wt-1', 'hello'));
    expect(error).toBeUndefined();
    expect(keys).toEqual(['type:hello', 'Enter']);
  });
});

describe('vibe-local: the send (Issue #4040)', () => {
  let tool: VibeLocalTool;

  beforeEach(() => {
    tool = new VibeLocalTool();
    stubSession(tool);
  });

  it.each([
    ['the wrapper banner', VL.bootLoading],
    ['a relaunch with an old empty prompt above the loading screen', VL_RELAUNCH_LOADING],
  ])('positive: %s for the whole window — nothing typed, not-sent / prompt-not-ready after the wrap', async (_name, frame) => {
    framesInTurn(frame);
    const error = await settle(tool.sendMessage('wt-1', 'secret body 4040'));
    expect(keys).toEqual([]);
    expect(error!.message).toMatch(/^Failed to send message to Vibe Local: Vibe Local prompt not ready/);
    expect(error!.message).not.toContain('secret body 4040');
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
  });

  it('positive: ready before the lock, loading under it — nothing typed', async () => {
    framesInTurn(VL.bootReady, VL.bootLoading);
    const error = await settle(tool.sendMessage('wt-1', 'hello'));
    expect(keys).toEqual([]);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
  });

  it('negative: loading, then the prompt within the window — typed once, with both Enters', async () => {
    framesInTurn(VL.bootLoading, VL.bootLoading, VL.bootReady);
    const error = await settle(tool.sendMessage('wt-1', 'hello'));
    expect(error).toBeUndefined();
    expect(keys).toEqual(['type:hello', 'Enter', 'Enter']);
  });
});

describe('opencode v1: the keyboard fallback (Issue #4040)', () => {
  let tool: OpenCodeTool;
  let dispatch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tool = new OpenCodeTool();
    stubSession(tool);
    dispatch = vi.fn(async () => 'skipped');
    (tool as unknown as Record<string, unknown>).dispatchViaServer = dispatch;
  });

  it.each([
    ['the `Connect a provider` overlay', buildOpencodeConnectProviderFrame()],
    ['the cleared screen of a launch still coming up', buildOpencodeClearedFrame()],
  ])('positive: skipped, then %s for the whole window — nothing typed, not-sent', async (_name, frame) => {
    framesInTurn(frame);
    const error = await settle(tool.sendMessage('wt-1', 'secret body 4040'));
    expect(keys).toEqual([]);
    expect(error!.message).toMatch(/^Failed to send message to OpenCode: OpenCode prompt not ready/);
    expect(error!.message).not.toContain('secret body 4040');
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
  });

  it('control (not unknown): a POST the server refused (not_sent), then no box — not-sent', async () => {
    dispatch.mockResolvedValue('not_sent');
    framesInTurn(buildOpencodeConnectProviderFrame());
    const error = await settle(tool.sendMessage('wt-1', 'hello'));
    expect(keys).toEqual([]);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
  });

  it('positive: a POST with an unknown outcome, then no box — the send stays indeterminate', async () => {
    dispatch.mockResolvedValue('unknown');
    framesInTurn(buildOpencodeConnectProviderFrame());
    const error = await settle(tool.sendMessage('wt-1', 'hello'));
    expect(keys).toEqual([]);
    expect(classifySendFailure(error).state).toBe('indeterminate');
  });

  it('positive: a POST with an unknown outcome, then a dialog — any refusal before the keys stays indeterminate', async () => {
    dispatch.mockResolvedValue('unknown');
    framesInTurn(OC.w80('permission-bash'));
    const error = await settle(tool.sendMessage('wt-1', 'hello'));
    expect(keys).toEqual([]);
    expect(classifySendFailure(error).state).toBe('indeterminate');
  });

  it('skipped, then the permission dialog — refused, not-sent, without waiting out the 15 s window', async () => {
    framesInTurn(OC.w80('permission-bash'));
    const startedAt = Date.now();
    const error = await settle(tool.sendMessage('wt-1', 'hello'));
    expect(keys).toEqual([]);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
    expect(Date.now() - startedAt).toBeLessThanOrEqual(INPUT_READINESS_UNDER_LOCK_WAIT_MS + 1000);
  });

  it('positive: an image dispatch unknown, the path fallback refused — the first unknown is kept', async () => {
    dispatch.mockResolvedValueOnce('unknown').mockResolvedValueOnce('not_sent');
    framesInTurn(buildOpencodeConnectProviderFrame());
    const error = await settle(tool.sendMessageWithImage('wt-1', 'look', '/tmp/x.png'));
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(keys).toEqual([]);
    expect(classifySendFailure(error).state).toBe('indeterminate');
  });

  it('control (not unknown): an image dispatch refused, the path fallback refused — not-sent', async () => {
    dispatch.mockResolvedValue('not_sent');
    framesInTurn(buildOpencodeConnectProviderFrame());
    const error = await settle(tool.sendMessageWithImage('wt-1', 'look', '/tmp/x.png'));
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
  });

  it('negative: delivered over the server — no capture, no key', async () => {
    dispatch.mockResolvedValue('delivered');
    const error = await settle(tool.sendMessage('wt-1', 'hello'));
    expect(error).toBeUndefined();
    expect(vi.mocked(capturePane)).not.toHaveBeenCalled();
    expect(keys).toEqual([]);
  });

  it('positive: ready before the lock, the overlay under it — nothing typed', async () => {
    framesInTurn(buildOpencodeComposerFrame(), buildOpencodeConnectProviderFrame());
    const error = await settle(tool.sendMessage('wt-1', 'hello'));
    expect(keys).toEqual([]);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
  });

  it.each([
    ['the first-launch composer', buildOpencodeComposerFrame()],
    ['a finished turn', OC.w80('turn-complete')],
  ])('negative: %s — typed once', async (_name, frame) => {
    framesInTurn(frame);
    const error = await settle(tool.sendMessage('wt-1', 'hello'));
    expect(error).toBeUndefined();
    expect(keys).toEqual(['type:hello', 'Enter']);
  });
});
