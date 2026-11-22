/**
 * Issue #4555: a lone slash command gets no Enter after its first one.
 *
 * On a codex session whose drawing lagged, `/model`'s Enter opened the picker
 * while captures still showed `› /model` in the composer. The read-back read
 * that as rule D ("still typed") and resent Enter four times; two of them
 * picked the picker's highlighted rows (`• Model changed to gpt-6.2-sol high`,
 * the effort saved as codex's default). Server log of s10: `rule D` ×4 →
 * `submit-verification-failed attempts 4`, five Enters in all.
 *
 * The pane here is {@link createFakeSlowPane}: the first Enter opens the
 * picker, captures show the stale frame for `drawDelayMs`, and every later
 * Enter picks a row. The sender runs unmocked; only `@/lib/tmux/tmux` (the
 * three calls it makes) is the fake.
 *
 *   I1 — a lone slash command: no Enter or other key after the first Enter
 *        (slow pane, fast pane, `/model <arg>`, every tool on the shared loop);
 *   I2 — a pane that never changes: unconfirmed (`indeterminate`), never
 *        `not-sent`, with no resend;
 *   I3 — a plain body: the resends are what they were (#3366's Enter turned
 *        newline is sent again, and a body stuck to the end gets 1 + 4 Enters).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
  clearInputLine: vi.fn().mockResolvedValue(undefined),
  clearComposerLine: vi.fn().mockResolvedValue(undefined),
  exactTarget: (name: string) => `=${name}:`,
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

vi.mock('child_process', () => ({ execFile: vi.fn() }));

const loggerSpies = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ ...loggerSpies, withContext: () => loggerSpies }),
}));

import { sendMessageWithSubmitVerification, classifySubmitWithRule } from '@/lib/cli-tools/submit-verified-sender';
import { classifySendFailure } from '@/lib/session/send-attempt-state';
import { sendKeys, sendSpecialKeys, capturePane, clearInputLine, clearComposerLine } from '@/lib/tmux/tmux';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createFakeSlowPane, type FakeSlowPane, type FakeSlowPaneOptions } from '../../helpers/slash-4555/fake-slow-pane';

const ESC = '\u001b';
const fixture = (...parts: string[]): string => readFileSync(path.resolve(__dirname, '../../fixtures', ...parts), 'utf8');
const detectionFixture = (...parts: string[]): string =>
  readFileSync(path.resolve(__dirname, '../lib/detection/fixtures', ...parts), 'utf8');

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/** codex 0.160.0 at 200x1000: idle composer (`Ask Codex to do anything`). */
const CODEX_IDLE = fixture('codex-send-burst-3366', 'typed-in-burst.capture');
const CODEX_BODY_LANDED = fixture('codex-send-burst-3366', 'body-landed.capture');
const CODEX_LANDED_BODY = "Run the shell command 'sleep 15 && ls', then reply with the single word WORD6.";
/** The live composer of {@link CODEX_BODY_LANDED}, holding `body` instead. */
const codexTyped = (body: string): string => CODEX_BODY_LANDED.replace(CODEX_LANDED_BODY, body);
/** codex 0.157.1's `/model` picker (`Select Model and Effort`, `enter select · esc back`), its tail. */
const CODEX_MODEL_PICKER = fixture('codex-dialogs-0157', 'model-picker.txt').split('\n').slice(-40).join('\n');

const SEP = '─'.repeat(40);
const claudeFrame = (...rows: string[]): string => ['⏺ a reply', SEP, ...rows, SEP, '  ⏵⏵ auto mode on'].join('\n');
const CLAUDE_IDLE = claudeFrame(`${ESC}[39m❯ `);
const claudeTyped = (body: string): string => claudeFrame(`${ESC}[39m❯ ${body}`);
/** claude's `/model` dialog: no composer on screen. */
const CLAUDE_MODEL_DIALOG = [
  ' Select model',
  ' Switch between Claude models.',
  '',
  ' ❯ 1. Default (recommended)',
  '   2. Opus',
  '',
  ' Enter to confirm · Esc to exit',
].join('\n');

const markerFrame = (marker: string, text: string): string => ['some history', '', `${marker} ${text}`, '', '  status'].join('\n');
const MARKER_DIALOG = ['  Select a model', '', '  1. model-a', '  2. model-b', '', '  enter select · esc cancel'].join('\n');

const OPENCODE_RESIDUAL = detectionFixture('opencode-live-1883', 'composer-residual.txt');
const OPENCODE_IDLE = detectionFixture('opencode-live-1883', 'boot-idle.txt');
const OPENCODE_MODEL_PICKER = detectionFixture('opencode-live-1896', 'model-picker.txt');

const SESSION = 'mcbd-4555-slash';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function install(options: FakeSlowPaneOptions): FakeSlowPane {
  const pane = createFakeSlowPane(options);
  vi.mocked(sendKeys).mockImplementation(pane.sendKeys as never);
  vi.mocked(sendSpecialKeys).mockImplementation(pane.sendSpecialKeys as never);
  vi.mocked(capturePane).mockImplementation(pane.capturePane as never);
  return pane;
}

async function send(message: string, cliToolId: CLIToolType, extra: { awaitTypedBody?: boolean } = {}): Promise<unknown> {
  const p = sendMessageWithSubmitVerification({ sessionName: SESSION, message, cliToolId, ...extra });
  const settled = p.then(
    () => null,
    (error: unknown) => error
  );
  await vi.runAllTimersAsync();
  return settled;
}

const keysAfterFirstEnter = (pane: FakeSlowPane): number =>
  pane.keysAfterFirstEnter().length +
  vi.mocked(clearInputLine).mock.calls.length +
  vi.mocked(clearComposerLine).mock.calls.length;

const codexSlow = (body: string, drawDelayMs: number | null): FakeSlowPaneOptions => ({
  idleFrame: CODEX_IDLE,
  typedFrame: codexTyped(body),
  openedFrame: CODEX_MODEL_PICKER,
  drawDelayMs,
});

describe('Issue #4555: no Enter is resent for a lone slash command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(clearInputLine).mockResolvedValue(undefined);
    vi.mocked(clearComposerLine).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('the frames read as the Issue says: the stale composer is rule D, the picker is no composer', () => {
    expect(classifySubmitWithRule(codexTyped('/model'), 'codex', '/model')).toEqual({ state: 'pending', rule: 'D' });
    expect(classifySubmitWithRule(CODEX_MODEL_PICKER, 'codex', '/model').state).toBe('submitted');
    expect(classifySubmitWithRule(claudeTyped('/model'), 'claude', '/model')).toEqual({ state: 'pending', rule: 'D' });
    expect(classifySubmitWithRule(CLAUDE_MODEL_DIALOG, 'claude', '/model').state).toBe('submitted');
  });

  describe('I1: codex `/model`, the picker drawn late', () => {
    it('slow pane (picker drawn 1.5 s after Enter): one Enter, resolves on the picker frame', async () => {
      const pane = install(codexSlow('/model', 1500));

      const error = await send('/model', 'codex', { awaitTypedBody: true });

      expect(error).toBeNull();
      expect(pane.enters()).toBe(1);
      expect(keysAfterFirstEnter(pane)).toBe(0);
      expect(pane.picks()).toBe(0);
    });

    it('fast pane (picker within 200 ms): one Enter, resolves, as before', async () => {
      const pane = install(codexSlow('/model', 150));

      const error = await send('/model', 'codex', { awaitTypedBody: true });

      expect(error).toBeNull();
      expect(pane.enters()).toBe(1);
      expect(keysAfterFirstEnter(pane)).toBe(0);
    });

    it('a slash command with an argument (`/model gpt-6.2-sol`) is held the same way', async () => {
      const pane = install(codexSlow('/model gpt-6.2-sol', 1500));

      const error = await send('/model gpt-6.2-sol', 'codex', { awaitTypedBody: true });

      expect(error).toBeNull();
      expect(pane.enters()).toBe(1);
      expect(keysAfterFirstEnter(pane)).toBe(0);
      expect(pane.picks()).toBe(0);
    });
  });

  describe('I2: the Enter eaten — the composer shows `/model` to the end', () => {
    it('throws unconfirmed (indeterminate, never not-sent) after one Enter, nothing resent', async () => {
      const pane = install(codexSlow('/model', null));

      const error = await send('/model', 'codex', { awaitTypedBody: true });

      expect(error).toBeInstanceOf(Error);
      expect(pane.enters()).toBe(1);
      expect(keysAfterFirstEnter(pane)).toBe(0);
      const classified = classifySendFailure(new Error(`Failed to send message to Codex: ${(error as Error).message}`));
      expect(classified).toEqual({ state: 'indeterminate', reason: 'submit-unconfirmed' });
      expect(classified.state).not.toBe('not-sent');
    });
  });

  describe('I1 on every tool that goes through the same read-back loop', () => {
    const cases: Array<{ tool: CLIToolType; options: FakeSlowPaneOptions; resolves: boolean }> = [
      {
        tool: 'claude',
        options: { idleFrame: CLAUDE_IDLE, typedFrame: claudeTyped('/model'), openedFrame: CLAUDE_MODEL_DIALOG, drawDelayMs: 1500 },
        resolves: true,
      },
      {
        tool: 'gemini',
        options: { idleFrame: markerFrame('>', ''), typedFrame: markerFrame('>', '/model'), openedFrame: MARKER_DIALOG, drawDelayMs: 1500 },
        resolves: true,
      },
      {
        tool: 'copilot',
        options: { idleFrame: markerFrame('❯', ''), typedFrame: markerFrame('❯', '/model'), openedFrame: MARKER_DIALOG, drawDelayMs: 1500 },
        resolves: true,
      },
      {
        tool: 'opencode',
        options: {
          idleFrame: OPENCODE_IDLE,
          typedFrame: OPENCODE_RESIDUAL.replace('echo PREFILLED', '/models'),
          openedFrame: OPENCODE_MODEL_PICKER,
          drawDelayMs: 1500,
        },
        // The picker is an overlay over the box (`B-obscured` / `F-obscured`):
        // indeterminate, so the send ends unconfirmed — without a key.
        resolves: false,
      },
    ];

    for (const { tool, options, resolves } of cases) {
      it(`${tool}: slow pane, one Enter, no key after it`, async () => {
        const body = tool === 'opencode' ? '/models' : '/model';
        expect(classifySubmitWithRule(options.typedFrame, tool, body).state).toBe('pending');
        const pane = install(options);

        const error = await send(body, tool);

        expect(pane.enters()).toBe(1);
        expect(keysAfterFirstEnter(pane)).toBe(0);
        if (resolves) {
          expect(error).toBeNull();
        } else {
          expect(classifySendFailure(error).state).toBe('indeterminate');
        }
      });
    }
  });

  describe('I3 (positive control): a plain body is resent as before', () => {
    const BODY = 'explain the model picker';

    it('#3366 shape: the first Enter became a newline, the resent one submits — two Enters', async () => {
      const pane = install({ ...codexSlow(BODY, null), openedFrame: CODEX_IDLE, submitsOnEnter: 2 });

      const error = await send(BODY, 'codex', { awaitTypedBody: true });

      expect(error).toBeNull();
      expect(pane.enters()).toBe(2);
    });

    it('stuck to the end: 1 + 4 Enters and the `typed but unsent` failure, unchanged', async () => {
      const pane = install(codexSlow(BODY, null));

      const error = await send(BODY, 'codex', { awaitTypedBody: true });

      expect((error as Error).message).toMatch(/after 4 attempts \(typed but unsent\)/);
      expect(pane.enters()).toBe(5);
    });

    it('a body that only starts with a slash command line is not a lone one: resent as before', async () => {
      // Two lines: not a lone slash command, the plain path.
      const body = '/model\nthen explain';
      const pane = install({
        idleFrame: CLAUDE_IDLE,
        typedFrame: claudeTyped('/model'),
        openedFrame: CLAUDE_IDLE,
        drawDelayMs: null,
        submitsOnEnter: 2,
      });

      const error = await send(body, 'claude');

      expect(error).toBeNull();
      expect(pane.enters()).toBe(2);
    });
  });
});
