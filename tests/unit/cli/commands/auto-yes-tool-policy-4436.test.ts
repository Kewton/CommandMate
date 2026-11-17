/**
 * Issue #4436 (I7): `commandmate auto-yes --enable` refused by the server's tool
 * policy (409 `TOOL_POLICY_DENIED`) exits 33 (`ToolPolicyExitCode.DENIED`) with
 * the reason on the first stderr line. Every other failure keeps its exit code.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetchResponse, mockFetchSequence, restoreFetch, keepOffTheRealServer } from '../../../helpers/mock-api';
import { ExitCode, ToolPolicyExitCode } from '../../../../src/cli/types';
import {
  ANTIGRAVITY_CONSUMER_TERMS,
  ANTIGRAVITY_FAQ_URL,
  ANTIGRAVITY_TERMS_URL,
  TOOL_POLICY_DENIED,
  TOOL_POLICY_DENIED_MESSAGE,
  USAGE_DECLARATION_ENV,
} from '../../../../src/lib/tool-policy/policy';

keepOffTheRealServer();

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleError.mockClear();
});

const DENIAL = {
  code: TOOL_POLICY_DENIED,
  error: TOOL_POLICY_DENIED_MESSAGE,
  reason: ANTIGRAVITY_CONSUMER_TERMS,
  links: { terms: ANTIGRAVITY_TERMS_URL, faq: ANTIGRAVITY_FAQ_URL },
  cliToolId: 'antigravity',
  instanceId: 'antigravity',
};

async function run(...args: string[]): Promise<void> {
  const { createAutoYesCommand } = await import('../../../../src/cli/commands/auto-yes');
  await createAutoYesCommand().parseAsync(['node', 'auto-yes', ...args]);
}

function stderrLines(): string[] {
  return mockConsoleError.mock.calls.map((call) => String(call[0]));
}

describe('Issue #4436: auto-yes --enable refused by the tool policy', () => {
  it('4436 I7: a 409 TOOL_POLICY_DENIED exits 33 with the reason on the first stderr line', async () => {
    mockFetchResponse(DENIAL, 409);
    await run('wt1', '--enable', '--agent', 'antigravity');

    expect(mockExit).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(ToolPolicyExitCode.DENIED);
    expect(ToolPolicyExitCode.DENIED).toBe(33);
    const lines = stderrLines();
    expect(lines[0]).toContain(TOOL_POLICY_DENIED_MESSAGE);
    expect(lines[0]).toContain(TOOL_POLICY_DENIED);
    expect(lines.join('\n')).toContain(ANTIGRAVITY_FAQ_URL);
    expect(lines.join('\n')).toContain(USAGE_DECLARATION_ENV);
    // Not reported as armed.
    expect(lines.join('\n')).not.toContain('Auto-yes enabled');
  });

  it('4436 I7: the first line still names the refusal when the body has no error text', async () => {
    mockFetchResponse({ code: TOOL_POLICY_DENIED }, 409);
    await run('wt1', '--enable');

    expect(mockExit).toHaveBeenCalledWith(ToolPolicyExitCode.DENIED);
    expect(stderrLines()[0]).toContain(TOOL_POLICY_DENIED_MESSAGE);
    expect(stderrLines().join('\n')).toContain(ANTIGRAVITY_FAQ_URL);
  });

  const UNCHANGED: Array<[string, unknown, number, number]> = [
    ['another 409 (AUTO_YES_ALREADY_ENABLED)', { code: 'AUTO_YES_ALREADY_ENABLED', error: 'already on' }, 409, ExitCode.UNEXPECTED_ERROR],
    ['a 409 without a code', { error: 'conflict' }, 409, ExitCode.UNEXPECTED_ERROR],
    ['TOOL_POLICY_DENIED on a status other than 409', { code: TOOL_POLICY_DENIED, error: 'x' }, 400, ExitCode.CONFIG_ERROR],
    ['a 400', { error: 'bad' }, 400, ExitCode.CONFIG_ERROR],
    ['a 500', { error: 'boom' }, 500, ExitCode.UNEXPECTED_ERROR],
  ];

  it.each(UNCHANGED)('4436 I7: %s keeps its exit code', async (_label, body, status, exitCode) => {
    mockFetchResponse(body, status);
    await run('wt1', '--enable');

    expect(mockExit).toHaveBeenCalledWith(exitCode);
    expect(mockExit).not.toHaveBeenCalledWith(ToolPolicyExitCode.DENIED);
  });

  it('4436 I3: a successful enable is unchanged (no exit, the enabled line)', async () => {
    mockFetchResponse({ enabled: true, cliToolId: 'claude', instanceId: 'claude' }, 200);
    await run('wt1', '--enable', '--agent', 'claude');

    expect(mockExit).not.toHaveBeenCalled();
    expect(stderrLines()[0]).toBe('Auto-yes enabled for wt1 (claude).');
  });
});

describe('Issue #4436 I7a: the refusal is the first stderr line with --token too', () => {
  const TOKEN_WARNING_HEAD = 'Warning: --token flag exposes token';

  it('4436 I7a: --enable --agent antigravity --token <x> refused (409) → the reason first, exit 33, the token warning after it', async () => {
    mockFetchResponse(DENIAL, 409);
    await run('wt1', '--enable', '--agent', 'antigravity', '--token', 'secret-4436');

    expect(mockExit).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(ToolPolicyExitCode.DENIED);
    const lines = stderrLines();
    expect(lines[0]).toContain(TOOL_POLICY_DENIED_MESSAGE);
    expect(lines[0]).toContain(TOOL_POLICY_DENIED);
    const warningAt = lines.findIndex((line) => line.startsWith(TOKEN_WARNING_HEAD));
    expect(warningAt).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('secret-4436');
  });

  it('4436 I7a (control): --token on a successful enable keeps the warning before the enabled line', async () => {
    mockFetchResponse({ enabled: true, cliToolId: 'claude', instanceId: 'claude' }, 200);
    await run('wt1', '--enable', '--agent', 'claude', '--token', 'secret-4436');

    expect(mockExit).not.toHaveBeenCalled();
    const lines = stderrLines();
    expect(lines[0].startsWith(TOKEN_WARNING_HEAD)).toBe(true);
    expect(lines).toContain('Auto-yes enabled for wt1 (claude).');
    expect(lines.indexOf('Auto-yes enabled for wt1 (claude).')).toBeGreaterThan(0);
  });

  it('4436 I7a (control): --token on another failure keeps the warning first and its exit code', async () => {
    mockFetchResponse({ error: 'boom' }, 500);
    await run('wt1', '--enable', '--token', 'secret-4436');

    expect(mockExit).toHaveBeenCalledWith(ExitCode.UNEXPECTED_ERROR);
    expect(stderrLines()[0].startsWith(TOKEN_WARNING_HEAD)).toBe(true);
  });

  it('4436 I7a (control): --token with an invalid duration keeps the warning before the error and exit 2', async () => {
    await run('wt1', '--enable', '--duration', '0h', '--token', 'secret-4436');

    expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
    const lines = stderrLines();
    expect(lines[0].startsWith(TOKEN_WARNING_HEAD)).toBe(true);
    expect(lines.some((line) => line.startsWith('Error: Invalid duration.'))).toBe(true);
  });
});

describe('Issue #4436 I7b: the held warnings are printed however the command ends', () => {
  const TOKEN_WARNING_HEAD = 'Warning: --token flag exposes token';

  /** The 409 `/resolve-target` answers for an alias two roster rows respond to. */
  const AMBIGUOUS = {
    data: {
      error: "Instance 'review' matches 2 roster entries. Name one by its instance id.",
      code: 'ambiguous_instance_alias',
      issues: ['review-1 (claude) — alias "review"', 'review-2 (codex) — alias "review"'],
    },
    status: 409,
  };

  /**
   * The stderr lines printed before the first `process.exit` — what the operator
   * sees, since the real exit ends the process there (the spy does not).
   */
  function linesBeforeFirstExit(): string[] {
    const exitAt = mockExit.mock.invocationCallOrder[0];
    expect(exitAt).toBeDefined();
    return mockConsoleError.mock.calls
      .filter((_call, i) => mockConsoleError.mock.invocationCallOrder[i] < exitAt)
      .map((call) => String(call[0]));
  }

  it('4436 I7b: --token with an ambiguous --instance → the token warning is printed, then the ambiguity, exit 2', async () => {
    mockFetchSequence([AMBIGUOUS]);
    await run('wt1', '--enable', '--instance', 'review', '--token', 'secret-4436');

    expect(mockExit.mock.calls[0]).toEqual([ExitCode.CONFIG_ERROR]);
    const lines = linesBeforeFirstExit();
    expect(lines[0].startsWith(TOKEN_WARNING_HEAD)).toBe(true);
    expect(lines.some((line) => line.startsWith("Error: Instance 'review' matches 2 roster entries."))).toBe(true);
    expect(lines.join('\n')).not.toContain('secret-4436');
  });

  it('4436 I7b: --token with --agent contradicting the roster → the token warning is printed, then the contradiction, exit 2', async () => {
    mockFetchSequence([
      {
        data: {
          cliToolId: 'codex',
          instanceId: 'codex',
          resolvedBy: 'roster',
          conflict: { instanceId: 'codex', rosterCliTool: 'codex', requestedCliTool: 'claude' },
        },
      },
    ]);
    await run('wt1', '--enable', '--instance', 'codex', '--agent', 'claude', '--token', 'secret-4436');

    expect(mockExit.mock.calls[0]).toEqual([ExitCode.CONFIG_ERROR]);
    const lines = linesBeforeFirstExit();
    expect(lines[0].startsWith(TOKEN_WARNING_HEAD)).toBe(true);
    expect(lines.some((line) => line.startsWith('Error: '))).toBe(true);
  });

  it('4436 I7b (control): an ambiguous --instance without --token is unchanged (no warning, exit 2)', async () => {
    mockFetchSequence([AMBIGUOUS]);
    await run('wt1', '--enable', '--instance', 'review');

    expect(mockExit.mock.calls[0]).toEqual([ExitCode.CONFIG_ERROR]);
    const lines = linesBeforeFirstExit();
    expect(lines[0]).toBe("Error: Instance 'review' matches 2 roster entries. Name one by its instance id.");
    expect(lines.some((line) => line.startsWith('Warning:'))).toBe(false);
  });

  it('4436 I7b (control): --token with a resolved --instance refused (409) → the reason is still first, exit 33', async () => {
    mockFetchSequence([
      { data: { cliToolId: 'antigravity', instanceId: 'antigravity', resolvedBy: 'roster', conflict: null } },
      { data: DENIAL, status: 409 },
    ]);
    await run('wt1', '--enable', '--instance', 'antigravity', '--token', 'secret-4436');

    expect(mockExit).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(ToolPolicyExitCode.DENIED);
    const lines = stderrLines();
    expect(lines[0]).toContain(TOOL_POLICY_DENIED_MESSAGE);
    expect(lines.findIndex((line) => line.startsWith(TOKEN_WARNING_HEAD))).toBeGreaterThan(0);
  });
});
