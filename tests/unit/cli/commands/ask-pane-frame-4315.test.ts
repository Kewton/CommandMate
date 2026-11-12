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

async function askWithPane(output: string): Promise<{ source: string; reply: string | null }> {
  mockFetchSequence([
    { data: { cliToolId: 'copilot', instanceId: 'copilot', resolvedBy: 'roster', conflict: null } },
    { data: { id: 1 }, status: 201 },
    { data: completedFrame },
    { data: [] },
    { data: { output } },
  ]);
  const { createAskCommand } = await import('../../../../src/cli/commands/ask');
  await createAskCommand().parseAsync(['node', 'ask', 'wt1', 'hi', '--instance', 'copilot', '--json']);
  return JSON.parse(mockConsoleLog.mock.calls[0][0] as string);
}

describe('ask: the pane fallback reads the whole frame (Issue #4315)', () => {
  it('recovers a reply drawn at row 305 above hundreds of border rows', async () => {
    const payload = await askWithPane(FRAME);
    expect(payload.source).toBe('pane');
    expect(payload.reply).toContain('DONE: 4315 0a1b2c3d4e');
    expect(payload.reply).toContain('IMPL_COMPLETED head=0a1b2c3d4e');
  });

  it('still answers source=none for a pane with nothing on it', async () => {
    const payload = await askWithPane(`${'\n'.repeat(999)}`);
    expect(payload.source).toBe('none');
    expect(payload.reply).toBeNull();
  });

  it('a frame without the reply does not gain one', async () => {
    const payload = await askWithPane(FRAME.replace('⏺ DONE: 4315 0a1b2c3d4e', '⏺ working'));
    expect(payload.source).toBe('pane');
    expect(payload.reply).not.toContain('DONE:');
  });
});
