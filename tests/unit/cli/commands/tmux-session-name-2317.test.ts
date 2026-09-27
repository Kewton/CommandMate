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
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mockFetchResponse, mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { resolveSessionName } from '@/lib/cli-tools/session-name';

/** Every tmux argv `attach` runs (Issue #2867). No real tmux is ever spawned. */
const tmuxCalls = vi.hoisted(() => [] as string[][]);
vi.mock('child_process', () => ({
  spawnSync: (_cmd: string, argv: string[]) => {
    tmuxCalls.push(argv);
    return { status: 0 };
  },
}));

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

  it('names the namespaced session when the server publishes its namespace (Issue #2867)', async () => {
    mockFetchResponse({
      worktrees: [
        { id: 'wt1', name: 'wt1', cliToolId: 'claude', isSessionRunning: true },
        { id: 'wt2', name: 'wt2', cliToolId: 'codex' },
      ],
      tmuxSessionNamespace: '0a1b2c3d',
    });

    await runLs(['--json']);

    const rows = JSON.parse(lastLogged());
    expect(rows[0].tmuxSession).toBe('mcbd-0a1b2c3d-claude-wt1');
    expect(rows[1].tmuxSession).toBe('mcbd-0a1b2c3d-codex-wt2');
  });

  it('names the legacy session when the namespace is null or absent (Issue #2867)', async () => {
    // null: a server that could not initialize its namespace. Absent: a server
    // older than #2867. Both still name their sessions the legacy way.
    for (const extra of [{ tmuxSessionNamespace: null }, {}]) {
      mockFetchResponse({
        worktrees: [{ id: 'wt1', name: 'wt1', cliToolId: 'claude' }],
        ...extra,
      });
      await runLs(['--json']);
      expect(JSON.parse(lastLogged())[0].tmuxSession).toBe('mcbd-claude-wt1');
    }
  });

  it('says null rather than printing a name built from a malformed namespace', async () => {
    mockFetchResponse({
      worktrees: [{ id: 'wt1', name: 'wt1', cliToolId: 'claude' }],
      tmuxSessionNamespace: 'bad;ns',
    });
    await runLs(['--json']);
    expect(JSON.parse(lastLogged())[0].tmuxSession).toBeNull();
  });

  it('keeps the tmux session name out of the table and out of --quiet', async () => {
    mockFetchResponse({
      worktrees: [{ id: 'wt1', name: 'wt1', cliToolId: 'claude', isSessionRunning: true }],
    });
    await runLs([]);
    // What #2317 decided was that a `mcbd-<tool>-<worktree>[-<suffix>]` string —
    // as long as the id it contains, plus a prefix — does not belong in a table
    // read on an 80-column terminal; it belongs in `--json` and in `instances`.
    // That is a judgement about THIS value's width, not a freeze of the column
    // count, so Issue #2575 appending a short status word (`off` / `10:00`) is
    // compatible with it. The first five columns are what must not move: they
    // are read positionally.
    const columns = lastLogged().split('\n')[0].trim().split(/\s+/);
    expect(columns.slice(0, 5)).toEqual(['ID', 'NAME', 'STATUS', 'REASON', 'DEFAULT']);
    expect(columns[5]).toBe('AUTO_YES');
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

describe('attach (Issue #2867)', () => {
  beforeEach(() => {
    tmuxCalls.length = 0;
    delete process.env.TMUX;
  });

  async function runAttach(argv: string[]): Promise<void> {
    const { createAttachCommand } = await import('@/cli/commands/attach');
    await createAttachCommand().parseAsync(['node', 'attach', ...argv]);
  }

  function resolveTarget(cliToolId: string, instanceId = cliToolId) {
    return { data: { cliToolId, instanceId, resolvedBy: 'worktree-default', conflict: null } };
  }

  it('checks and attaches to the name the server published for the instance', async () => {
    mockFetchSequence([
      resolveTarget('claude'),
      {
        data: {
          agentInstances: [
            { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0, sessionName: 'mcbd-0a1b2c3d-claude-wt1' },
            { id: 'codex-2', cliTool: 'codex', alias: 'Codex', order: 1, sessionName: 'mcbd-0a1b2c3d-codex-wt1-2' },
          ],
        },
      },
    ]);

    await runAttach(['wt1']);

    expect(tmuxCalls).toContainEqual(['has-session', '-t', '=mcbd-0a1b2c3d-claude-wt1:']);
    expect(tmuxCalls).toContainEqual(['attach-session', '-t', '=mcbd-0a1b2c3d-claude-wt1:']);
  });

  it('uses an adopted legacy name the server published, not a namespaced one', async () => {
    mockFetchSequence([
      resolveTarget('codex', 'codex-2'),
      {
        data: {
          agentInstances: [
            { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0, sessionName: 'mcbd-0a1b2c3d-claude-wt1' },
            { id: 'codex-2', cliTool: 'codex', alias: 'Codex', order: 1, sessionName: 'mcbd-codex-wt1-2' },
          ],
        },
      },
    ]);

    await runAttach(['wt1', '--instance', 'codex-2']);

    expect(tmuxCalls).toContainEqual(['has-session', '-t', '=mcbd-codex-wt1-2:']);
  });

  it('assembles the legacy name when the server sends no sessionName (older server)', async () => {
    mockFetchSequence([
      resolveTarget('codex', 'codex-2'),
      {
        data: {
          agentInstances: [
            { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
            { id: 'codex-2', cliTool: 'codex', alias: 'Codex', order: 1 },
          ],
        },
      },
    ]);

    await runAttach(['wt1', '--instance', 'codex-2']);

    expect(tmuxCalls).toContainEqual(['has-session', '-t', '=mcbd-codex-wt1-2:']);
    expect(tmuxCalls).toContainEqual(['attach-session', '-t', '=mcbd-codex-wt1-2:']);
  });

  it('refuses a published name that would not survive validateSessionName', async () => {
    mockFetchSequence([
      resolveTarget('claude'),
      {
        data: {
          agentInstances: [
            { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0, sessionName: "x'; rm -rf ~" },
          ],
        },
      },
    ]);

    await runAttach(['wt1']);

    expect(tmuxCalls).toContainEqual(['has-session', '-t', '=mcbd-claude-wt1:']);
    expect(tmuxCalls.flat().join(' ')).not.toContain('rm -rf');
  });
});
