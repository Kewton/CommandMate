/**
 * Issue #4555 R6: Claude Code 2.1.330's `/effort` picker is drawn UNDER the
 * composer row `❯ /effort`, which stays on screen. The sender read that row as
 * rule D ("still typed") for the whole slash-command wait and ended the send
 * `slash-command-unsettled` (HTTP 500 unknown / CLI exit 99), though the picker
 * had opened. Server log of s10: `/effort` ×5, each `rule D` → `slash-command-held`
 * → `slash-command-unsettled` 4.8 s later.
 *
 * The fix (案 A): inside the slash-command wait only, a pending read with
 * claude's picker footer ({@link CLAUDE_SELECTION_LIST_FOOTER}) on a row BELOW
 * the composer row counts as submitted, rule `S-panel`. Rules A–F and the
 * read-back loop are unchanged.
 *
 * The frames are the real 2.1.330 captures of #4556
 * (`tests/fixtures/claude-picker-footer-4556/`, read only). The sender runs
 * unmocked; only the three tmux calls are the fake pane of #4555.
 *
 *   I1 — a lone slash command: no Enter after the first one;
 *   I2 — no footer under the composer: unconfirmed at the deadline, never sent;
 *   I3 — a plain body: read and resent as before.
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
import { createFakeSlowPane, type FakeSlowPane, type FakeSlowPaneOptions } from '../../helpers/slash-4555/fake-slow-pane';

const ESC = '\u001b';
const fixture = (...parts: string[]): string => readFileSync(path.resolve(__dirname, '../../fixtures', ...parts), 'utf8');

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/** 2.1.330 `/effort`: `❯ /effort` kept, the slider and its footer drawn under it. */
const EFFORT_PICKER = fixture('claude-picker-footer-4556', 'claude-2.1.330-effort.raw.txt');
/** 2.1.330 `/model`: `❯ /model` kept, the picker (its own `❯ 1. Default …` row) and footer under it. */
const MODEL_PICKER = fixture('claude-picker-footer-4556', 'claude-2.1.330-model.raw.txt');

const SEP = '─'.repeat(40);
const claudeFrame = (...rows: string[]): string => ['⏺ a reply', SEP, ...rows, SEP, '  ⏵⏵ auto mode on'].join('\n');
const CLAUDE_IDLE = claudeFrame(`${ESC}[39m❯ `);
const claudeTyped = (body: string): string => claudeFrame(`${ESC}[39m❯ ${body}`);

/** `/effort` in the composer, the completion list under it — no picker footer. */
const EFFORT_COMPLETIONS = [
  '⏺ a reply',
  SEP,
  `${ESC}[39m❯ /effort`,
  SEP,
  '  /effort          Set effort level for model usage',
  '  /export          Export the current conversation',
].join('\n');

/** A reply quoting the 2.1.330 footer, ABOVE a composer still holding `/effort` (#2847). */
const FOOTER_QUOTED_ABOVE = [
  '⏺ The picker footer reads:',
  '  ←/→ to adjust · s to use this session only · Enter to save · Esc to cancel',
  SEP,
  `${ESC}[39m❯ /effort`,
  SEP,
  '  ⏵⏵ auto mode on',
].join('\n');

const SESSION = 'mcbd-4555-r6-slash';

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

async function send(message: string): Promise<unknown> {
  const p = sendMessageWithSubmitVerification({ sessionName: SESSION, message, cliToolId: 'claude' });
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

/** The rules the read-back logged as deciding a `submitted` verdict, in order. */
const submittedRules = (): string[] =>
  loggerSpies.info.mock.calls
    .filter(([event, data]) => event === 'submit-classified' && (data as { state?: string }).state === 'submitted')
    .map(([, data]) => (data as { rule: string }).rule);

const loggedEvents = (spy: typeof loggerSpies.error): string[] => spy.mock.calls.map(([event]) => event as string);

const slash = (body: string, openedFrame: string, drawDelayMs: number | null = 0): FakeSlowPaneOptions => ({
  idleFrame: CLAUDE_IDLE,
  typedFrame: claudeTyped(body),
  openedFrame,
  drawDelayMs,
});

describe('Issue #4555 R6: claude picker drawn under the composer settles a lone slash command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(clearInputLine).mockResolvedValue(undefined);
    vi.mocked(clearComposerLine).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('the frames read as the Issue says: `/effort` picker is rule D, `/model` picker is rule F', () => {
    expect(classifySubmitWithRule(EFFORT_PICKER, 'claude', '/effort')).toEqual({ state: 'pending', rule: 'D' });
    // The picker's own `❯ 1. Default …` row is the last `❯` row: read as the composer (rule F).
    expect(classifySubmitWithRule(MODEL_PICKER, 'claude', '/model')).toEqual({ state: 'submitted', rule: 'F' });
    expect(classifySubmitWithRule(EFFORT_COMPLETIONS, 'claude', '/effort')).toEqual({ state: 'pending', rule: 'D' });
    expect(classifySubmitWithRule(FOOTER_QUOTED_ABOVE, 'claude', '/effort')).toEqual({ state: 'pending', rule: 'D' });
  });

  it('`/effort` (2.1.330 real frame): one Enter, sent, decided by the footer rule S-panel', async () => {
    const pane = install(slash('/effort', EFFORT_PICKER));

    const error = await send('/effort');

    expect(error).toBeNull();
    expect(pane.enters()).toBe(1);
    expect(keysAfterFirstEnter(pane)).toBe(0);
    expect(submittedRules()).toEqual(['S-panel']);
    expect(loggedEvents(loggerSpies.error)).not.toContain('submit-not-confirmed:slash-command-unsettled');
  });

  it('`/effort` drawn late (stale composer for 1.5 s, then the picker): one Enter, sent by S-panel', async () => {
    const pane = install(slash('/effort', EFFORT_PICKER, 1500));

    const error = await send('/effort');

    expect(error).toBeNull();
    expect(pane.enters()).toBe(1);
    expect(keysAfterFirstEnter(pane)).toBe(0);
    expect(submittedRules()).toEqual(['S-panel']);
  });

  describe('positive control: `/model` (2.1.330 real frame)', () => {
    // Rule F reads the picker's `❯ 1. Default …` row as the composer and comes
    // first: F is not pending, so S-panel (pending reads only) is never asked.
    // Rules A–F are not changed by this fix, so `/model` stays on F.
    it('picker drawn at once: one Enter, sent (rule F, read before the slash wait)', async () => {
      const pane = install(slash('/model', MODEL_PICKER));

      const error = await send('/model');

      expect(error).toBeNull();
      expect(pane.enters()).toBe(1);
      expect(keysAfterFirstEnter(pane)).toBe(0);
      expect(submittedRules()).toEqual(['F']);
    });

    it('picker drawn late: one Enter, sent (rule F inside the slash wait)', async () => {
      const pane = install(slash('/model', MODEL_PICKER, 1500));

      const error = await send('/model');

      expect(error).toBeNull();
      expect(pane.enters()).toBe(1);
      expect(keysAfterFirstEnter(pane)).toBe(0);
      expect(submittedRules()).toEqual(['F']);
    });
  });

  describe('I2 (negative): no picker footer under the composer — unconfirmed, one Enter', () => {
    const cases: Array<{ name: string; frame: string }> = [
      { name: 'completion list under `/effort`, no footer', frame: EFFORT_COMPLETIONS },
      { name: 'footer quoted in the conversation ABOVE the composer', frame: FOOTER_QUOTED_ABOVE },
    ];

    for (const { name, frame } of cases) {
      it(name, async () => {
        const pane = install(slash('/effort', frame));

        const error = await send('/effort');

        expect(error).toBeInstanceOf(Error);
        expect(pane.enters()).toBe(1);
        expect(keysAfterFirstEnter(pane)).toBe(0);
        expect(submittedRules()).toEqual([]);
        expect(loggedEvents(loggerSpies.error)).toContain('submit-not-confirmed:slash-command-unsettled');
        expect(classifySendFailure(error)).toEqual({ state: 'indeterminate', reason: 'submit-unconfirmed' });
      });
    }
  });

  // Known gap — NOT fixed here (tracked with the entrance fence of #4534): the
  // sender does not look for an open picker before it types. With the `/effort`
  // picker already open, the typed characters go to the picker (`s` = this
  // session only, …) and the first Enter saves the slider; the screen after it
  // still shows `❯ /effort` with the footer under it, so the send is reported
  // sent by S-panel. Pinned here as it happens, so a change to it is seen.
  it('known gap (#4555 R6): picker already open before the send — typed into the picker, reported sent', async () => {
    const pane = install({ idleFrame: EFFORT_PICKER, typedFrame: EFFORT_PICKER, openedFrame: EFFORT_PICKER, drawDelayMs: 0 });

    const error = await send('/effort');

    expect(error).toBeNull();
    // The body was typed (into the open picker) and one Enter followed it.
    expect(pane.calls().some((c) => c[0] === 'send-keys' && c.includes('/effort'))).toBe(true);
    expect(pane.enters()).toBe(1);
    expect(keysAfterFirstEnter(pane)).toBe(0);
    expect(submittedRules()).toEqual(['S-panel']);
  });

  describe('I3 (positive control): a plain body is read and resent as before', () => {
    const BODY = 'explain the effort picker';

    it('stuck to the end: 1 + 4 Enters and the `typed but unsent` failure, unchanged', async () => {
      const pane = install(slash(BODY, claudeTyped(BODY), null));

      const error = await send(BODY);

      expect((error as Error).message).toMatch(/after 4 attempts \(typed but unsent\)/);
      expect(pane.enters()).toBe(5);
    });

    it('a picker footer under a plain body does not count outside the slash wait: still 1 + 4 Enters', async () => {
      const frame = EFFORT_PICKER.replace('/effort', BODY);
      expect(classifySubmitWithRule(frame, 'claude', BODY)).toEqual({ state: 'pending', rule: 'D' });
      const pane = install({ idleFrame: CLAUDE_IDLE, typedFrame: frame, openedFrame: frame, drawDelayMs: null });

      const error = await send(BODY);

      expect((error as Error).message).toMatch(/after 4 attempts \(typed but unsent\)/);
      expect(pane.enters()).toBe(5);
      expect(submittedRules()).toEqual([]);
    });
  });
});
