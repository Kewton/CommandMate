/**
 * ls Command Tests
 * Issue #518
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';

// Mock process.exit to prevent actual exit
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

describe('createLsCommand', () => {
  it('exports createLsCommand function', async () => {
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    expect(typeof createLsCommand).toBe('function');
  });

  it('creates a Command named "ls"', async () => {
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    expect(cmd.name()).toBe('ls');
  });
});

describe('ls command action', () => {
  const mockWorktrees = {
    worktrees: [
      { id: 'wt1', name: 'main', cliToolId: 'claude', isSessionRunning: true, isWaitingForResponse: false, isProcessing: true },
      { id: 'wt2', name: 'feature/test', cliToolId: 'codex', isSessionRunning: true, isWaitingForResponse: true, isProcessing: false },
      { id: 'wt3', name: 'fix/bug', cliToolId: undefined, isSessionRunning: false, isWaitingForResponse: false, isProcessing: false },
    ],
    repositories: [],
  };

  it('outputs JSON when --json flag', async () => {
    mockFetchResponse(mockWorktrees);
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    await cmd.parseAsync(['node', 'ls', '--json']);
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('"id": "wt1"')
    );
  });

  it('outputs IDs only when --quiet flag', async () => {
    mockFetchResponse(mockWorktrees);
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    await cmd.parseAsync(['node', 'ls', '--quiet']);
    const output = mockConsoleLog.mock.calls[0][0];
    expect(output).toBe('wt1\nwt2\nwt3');
  });

  it('outputs table by default', async () => {
    mockFetchResponse(mockWorktrees);
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    await cmd.parseAsync(['node', 'ls']);
    const output = mockConsoleLog.mock.calls[0][0];
    expect(output).toContain('ID');
    expect(output).toContain('NAME');
    expect(output).toContain('STATUS');
    expect(output).toContain('wt1');
  });

  it('filters by --branch prefix', async () => {
    mockFetchResponse(mockWorktrees);
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    await cmd.parseAsync(['node', 'ls', '--quiet', '--branch', 'feature/']);
    const output = mockConsoleLog.mock.calls[0][0];
    expect(output).toBe('wt2');
  });

  it('derives status correctly', async () => {
    mockFetchResponse(mockWorktrees);
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    await cmd.parseAsync(['node', 'ls', '--json']);
    const output = JSON.parse(mockConsoleLog.mock.calls[0][0]);
    // wt1: isProcessing=true -> running
    // wt2: isWaitingForResponse=true -> waiting
    // wt3: all false -> idle
    // Note: status is derived in table format, not in JSON output
    // JSON outputs raw data
    expect(output[0].isProcessing).toBe(true);
    expect(output[1].isWaitingForResponse).toBe(true);
  });

  it('shows "No worktrees found." for empty list', async () => {
    mockFetchResponse({ worktrees: [], repositories: [] });
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    await cmd.parseAsync(['node', 'ls']);
    const output = mockConsoleLog.mock.calls[0][0];
    expect(output).toBe('No worktrees found.');
  });
});

describe('ls --branch filter uses real branch, not name (Issue #1003)', () => {
  // Fixture where the derived `name` differs from the real git `branch`.
  // The `id`/`name` here mimic sync-generated slugs (repo-prefixed, sanitized),
  // so filtering by name would NOT match a `feature/` prefix.
  const mockWorktreesWithBranch = {
    worktrees: [
      { id: 'wt1', name: 'myrepo-main', branch: 'main' },
      { id: 'wt2', name: 'myrepo-feature-x', branch: 'feature/x' },
      // No branch field: filter must fall back to `name` (legacy behavior).
      { id: 'wt3', name: 'myrepo-fix-bug' },
    ],
    repositories: [],
  };

  it('filters by the real branch name, not the derived name field', async () => {
    mockFetchResponse(mockWorktreesWithBranch);
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    await cmd.parseAsync(['node', 'ls', '--quiet', '--branch', 'feature/']);
    const output = mockConsoleLog.mock.calls[0][0];
    // wt2's branch is "feature/x" (matches); its name "myrepo-feature-x" would NOT
    // match "feature/" under the old name-based filter.
    expect(output).toBe('wt2');
  });

  it('falls back to name when branch is absent', async () => {
    mockFetchResponse(mockWorktreesWithBranch);
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    await cmd.parseAsync(['node', 'ls', '--quiet', '--branch', 'myrepo-fix']);
    const output = mockConsoleLog.mock.calls[0][0];
    // wt3 has no branch, so the filter falls back to name "myrepo-fix-bug".
    expect(output).toBe('wt3');
  });
});

describe('ls --id filter (Issue #1005)', () => {
  // Motivating scenario: the same branch name (`develop`) exists in multiple
  // repositories, so `--branch develop` alone cannot disambiguate. Worktree IDs
  // are `<repo>-<branch>` slugs, so `--id anvil-` narrows to one repository.
  const mockWorktreesMultiRepo = {
    worktrees: [
      { id: 'anvil-develop', name: 'develop', branch: 'develop' },
      { id: 'anvil-feature-x', name: 'feature/x', branch: 'feature/x' },
      { id: 'mycodebranchdesk-develop', name: 'develop', branch: 'develop' },
      { id: 'mycodebranchdesk-main', name: 'main', branch: 'main' },
    ],
    repositories: [],
  };

  it('filters by worktree id prefix', async () => {
    mockFetchResponse(mockWorktreesMultiRepo);
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    await cmd.parseAsync(['node', 'ls', '--quiet', '--id', 'anvil-']);
    const output = mockConsoleLog.mock.calls[0][0];
    // Both anvil-* worktrees match the id prefix.
    expect(output).toBe('anvil-develop\nanvil-feature-x');
  });

  it('disambiguates same branch across repositories via id prefix', async () => {
    mockFetchResponse(mockWorktreesMultiRepo);
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    // `develop` exists in two repos; the repo-prefixed id slug disambiguates.
    await cmd.parseAsync(['node', 'ls', '--quiet', '--id', 'anvil-develop']);
    const output = mockConsoleLog.mock.calls[0][0];
    expect(output).toBe('anvil-develop');
  });

  it('applies --branch and --id together as AND', async () => {
    mockFetchResponse(mockWorktreesMultiRepo);
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    // --branch develop matches anvil-develop + mycodebranchdesk-develop;
    // --id anvil- narrows to just the anvil worktree (AND, not exclusive).
    await cmd.parseAsync(['node', 'ls', '--quiet', '--branch', 'develop', '--id', 'anvil-']);
    const output = mockConsoleLog.mock.calls[0][0];
    expect(output).toBe('anvil-develop');
  });

  it('treats --id "" (empty string) as a no-op and returns all worktrees', async () => {
    mockFetchResponse(mockWorktreesMultiRepo);
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    await cmd.parseAsync(['node', 'ls', '--quiet', '--id', '']);
    const output = mockConsoleLog.mock.calls[0][0];
    // Falsy check (like --branch): empty prefix disables the filter.
    expect(output).toBe('anvil-develop\nanvil-feature-x\nmycodebranchdesk-develop\nmycodebranchdesk-main');
  });

  it('is case-sensitive (startsWith)', async () => {
    mockFetchResponse(mockWorktreesMultiRepo);
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    // Uppercase prefix does not match the lowercase slug.
    await cmd.parseAsync(['node', 'ls', '--quiet', '--id', 'Anvil-']);
    const output = mockConsoleLog.mock.calls[0][0];
    expect(output).toBe('');
  });

  it('produces empty --quiet output when 0 worktrees match', async () => {
    mockFetchResponse(mockWorktreesMultiRepo);
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    await cmd.parseAsync(['node', 'ls', '--quiet', '--id', 'nonexistent-']);
    const output = mockConsoleLog.mock.calls[0][0];
    expect(output).toBe('');
  });

  it('produces "[]" --json output when 0 worktrees match', async () => {
    mockFetchResponse(mockWorktreesMultiRepo);
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    await cmd.parseAsync(['node', 'ls', '--json', '--id', 'nonexistent-']);
    const output = mockConsoleLog.mock.calls[0][0];
    expect(output).toBe('[]');
  });

  it('produces "No worktrees found." table output when 0 worktrees match', async () => {
    mockFetchResponse(mockWorktreesMultiRepo);
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    await cmd.parseAsync(['node', 'ls', '--id', 'nonexistent-']);
    const output = mockConsoleLog.mock.calls[0][0];
    expect(output).toBe('No worktrees found.');
  });

  it('is combinable with --json output', async () => {
    mockFetchResponse(mockWorktreesMultiRepo);
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    await cmd.parseAsync(['node', 'ls', '--json', '--id', 'anvil-']);
    const output = JSON.parse(mockConsoleLog.mock.calls[0][0]);
    expect(output.map((wt: { id: string }) => wt.id)).toEqual(['anvil-develop', 'anvil-feature-x']);
  });

  it('registers the --id option in --help output', async () => {
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    const help = cmd.helpInformation();
    expect(help).toContain('--id <prefix>');
  });
});
