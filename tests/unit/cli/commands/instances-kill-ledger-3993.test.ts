/**
 * `instances … kill` records who stopped the session (Issue #3993).
 *
 * The env-clean gate sets a vanished sibling session apart as `external` only
 * from this record, so the record must name the worktree, the instance and the
 * caller, be written only for a kill that succeeded, and never fail the command.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mockFetchResponse, mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import {
  readSessionKillRecords,
  SESSION_KILL_LEDGER_ROOT_ENV,
} from '../../../../src/lib/verification/session-kill-ledger';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

let ledgerRoot: string;

beforeEach(() => {
  ledgerRoot = mkdtempSync(join(tmpdir(), 'cm-kill-ledger-3993-'));
  vi.stubEnv(SESSION_KILL_LEDGER_ROOT_ENV, ledgerRoot);
  // Outside tmux: no caller session to ask for, and no tmux spawned.
  vi.stubEnv('TMUX', '');
});

afterEach(() => {
  restoreFetch();
  vi.unstubAllEnvs();
  mockExit.mockClear();
  mockConsoleError.mockClear();
  rmSync(ledgerRoot, { recursive: true, force: true });
});

function recorded() {
  return readSessionKillRecords(0, Date.now() + 1000, ledgerRoot);
}

describe('instances kill: session-kill ledger (Issue #3993)', () => {
  it('records the worktree, the instance and the caller’s cwd after a successful kill', async () => {
    mockFetchResponse({ success: true });
    const before = Date.now();
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    await createInstancesCommand().parseAsync(['node', 'instances', 'wt1', 'kill', 'claude-2']);

    const records = recorded();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      version: 1,
      api: 'kill-session',
      worktreeId: 'wt1',
      instanceId: 'claude-2',
      callerCwd: process.cwd(),
      callerSession: null,
    });
    expect(records[0].at).toBeGreaterThanOrEqual(before);
    expect(mockConsoleError).toHaveBeenCalledWith('Session killed: claude-2');
  });

  it('records the kill of `remove --kill` too', async () => {
    mockFetchSequence([
      { data: { id: 'wt1', name: 'main', agentInstances: [
        { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
        { id: 'claude-2', cliTool: 'claude', alias: 'Claude 2', order: 1 },
      ] } },
      { data: { success: true } },
      { data: { id: 'wt1', agentInstances: [] } },
    ]);
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    await createInstancesCommand().parseAsync(['node', 'instances', 'wt1', 'remove', 'claude-2', '--kill']);

    expect(recorded().map((r) => [r.worktreeId, r.instanceId])).toEqual([['wt1', 'claude-2']]);
  });

  it('records nothing when the kill failed', async () => {
    mockFetchResponse({ error: 'No active sessions found' }, 404);
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    await createInstancesCommand().parseAsync(['node', 'instances', 'wt1', 'kill', 'claude-2']);

    expect(recorded()).toEqual([]);
    expect(mockConsoleError).not.toHaveBeenCalledWith('Session killed: claude-2');
  });

  it('still reports the kill when the ledger cannot be written', async () => {
    // A file where the directory should be: mkdir fails, the command does not.
    const blocked = join(ledgerRoot, 'blocked');
    writeFileSync(blocked, '');
    vi.stubEnv(SESSION_KILL_LEDGER_ROOT_ENV, blocked);
    mockFetchResponse({ success: true });
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    await createInstancesCommand().parseAsync(['node', 'instances', 'wt1', 'kill', 'claude-2']);

    expect(mockConsoleError).toHaveBeenCalledWith('Session killed: claude-2');
    expect(mockExit).not.toHaveBeenCalled();
    expect(readdirSync(ledgerRoot)).toEqual(['blocked']);
  });
});
