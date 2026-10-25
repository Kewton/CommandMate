/**
 * Issue #3906: a codex composer outside the readers' windows.
 *
 * #3880 compares the codex composer whole, but the windows used to FIND it are
 * still the old ones — the last twelve drawn rows (marker reader) and the last
 * four blank-row-delimited blocks (`extractComposerText`). The independent
 * review of #3880 A2 named two frames that slip past them:
 *
 *   1. a one-line paragraph, a blank line, then a 20-line paragraph: the
 *      extractor finds the composer, but its `›` row is above the twelve-row
 *      window, so the marker reader saw no input line — the paste check said
 *      `unseen` while the post-Enter check said `submitted` for the same frame;
 *   2. many paragraphs, so the composer is not among the last four blocks: the
 *      extractor says `no_composer`, the marker reader finds the `›` row in the
 *      window, and the paste check said `landed` on its first line alone.
 *
 * Both are positive controls here (they fail on the pre-#3906 reader); the
 * negative controls pin the frames whose verdicts must not move — an idle
 * composer, the dim transcript echo of a sent body, and a composer row left
 * above a full-screen dialog (codex-live-1671).
 *
 * Frames are built like the #3880 corpus: the live codex-cli 0.160.0 capture of
 * `tests/fixtures/codex-multiline-composer-3205/tc104-raw-pane.txt` (its
 * transcript and footer), ANSI intact, with the composer rows replaced. No
 * codex is run.
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

import { execFile } from 'child_process';
import {
  sendMessageWithSubmitVerification,
  classifySubmit,
  classifyPasteLanded,
  LITERAL_SEND_MAX_BYTES,
} from '@/lib/cli-tools/submit-verified-sender';
import { extractComposerText } from '@/lib/detection/composer-text';
import { classifySendFailure } from '@/lib/session/send-attempt-state';
import { sendSpecialKeys, capturePane, clearComposerLine } from '@/lib/tmux/tmux';

const ESC = '\u001b';
const TC104 = readFileSync(
  path.resolve(__dirname, '../../fixtures/codex-multiline-composer-3205/tc104-raw-pane.txt'),
  'utf-8'
).split('\n');
const TRANSCRIPT = TC104.slice(0, 38);
const FOOTER = TC104[45];

const GLYPH = `${ESC}[1m›${ESC}[0m `;
/** The transcript echo of a sent message: codex draws its glyph dim. */
const ECHO_GLYPH = `${ESC}[1;2m› ${ESC}[0m`;
const IDLE_ROW = `${GLYPH}${ESC}[2mAsk Codex to do anything${ESC}[0m`;

function codexFrame(composerRows: string[]): string {
  return [...TRANSCRIPT, ...composerRows, '', FOOTER].join('\n');
}

const IDLE = codexFrame([IDLE_ROW]);

/** The composer rows for `body`: the glyph on its first row, a two-column indent on the rest (no wrapping needed). */
function composerRows(body: string): string[] {
  return body.split('\n').map((line, index) => (index === 0 ? GLYPH : line === '' ? '' : '  ') + line);
}

/** `count` lines, each naming its number so a missing or changed line shows. */
function numberedLines(count: number, from = 1): string {
  return Array.from({ length: count }, (_, i) => `row ${i + from}: verify the paste arrived in full`).join('\n');
}

/** `count` one-line paragraphs separated by blank lines. */
function paragraphs(count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `paragraph ${i + 1}: review the composer reader and report every finding with its file, its line and the frame that shows it`
  ).join('\n\n');
}

/** Index (in the drawn frame) of the composer's `›` row, and the first row of the twelve-row tail. */
function glyphAndWindow(frame: string): { glyph: number; windowStart: number } {
  const rows = frame.split('\n');
  return { glyph: rows.findIndex((row) => row.startsWith(GLYPH)), windowStart: rows.length - 12 };
}

// ---------------------------------------------------------------------------
// (1) one-line paragraph + blank line + 20-line paragraph
// ---------------------------------------------------------------------------

describe('Issue #3906 (1): the `›` row above the twelve-row window', () => {
  const HEAD = 'Read the list below and answer in Japanese.';
  const BODY = `${HEAD}\n\n${numberedLines(20)}`;
  const FULL = codexFrame(composerRows(BODY));

  it('the frame is the one the review named: the extractor reads one row, the `›` row is outside the window', () => {
    expect(Buffer.byteLength(BODY, 'utf8')).toBeGreaterThan(LITERAL_SEND_MAX_BYTES);
    const read = extractComposerText(FULL, 'codex');
    expect(read.state).toBe('content');
    expect(read.text).toBe(HEAD);
    const { glyph, windowStart } = glyphAndWindow(FULL);
    expect(glyph).toBeGreaterThanOrEqual(0);
    expect(glyph).toBeLessThan(windowStart);
  });

  it('whole body drawn: landed before Enter and pending after it (was unseen / submitted)', () => {
    expect(classifyPasteLanded(FULL, 'codex', BODY)).toBe('landed');
    expect(classifySubmit(FULL, 'codex', BODY)).toBe('pending');
  });

  it('the second paragraph only partly drawn: pasting, and still pending after Enter', () => {
    const partial = codexFrame(composerRows(`${HEAD}\n\n${numberedLines(14)}`));
    expect(glyphAndWindow(partial).glyph).toBeLessThan(glyphAndWindow(partial).windowStart);
    expect(classifyPasteLanded(partial, 'codex', BODY)).toBe('pasting');
    expect(classifySubmit(partial, 'codex', BODY)).toBe('pending');
  });

  it('a different second paragraph: mismatch, never landed', () => {
    const other = codexFrame(composerRows(`${HEAD}\n\n${numberedLines(20, 100)}`));
    expect(classifyPasteLanded(other, 'codex', BODY)).toBe('mismatch');
  });
});

// ---------------------------------------------------------------------------
// (2) many paragraphs: the composer is not among the last four blocks
// ---------------------------------------------------------------------------

describe('Issue #3906 (2): more paragraphs than the extractor searches', () => {
  const BODY = paragraphs(5);
  const FULL = codexFrame(composerRows(BODY));

  it('the frame is the one the review named: no composer for the extractor, the `›` row inside the window', () => {
    expect(Buffer.byteLength(BODY, 'utf8')).toBeGreaterThan(LITERAL_SEND_MAX_BYTES);
    expect(extractComposerText(FULL, 'codex').state).toBe('no_composer');
    const { glyph, windowStart } = glyphAndWindow(FULL);
    expect(glyph).toBeGreaterThanOrEqual(windowStart);
  });

  it('only the first paragraphs drawn: pasting, not landed on the first line (was landed)', () => {
    const partial = codexFrame(composerRows(paragraphs(4)));
    expect(extractComposerText(partial, 'codex').state).toBe('no_composer');
    expect(classifyPasteLanded(partial, 'codex', BODY)).toBe('pasting');
    expect(classifySubmit(partial, 'codex', BODY)).toBe('pending');
  });

  it('only the first line drawn, under four other blocks of transcript: not landed', () => {
    const head = BODY.split('\n')[0];
    const frame = [
      ...TRANSCRIPT,
      composerRows(head)[0],
      '',
      '  stray block one',
      '',
      '  stray block two',
      '',
      '  stray block three',
      '',
      FOOTER,
    ].join('\n');
    expect(extractComposerText(frame, 'codex').state).toBe('no_composer');
    expect(classifyPasteLanded(frame, 'codex', BODY)).not.toBe('landed');
  });

  it('whole body drawn: landed before Enter and pending after it', () => {
    expect(classifyPasteLanded(FULL, 'codex', BODY)).toBe('landed');
    expect(classifySubmit(FULL, 'codex', BODY)).toBe('pending');
  });

  it('a different last paragraph: mismatch, never landed', () => {
    const other = codexFrame(composerRows(BODY.replace('paragraph 5', 'PARAGRAPH 5')));
    expect(classifyPasteLanded(other, 'codex', BODY)).toBe('mismatch');
  });
});

describe('Issue #3906 (1)+(2): many paragraphs AND the `›` row above the window', () => {
  const BODY = paragraphs(9);
  const FULL = codexFrame(composerRows(BODY));

  it('neither bounded reader reaches the composer', () => {
    expect(extractComposerText(FULL, 'codex').state).toBe('no_composer');
    const { glyph, windowStart } = glyphAndWindow(FULL);
    expect(glyph).toBeLessThan(windowStart);
  });

  it('whole body drawn: landed / pending (was unseen / submitted)', () => {
    expect(classifyPasteLanded(FULL, 'codex', BODY)).toBe('landed');
    expect(classifySubmit(FULL, 'codex', BODY)).toBe('pending');
  });

  it('partly drawn: pasting / pending', () => {
    const partial = codexFrame(composerRows(paragraphs(7)));
    expect(classifyPasteLanded(partial, 'codex', BODY)).toBe('pasting');
    expect(classifySubmit(partial, 'codex', BODY)).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Negative controls: verdicts that must not move
// ---------------------------------------------------------------------------

describe('Issue #3906: frames whose verdicts are unchanged', () => {
  const BODY = paragraphs(9);

  it('idle composer: unseen / submitted', () => {
    expect(classifyPasteLanded(IDLE, 'codex', BODY)).toBe('unseen');
    expect(classifySubmit(IDLE, 'codex', BODY)).toBe('submitted');
  });

  it('the dim transcript echo of the sent body above an idle composer: unseen / submitted', () => {
    const echo = BODY.split('\n').map((line, i) => (i === 0 ? ECHO_GLYPH : line === '' ? '' : '  ') + line);
    const frame = [...TRANSCRIPT, ...echo, '', IDLE_ROW, '', FOOTER].join('\n');
    expect(classifyPasteLanded(frame, 'codex', BODY)).toBe('unseen');
    expect(classifySubmit(frame, 'codex', BODY)).toBe('submitted');
  });

  it('the dim transcript echo with no composer drawn: unseen / submitted (the echo is not a composer)', () => {
    const echo = BODY.split('\n').map((line, i) => (i === 0 ? ECHO_GLYPH : line === '' ? '' : '  ') + line);
    const frame = [...TRANSCRIPT, ...echo, '', FOOTER].join('\n');
    expect(classifyPasteLanded(frame, 'codex', BODY)).toBe('unseen');
    expect(classifySubmit(frame, 'codex', BODY)).toBe('submitted');
  });

  it('a composer row left above an approval dialog stays unread: unseen / submitted', () => {
    const frame = [
      ...TRANSCRIPT,
      `${GLYPH}echo left before the dialog`,
      '',
      'Would you like to run the following command?',
      '',
      '  $ npm run build',
      '',
      `${ESC}[1m${ESC}[38;5;6m› 1. Yes, proceed (y)${ESC}[0m`,
      '  2. No, and tell Codex what to do differently (esc)',
      '',
      'Press enter to confirm or esc to cancel',
    ].join('\n');
    expect(extractComposerText(frame, 'codex').state).toBe('no_composer');
    expect(classifyPasteLanded(frame, 'codex', BODY)).toBe('unseen');
    expect(classifySubmit(frame, 'codex', BODY)).toBe('submitted');
  });
});

// ---------------------------------------------------------------------------
// The whole send
// ---------------------------------------------------------------------------

const enterCount = (): number =>
  vi.mocked(sendSpecialKeys).mock.calls.filter((c) => Array.isArray(c[1]) && c[1][0] === 'Enter').length;

function scriptPane(beforeEnter: string, afterEnter: string): void {
  vi.mocked(capturePane).mockImplementation((async (_session: string, arg?: unknown) => {
    if (typeof arg === 'number') return IDLE;
    return enterCount() > 0 ? afterEnter : beforeEnter;
  }) as never);
}

async function send(message: string): Promise<unknown> {
  const p = sendMessageWithSubmitVerification({ sessionName: 'mcbd-codex-3906', message, cliToolId: 'codex' });
  const settled = p.then(() => null, (error: unknown) => error);
  await vi.runAllTimersAsync();
  return settled;
}

describe('Issue #3906: sending the review frames to codex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null) => void
    ) => {
      queueMicrotask(() => callback(null));
      return { stdin: { end: () => undefined } };
    }) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['(1) one-line paragraph + 20-line paragraph', `Read the list below.\n\n${numberedLines(20)}`],
    ['(2) five paragraphs', paragraphs(5)],
    ['(1)+(2) nine paragraphs', paragraphs(9)],
  ])('%s, drawn in full: one Enter, sent', async (_name, body) => {
    scriptPane(codexFrame(composerRows(body)), IDLE);
    expect(await send(body)).toBeNull();
    expect(enterCount()).toBe(1);
  });

  it('(2) only the first paragraphs ever drawn: fails before Enter, indeterminate', async () => {
    const body = paragraphs(5);
    scriptPane(codexFrame(composerRows(paragraphs(4))), IDLE);
    const error = await send(body);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/had not finished arriving/);
    expect(enterCount()).toBe(0);
    expect(classifySendFailure(new Error(`Failed to send message to Codex: ${(error as Error).message}`))).toEqual({
      state: 'indeterminate',
      reason: 'body-not-landed',
    });
  });
});

describe('Issue #3906: a typed body of many short paragraphs (awaitTypedBody)', () => {
  const BODY = ['a', 'b', 'c', 'd', 'e'].map((p) => `paragraph ${p}: short`).join('\n\n');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function sendTyped(message: string): Promise<unknown> {
    const p = sendMessageWithSubmitVerification({
      sessionName: 'mcbd-codex-3906-typed',
      message,
      cliToolId: 'codex',
      awaitTypedBody: true,
      typedBodyAttempts: 5,
    });
    const settled = p.then(() => null, (error: unknown) => error);
    await vi.runAllTimersAsync();
    return settled;
  }

  it('is typed, and the extractor cannot reach its composer', () => {
    expect(Buffer.byteLength(BODY, 'utf8')).toBeLessThanOrEqual(LITERAL_SEND_MAX_BYTES);
    expect(extractComposerText(codexFrame(composerRows(BODY)), 'codex').state).toBe('no_composer');
  });

  it('drawn in full: Enter is pressed once and the send succeeds (was typed-body-not-landed)', async () => {
    scriptPane(codexFrame(composerRows(BODY)), IDLE);
    expect(await sendTyped(BODY)).toBeNull();
    expect(enterCount()).toBe(1);
  });

  it('only four of the five paragraphs drawn: fails before Enter', async () => {
    scriptPane(codexFrame(composerRows(BODY.split('\n\n').slice(0, 4).join('\n\n'))), IDLE);
    const error = await sendTyped(BODY);
    expect(error).toBeInstanceOf(Error);
    expect(enterCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Re-review (整合性レビュー 1 回目): the four conditions, each as a pair
// ---------------------------------------------------------------------------

const APPROVAL_DIALOG = [
  'Would you like to run the following command?',
  '',
  '  $ npm run build',
  '',
  `${ESC}[1m${ESC}[38;5;6m› 1. Yes, proceed (y)${ESC}[0m`,
  '  2. No, and tell Codex what to do differently (esc)',
  '',
  'Press enter to confirm or esc to cancel',
];

describe('Issue #3906 re-review (1): a dialog at the bottom wins over a composer row above the window', () => {
  const BODY = paragraphs(9);
  /** The body's own rows (first line included) above the window, an approval dialog at the bottom. */
  const DIALOG_FRAME = [...TRANSCRIPT, ...composerRows(BODY), '', ...APPROVAL_DIALOG].join('\n');

  it('the frame: the old composer row is above the window and holds the body\'s first line', () => {
    const { glyph, windowStart } = glyphAndWindow(DIALOG_FRAME);
    expect(glyph).toBeGreaterThanOrEqual(0);
    expect(glyph).toBeLessThan(windowStart);
    expect(extractComposerText(DIALOG_FRAME, 'codex').state).toBe('no_composer');
  });

  it('positive: not pending (no Enter into the dialog) — submitted / unseen', () => {
    expect(classifySubmit(DIALOG_FRAME, 'codex', BODY)).toBe('submitted');
    expect(classifyPasteLanded(DIALOG_FRAME, 'codex', BODY)).toBe('unseen');
  });

  it('positive: the live codex 0.157 approval frame, its echo row matching the body, is not pending', () => {
    const frame = readFileSync(path.resolve(__dirname, '../../fixtures/codex-dialogs-0157/approval.txt'), 'utf-8');
    expect(classifySubmit(frame, 'codex', 'Run the shell command: touch probe.txt')).toBe('submitted');
  });

  it('negative: the same rows with the composer at the bottom (no dialog) are still pending', () => {
    expect(classifySubmit(codexFrame(composerRows(BODY)), 'codex', BODY)).toBe('pending');
  });
});

describe('Issue #3906 re-review (2): a composer above the window that is not the body is not submitted', () => {
  const BODY = `/review the composer reader\n\n${paragraphs(8)}`;
  const REPLACED = codexFrame(composerRows(`/teamwork-preview the composer reader\n\n${paragraphs(8)}`));
  const OTHER = codexFrame(composerRows(`something else typed here\n\n${paragraphs(8)}`));

  it('the frames: the `›` row is above the window and the extractor finds no composer', () => {
    for (const frame of [REPLACED, OTHER]) {
      const { glyph, windowStart } = glyphAndWindow(frame);
      expect(glyph).toBeLessThan(windowStart);
      expect(extractComposerText(frame, 'codex').state).toBe('no_composer');
    }
  });

  it('positive: a different `/…` command there is replaced (was submitted)', () => {
    expect(classifySubmit(REPLACED, 'codex', BODY)).toBe('replaced');
  });

  it('positive: other text there is indeterminate (was submitted)', () => {
    expect(classifySubmit(OTHER, 'codex', BODY)).toBe('indeterminate');
  });

  it('positive: the extractor-found composer above the window, holding other text, is indeterminate', () => {
    const frame = codexFrame(composerRows(`something else typed here\n\n${numberedLines(20)}`));
    expect(extractComposerText(frame, 'codex').state).toBe('content');
    expect(glyphAndWindow(frame).glyph).toBeLessThan(glyphAndWindow(frame).windowStart);
    expect(classifySubmit(frame, 'codex', `Read the list below.\n\n${numberedLines(20)}`)).toBe('indeterminate');
  });

  it('negative: an empty composer above the window (placeholder only) is still submitted', () => {
    const frame = [...TRANSCRIPT, IDLE_ROW, '', ...paragraphs(8).split('\n').map((l) => (l === '' ? '' : `  ${l}`)), '', FOOTER].join('\n');
    expect(classifySubmit(frame, 'codex', BODY)).toBe('submitted');
  });

  it('negative: the composer gone under an approval dialog is still submitted', () => {
    const frame = [...TRANSCRIPT, `${GLYPH}echo left before the dialog`, '', ...APPROVAL_DIALOG].join('\n');
    expect(classifySubmit(frame, 'codex', BODY)).toBe('submitted');
  });
});

describe('Issue #3906 re-review (1)(2): the whole send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null) => void
    ) => {
      queueMicrotask(() => callback(null));
      return { stdin: { end: () => undefined } };
    }) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('(1) positive: an approval dialog right after Enter, the body rows above it: one Enter, sent', async () => {
    const body = paragraphs(9);
    const dialog = [...TRANSCRIPT, ...composerRows(body), '', ...APPROVAL_DIALOG].join('\n');
    scriptPane(codexFrame(composerRows(body)), dialog);
    expect(await send(body)).toBeNull();
    expect(enterCount()).toBe(1);
  });

  it('(2) positive: replaced above the window after Enter: throws replaced, no second Enter', async () => {
    const body = `/review the composer reader\n\n${paragraphs(8)}`;
    scriptPane(
      codexFrame(composerRows(body)),
      codexFrame(composerRows(`/teamwork-preview the composer reader\n\n${paragraphs(8)}`))
    );
    const error = await send(body);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/replaced by a TUI autocompletion/);
    expect(enterCount()).toBe(1);
  });

  it('(2) positive: other text above the window after Enter: never success, no further Enter, indeterminate', async () => {
    const body = paragraphs(9);
    scriptPane(codexFrame(composerRows(body)), codexFrame(composerRows(`something else typed here\n\n${paragraphs(8)}`)));
    const error = await send(body);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/submit could not be confirmed/);
    expect(enterCount()).toBe(1);
    expect(classifySendFailure(new Error(`Failed to send message to Codex: ${(error as Error).message}`))).toEqual({
      state: 'indeterminate',
      reason: 'submit-unconfirmed',
    });
  });

  it('(2) negative: the composer gone under an approval dialog after Enter: one Enter, sent', async () => {
    const body = paragraphs(9);
    const dialog = [...TRANSCRIPT, `${GLYPH}echo left before the dialog`, '', ...APPROVAL_DIALOG].join('\n');
    scriptPane(codexFrame(composerRows(body)), dialog);
    expect(await send(body)).toBeNull();
    expect(enterCount()).toBe(1);
  });
});

describe('Issue #3906 re-review (3): a short typed body must show in full', () => {
  const BODY = ['a', 'b', 'c', 'd', 'e'].map((p) => `paragraph ${p}: short`).join('\n\n');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function sendTyped(message: string): Promise<unknown> {
    const p = sendMessageWithSubmitVerification({
      sessionName: 'mcbd-codex-3906-typed-full',
      message,
      cliToolId: 'codex',
      awaitTypedBody: true,
      typedBodyAttempts: 5,
    });
    const settled = p.then(() => null, (error: unknown) => error);
    await vi.runAllTimersAsync();
    return settled;
  }

  it('the frame: the extractor reads the first paragraph, which is all that is drawn', () => {
    const frame = codexFrame(composerRows('paragraph a: short'));
    const read = extractComposerText(frame, 'codex');
    expect(read).toEqual({ state: 'content', text: 'paragraph a: short' });
  });

  it('positive: only the first paragraph drawn — not landed, no Enter (was landed on the first paragraph)', async () => {
    scriptPane(codexFrame(composerRows('paragraph a: short')), IDLE);
    const error = await sendTyped(BODY);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/did not appear in the composer/);
    expect(enterCount()).toBe(0);
  });

  it('negative: all five paragraphs drawn — landed, one Enter', async () => {
    scriptPane(codexFrame(composerRows(BODY)), IDLE);
    expect(await sendTyped(BODY)).toBeNull();
    expect(enterCount()).toBe(1);
  });

  it('negative: a one-paragraph body drawn — landed, one Enter', async () => {
    scriptPane(codexFrame(composerRows('paragraph a: short')), IDLE);
    expect(await sendTyped('paragraph a: short')).toBeNull();
    expect(enterCount()).toBe(1);
  });
});

describe('Issue #3906 re-review (4): the withdrawal clears what the sender read as pasting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null) => void
    ) => {
      queueMicrotask(() => callback(null));
      return { stdin: { end: () => undefined } };
    }) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('positive: four of five paragraphs ever drawn — the withdrawal sends clear keys (was none)', async () => {
    const body = paragraphs(5);
    const partial = codexFrame(composerRows(paragraphs(4)));
    // The clear reads with a numeric capture length: its first read (the
    // pre-send clear) sees an idle composer, the withdrawal's reads see the
    // partial body until a clear pass has gone out. The paste check sees it too.
    let clearReads = 0;
    vi.mocked(capturePane).mockImplementation((async (_session: string, arg?: unknown) => {
      if (typeof arg !== 'number') return partial;
      clearReads++;
      if (clearReads === 1) return IDLE;
      return vi.mocked(clearComposerLine).mock.calls.length > 0 ? IDLE : partial;
    }) as never);
    const error = await send(body);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/had not finished arriving/);
    expect(enterCount()).toBe(0);
    expect(vi.mocked(clearComposerLine)).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Re-review 2: the extractor's multi-row branch follows the same two rules
// ---------------------------------------------------------------------------

describe('Issue #3906 re-review 2 (1): a dialog below a multi-row composer the extractor finds', () => {
  const BODY = numberedLines(3);
  /** The old composer is the 2nd block from the bottom; the dialog's option block is the last. */
  const DIALOG_FRAME = [
    ...TRANSCRIPT,
    ...composerRows(BODY),
    '',
    `${ESC}[1m${ESC}[38;5;6m› 1. Yes, proceed (y)${ESC}[0m`,
    '  2. No, and tell Codex what to do differently (esc)',
  ].join('\n');
  const LIVE_FRAME = codexFrame(composerRows(BODY));

  it('the frame: the extractor reads the old composer as multi-row content', () => {
    const read = extractComposerText(DIALOG_FRAME, 'codex');
    expect(read.state).toBe('content');
    expect(read.text).toContain('\n');
  });

  it('positive: not pending, not landed — submitted / unseen (was pending / landed)', () => {
    expect(classifySubmit(DIALOG_FRAME, 'codex', BODY)).toBe('submitted');
    expect(classifyPasteLanded(DIALOG_FRAME, 'codex', BODY)).toBe('unseen');
  });

  it('negative: the same rows as the live composer at the bottom are still pending / landed', () => {
    expect(classifySubmit(LIVE_FRAME, 'codex', BODY)).toBe('pending');
    expect(classifyPasteLanded(LIVE_FRAME, 'codex', BODY)).toBe('landed');
  });
});

describe('Issue #3906 re-review 2 (2): a 20-row composer with no blank line, `›` above the window', () => {
  const BODY = numberedLines(20);
  const OTHER = codexFrame(composerRows(`something else typed here\n${numberedLines(19, 2)}`));
  const SAME = codexFrame(composerRows(BODY));

  it('the frames: the extractor reads multi-row content, the `›` row is above the window', () => {
    for (const frame of [OTHER, SAME]) {
      const read = extractComposerText(frame, 'codex');
      expect(read.state).toBe('content');
      expect(read.text).toContain('\n');
      expect(glyphAndWindow(frame).glyph).toBeLessThan(glyphAndWindow(frame).windowStart);
    }
  });

  it('positive: a first line that is not the body is indeterminate (was submitted)', () => {
    expect(classifySubmit(OTHER, 'codex', BODY)).toBe('indeterminate');
  });

  it('negative: the body itself is still pending', () => {
    expect(classifySubmit(SAME, 'codex', BODY)).toBe('pending');
  });
});
