/**
 * `commandmate ls`: the REASON column, and where `--json` puts the new fields
 * (Issue #1926, 方針書 §7 / DR3-005).
 *
 * `deriveStatus` folds every agent of a worktree into one of four words, and
 * until now that word was all an operator got: a `ready` that meant "the agent
 * finished" and a `ready` that meant "the frame went unreadable and the
 * staleness fallback called it ready" printed identically. The column added here
 * is the difference between the two, and the `(no evidence)` marker is what says
 * the word beside it is a fallback rather than a reading.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';

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

/** The row for a worktree whose only agent reports `entry`. */
function worktree(id: string, entry: Record<string, unknown>, top: Record<string, unknown>) {
  return {
    id,
    name: id,
    cliToolId: 'claude',
    ...top,
    sessionStatusByCli: { claude: entry },
  };
}

const RUNNING_TOP = { isSessionRunning: true, isWaitingForResponse: false, isProcessing: true };
const READY_TOP = { isSessionRunning: true, isWaitingForResponse: false, isProcessing: false };
const WAITING_TOP = { isSessionRunning: true, isWaitingForResponse: true, isProcessing: false };
const IDLE_TOP = { isSessionRunning: false, isWaitingForResponse: false, isProcessing: false };

describe('[#1926] ls table REASON column', () => {
  it('adds REASON between STATUS and DEFAULT, leaving the other headers alone', async () => {
    const out = await runLs([
      worktree(
        'wt1',
        { isRunning: true, isWaitingForResponse: false, isProcessing: true, sessionStatusReason: 'thinking_indicator', statusEvidence: 'positive' },
        RUNNING_TOP,
      ),
    ]);

    const header = out.split('\n')[0];
    expect(header).toMatch(/\bID\b.*\bNAME\b.*\bSTATUS\b.*\bREASON\b.*\bDEFAULT\b/);
    expect(out).toContain('thinking_indicator');
  });

  it('marks a status that rests on no evidence', async () => {
    // The row this column exists for: `ready` produced by the 5-second
    // staleness fallback on a frame nobody could parse. The word is unchanged
    // (DR3-002 keeps the wire value put); the marker is the new information.
    const out = await runLs([
      worktree(
        'wt1',
        { isRunning: true, isWaitingForResponse: false, isProcessing: false, sessionStatusReason: 'no_recent_output', statusEvidence: 'none' },
        READY_TOP,
      ),
    ]);

    expect(out).toContain('ready');
    expect(out).toContain('no_recent_output (no evidence)');
  });

  it('leaves a positively read status unmarked', async () => {
    const out = await runLs([
      worktree(
        'wt1',
        { isRunning: true, isWaitingForResponse: false, isProcessing: false, sessionStatusReason: 'input_prompt', statusEvidence: 'positive' },
        READY_TOP,
      ),
    ]);

    expect(out).toContain('input_prompt');
    expect(out).not.toContain('(no evidence)');
  });

  it('prints - for a server that does not publish the fields', async () => {
    // A CLI newer than the daemon it dials is the ordinary case, and #1926 must
    // not print `undefined` at it.
    const out = await runLs([
      { id: 'wt1', name: 'wt1', cliToolId: 'claude', ...READY_TOP },
    ]);

    expect(out).toContain('ready');
    expect(out).not.toContain('undefined');
    expect(out.split('\n')[2]).toMatch(/ready\s+-\s+claude/);
  });

  it('prints - for an idle worktree', async () => {
    const out = await runLs([
      worktree(
        'wt1',
        { isRunning: false, isWaitingForResponse: false, isProcessing: false },
        IDLE_TOP,
      ),
    ]);

    expect(out.split('\n')[2]).toMatch(/idle\s+-\s+claude/);
  });

  it('reports the reason of the agent that produced the STATUS, not the default agent', async () => {
    // A second agent is what makes the worktree `waiting`; printing the default
    // agent's `input_prompt` beside that word would be a sentence about the
    // session the operator is not being warned about.
    const out = await runLs([
      {
        id: 'wt1',
        name: 'wt1',
        cliToolId: 'claude',
        ...WAITING_TOP,
        sessionStatusByCli: {
          claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false, sessionStatusReason: 'input_prompt', statusEvidence: 'positive' },
          codex: { isRunning: true, isWaitingForResponse: true, isProcessing: false, sessionStatusReason: 'prompt_detected', statusEvidence: 'positive' },
        },
      },
    ]);

    expect(out).toContain('prompt_detected');
    expect(out).not.toContain('input_prompt');
  });

  it('prefers the worktree default when both agents explain the status', async () => {
    const out = await runLs([
      {
        id: 'wt1',
        name: 'wt1',
        cliToolId: 'codex',
        ...RUNNING_TOP,
        sessionStatusByCli: {
          claude: { isRunning: true, isWaitingForResponse: false, isProcessing: true, sessionStatusReason: 'thinking_indicator', statusEvidence: 'positive' },
          codex: { isRunning: true, isWaitingForResponse: false, isProcessing: true, sessionStatusReason: 'default', statusEvidence: 'none' },
        },
      },
    ]);

    expect(out).toContain('default (no evidence)');
    expect(out).not.toContain('thinking_indicator');
  });

  it('keeps the columns aligned when one reason is much longer than another', async () => {
    const out = await runLs([
      worktree('wt1', { isRunning: true, isWaitingForResponse: false, isProcessing: false }, READY_TOP),
      worktree(
        'wt2',
        { isRunning: true, isWaitingForResponse: false, isProcessing: false, sessionStatusReason: 'no_recent_output', statusEvidence: 'none' },
        READY_TOP,
      ),
    ]);

    const lines = out.split('\n');
    // Header, separator, two rows. The column after REASON has to start at the
    // same offset on both rows — `-` and `no_recent_output (no evidence)` are
    // 30 characters apart, and a width computed before the marker was appended
    // would ragged the DEFAULT column.
    expect(lines).toHaveLength(4);
    expect(lines[0].indexOf('DEFAULT')).toBe(lines[2].indexOf('claude'));
    expect(lines[2].indexOf('claude')).toBe(lines[3].indexOf('claude'));
  });
});

describe('[#1926] ls --json', () => {
  it('carries the fields where the server put them, under sessionStatusByCli', async () => {
    // `--json` stays the server rows verbatim. A synthesised top-level
    // `statusEvidence` would read as a server field to anyone holding
    // `WorktreeItem` and would make this output disagree with GET /api/worktrees.
    const out = await runLs(
      [
        worktree(
          'wt1',
          { isRunning: true, isWaitingForResponse: false, isProcessing: false, sessionStatusReason: 'no_recent_output', statusEvidence: 'none', lastKnownStatus: 'running', lastKnownStatusAt: 1_700_000_000_000 },
          READY_TOP,
        ),
      ],
      ['--json'],
    );

    const rows = JSON.parse(out) as Array<Record<string, unknown>>;
    const entry = (rows[0].sessionStatusByCli as Record<string, Record<string, unknown>>).claude;
    expect(entry.statusEvidence).toBe('none');
    expect(entry.sessionStatusReason).toBe('no_recent_output');
    expect(entry.lastKnownStatus).toBe('running');
    expect(entry.lastKnownStatusAt).toBe(1_700_000_000_000);
    expect(rows[0]).not.toHaveProperty('statusEvidence');
  });
});
