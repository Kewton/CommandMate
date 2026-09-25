/**
 * Auto-Yes's entry does not read a dialog agy's reply QUOTED as an open one
 * (Issue #2851).
 *
 * #2845 taught the status side (`detectSessionStatus`, agy's own dialog reader)
 * that a numbered list with the `>` composer drawn under its last row is the
 * model's reply, not a dialog. Auto-Yes does not go through that chain: its
 * entry is `detectPromptOnCleanFrame`, and after agy's reader answers `null` the
 * generic `detectPrompt` at the end of that function read the quoted
 * `Do you want to proceed?` and its four options as a `multiple_choice` prompt.
 * agy's rollout row in the Auto-Yes dialog gate is `legacy`, so nothing after
 * this point judges the frame again — the poller answered a dialog nobody had
 * opened.
 *
 * The quoted frames are built the way `antigravity-quoted-dialog.test.ts` builds
 * them: `idle-after-deny.txt` (the pane at its composer) with the rows of a real
 * dialog capture, indented two columns as a reply would carry them, inserted
 * right above the input box. The control group is every `dialog-*.txt` capture in
 * the same directory — a real, open dialog — which must stay a prompt.
 *
 * @vitest-environment node
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// `@/lib/logger` is pulled in transitively by `cli-patterns` while the hoisted
// vi.mock factory runs, so the mock is built inside vi.hoisted().
const mockLogger = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  };
  logger.withContext.mockReturnValue(logger);
  return logger;
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

// Module boundary mocks: the seams `response-checker` reaches for at import
// time. Nothing here is under test.
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(),
  isSessionRunning: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  createMessage: vi.fn(),
  getSessionState: vi.fn(),
  updateSessionState: vi.fn(),
  getWorktreeById: vi.fn(),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: vi.fn(() => 0),
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/conversation-logger', () => ({
  recordClaudeConversation: vi.fn(async () => {}),
}));

import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { detectPromptOnCleanFrame, detectPromptWithOptions } from '@/lib/polling/response-checker';

const DIR_2364 = path.resolve(__dirname, '../../../fixtures/antigravity-live-2364');

const FOOTER = /↑\/↓ Navigate/;

/** The rows a fixture holds, ANSI intact; the file's closing newline is not a row. */
function rowsOf(name: string): string[] {
  const rows = readFileSync(path.join(DIR_2364, name), 'utf8').split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  return rows;
}

const plain = (row: string): string => stripAnsi(row).trim();

/**
 * `idle-after-deny.txt` with rows of `source` quoted, two columns in, directly
 * above the input box — from the first row matching `from` through the first
 * row after it matching `to`. Trailing blank padding gives way row for row, so
 * the pane stays 1000 rows tall.
 */
function quoteAboveComposer(source: string, from: RegExp, to: RegExp): string {
  const base = 'idle-after-deny.txt';
  const baseRows = rowsOf(base);
  const sourceRows = rowsOf(source);

  const first = sourceRows.findIndex(row => from.test(plain(row)));
  const last = sourceRows.findIndex((row, i) => i >= first && to.test(plain(row)));
  if (first < 0 || last < 0) throw new Error(`${source} no longer holds the rows ${from} … ${to}`);
  const quoted = sourceRows.slice(first, last + 1).map(row => (row === '' ? row : `  ${row}`));

  let composerAt = -1;
  baseRows.forEach((row, i) => {
    if (/^>$/.test(plain(row))) composerAt = i;
  });
  const topRuleAt = composerAt - 1;
  if (composerAt < 0 || !/^─{3,}$/.test(plain(baseRows[topRuleAt]))) {
    throw new Error(`${base} no longer ends in a rule / bare \`>\` / rule input box`);
  }

  const rows = [...baseRows.slice(0, topRuleAt), ...quoted, ...baseRows.slice(topRuleAt)];
  for (let excess = quoted.length; excess > 0; excess--) {
    if (rows[rows.length - 1] !== '') throw new Error(`${base} has no blank padding left to give up`);
    rows.pop();
  }
  return `${rows.join('\n')}\n`;
}

/** The frame exactly as the Auto-Yes poller's `captureAndCleanOutput` hands it over. */
const asPollerSees = (raw: string): string => stripBoxDrawing(stripAnsi(raw));

/**
 * The two ways the entry is reached: the way `detectAndRespondToPrompt` calls
 * it with the same tick's capture (`rawFrame` alongside the cleaned frame), and
 * the way a caller with no raw frame does.
 */
const readings = (raw: string): Array<[string, () => ReturnType<typeof detectPromptOnCleanFrame>]> => [
  ['clean frame + raw frame (the poller)', () => detectPromptOnCleanFrame(asPollerSees(raw), 'antigravity', undefined, raw)],
  ['clean frame only', () => detectPromptOnCleanFrame(asPollerSees(raw), 'antigravity')],
  ['detectPromptWithOptions (the response poller)', () => detectPromptWithOptions(raw, 'antigravity')],
];

const QUOTED_FRAMES: Record<string, string> = {
  'the Bash approval dialog (question, four options, footer)': quoteAboveComposer(
    'dialog-bash-oneline.txt',
    /^Do you want to proceed\?$/,
    FOOTER,
  ),
  'the wrapped Bash approval dialog': quoteAboveComposer(
    'dialog-bash-wrapped.txt',
    /^Do you want to proceed\?$/,
    FOOTER,
  ),
  'the file-creation dialog': quoteAboveComposer('dialog-create-file.txt', /^Allow creation of this file\?$/, FOOTER),
};

describe('[#2851] a dialog quoted above the composer is not a prompt Auto-Yes answers', () => {
  describe.each(Object.entries(QUOTED_FRAMES))('%s', (_label, raw) => {
    it('is built as a reply above a live input box, 1000 rows tall', () => {
      const rows = stripAnsi(raw)
        .split('\n')
        .filter(row => row.trim() !== '');
      const footerAt = rows.findLastIndex(row => FOOTER.test(row));
      expect(footerAt).toBeGreaterThan(-1);
      // Under the quoted footer: the input box's rule, the bare `>`, its rule and the status row.
      expect(rows.slice(footerAt + 1).map(row => row.trim()).filter(row => !/^─+$/.test(row))).toEqual([
        '>',
        expect.stringMatching(/^\? for shortcuts/),
      ]);
      expect(raw.split('\n')).toHaveLength(1001);
    });

    it.each(readings(raw))('reads no prompt: %s', (_via, read) => {
      const result = read();

      expect(result.isPrompt).toBe(false);
      expect(result.promptData).toBeUndefined();
    });
  });
});

describe('[#2851] a real open dialog is still a prompt', () => {
  const dialogs = readdirSync(DIR_2364).filter(name => /^dialog-.*\.txt$/.test(name));

  it('covers every dialog capture the directory holds', () => {
    expect(dialogs).toEqual([
      'dialog-bash-oneline.txt',
      'dialog-bash-wrapped-highlight-4.txt',
      'dialog-bash-wrapped-six.txt',
      'dialog-bash-wrapped.txt',
      'dialog-create-file-highlight-2.txt',
      'dialog-create-file.txt',
      'dialog-feedback-category.txt',
    ]);
  });

  describe.each(dialogs)('%s', name => {
    const raw = readFileSync(path.join(DIR_2364, name), 'utf8');

    it.each(readings(raw))('is a multiple_choice prompt: %s', (_via, read) => {
      const result = read();

      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });
  });

  it('`/feedback`, whose numbered rows sit BELOW the composer, is not taken for a quotation', () => {
    const rows = stripAnsi(readFileSync(path.join(DIR_2364, 'dialog-feedback-category.txt'), 'utf8')).split('\n');
    const composerAt = rows.findLastIndex(row => /^\s*>\s*$/.test(row));
    const optionAt = rows.findIndex(row => /^\s*>?\s*1\.\s+\S/.test(row));
    expect(composerAt).toBeGreaterThan(-1);
    expect(optionAt).toBeGreaterThan(composerAt);
  });
});
