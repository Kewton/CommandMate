/**
 * Issue #4436 (I7): `commandmate auto-yes --enable` refused by the server's tool
 * policy (409 `TOOL_POLICY_DENIED`) exits 33 (`ToolPolicyExitCode.DENIED`) with
 * the reason on the first stderr line. Every other failure keeps its exit code.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetchResponse, restoreFetch, keepOffTheRealServer } from '../../../helpers/mock-api';
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
