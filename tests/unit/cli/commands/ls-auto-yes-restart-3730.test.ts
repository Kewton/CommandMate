/**
 * `commandmate ls`: AUTO_YES says `off(restart)` for an instance the last
 * server restart released (Issue #3730).
 *
 * The list row carries the release beside `autoYesByInstance`, in
 * `autoYesStopReasonByInstance` (that map holds armed instances only). The
 * cell's own rules do not move: the instance the cell is about is still chosen
 * by #2575's rule, and only an `off` about a released instance gains the
 * suffix. One token, so the ` (<instanceId>)` after it still splits off.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

const NOW = new Date('2026-10-17T12:00:00Z').getTime();
const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
});

async function runLs(worktrees: unknown[], args: string[] = []): Promise<string> {
  mockFetchResponse({ worktrees, repositories: [] });
  const { createLsCommand } = await import('../../../../src/cli/commands/ls');
  await createLsCommand().parseAsync(['node', 'ls', ...args]);
  return mockConsoleLog.mock.calls[0][0] as string;
}

function autoYesCell(out: string, id: string): string {
  const line = out.split('\n').find((candidate) => candidate.split(/\s{2,}/)[0] === id);
  if (!line) throw new Error(`no row for ${id} in:\n${out}`);
  const cells = line.split(/\s{2,}/);
  return cells[cells.length - 1];
}

const IDLE_TOP = { isSessionRunning: false, isWaitingForResponse: false, isProcessing: false };
const WAITING_TOP = { isSessionRunning: true, isWaitingForResponse: true, isProcessing: false };
const WAITING_ENTRY = {
  isRunning: true,
  isWaitingForResponse: true,
  isProcessing: false,
  sessionStatusReason: 'prompt_detected',
  statusEvidence: 'positive',
};

function row(fields: Record<string, unknown>): Record<string, unknown> {
  return { name: 'main', cliToolId: 'claude', ...fields };
}

describe('[#3730] ls AUTO_YES after a restart', () => {
  it('a waiting instance the restart released reads off(restart)', async () => {
    const out = await runLs([
      row({
        id: 'wt-a',
        ...WAITING_TOP,
        sessionStatusByInstance: { claude: WAITING_ENTRY },
        autoYesByInstance: {},
        autoYesStopReasonByInstance: { claude: 'server-restart' },
      }),
    ]);
    expect(autoYesCell(out, 'wt-a')).toBe('off(restart)');
  });

  it('an alias keeps its instance parenthesis after the one-token value', async () => {
    const out = await runLs([
      row({
        id: 'wt-a',
        ...WAITING_TOP,
        sessionStatusByInstance: { 'claude-2': WAITING_ENTRY },
        autoYesByInstance: {},
        autoYesStopReasonByInstance: { 'claude-2': 'server-restart' },
      }),
    ]);
    expect(autoYesCell(out, 'wt-a')).toBe('off(restart) (claude-2)');
  });

  it('an idle row with nothing armed names the release, the default primary first', async () => {
    const out = await runLs([
      row({
        id: 'wt-a',
        ...IDLE_TOP,
        autoYesByInstance: {},
        autoYesStopReasonByInstance: { codex: 'server-restart', claude: 'server-restart' },
      }),
      row({
        id: 'wt-b',
        ...IDLE_TOP,
        autoYesByInstance: {},
        autoYesStopReasonByInstance: { codex: 'server-restart' },
      }),
    ]);
    expect(autoYesCell(out, 'wt-a')).toBe('off(restart)');
    expect(autoYesCell(out, 'wt-b')).toBe('off(restart) (codex)');
  });

  it('negative: an armed instance beside a released one still prints its countdown', async () => {
    const out = await runLs([
      row({
        id: 'wt-a',
        ...IDLE_TOP,
        autoYesByInstance: { claude: { enabled: true, expiresAt: NOW + 10 * MINUTE } },
        autoYesStopReasonByInstance: { 'claude-2': 'server-restart' },
      }),
    ]);
    expect(autoYesCell(out, 'wt-a')).toBe('10:00');
  });

  it.each([
    ['no release field (an older server)', {}],
    ['a release of another instance', { autoYesStopReasonByInstance: { codex: 'server-restart' } }],
    ['an unknown reason', { autoYesStopReasonByInstance: { claude: 'something-new' } }],
  ])('negative: %s — the waiting row stays plain off', async (_label, extra) => {
    const out = await runLs([
      row({
        id: 'wt-a',
        ...WAITING_TOP,
        sessionStatusByInstance: { claude: WAITING_ENTRY },
        autoYesByInstance: {},
        ...extra,
      }),
    ]);
    expect(autoYesCell(out, 'wt-a')).toBe('off');
  });

  it('--json passes the field through raw', async () => {
    mockFetchResponse({
      worktrees: [row({ id: 'wt-a', ...IDLE_TOP, autoYesByInstance: {}, autoYesStopReasonByInstance: { claude: 'server-restart' } })],
      repositories: [],
    });
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    await createLsCommand().parseAsync(['node', 'ls', '--json']);
    const parsed = JSON.parse(String(mockConsoleLog.mock.calls[0][0])) as Array<Record<string, unknown>>;
    expect(parsed[0].autoYesStopReasonByInstance).toEqual({ claude: 'server-restart' });
  });
});
