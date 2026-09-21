/**
 * `commandmate ls` and `commandmate peers` stop printing `running` for a frame
 * no rule could read (Issue #2775).
 *
 * The rows are built from the REAL `detectWorktreeSessionStatus`, with only the
 * tmux edges and the detector's verdict stubbed, so this pins the whole chain
 * the CLI sees: detector floor → helper projection → list row → STATUS word. A
 * hand-written row would keep passing after the helper went back to publishing
 * `isProcessing: true`.
 *
 * The STATUS vocabulary is deliberately NOT widened (the Issue forbids it, and
 * operators read the table positionally): an unclassified session prints
 * `ready`, and the REASON beside it names the floor with `(no evidence)`.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (cliToolId: string) => ({
        getSessionName: (worktreeId: string) => `${cliToolId}-${worktreeId}`,
        name: cliToolId,
      }),
    }),
  },
}));

vi.mock('@/lib/cli-tools/types', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/cli-tools/types')>();
  return { ...original, CLI_TOOL_IDS: ['codex'] as readonly CLIToolType[] };
});

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue('frame'),
  publishSessionSurface: vi.fn().mockResolvedValue(undefined),
  forgetSessionSurface: vi.fn(),
}));

vi.mock('@/lib/detection/status-detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detection/status-detector')>()),
  detectSessionStatus: vi.fn(),
}));

vi.mock('@/lib/cli-tools/session-liveness', () => ({
  probeToolSessionLiveness: vi.fn().mockResolvedValue({ alive: true }),
}));

vi.mock('@/lib/cli-tools/opencode', () => ({ OPENCODE_PANE_HEIGHT: 200 }));
vi.mock('@/lib/cli-tools/gemini', () => ({ GEMINI_PANE_HEIGHT: 200 }));

vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getLastServerResponseTimestamp: vi.fn().mockReturnValue(null),
  buildCompositeKey: vi.fn((worktreeId: string, cliToolId: string) => `${worktreeId}:${cliToolId}`),
}));

import { detectWorktreeSessionStatus } from '@/lib/session/worktree-status-helper';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import { clearLastKnownStatuses, type StatusEvidence } from '@/lib/session/status-evidence';
import { buildPeerRows } from '@/cli/commands/peers';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

beforeEach(() => {
  clearLastKnownStatuses();
});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
});

/** One list row, exactly as the route spreads the helper's result into it. */
async function rowFor(status: 'running' | 'ready', reason: string, evidence: StatusEvidence) {
  vi.mocked(detectSessionStatus).mockReturnValue({
    status,
    confidence: 'high',
    reason,
    hasActivePrompt: false,
    evidence,
    promptDetection: { isPrompt: false, cleanContent: '' },
  });
  const result = await detectWorktreeSessionStatus(
    'wt-2775',
    new Set(['codex-wt-2775']),
    {} as ReturnType<typeof import('@/lib/db/db-instance').getDbInstance>,
    vi.fn().mockReturnValue([]),
    vi.fn(),
    vi.fn().mockReturnValue([]),
  );
  // Round-tripped through JSON, as the CLI receives it.
  return JSON.parse(
    JSON.stringify({
      id: 'wt-2775',
      name: 'feature/2775',
      cliToolId: 'codex',
      repositoryPath: '/repos/cm',
      repositoryName: 'cm',
      ...result,
    }),
  );
}

async function lsCells(row: unknown): Promise<string[]> {
  mockFetchResponse({ worktrees: [row], repositories: [] });
  const { createLsCommand } = await import('@/cli/commands/ls');
  await createLsCommand().parseAsync(['node', 'ls']);
  const table = mockConsoleLog.mock.calls[0][0] as string;
  return table.split('\n')[2].trim().split(/\s{2,}/);
}

function peerStatus(row: Parameters<typeof buildPeerRows>[0][number]): string {
  const rows = buildPeerRows(
    [row],
    { worktreeId: 'wt-2775', instanceId: 'codex', cliToolId: 'codex', source: 'env', sessionName: null },
    'commandmate',
  );
  return rows[0].status;
}

const FLOORS = [STATUS_REASON.DEFAULT, STATUS_REASON.UNKNOWN_FRAME, STATUS_REASON.NO_RECENT_OUTPUT];

describe('[#2775] ls / peers: an unclassified session', () => {
  it.each(FLOORS)('%s: ls prints ready, not running, and the REASON names the floor', async (reason) => {
    const row = await rowFor('running', reason, 'none');

    const [id, , status, reasonCell] = await lsCells(row);

    expect(id).toBe('wt-2775');
    expect(status).toBe('ready');
    expect(status).not.toBe('running');
    expect(reasonCell).toBe(`${reason} (no evidence)`);
  });

  it.each(FLOORS)('%s: peers prints ready, not running', async (reason) => {
    const row = await rowFor('running', reason, 'none');

    expect(peerStatus(row)).toBe('ready');
  });

  it('ls --json carries the flag where the server put it', async () => {
    const row = await rowFor('running', STATUS_REASON.DEFAULT, 'none');
    mockFetchResponse({ worktrees: [row], repositories: [] });
    const { createLsCommand } = await import('@/cli/commands/ls');
    await createLsCommand().parseAsync(['node', 'ls', '--json']);
    const [out] = JSON.parse(mockConsoleLog.mock.calls[0][0] as string);

    expect(out.isProcessing).toBe(false);
    expect(out.sessionStatusByCli.codex.isUnclassified).toBe(true);
  });
});

describe('[#2775] ls / peers: a running with positive evidence is unchanged', () => {
  it('ls still prints running with its reason', async () => {
    const row = await rowFor('running', STATUS_REASON.THINKING_INDICATOR, 'positive');

    const [, , status, reasonCell] = await lsCells(row);

    expect(status).toBe('running');
    expect(reasonCell).toBe(STATUS_REASON.THINKING_INDICATOR);
  });

  it('peers still prints running', async () => {
    const row = await rowFor('running', STATUS_REASON.THINKING_INDICATOR, 'positive');

    expect(peerStatus(row)).toBe('running');
  });
});
