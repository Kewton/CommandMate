/**
 * respond Command Tests
 * Issue #518
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchResponse, mockFetchError, restoreFetch } from '../../../helpers/mock-api';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

describe('createRespondCommand', () => {
  it('creates a Command named "respond"', async () => {
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    const cmd = createRespondCommand();
    expect(cmd.name()).toBe('respond');
  });
});

describe('respond command action', () => {
  it('sends answer with prompt-response API', async () => {
    mockFetchResponse({ success: true, answer: 'yes' }, 200);
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    const cmd = createRespondCommand();
    await cmd.parseAsync(['node', 'respond', 'wt1', 'yes']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/worktrees/wt1/prompt-response'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ answer: 'yes' }),
      })
    );
    expect(mockConsoleError).toHaveBeenCalledWith('Response sent.');
  });

  it('sends with --agent flag as cliTool', async () => {
    mockFetchResponse({ success: true, answer: 'yes' }, 200);
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    const cmd = createRespondCommand();
    await cmd.parseAsync(['node', 'respond', 'wt1', 'yes', '--agent', 'claude']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ answer: 'yes', cliTool: 'claude' }),
      })
    );
  });

  it('handles failure reason from API', async () => {
    mockFetchResponse({ success: false, answer: '', reason: 'prompt_no_longer_active' }, 200);
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    const cmd = createRespondCommand();
    await cmd.parseAsync(['node', 'respond', 'wt1', 'yes']);

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('prompt_no_longer_active')
    );
    expect(mockExit).toHaveBeenCalledWith(99); // UNEXPECTED_ERROR
  });

  it('rejects invalid worktree ID', async () => {
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    const cmd = createRespondCommand();
    await cmd.parseAsync(['node', 'respond', '../bad', 'yes']);
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('handles server connection error', async () => {
    mockFetchError('connect ECONNREFUSED 127.0.0.1:3000');
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    const cmd = createRespondCommand();
    await cmd.parseAsync(['node', 'respond', 'wt1', 'yes']);
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

describe('respond command semantic resolution (Issue #1681)', () => {
  it('prints the resolved option to stdout for audit', async () => {
    mockFetchResponse({
      success: true,
      answer: '3',
      resolved: {
        via: 'semantic',
        optionNumber: 3,
        optionLabel: 'No, and tell Claude what to do differently (esc)',
      },
    }, 200);
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    const cmd = createRespondCommand();
    await cmd.parseAsync(['node', 'respond', 'wt1', 'no']);

    expect(mockConsoleLog).toHaveBeenCalledWith(
      'Resolved "no" to option 3: No, and tell Claude what to do differently (esc)'
    );
    expect(mockConsoleError).toHaveBeenCalledWith('Response sent.');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('exits non-zero when the answer is unresolvable', async () => {
    mockFetchResponse({
      success: false,
      answer: 'yes',
      reason: 'unresolvable_answer',
      message: 'No option label matches "yes". Answer with an option number.',
    }, 200);
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    const cmd = createRespondCommand();
    await cmd.parseAsync(['node', 'respond', 'wt1', 'yes']);

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('unresolvable_answer')
    );
    expect(mockExit).toHaveBeenCalledWith(99);
  });

  it('sends useDefault with --default and prints the selected option', async () => {
    mockFetchResponse({
      success: true,
      answer: '1',
      resolved: { via: 'default', optionNumber: 1, optionLabel: 'Yes' },
    }, 200);
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    const cmd = createRespondCommand();
    await cmd.parseAsync(['node', 'respond', 'wt1', '--default']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/worktrees/wt1/prompt-response'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ useDefault: true }),
      })
    );
    expect(mockConsoleLog).toHaveBeenCalledWith('Selected default option 1: Yes');
  });

  it('prints the default answer for yes_no default resolution (no option number)', async () => {
    mockFetchResponse({
      success: true,
      answer: 'yes',
      resolved: { via: 'default', optionLabel: 'yes' },
    }, 200);
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    const cmd = createRespondCommand();
    await cmd.parseAsync(['node', 'respond', 'wt1', '--default']);

    expect(mockConsoleLog).toHaveBeenCalledWith('Selected default answer: yes');
  });

  it('rejects <answer> combined with --default', async () => {
    // process.exit is mocked (no-op), so the action continues past validation;
    // mock fetch to keep the continuation off the network.
    mockFetchResponse({ success: true, answer: '' }, 200);
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    const cmd = createRespondCommand();
    await cmd.parseAsync(['node', 'respond', 'wt1', 'yes', '--default']);

    expect(mockConsoleError).toHaveBeenCalledWith('Error: <answer> and --default are mutually exclusive.');
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('rejects a missing answer without --default', async () => {
    mockFetchResponse({ success: true, answer: '' }, 200);
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    const cmd = createRespondCommand();
    await cmd.parseAsync(['node', 'respond', 'wt1']);

    expect(mockConsoleError).toHaveBeenCalledWith('Error: Answer cannot be empty. Provide an answer or --default.');
    expect(mockExit).toHaveBeenCalledWith(2);
  });
});
