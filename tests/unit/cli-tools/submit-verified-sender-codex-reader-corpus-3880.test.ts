/**
 * Issue #3880 (H-2): one corpus of codex composers through every reader of a send.
 *
 * A send reads the codex composer three times, and they used to be three
 * different readers:
 *   - typed body, before Enter: `extractComposerText` (#3366);
 *   - pasted body, before Enter: `classifyPasteLanded` -> `readComposer`, the
 *     bottom-most `›` row of the last twelve drawn rows;
 *   - after Enter: `classifySubmit` -> `extractComposerText` for a multi-row
 *     codex composer (#3205), `readComposer` otherwise.
 *
 * A pasted body taller than twelve rows (20 lines, or 600 bytes wrapped in a
 * narrow pane) put its `›` row above the paste reader's window — `unseen`, so
 * the body that WAS in the composer was withdrawn and the send failed as
 * `body-not-landed` — and a continuation row starting with `>` (a Markdown
 * quote) was taken for the input line — `mismatch`. The very same frame was
 * `pending` after Enter. Those are the positive controls here: they fail on the
 * pre-#3880 reader.
 *
 * The corpus is the Issue's: Japanese / ASCII, both sides of the 512-byte
 * literal/paste boundary, multi-line, a narrow pane, the paste placeholder, and
 * a slow draw (idle frames before the body shows). Frames are built on the
 * live codex-cli 0.160.0 capture of
 * `tests/fixtures/codex-multiline-composer-3205/tc104-raw-pane.txt` (its
 * transcript above the composer and its footer), ANSI intact, with the
 * composer rows replaced — the same derivation that fixture's README records
 * for its own controls.
 *
 * A composer that never shows the body ends the send with a failure whose state
 * is `indeterminate`: "could not read it" is never collapsed into "not sent".
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
import { sendKeys, sendSpecialKeys, capturePane, clearComposerLine, clearInputLine } from '@/lib/tmux/tmux';

const ESC = '\u001b';
const TC104 = readFileSync(
  path.resolve(__dirname, '../../fixtures/codex-multiline-composer-3205/tc104-raw-pane.txt'),
  'utf-8'
).split('\n');
/** The transcript above the composer (rows 1–38 of the live frame). */
const TRANSCRIPT = TC104.slice(0, 38);
/** The model / cwd footer (row 46). */
const FOOTER = TC104[45];

const GLYPH = `${ESC}[1m›${ESC}[0m `;
const IDLE_ROW = `${GLYPH}${ESC}[2mAsk Codex to do anything${ESC}[0m`;

function codexFrame(composerRows: string[]): string {
  return [...TRANSCRIPT, ...composerRows, '', FOOTER].join('\n');
}

/** Display cells of one character: CJK and full-width forms take two. */
function cells(ch: string): number {
  return /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
}

/**
 * The composer rows codex draws for `body` in a pane `width` columns wide: the
 * glyph and its gutter on the first row, a two-column indent on the rest, each
 * line of the body wrapped at the remaining width.
 */
function composerRows(body: string, width: number): string[] {
  const usable = width - 2;
  const rows: string[] = [];
  for (const line of body.split('\n')) {
    let row = '';
    let used = 0;
    for (const ch of line) {
      if (used + cells(ch) > usable) {
        rows.push(row);
        row = '';
        used = 0;
      }
      row += ch;
      used += cells(ch);
    }
    rows.push(row);
  }
  return rows.map((row, index) => (index === 0 ? GLYPH : '  ') + row);
}

/** `count` bytes of ASCII words. */
function asciiOfBytes(count: number): string {
  const words = 'review the diff and report every finding by severity ';
  return words.repeat(Math.ceil(count / words.length)).slice(0, count).trimEnd().padEnd(count, 'x');
}

/** `chars` characters of Japanese (three UTF-8 bytes each). */
function japaneseOfChars(chars: number): string {
  const text = 'この差分をレビューして指摘を重要度の順に報告してください';
  return text.repeat(Math.ceil(chars / text.length)).slice(0, chars);
}

interface CorpusEntry {
  name: string;
  body: string;
  /** Pane width the composer is drawn at (production is 200). */
  width: number;
  /** codex collapsed the paste into this placeholder instead of drawing it. */
  placeholder?: string;
}

const MULTILINE_20 = Array.from({ length: 20 }, (_, i) => `line ${i + 1}: check src/lib/module-${i}.ts for the regression`).join('\n');
const QUOTED = [
  'Please re-review the following reply from the previous round.',
  ...Array.from({ length: 8 }, (_, i) => `point ${i + 1}: the fix keeps the old behaviour for single-row composers`),
  '> the reviewer said: the final Enter is never read back',
  'answer with findings only.',
].join('\n');
const LONG_FLAT = asciiOfBytes(1200);

const CORPUS: CorpusEntry[] = [
  { name: 'ASCII, short (typed)', body: 'Review PR 3821 and report findings.', width: 200 },
  { name: 'Japanese, short (typed)', body: japaneseOfChars(120), width: 200 },
  { name: 'ASCII, 511 bytes (typed)', body: asciiOfBytes(511), width: 200 },
  { name: 'ASCII, 513 bytes (pasted)', body: asciiOfBytes(513), width: 200 },
  { name: 'Japanese, 510 bytes (typed)', body: japaneseOfChars(170), width: 200 },
  { name: 'Japanese, 513 bytes (pasted)', body: japaneseOfChars(171), width: 200 },
  { name: 'multi-line, 20 lines (pasted)', body: MULTILINE_20, width: 200 },
  { name: 'multi-line with a > quote row (pasted)', body: QUOTED, width: 200 },
  { name: 'narrow pane, ASCII 600 bytes (pasted)', body: asciiOfBytes(600), width: 40 },
  { name: 'narrow pane, Japanese 600 bytes (pasted)', body: japaneseOfChars(200), width: 40 },
  { name: 'narrow pane, Japanese 300 bytes (typed)', body: japaneseOfChars(100), width: 40 },
  {
    name: 'placeholder (pasted)',
    body: LONG_FLAT,
    width: 200,
    placeholder: `${GLYPH}${ESC}[38;5;6m[Pasted Content ${LONG_FLAT.length} chars]${ESC}[39m`,
  },
];

function drawn(entry: CorpusEntry): string {
  return codexFrame(entry.placeholder !== undefined ? [entry.placeholder] : composerRows(entry.body, entry.width));
}

const IDLE = codexFrame([IDLE_ROW]);
const isPasted = (entry: CorpusEntry): boolean => Buffer.byteLength(entry.body, 'utf8') > LITERAL_SEND_MAX_BYTES;

describe('Issue #3880 H-2: codex composer corpus', () => {
  it('the corpus straddles the 512-byte boundary on both scripts', () => {
    const bytes = (name: string): number =>
      Buffer.byteLength(CORPUS.find((e) => e.name.startsWith(name))!.body, 'utf8');
    expect(bytes('ASCII, 511')).toBe(511);
    expect(bytes('ASCII, 513')).toBe(513);
    expect(bytes('Japanese, 510')).toBe(510);
    expect(bytes('Japanese, 513')).toBe(513);
    // The positive controls put the `›` row above the twelve-row tail (composer +
    // blank row + footer) the old paste reader read.
    for (const name of ['multi-line, 20', 'narrow pane, ASCII', 'narrow pane, Japanese 600']) {
      const entry = CORPUS.find((e) => e.name.startsWith(name))!;
      expect(composerRows(entry.body, entry.width).length + 2).toBeGreaterThan(12);
    }
  });

  describe.each(CORPUS)('$name', (entry) => {
    it('body drawn: the paste reader and the post-Enter reader both see it in the composer', () => {
      const frame = drawn(entry);
      expect(classifyPasteLanded(frame, 'codex', entry.body)).toBe('landed');
      expect(classifySubmit(frame, 'codex', entry.body)).toBe('pending');
    });

    it('nothing drawn yet: both readers see an idle composer', () => {
      expect(classifyPasteLanded(IDLE, 'codex', entry.body)).toBe('unseen');
      expect(classifySubmit(IDLE, 'codex', entry.body)).toBe('submitted');
    });

    it.runIf(!isPasted(entry))('typed body drawn: the typed reader reads exactly the body', () => {
      const read = extractComposerText(drawn(entry), 'codex');
      expect(read.state).toBe('content');
      expect(read.text.replace(/\s+/g, '')).toBe(entry.body.replace(/\s+/g, ''));
    });
  });

  it('a pasted fragment from inside the body is still a mismatch on the multi-row reader', () => {
    const tail = MULTILINE_20.split('\n').slice(5).join('\n');
    expect(classifyPasteLanded(codexFrame(composerRows(tail, 200)), 'codex', MULTILINE_20)).toBe('mismatch');
  });

  it('a placeholder with typed text under it is a mismatch, not landed', () => {
    const frame = codexFrame([CORPUS[CORPUS.length - 1].placeholder!, '  stray residual']);
    expect(classifyPasteLanded(frame, 'codex', LONG_FLAT)).toBe('mismatch');
  });
});

// ---------------------------------------------------------------------------
// Independent review of #3880 (P2 x3): the inputs it named, as controls
// ---------------------------------------------------------------------------

/** `count` lines, each naming its number so a missing or changed line shows. */
function numberedLines(count: number, from = 1): string {
  return Array.from({ length: count }, (_, i) => `row ${i + from}: verify the paste arrived in full`).join('\n');
}

describe('Issue #3880 review: a UI excerpt is not proof the whole body arrived', () => {
  it('more than 40 rows: the first 40 match but the rest differs -> not landed', () => {
    const body = numberedLines(50);
    const shown = `${numberedLines(40)}\n${numberedLines(10, 900)}`;
    expect(composerRows(shown, 200).length).toBeGreaterThan(40);
    expect(classifyPasteLanded(codexFrame(composerRows(shown, 200)), 'codex', body)).toBe('mismatch');
  });

  it('more than 40 rows: only the first 40 drawn -> still pasting, not landed', () => {
    const body = numberedLines(50);
    expect(classifyPasteLanded(codexFrame(composerRows(numberedLines(40), 200)), 'codex', body)).toBe('pasting');
  });

  it('more than 40 rows, all drawn -> landed', () => {
    const body = numberedLines(50);
    expect(classifyPasteLanded(codexFrame(composerRows(body, 200)), 'codex', body)).toBe('landed');
  });

  it('more than 2,000 characters: the first 2,000 match but the tail is missing -> not landed', () => {
    const body = numberedLines(60);
    expect(body.length).toBeGreaterThan(2000);
    const head = body.slice(0, 2100).split('\n').slice(0, -1).join('\n');
    expect(classifyPasteLanded(codexFrame(composerRows(head, 200)), 'codex', body)).toBe('pasting');
    expect(classifyPasteLanded(codexFrame(composerRows(body, 200)), 'codex', body)).toBe('landed');
  });

  it('only the beginning of the body drawn (no truncation involved) -> pasting, not landed', () => {
    expect(classifyPasteLanded(codexFrame(composerRows(numberedLines(5), 200)), 'codex', numberedLines(20))).toBe(
      'pasting'
    );
  });

  it('the whole body followed by stray text -> mismatch, not landed', () => {
    const body = numberedLines(20);
    expect(classifyPasteLanded(codexFrame(composerRows(`${body}\nstray residual`, 200)), 'codex', body)).toBe(
      'mismatch'
    );
  });

  it('a body with a blank line: only the paragraph before it drawn -> not landed; both drawn -> landed', () => {
    const body = `${numberedLines(10)}\n\n${numberedLines(10, 11)}`;
    const firstParagraph = codexFrame(composerRows(numberedLines(10), 200));
    // codex draws the blank line as a blank row, so the second paragraph is a block of its own.
    const both = codexFrame([...composerRows(numberedLines(10), 200), '', ...composerRows(numberedLines(10, 11), 200).map((r, i) => (i === 0 ? `  ${r.slice(GLYPH.length)}` : r))]);
    expect(classifyPasteLanded(firstParagraph, 'codex', body)).toBe('pasting');
    expect(classifyPasteLanded(both, 'codex', body)).toBe('landed');
  });

  it('send: a composer that only ever shows the first 40 of 50 rows fails before Enter', async () => {
    vi.useFakeTimers();
    try {
      vi.clearAllMocks();
      vi.mocked(execFile).mockImplementation(((_f: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) => {
        queueMicrotask(() => cb(null));
        return { stdin: { end: () => undefined } };
      }) as never);
      const partial = codexFrame(composerRows(numberedLines(40), 200));
      vi.mocked(capturePane).mockImplementation((async (_s: string, arg?: unknown) =>
        typeof arg === 'number' ? IDLE : partial) as never);

      const p = sendMessageWithSubmitVerification({ sessionName: 'mcbd-codex-40', message: numberedLines(50), cliToolId: 'codex' });
      const settled = p.then(() => null, (e: unknown) => e);
      await vi.runAllTimersAsync();
      const error = await settled;

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/had not finished arriving/);
      expect(vi.mocked(sendSpecialKeys).mock.calls.filter((c) => Array.isArray(c[1]) && c[1][0] === 'Enter')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Issue #3880 review: the body\'s own words never turn indeterminate into not-sent', () => {
  it('a failed paste whose shown first line says "prompt not ready" stays indeterminate/body-not-landed', async () => {
    vi.useFakeTimers();
    try {
      vi.clearAllMocks();
      vi.mocked(execFile).mockImplementation(((_f: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) => {
        queueMicrotask(() => cb(null));
        return { stdin: { end: () => undefined } };
      }) as never);
      const body = `prompt not ready: why does agy say this?\n${numberedLines(20)}`;
      // More than twelve rows, and only part of the body: the error quotes the composer's first row.
      const partial = codexFrame(composerRows(`prompt not ready: why does agy say this?\n${numberedLines(14)}`, 200));
      vi.mocked(capturePane).mockImplementation((async (_s: string, arg?: unknown) =>
        typeof arg === 'number' ? IDLE : partial) as never);

      const p = sendMessageWithSubmitVerification({ sessionName: 'mcbd-codex-pnr', message: body, cliToolId: 'codex' });
      const settled = p.then(() => null, (e: unknown) => e);
      await vi.runAllTimersAsync();
      const error = (await settled) as Error;

      expect(error.message).toContain('prompt not ready: why does agy say this?');
      expect(classifySendFailure(new Error(`Failed to send message to Codex: ${error.message}`))).toEqual({
        state: 'indeterminate',
        reason: 'body-not-landed',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Issue #3880 review: a placeholder quoted inside the body is the body', () => {
  const QUOTING = [
    'Codex collapses a long paste into a placeholder. Explain where this string comes from:',
    '[Pasted Content 600 chars]',
    ...Array.from({ length: 8 }, (_, i) => `step ${i + 1}: trace the composer renderer and report the file and line`),
  ].join('\n');

  it('the body is longer than one keystroke read (it goes through the paste path)', () => {
    expect(Buffer.byteLength(QUOTING, 'utf8')).toBeGreaterThan(LITERAL_SEND_MAX_BYTES);
  });

  it('drawn in full -> landed, and the post-Enter reader agrees it is in the composer', () => {
    const frame = codexFrame(composerRows(QUOTING, 200));
    expect(classifyPasteLanded(frame, 'codex', QUOTING)).toBe('landed');
    expect(classifySubmit(frame, 'codex', QUOTING)).toBe('pending');
  });

  it('a real placeholder plus extra input under it is still a mismatch', () => {
    const frame = codexFrame([`${GLYPH}${ESC}[38;5;6m[Pasted Content ${QUOTING.length} chars]${ESC}[39m`, '  extra input']);
    expect(classifyPasteLanded(frame, 'codex', QUOTING)).toBe('mismatch');
  });

  it('a real placeholder alone, counting the body, is landed', () => {
    const frame = codexFrame([`${GLYPH}${ESC}[38;5;6m[Pasted Content ${QUOTING.length} chars]${ESC}[39m`]);
    expect(classifyPasteLanded(frame, 'codex', QUOTING)).toBe('landed');
  });
});

// ---------------------------------------------------------------------------
// The whole send, on the same corpus
// ---------------------------------------------------------------------------

const SESSION = 'mcbd-codex-corpus-3880';

const enterCount = (): number =>
  vi.mocked(sendSpecialKeys).mock.calls.filter((c) => Array.isArray(c[1]) && c[1][0] === 'Enter').length;

/**
 * The pre-send clear reads with a number; the sender's own reads with
 * `{ startLine }`. Before the first Enter they return `beforeEnter[i]` (the last
 * repeats), after it `afterEnter`.
 */
function scriptPane(beforeEnter: string[], afterEnter: string): void {
  let index = 0;
  vi.mocked(capturePane).mockImplementation((async (_session: string, arg?: unknown) => {
    if (typeof arg === 'number') return IDLE;
    if (enterCount() > 0) return afterEnter;
    return beforeEnter[Math.min(index++, beforeEnter.length - 1)];
  }) as never);
}

async function send(message: string): Promise<void> {
  const p = sendMessageWithSubmitVerification({
    sessionName: SESSION,
    message,
    cliToolId: 'codex',
    awaitTypedBody: true,
  });
  const settled = p.then(() => undefined, (error: unknown) => { throw error; });
  settled.catch(() => undefined);
  await vi.runAllTimersAsync();
  return settled;
}

describe('Issue #3880 H-2: sending the corpus to codex', () => {
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
    vi.mocked(sendKeys).mockResolvedValue(undefined);
    vi.mocked(sendSpecialKeys).mockResolvedValue(undefined);
    vi.mocked(clearInputLine).mockResolvedValue(undefined);
    vi.mocked(clearComposerLine).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(CORPUS)('$name: drawn slowly (idle frames first), then sent with one Enter', async (entry) => {
    scriptPane([IDLE, IDLE, IDLE, drawn(entry)], IDLE);

    await expect(send(entry.body)).resolves.toBeUndefined();

    expect(enterCount()).toBe(1);
    expect(vi.mocked(sendKeys).mock.calls.length).toBe(isPasted(entry) ? 0 : 1);
  });

  it.each(CORPUS)('$name: never drawn -> fails before Enter, and the state is indeterminate', async (entry) => {
    scriptPane([IDLE], IDLE);

    const error = await send(entry.body).then(
      () => null,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(Error);
    expect(enterCount()).toBe(0);
    const failure = classifySendFailure(new Error(`Failed to send message to Codex: ${(error as Error).message}`));
    expect(failure).toEqual({ state: 'indeterminate', reason: 'body-not-landed' });
  });
});
