/**
 * `commandmate instances` shows the opencode session each instance will resume
 * (Issue #2038).
 *
 * The value the columns add is the one an operator cannot get any other way:
 * for a **stopped** opencode instance, `SESSION_ID` is what the next `send` will
 * pass to `opencode -s <id>`. Everything else on the row describes a live
 * session; this describes what happens when it is started again.
 *
 * Additive means two things and both are pinned: the table **appends**, so
 * anything reading INSTANCE_ID / ALIAS / CLI_TOOL / RUNNING / AUTO_YES / MODEL /
 * EFFORT by column index keeps working, and the extra request is made **only**
 * when the roster actually has an opencode instance — a claude-only worktree
 * pays nothing for a feature it cannot use.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

const SESSION_ID = 'ses_fc9802f88ffeZzlE5mU5cYYEFs';

const OPENCODE_ROSTER = {
  id: 'wt1',
  name: 'main',
  agentInstances: [
    { id: 'opencode', cliTool: 'opencode', alias: 'OpenCode', order: 0 },
    { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 1 },
  ],
};

const CLAUDE_ONLY_ROSTER = {
  id: 'wt1',
  name: 'main',
  agentInstances: [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }],
};

const STOPPED = { isRunning: false, autoYes: { enabled: false }, model: null, reasoningEffort: null };

async function runInstances(args: string[]): Promise<void> {
  const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
  await createInstancesCommand().parseAsync(['node', 'instances', ...args]);
}

/** Every URL the command asked for, capability probe excluded by the helper. */
function requestedUrls(): string[] {
  return vi.mocked(global.fetch).mock.calls.map(([input]) => String(input));
}

describe('instances table: SESSION_ID / SESSION_TITLE columns', () => {
  it('prints the session a stopped opencode instance will resume', async () => {
    mockFetchSequence([
      { data: OPENCODE_ROSTER },
      {
        data: {
          instances: [
            { instanceId: 'opencode', sessionId: SESSION_ID, title: 'Fix the launcher', worktreePath: '/w', updatedAt: 1, live: false },
          ],
        },
      },
      { data: STOPPED },
      { data: STOPPED },
    ]);

    await runInstances(['wt1']);

    const [header, , opencodeRow, claudeRow] = String(mockConsoleLog.mock.calls[0][0]).split('\n');
    expect(header).toContain('SESSION_ID');
    expect(header).toContain('SESSION_TITLE');
    expect(opencodeRow).toContain(SESSION_ID);
    expect(opencodeRow).toContain('Fix the launcher');
    // No other agent's launch command names a conversation, so the columns are
    // blank rather than borrowing opencode's answer.
    expect(claudeRow).not.toContain(SESSION_ID);
    expect(claudeRow).not.toContain('Fix the launcher');
  });

  it('appends the columns rather than inserting them', async () => {
    mockFetchSequence([
      { data: OPENCODE_ROSTER },
      { data: { instances: [] } },
      { data: STOPPED },
      { data: STOPPED },
    ]);

    await runInstances(['wt1']);

    const header = String(mockConsoleLog.mock.calls[0][0]).split('\n')[0];
    expect(header.trim().split(/\s+/)).toEqual([
      'INSTANCE_ID',
      'ALIAS',
      'CLI_TOOL',
      'RUNNING',
      'AUTO_YES',
      'MODEL',
      'EFFORT',
      'SESSION_ID',
      'SESSION_TITLE',
      // Issue #2317 appended one more, for the same reason.
      'TMUX_SESSION',
    ]);
  });
});

describe('instances --json: sessionId / sessionTitle fields', () => {
  it('carries both fields per row', async () => {
    mockFetchSequence([
      { data: OPENCODE_ROSTER },
      {
        data: {
          instances: [
            { instanceId: 'opencode', sessionId: SESSION_ID, title: 'Fix the launcher', worktreePath: '/w', updatedAt: 1, live: true },
          ],
        },
      },
      { data: STOPPED },
      { data: STOPPED },
    ]);

    await runInstances(['wt1', '--json']);

    const rows = JSON.parse(String(mockConsoleLog.mock.calls[0][0]));
    expect(rows[0]).toMatchObject({
      instanceId: 'opencode',
      sessionId: SESSION_ID,
      sessionTitle: 'Fix the launcher',
    });
    expect(rows[1]).toMatchObject({
      instanceId: 'claude',
      sessionId: null,
      sessionTitle: null,
    });
  });
});

describe('the extra request', () => {
  it('is made once for the whole worktree when an opencode instance exists', async () => {
    mockFetchSequence([
      { data: OPENCODE_ROSTER },
      { data: { instances: [] } },
      { data: STOPPED },
      { data: STOPPED },
    ]);

    await runInstances(['wt1']);

    const sessionRequests = requestedUrls().filter((url) => url.includes('/opencode/session'));
    expect(sessionRequests).toHaveLength(1);
  });

  it('is not made at all for a roster with no opencode instance', async () => {
    mockFetchSequence([{ data: CLAUDE_ONLY_ROSTER }, { data: STOPPED }]);

    await runInstances(['wt1']);

    expect(requestedUrls().some((url) => url.includes('/opencode/session'))).toBe(false);
    expect(String(mockConsoleLog.mock.calls[0][0])).toContain('SESSION_ID');
  });

  it('still prints the table when an older server has no such route', async () => {
    mockFetchSequence([
      { data: OPENCODE_ROSTER },
      { data: { error: 'Not Found' }, status: 404 },
      { data: STOPPED },
      { data: STOPPED },
    ]);

    await runInstances(['wt1', '--json']);

    const rows = JSON.parse(String(mockConsoleLog.mock.calls[0][0]));
    expect(rows).toHaveLength(2);
    expect(rows[0].sessionId).toBeNull();
    expect(mockExit).not.toHaveBeenCalled();
  });
});
