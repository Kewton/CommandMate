/**
 * Issue #4161: opencode, command-code, copilot and agy say what held the pane when
 * they give up waiting for the prompt, as codex, claude, gemini and vibe-local do.
 * The refusal stays `not-sent / prompt-not-ready`, keeps its opening words, types
 * nothing, and carries nothing captured.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pane = vi.hoisted(() => ({ screen: '', fails: false }));

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
  capturePane: vi.fn(async () => {
    if (pane.fails) throw new Error('capture failed');
    return pane.screen;
  }),
  killSession: vi.fn().mockResolvedValue(true),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  exactTarget: (name: string) => `=${name}:`,
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

import { AntigravityTool } from '@/lib/cli-tools/antigravity';
import { clearStartupTrust } from '@/lib/cli-tools/antigravity-startup-trust';
import { CommandCodeTool } from '@/lib/cli-tools/command-code';
import { CopilotTool } from '@/lib/cli-tools/copilot';
import { OpenCodeTool } from '@/lib/cli-tools/opencode';
import { classifySendFailure } from '@/lib/session/send-attempt-state';
import { resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import { sendKeys, sendSpecialKey } from '@/lib/tmux/tmux';
import { buildCopilotFolderTrustFrame } from '@tests/fixtures/copilot-folder-trust-1080';

const fixture = (rel: string): string => readFileSync(resolve(__dirname, '../../fixtures', rel), 'utf8');

type WaitForPrompt = { waitForPrompt(session: string, ...rest: unknown[]): Promise<unknown> };

async function refusal(run: () => Promise<unknown>, ms: number): Promise<Error> {
  const settled = run().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(ms);
  const error = await settled;
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

function expectRefusal(error: Error, opening: string): void {
  expect(error.message.startsWith(opening)).toBe(true);
  expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
  expect(sendKeys).not.toHaveBeenCalled();
  expect(sendSpecialKey).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  pane.fails = false;
  resetInstanceInputLocks();
  clearStartupTrust();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('opencode names what held the pane', () => {
  const OPENING = 'OpenCode prompt not ready: timed out waiting for the input prompt before sending (';
  const send = (): Promise<Error> =>
    refusal(() => (new OpenCodeTool() as unknown as WaitForPrompt).waitForPrompt('mcbd-opencode-wt4161'), 16_000);
  const IDLE = fixture('opencode-live-2047/w80/boot-idle.txt');

  it('a pane with no input box', async () => {
    pane.screen = 'pane text 4161 that must stay out';
    const error = await send();
    expectRefusal(error, OPENING);
    expect(error.message).toMatch(/\(no input box on the pane: opencode may still be starting\)$/);
    expect(error.message).not.toContain('pane text 4161');
  });

  it('an input box holding text', async () => {
    pane.screen = fixture('opencode-live-2047/w80/composer-residual.txt');
    const error = await send();
    expectRefusal(error, OPENING);
    expect(error.message).toMatch(/\(the input box still holds text\)$/);
  });

  it('a pane that could not be read', async () => {
    pane.fails = true;
    const error = await send();
    expectRefusal(error, OPENING);
    expect(error.message).toMatch(/\(the pane could not be read\)$/);
  });

  it('negative: an empty input box is ready', async () => {
    pane.screen = IDLE;
    const wait = (new OpenCodeTool() as unknown as WaitForPrompt).waitForPrompt('mcbd-opencode-wt4161');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(wait).resolves.toBeUndefined();
  });
});

describe('command-code names what held the pane', () => {
  const OPENING = 'Command Code prompt not ready: timed out waiting for the composer before sending (';
  const COMPOSER = fixture('command-code-live-2250/boot-idle.txt');
  const send = (): Promise<Error> =>
    refusal(() => (new CommandCodeTool() as unknown as WaitForPrompt).waitForPrompt('mcbd-command-code-wt4161', 'wt4161'), 200_000);

  it('a pane with no composer', async () => {
    pane.screen = 'pane text 4161 that must stay out';
    const error = await send();
    expectRefusal(error, OPENING);
    expect(error.message).toMatch(/\(no composer on the pane: command code may still be starting\)$/);
    expect(error.message).not.toContain('pane text 4161');
  });

  it('a permission dialog', async () => {
    pane.screen = fixture('command-code-live-2250/dialog-create-file.txt');
    const error = await send();
    expectRefusal(error, OPENING);
    expect(error.message).toMatch(/\(a dialog is open: answer it in the terminal\)$/);
  });

  it('a pane that could not be read', async () => {
    pane.fails = true;
    expect((await send()).message).toMatch(/\(the pane could not be read\)$/);
  });

  it('negative: a live composer is ready', async () => {
    pane.screen = COMPOSER;
    const wait = (new CommandCodeTool() as unknown as WaitForPrompt).waitForPrompt('mcbd-command-code-wt4161', 'wt4161');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(wait).resolves.toBeUndefined();
  });
});

describe('copilot names what held the pane', () => {
  const OPENING = 'copilot prompt not ready within 15000ms, so the message was not sent; nothing was typed (';
  const send = (): Promise<Error> => refusal(() => new CopilotTool().sendMessage('wt4161', 'secret body 4161'), 16_000);

  it('a pane with no composer', async () => {
    pane.screen = 'pane text 4161 that must stay out';
    const error = await send();
    expect(error.message).toContain(OPENING);
    expect(error.message).toMatch(/\(no composer on the pane: copilot may still be starting\)$/);
    expect(error.message).not.toContain('pane text 4161');
    expect(error.message).not.toContain('secret body 4161');
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('negative: a dialog is still refused as prompt-waiting, not with this wording', async () => {
    pane.screen = buildCopilotFolderTrustFrame();
    const error = await send();
    expect(error.message).not.toContain('prompt not ready');
    expect(classifySendFailure(error).state).toBe('not-sent');
  });

  it('a pane that could not be read', async () => {
    pane.fails = true;
    expect((await send()).message).toMatch(/\(the pane could not be read\)$/);
  });
});

describe('agy names what held the pane', () => {
  const OPENING = 'Antigravity prompt not ready: timed out waiting for the input prompt before sending (';
  const send = (): Promise<Error> =>
    refusal(() => (new AntigravityTool() as unknown as WaitForPrompt).waitForPrompt('mcbd-antigravity-wt4161'), 200_000);

  it('a pane with nothing recognised', async () => {
    pane.screen = 'pane text 4161 that must stay out';
    const error = await send();
    expectRefusal(error, OPENING);
    expect(error.message).toMatch(/\(no input prompt on the pane: agy may still be starting\)$/);
    expect(error.message).not.toContain('pane text 4161');
  });

  it('a pane that could not be read', async () => {
    pane.fails = true;
    expect((await send()).message).toMatch(/\(the pane could not be read\)$/);
  });
});
