/**
 * Issue #4146: gemini and vibe-local say what held the pane when they give up
 * waiting for the prompt, as codex and claude do since #4134. The refusal stays
 * `not-sent / prompt-not-ready`, types nothing, and carries nothing captured.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pane = vi.hoisted(() => ({ screen: '', fails: false }));

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
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

const submit = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/cli-tools/submit-verified-sender', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/submit-verified-sender')>()),
  sendMessageWithSubmitVerification: submit,
}));

import { BaseCLITool } from '@/lib/cli-tools/base';
import { GeminiTool } from '@/lib/cli-tools/gemini';
import { VibeLocalTool } from '@/lib/cli-tools/vibe-local';
import { sendKeys, sendSpecialKey } from '@/lib/tmux/tmux';
import { classifySendFailure } from '@/lib/session/send-attempt-state';
import { readVibeLocalNotReadyScreen } from '@/lib/detection/tools/vibe-local/readiness';

const fixture = (rel: string): string => readFileSync(resolve(__dirname, '../../fixtures', rel), 'utf8');

const GENERIC = /timed out waiting for the input prompt before sending$/;

async function refusal(send: () => Promise<void>, ms: number): Promise<Error> {
  const settled = send().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(ms);
  const error = await settled;
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  pane.fails = false;
  vi.spyOn(BaseCLITool.prototype as unknown as { isToolLive: () => Promise<boolean> }, 'isToolLive').mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('gemini names what held the pane', () => {
  const send = (): Promise<Error> => refusal(() => new GeminiTool().sendMessage('wt4146', 'secret body 4146'), 16_000);

  it.each([
    ['the folder-trust dialog', () => fixture('gemini-live-3776/trust-dialog.txt'), /\(the folder-trust dialog is open: answer it in the terminal\)$/],
    ['the trust dialog with the cursor off the safe row', () => fixture('gemini-live-3776/trust-dialog-cursor-dont-trust.txt'), /\(the folder-trust dialog is open/],
    ['the sign-in picker', () => fixture('gemini-live-3776/after-enter-auth.txt'), /\(the sign-in picker is open: answer it in the terminal\)$/],
    ['a pane with nothing recognised', () => 'Loading…', /\(no input prompt on the pane: gemini may still be starting\)$/],
  ])('%s', async (_name, screen, reason) => {
    pane.screen = screen();
    const error = await send();
    expect(error.message).toMatch(/Gemini prompt not ready: timed out waiting for the input prompt before sending \(/);
    expect(error.message).toMatch(reason);
    expect(error.message).not.toMatch(GENERIC);
    expect(error.message).not.toContain('secret body 4146');
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
    expect(submit).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
    expect(sendSpecialKey).not.toHaveBeenCalled();
  });

  it('a pane that could not be read says so', async () => {
    pane.fails = true;
    expect((await send()).message).toMatch(/\(the pane could not be read\)$/);
  });

  it('does not quote the pane', async () => {
    pane.screen = 'pane text 4146 that must stay out';
    expect((await send()).message).not.toContain('pane text 4146');
  });

  it('negative: a prompt on screen is sent to as before', async () => {
    pane.screen = '> Type your message or @path/to/file';
    const sent = new GeminiTool().sendMessage('wt4146', 'hello');
    await vi.advanceTimersByTimeAsync(1_000);
    await sent;
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe('vibe-local names what held the pane', () => {
  const READY = fixture('vibe-local-readiness-4040/boot-ready.txt');
  const LOADING = fixture('vibe-local-readiness-4040/boot-loading.txt');
  const TURN_DONE = fixture('vibe-local-readiness-4040/turn-done.txt');
  const HOLDS_TEXT = READY.replace(/^ctx:4% ❯$/m, 'ctx:4% ❯ typed text 4146');
  const RELAUNCH = `${TURN_DONE}\ndev@host work % vibe-local -y\n${LOADING.trim()}\n`;

  function tool(): VibeLocalTool {
    const made = new VibeLocalTool();
    (made as unknown as Record<string, unknown>).requireSession = vi.fn(async () => undefined);
    return made;
  }
  const send = (): Promise<Error> => refusal(() => tool().sendMessage('wt4146', 'secret body 4146'), 120_000);

  it.each([
    ['the wrapper banner', () => LOADING, /\(no input row on the pane: vibe-local may still be starting\)$/],
    ['a relaunch below an old input row', () => RELAUNCH, /\(output is drawn below the newest input row: /],
    ['an input row holding text', () => HOLDS_TEXT, /\(the input row still holds text\)$/],
  ])('%s', async (_name, screen, reason) => {
    pane.screen = screen();
    const error = await send();
    expect(error.message).toMatch(/Vibe Local prompt not ready: timed out waiting for the input prompt before sending \(/);
    expect(error.message).toMatch(reason);
    expect(error.message).not.toContain('secret body 4146');
    expect(error.message).not.toContain('typed text 4146');
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('a pane that could not be read says so', async () => {
    pane.fails = true;
    expect((await send()).message).toMatch(/\(the pane could not be read\)$/);
  });

  it('negative: a ready pane is sent to as before', async () => {
    pane.screen = READY;
    const sent = tool().sendMessage('wt4146', 'hello');
    await vi.advanceTimersByTimeAsync(1_000);
    await sent;
    expect(submit).toHaveBeenCalledTimes(1);
  });

  describe('readVibeLocalNotReadyScreen', () => {
    it('reads the rows with ANSI on them', () => {
      expect(readVibeLocalNotReadyScreen(`\u001b[1m${LOADING}\u001b[0m`)).toBe('no-input-row');
      expect(readVibeLocalNotReadyScreen(HOLDS_TEXT)).toBe('input-row-holds-text');
      expect(readVibeLocalNotReadyScreen(RELAUNCH)).toBe('output-below-input-row');
    });
  });
});
