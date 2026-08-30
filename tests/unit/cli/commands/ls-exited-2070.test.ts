/**
 * `commandmate ls`: `exited` beside `idle` (Issue #2070).
 *
 * Before this Issue a codex whose agent had crashed printed `ready` — the
 * session existed, so it was reported running. Fixing the detection alone would
 * have moved it to a bare `idle`, which is the same word a worktree nobody ever
 * started shows. The REASON cell is what keeps the two apart: `idle` means
 * "start it", `idle` + `exited` means "it died under you".
 *
 * Additive by construction — see the assertions at the bottom, which pin that
 * every pre-#2070 row prints exactly what it printed before.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';
import { STATUS_REASON } from '../../../../src/lib/detection/status-reason';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
});

async function runLs(worktrees: unknown[], args: string[] = []): Promise<string> {
  mockFetchResponse({ worktrees, repositories: [] });
  const { createLsCommand } = await import('../../../../src/cli/commands/ls');
  const cmd = createLsCommand();
  await cmd.parseAsync(['node', 'ls', ...args]);
  return mockConsoleLog.mock.calls[0][0] as string;
}

const IDLE_TOP = { isSessionRunning: false, isWaitingForResponse: false, isProcessing: false };

function idleWorktree(id: string, entry: Record<string, unknown>, cliToolId = 'codex') {
  return {
    id,
    name: id,
    cliToolId,
    ...IDLE_TOP,
    sessionStatusByCli: { [cliToolId]: entry },
  };
}

const EXITED_ENTRY = {
  isRunning: false,
  isWaitingForResponse: false,
  isProcessing: false,
  sessionStatusReason: STATUS_REASON.EXITED,
  statusEvidence: 'positive',
};

describe('[#2070] ls REASON for a session whose agent exited', () => {
  it('prints `exited` next to `idle`', async () => {
    const out = await runLs([idleWorktree('wt1', EXITED_ENTRY)]);

    const row = out.split('\n').find((l) => l.startsWith('wt1'))!;
    expect(row).toMatch(/\bidle\b/);
    expect(row).toContain('exited');
  });

  it('does not mark it `(no evidence)` — tmux was asked and the pane was read', async () => {
    const out = await runLs([idleWorktree('wt1', EXITED_ENTRY)]);
    expect(out).not.toContain('no evidence');
  });

  it('finds it on a non-default agent too', async () => {
    const out = await runLs([
      {
        id: 'wt1',
        name: 'wt1',
        cliToolId: 'claude',
        ...IDLE_TOP,
        sessionStatusByCli: {
          claude: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
          codex: EXITED_ENTRY,
        },
      },
    ]);
    expect(out.split('\n').find((l) => l.startsWith('wt1'))).toContain('exited');
  });

  it('leaves an ordinary idle row at `-`, exactly as before', async () => {
    const out = await runLs([
      idleWorktree('wt1', {
        isRunning: false,
        isWaitingForResponse: false,
        isProcessing: false,
      }),
    ]);
    const row = out.split('\n').find((l) => l.startsWith('wt1'))!;
    expect(row).toMatch(/idle\s+-/);
    expect(row).not.toContain('exited');
  });

  it('never claims `exited` for a row that is running', async () => {
    // A reason token that survived a poll cannot outvote the booleans: STATUS
    // still comes from `deriveStatus`, and only `idle` consults this reason.
    const out = await runLs([
      {
        id: 'wt1',
        name: 'wt1',
        cliToolId: 'codex',
        isSessionRunning: true,
        isWaitingForResponse: false,
        isProcessing: false,
        sessionStatusByCli: {
          codex: {
            isRunning: true,
            isWaitingForResponse: false,
            isProcessing: false,
            sessionStatusReason: 'input_prompt',
          },
        },
      },
    ]);
    const row = out.split('\n').find((l) => l.startsWith('wt1'))!;
    expect(row).toMatch(/\bready\b/);
    expect(row).toContain('input_prompt');
  });

  it('still prints `-` for a server that predates the reason fields', async () => {
    const out = await runLs([{ id: 'wt1', name: 'wt1', ...IDLE_TOP }]);
    expect(out.split('\n').find((l) => l.startsWith('wt1'))).toMatch(/idle\s+-/);
  });
});
