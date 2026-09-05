/**
 * Issue #2317 Phase A — the tmux session name, in `ls --json` and `instances`.
 *
 * Before this, the name was the one thing an operator needed and no command
 * printed: `mcbd-<tool>-<worktree>[-<suffix>]` had to be assembled from a naming
 * rule, the worktree's default agent, and the instance roster's suffix rule —
 * three facts spread across two commands and a docs page.
 *
 * Both surfaces derive the name from {@link resolveSessionName}, which is the
 * same function `BaseCLITool.getSessionName()` delegates to. That is the point:
 * a name printed here that the server would not open is worse than no name.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchResponse, mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { resolveSessionName } from '@/lib/cli-tools/session-name';

const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

afterEach(() => {
  restoreFetch();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  mockExit.mockClear();
});

function lastLogged(): string {
  return String(mockConsoleLog.mock.calls[mockConsoleLog.mock.calls.length - 1][0]);
}

describe('ls --json', () => {
  async function runLs(argv: string[]): Promise<void> {
    const { createLsCommand } = await import('@/cli/commands/ls');
    await createLsCommand().parseAsync(['node', 'ls', ...argv]);
  }

  it('names the session `commandmate attach <id>` would open', async () => {
    mockFetchResponse({
      worktrees: [
        { id: 'wt1', name: 'wt1', cliToolId: 'claude', isSessionRunning: true },
        { id: 'wt2', name: 'wt2', cliToolId: 'codex' },
      ],
    });

    await runLs(['--json']);

    const rows = JSON.parse(lastLogged());
    expect(rows[0].tmuxSession).toBe(resolveSessionName('claude', 'wt1'));
    expect(rows[0].tmuxSession).toBe('mcbd-claude-wt1');
    expect(rows[1].tmuxSession).toBe('mcbd-codex-wt2');
  });

  it('says null rather than guessing when there is no default agent', async () => {
    mockFetchResponse({ worktrees: [{ id: 'wt1', name: 'wt1' }] });
    await runLs(['--json']);
    expect(JSON.parse(lastLogged())[0].tmuxSession).toBeNull();
  });

  it('says null for an agent this CLI does not know', async () => {
    // A server newer than the CLI. A name assembled from an unknown tool id
    // would be a name that opens nothing.
    mockFetchResponse({ worktrees: [{ id: 'wt1', name: 'wt1', cliToolId: 'future-agent' }] });
    await runLs(['--json']);
    expect(JSON.parse(lastLogged())[0].tmuxSession).toBeNull();
  });

  it('passes every field the server sent through unchanged', async () => {
    // #1926's evidence fields ride inside `sessionStatusByCli`, and the
    // orchestrate-monitor recipe reads them. Appending a key must not disturb
    // anything already there.
    mockFetchResponse({
      worktrees: [
        {
          id: 'wt1',
          name: 'wt1',
          cliToolId: 'claude',
          sessionStatusByCli: {
            claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false, statusEvidence: 'positive' },
          },
        },
      ],
    });

    await runLs(['--json']);

    const row = JSON.parse(lastLogged())[0];
    expect(row.sessionStatusByCli.claude.statusEvidence).toBe('positive');
    expect(row.id).toBe('wt1');
  });

  it('leaves the table and --quiet exactly as they were', async () => {
    mockFetchResponse({
      worktrees: [{ id: 'wt1', name: 'wt1', cliToolId: 'claude', isSessionRunning: true }],
    });
    await runLs([]);
    // Five columns, not six: the Issue lets the table stay narrow and puts the
    // name in `--json` and in `instances`.
    expect(lastLogged().split('\n')[0].trim().split(/\s+/)).toEqual([
      'ID', 'NAME', 'STATUS', 'REASON', 'DEFAULT',
    ]);
    expect(lastLogged()).not.toContain('mcbd-');
  });
});

describe('instances', () => {
  async function runInstances(argv: string[]): Promise<void> {
    const { createInstancesCommand } = await import('@/cli/commands/instances');
    await createInstancesCommand().parseAsync(['node', 'instances', ...argv]);
  }

  /** GET agent-instances, then one GET current-output per instance. */
  function mockRoster(): void {
    mockFetchSequence([
      {
        data: {
          agentInstances: [
            { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
            { id: 'codex-2', cliTool: 'codex', alias: 'Reviewer', order: 1 },
          ],
        },
      },
      { data: { isRunning: true, autoYes: { enabled: false } } },
      { data: { isRunning: false, autoYes: { enabled: false } } },
    ]);
  }

  it('names each instance\'s session in --json', async () => {
    mockRoster();
    await runInstances(['wt1', '--json']);

    const rows = JSON.parse(lastLogged());
    expect(rows[0].tmuxSession).toBe('mcbd-claude-wt1');
    // The suffix rule: an alias instance drops the tool prefix from its id.
    expect(rows[1].tmuxSession).toBe(resolveSessionName('codex', 'wt1', 'codex-2'));
    expect(rows[1].tmuxSession).toBe('mcbd-codex-wt1-2');
  });

  it('appends a TMUX_SESSION column rather than inserting one', async () => {
    // Anything reading this table by column position keeps working — the same
    // rule #1785 and #2038 followed.
    mockRoster();
    await runInstances(['wt1']);

    const [header, , ...rows] = lastLogged().split('\n');
    const columns = header.trim().split(/\s+/);
    expect(columns).toEqual([
      'INSTANCE_ID', 'ALIAS', 'CLI_TOOL', 'RUNNING', 'AUTO_YES',
      'MODEL', 'EFFORT', 'SESSION_ID', 'SESSION_TITLE', 'TMUX_SESSION',
    ]);
    expect(rows[0]).toContain('mcbd-claude-wt1');
    expect(rows[1]).toContain('mcbd-codex-wt1-2');
  });
});
