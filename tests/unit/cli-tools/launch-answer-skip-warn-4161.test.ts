/**
 * Issue #4161: a launch answer that did not go out is a warn (at info an ERROR- or
 * WARN-level setting hid the only trace), once while the same reason goes on, as the
 * Claude trust dialog does since #4149. Where the wait that skipped also ends the
 * send, its refusal says the key never went out.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ screen: '', calls: 0, flipAfterCalls: Infinity }));
const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ ...log, withContext: () => log }),
}));
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: vi.fn() };
});
vi.mock('@/lib/cli-tools/copilot-executable', () => ({ resolveCopilotExecutable: vi.fn() }));
vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(true),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  sendSpecialKey: vi.fn(),
  sendSpecialKeys: vi.fn(),
  capturePane: vi.fn(async () => state.screen),
  killSession: vi.fn().mockResolvedValue(true),
  getSessionWorkingDirectory: vi.fn().mockResolvedValue('/path/to/wt'),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  exactTarget: (name: string) => `=${name}:`,
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/session/instance-input-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/instance-input-lock')>()),
  // The reason changes after a number of declines: some of the waits poll with no timer between them.
  answerUnderInstanceInputLock: vi.fn(async () => ({
    answered: false,
    reason: ++state.calls > state.flipAfterCalls ? 'recheck-failed' : 'target-changed',
  })),
}));

import { AntigravityTool } from '@/lib/cli-tools/antigravity';
import { clearStartupTrust, markStartupTrustPending } from '@/lib/cli-tools/antigravity-startup-trust';
import { CodexTool } from '@/lib/cli-tools/codex';
import { CopilotTool } from '@/lib/cli-tools/copilot';
import { GeminiTool } from '@/lib/cli-tools/gemini';
import { CODEX_UPDATE_DIALOG_ENV_VAR } from '@/config/codex-update-dialog-config';
import { classifySendFailure } from '@/lib/session/send-attempt-state';
import { sendKeys, sendSpecialKey } from '@/lib/tmux/tmux';
import { buildCopilotFolderTrustFrame } from '@tests/fixtures/copilot-folder-trust-1080';

const fixture = (rel: string): string => readFileSync(resolve(__dirname, '../../fixtures', rel), 'utf8');
const SESSION = 'mcbd-tool-wt4161';

type Waits = {
  waitForReady(session: string, options?: { trustHooks: boolean }): Promise<void>;
  waitForPrompt(session: string, ...rest: unknown[]): Promise<unknown>;
};
const waits = (tool: unknown): Waits => tool as Waits;

const warned = (event: string): unknown[][] => log.warn.mock.calls.filter((call) => call[0] === event);
const informed = (event: string): unknown[][] => log.info.mock.calls.filter((call) => call[0] === event);

/** Run a wait to its end, or to its refusal. */
async function run(wait: Promise<unknown>, ms: number): Promise<unknown> {
  const settled = wait.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(ms);
  return settled;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubEnv(CODEX_UPDATE_DIALOG_ENV_VAR, undefined as unknown as string);
  state.calls = 0;
  state.flipAfterCalls = Infinity;
  clearStartupTrust();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('codex launch answers', () => {
  const launch = (): Promise<unknown> => run(waits(new CodexTool()).waitForReady(SESSION, { trustHooks: false }), 120_000);

  it.each([
    ['the update offer', 'codex-dialogs-0166/update.txt', 'codex-update-dialog-answer-skipped'],
    ['the folder trust', 'codex-dialogs-0166/trust.txt', 'codex-trust-dialog-answer-skipped'],
    ['the hook review', 'codex-dialogs-0166/hooks-review.txt', 'codex-hooks-screen-answer-skipped'],
  ])('%s: once per reason in a row, at warn', async (_name, rel, event) => {
    state.screen = fixture(rel);
    state.flipAfterCalls = 2;
    await launch();
    expect(warned(event).map((call) => (call[1] as { reason: string }).reason)).toEqual(['target-changed', 'recheck-failed']);
    expect(informed(event)).toEqual([]);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('the press-enter notice', async () => {
    state.screen = 'Something changed\n\nPress enter to continue\n';
    await launch();
    expect(warned('codex-notification-answer-skipped')).toHaveLength(1);
    expect(informed('codex-notification-answer-skipped')).toEqual([]);
  });

  it('the refusal of a send says the hook review got no key, not that it ignored them', async () => {
    state.screen = fixture('codex-dialogs-0166/hooks-review.txt');
    const error = (await run(waits(new CodexTool()).waitForPrompt(SESSION), 20_000)) as Error;
    expect(error.message).toMatch(/^Codex prompt not ready: codex's hook review \(hooks-review\) got no key \(target-changed\)\. /);
    expect(error.message).not.toContain('did not respond');
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
    expect(warned('codex-hooks-screen-answer-skipped')).toHaveLength(1);
  });
});

describe('gemini launch answer', () => {
  it('once per reason in a row, at warn', async () => {
    state.screen = fixture('gemini-live-3776/trust-dialog.txt');
    state.flipAfterCalls = 2;
    await run(waits(new GeminiTool()).waitForReady(SESSION), 120_000);
    expect(warned('gemini-trust-answer-skipped').map((call) => (call[1] as { reason: string }).reason)).toEqual([
      'target-changed',
      'recheck-failed',
    ]);
    expect(informed('gemini-trust-answer-skipped')).toEqual([]);
    expect(sendSpecialKey).not.toHaveBeenCalled();
  });
});

describe('copilot folder trust', () => {
  it('the launch: once per reason in a row, at warn', async () => {
    state.screen = buildCopilotFolderTrustFrame();
    state.flipAfterCalls = 2;
    await run(waits(new CopilotTool()).waitForReady(SESSION), 120_000);
    expect(warned('copilot-folder-trust-answer-skipped').map((call) => (call[1] as { reason: string }).reason)).toEqual([
      'target-changed',
      'recheck-failed',
    ]);
    expect(informed('copilot-folder-trust-answer-skipped')).toEqual([]);
  });

  it('a send: once, and the dialog is still refused as prompt-waiting', async () => {
    state.screen = buildCopilotFolderTrustFrame();
    const error = (await run(new CopilotTool().sendMessage('wt4161', 'secret body 4161'), 16_000)) as Error;
    expect(error.message).not.toContain('prompt not ready');
    expect(warned('copilot-folder-trust-answer-skipped')).toHaveLength(1);
  });
});

describe('agy folder trust', () => {
  const TRUST = fixture('antigravity-live-2364/trust-dialog.txt');

  it('the launch: once per reason in a row, at warn', async () => {
    state.screen = TRUST;
    state.flipAfterCalls = 2;
    await run(waits(new AntigravityTool()).waitForReady(SESSION), 200_000);
    expect(warned('antigravity-trust-answer-skipped').map((call) => (call[1] as { reason: string }).reason)).toEqual([
      'target-changed',
      'recheck-failed',
    ]);
    expect(informed('antigravity-trust-answer-skipped')).toEqual([]);
  });

  it('the owed Enter at a send: once, and its refusal says the key was not sent', async () => {
    state.screen = TRUST;
    markStartupTrustPending(SESSION);
    const error = (await run(waits(new AntigravityTool()).waitForPrompt(SESSION), 200_000)) as Error;
    expect(warned('antigravity-trust-answer-skipped')).toHaveLength(1);
    expect(error.message).toMatch(/needs an answer; its Enter was not sent: target-changed\)$/);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
  });
});
