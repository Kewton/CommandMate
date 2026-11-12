/**
 * `ask`'s pane fallback reads the reply from the whole frame (Issue #4315).
 *
 * The frame is the shape observed on a live 200x1000 pane (prereview
 * 2026-11-13): the reply sits at rows 304-305, and rows 310-995 are 110 spaces
 * plus a `│` left behind by a border. The squeeze keeps those rows (they are not
 * blank), so a fixed 80-line tail of the squeezed pane held only them and the
 * composer, and `ask` printed a screen of borders as the reply.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';

const FRAME = fs.readFileSync(
  path.join(process.cwd(), 'tests/fixtures/pane-border-rows-4315/claude-signal-row-305.txt'),
  'utf8'
);

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

const completedFrame = {
  isRunning: true,
  isPromptWaiting: false,
  content: 'done',
  fullOutput: 'done',
  realtimeSnippet: '',
  lineCount: 1,
  lastCapturedLine: 1,
  promptData: null,
  autoYes: { enabled: false, expiresAt: null },
  thinking: false,
  cliToolId: 'copilot',
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: false,
  sessionStatus: 'ready' as const,
};

const REQUEST = 'Issue 4315 の状況を 1 行で返して';
const OLD_REQUEST = 'Issue 4315 を実装して DONE を返して';

/** The fixture's rows, without the trailing newline. */
function rows(): string[] {
  return FRAME.replace(/\n$/, '').split('\n');
}

/** The fixture with rows put in place (0-based index → text). */
function frameWith(put: Record<number, string>): string {
  const r = rows();
  for (const [i, text] of Object.entries(put)) r[Number(i)] = text;
  return `${r.join('\n')}\n`;
}

/** Rows 991-993 (above the composer at 996) hold this ask's request and its reply. */
const NEW_TURN = { 990: `❯ ${REQUEST}`, 991: '⏺ 実装は済み、検証待ちです', 992: '' };

async function askWithPane(
  output: string,
  message = REQUEST,
  ledger: unknown[] = [],
): Promise<{ source: string; reply: string | null }> {
  mockFetchSequence([
    { data: { cliToolId: 'copilot', instanceId: 'copilot', resolvedBy: 'roster', conflict: null } },
    { data: { id: 1 }, status: 201 },
    { data: completedFrame },
    { data: ledger },
    { data: { output } },
  ]);
  const { createAskCommand } = await import('../../../../src/cli/commands/ask');
  await createAskCommand().parseAsync(['node', 'ask', 'wt1', message, '--instance', 'copilot', '--json']);
  return JSON.parse(mockConsoleLog.mock.calls[0][0] as string);
}

describe('ask: the pane fallback reads the whole frame (Issue #4315)', () => {
  it('recovers a reply drawn at row 305 above hundreds of border rows', async () => {
    const payload = await askWithPane(frameWith({ 302: `> ${REQUEST}` }));
    expect(payload.source).toBe('pane');
    expect(payload.reply).toContain('DONE: 4315 0a1b2c3d4e');
    expect(payload.reply).toContain('IMPL_COMPLETED head=0a1b2c3d4e');
    expect(payload.reply).not.toContain(REQUEST);
  });

  it('still answers source=none for a pane with nothing on it', async () => {
    const payload = await askWithPane(`${'\n'.repeat(999)}`);
    expect(payload.source).toBe('none');
    expect(payload.reply).toBeNull();
  });

  it('a frame without the reply does not gain one', async () => {
    const payload = await askWithPane(
      frameWith({ 302: `> ${REQUEST}`, 303: '⏺ working' })
    );
    expect(payload.source).toBe('pane');
    expect(payload.reply).not.toContain('DONE:');
  });
});

describe('ask: only rows drawn after this request are the reply (Issue #4315 review)', () => {
  it('takes this turn\'s reply near the end, and not the previous one at row 305', async () => {
    const payload = await askWithPane(frameWith({ 302: `> ${OLD_REQUEST}`, ...NEW_TURN }));
    expect(payload.source).toBe('pane');
    expect(payload.reply).toContain('実装は済み、検証待ちです');
    expect(payload.reply).not.toContain('DONE: 4315');
    expect(payload.reply).not.toContain('IMPL_COMPLETED');
  });

  it('finds the request whatever glyph the tool draws before it', async () => {
    for (const glyph of ['›', '>', '│ >', '']) {
      mockConsoleLog.mockClear();
      const payload = await askWithPane(frameWith({ ...NEW_TURN, 990: `${glyph} ${REQUEST}` }));
      expect(payload.reply).toContain('実装は済み、検証待ちです');
      expect(payload.reply).not.toContain('DONE: 4315');
    }
  });

  it('(a) a frame that does not show this request gives no reply', async () => {
    const payload = await askWithPane(frameWith({ 302: `> ${OLD_REQUEST}` }));
    expect(payload.source).toBe('none');
    expect(payload.reply).toBeNull();
    expect(mockConsoleError.mock.calls.flat().join('\n')).toContain('does not show this message');
  });

  it('(b) a frame with this request only above an earlier request and its reply gives no reply', async () => {
    const ledger = [
      { id: 'u0', worktreeId: 'wt1', role: 'user', content: OLD_REQUEST, timestamp: new Date(Date.now() - 600_000).toISOString(), messageType: 'normal', instanceId: 'copilot' },
    ];
    const payload = await askWithPane(frameWith({ 200: `> ${REQUEST}`, 302: `> ${OLD_REQUEST}` }), REQUEST, ledger);
    expect(payload.source).toBe('none');
    expect(payload.reply).toBeNull();
  });

  it('a short request does not match inside a word of another row', async () => {
    const payload = await askWithPane(frameWith({ 302: `> ${OLD_REQUEST}` }), 'hi');
    expect(payload.source).toBe('none');
  });

  it('skips the wrapped rest of a long request, and keeps a reply that repeats its words', async () => {
    const long = `${'x'.repeat(190)} tail-of-request`;
    const payload = await askWithPane(
      frameWith({ ...NEW_TURN, 989: `> ${long.slice(0, 190)}`, 990: '  tail-of-request', 991: 'tail-of-request' }),
      long
    );
    expect(payload.reply?.startsWith('tail-of-request')).toBe(true);
    expect(payload.reply).not.toContain('x'.repeat(40));
  });
});
