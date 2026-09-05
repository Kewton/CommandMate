/**
 * `commandmate instances` shows MODEL / EFFORT (Issue #1785).
 *
 * `instances` is the one command that answers "what is each of these workers
 * actually doing" for a whole worktree at once, which is why the model belongs
 * here and not only on `capture`. The roster already knew the *agent*
 * (`CLI_TOOL`); only the live session knows the *model inside it*, and during a
 * parallel run that is the difference between "four workers" and "four workers,
 * one of which quietly fell back to a cheaper model".
 *
 * Both surfaces are pinned because they fail differently: the table can lose a
 * column to a formatting change without the JSON noticing, and the JSON can lose
 * a key to a refactor of the row type without the table noticing.
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

/** Roster response, then one /current-output response per instance, in order. */
const ROSTER = {
  id: 'wt1',
  name: 'main',
  agentInstances: [
    { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
    { id: 'codex-2', cliTool: 'codex', alias: 'Review', order: 1 },
  ],
};

async function runInstances(args: string[]): Promise<void> {
  const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
  await createInstancesCommand().parseAsync(['node', 'instances', ...args]);
}

describe('instances table: MODEL / EFFORT columns', () => {
  it('prints the columns and the running instance\'s model', async () => {
    mockFetchSequence([
      { data: ROSTER },
      { data: { isRunning: true, autoYes: { enabled: false }, model: 'claude-opus-5[1m]', reasoningEffort: 'xhigh' } },
      { data: { isRunning: false, autoYes: { enabled: false }, model: null, reasoningEffort: null } },
    ]);

    await runInstances(['wt1']);

    const output: string = mockConsoleLog.mock.calls[0][0];
    const [header, , claudeRow, codexRow] = output.split('\n');

    expect(header).toContain('MODEL');
    expect(header).toContain('EFFORT');
    expect(claudeRow).toContain('claude-opus-5[1m]');
    expect(claudeRow).toContain('xhigh');
    // A stopped instance gets blanks, not a stale model and not a placeholder
    // the reader has to look up.
    expect(codexRow).toContain('codex-2');
    expect(codexRow).not.toContain('claude-opus-5');
    // MODEL and EFFORT are both blank for the stopped instance. The row ends
    // with Issue #2317's TMUX_SESSION column, which is derived and never blank.
    expect(codexRow.trimEnd()).toMatch(/\bno\s+no\s+mcbd-codex-wt1-2$/);
  });

  it('appends the columns rather than inserting them', async () => {
    // Requirement 3 is "additive only", and for a table that means positional:
    // anything reading INSTANCE_ID / ALIAS / CLI_TOOL / RUNNING / AUTO_YES by
    // column index must keep working.
    mockFetchSequence([
      { data: ROSTER },
      { data: { isRunning: true, autoYes: { enabled: true }, model: 'gpt-5.6-sol', reasoningEffort: null } },
      { data: { isRunning: false, autoYes: { enabled: false }, model: null, reasoningEffort: null } },
    ]);

    await runInstances(['wt1']);

    const header: string = mockConsoleLog.mock.calls[0][0].split('\n')[0];
    expect(header.trim().split(/\s+/)).toEqual([
      'INSTANCE_ID',
      'ALIAS',
      'CLI_TOOL',
      'RUNNING',
      'AUTO_YES',
      'MODEL',
      'EFFORT',
      // Issue #2038 appended two more, for the same reason and in the same way.
      'SESSION_ID',
      'SESSION_TITLE',
      // Issue #2317 appended one more, likewise.
      'TMUX_SESSION',
    ]);
  });
});

describe('instances --json: model / reasoningEffort fields', () => {
  it('carries both fields per row', async () => {
    mockFetchSequence([
      { data: ROSTER },
      { data: { isRunning: true, autoYes: { enabled: false }, model: 'claude-opus-5[1m]', reasoningEffort: 'xhigh' } },
      { data: { isRunning: false, autoYes: { enabled: false }, model: null, reasoningEffort: null } },
    ]);

    await runInstances(['wt1', '--json']);

    const rows = JSON.parse(mockConsoleLog.mock.calls[0][0]);
    expect(rows).toEqual([
      {
        instanceId: 'claude',
        alias: 'Claude',
        cliTool: 'claude',
        running: true,
        autoYes: false,
        model: 'claude-opus-5[1m]',
        reasoningEffort: 'xhigh',
        // Issue #2038: null for every non-opencode instance, by construction.
        sessionId: null,
        sessionTitle: null,
        // Issue #2317: derived from the roster row, never fetched.
        tmuxSession: 'mcbd-claude-wt1',
      },
      {
        instanceId: 'codex-2',
        alias: 'Review',
        cliTool: 'codex',
        running: false,
        autoYes: false,
        model: null,
        reasoningEffort: null,
        sessionId: null,
        sessionTitle: null,
        // Issue #2317: the alias instance's own session, suffix and all.
        tmuxSession: 'mcbd-codex-wt1-2',
      },
    ]);
  });

  it('accepts a string or null for reasoningEffort on every row', async () => {
    // Schema, not value — #1784 holds the effort and lands separately. This
    // assertion is true before it lands and after.
    mockFetchSequence([
      { data: ROSTER },
      { data: { isRunning: true, autoYes: { enabled: false }, model: 'gpt-5.6-sol', reasoningEffort: null } },
      { data: { isRunning: true, autoYes: { enabled: false }, model: 'gpt-5.6-sol', reasoningEffort: 'high' } },
    ]);

    await runInstances(['wt1', '--json']);

    const rows: Array<{ reasoningEffort: unknown }> = JSON.parse(mockConsoleLog.mock.calls[0][0]);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toHaveProperty('reasoningEffort');
      expect(row.reasoningEffort === null || typeof row.reasoningEffort === 'string').toBe(true);
    }
  });

  it('reports null against a daemon too old to publish either field', async () => {
    // `undefined` from an old server and `null` from a new one both mean
    // "nothing knows"; the CLI has no way to tell them apart and no reason to.
    mockFetchSequence([
      { data: ROSTER },
      { data: { isRunning: true, autoYes: { enabled: false } } },
      { data: { isRunning: false, autoYes: { enabled: false } } },
    ]);

    await runInstances(['wt1', '--json']);

    const rows: Array<{ model: unknown; reasoningEffort: unknown }> = JSON.parse(
      mockConsoleLog.mock.calls[0][0]
    );
    expect(rows.map((r) => r.model)).toEqual([null, null]);
    expect(rows.map((r) => r.reasoningEffort)).toEqual([null, null]);
    expect(mockExit).not.toHaveBeenCalled();
  });
});
