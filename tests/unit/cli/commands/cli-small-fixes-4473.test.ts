/**
 * Issue #4473: small CLI fixes.
 *
 *  (P-2) `send --model` answered 400 prints the server's reason, not only the shared
 *        "Bad request" line. Only a send that carried --model and a 400 with a reason.
 *  (3)   the 400 bodies and `send --help` name the values `--model` takes.
 *  (P-3) `instances --help` says an underscore id (`claude_x`) is taken — checked against the
 *        roster's own validator, not a copy of its rules.
 *  (P-5) `instances --agent` lists every tool `add` takes (command-code included).
 *
 * Positive controls: the shared classifier is unchanged (a 400 on another command still
 * prints only its line); an id the roster refuses is not claimed by the help.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { ApiError } from '../../../../src/cli/utils/api-client';
import { CLI_TOOL_IDS } from '../../../../src/cli/config/cli-tool-ids';
import { validateAgentInstanceCandidate } from '../../../../src/lib/agent-instances-validator';
import { refuseModelOnRunningSession } from '../../../../src/app/api/worktrees/[id]/send/send-session-start';
import { CLAUDE_MODEL_EXAMPLES } from '../../../../src/app/api/worktrees/[id]/send/send-request';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

const errorLines = (): string[] => mockConsoleError.mock.calls.map((c) => String(c[0]));

async function runSend(argv: string[]): Promise<void> {
  const { createSendCommand } = await import('../../../../src/cli/commands/send');
  await createSendCommand().parseAsync(['node', 'send', ...argv]);
}

describe('#4473 P-2: send --model 400 prints the server reason', () => {
  const reason = 'Claude model can only be set when starting a new session. Stop the current Claude session and resend with --model to switch models.';

  it('prints the shared line and the server reason, exiting with the shared code', async () => {
    mockFetchSequence([{ data: { error: reason }, status: 400 }]);
    await runSend(['wt1', 'hello', '--agent', 'claude', '--model', 'opus']);
    const lines = errorLines();
    expect(lines).toContain('Error: Bad request. Check your input parameters.');
    expect(lines).toContain(`Server: ${reason}`);
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('negative control: without --model the 400 prints only the shared line', async () => {
    mockFetchSequence([{ data: { error: reason }, status: 400 }]);
    await runSend(['wt1', 'hello', '--agent', 'claude']);
    expect(errorLines().some((l) => l.startsWith('Server:'))).toBe(false);
    expect(errorLines()).toContain('Error: Bad request. Check your input parameters.');
  });

  it('negative control: a 400 with no reason, and a non-400, add nothing', async () => {
    const { reportModelRefusal } = await import('../../../../src/cli/commands/send');
    reportModelRefusal(new ApiError('Bad request. Check your input parameters.', 2, 400, undefined), { model: 'opus' });
    reportModelRefusal(new ApiError('Server error', 1, 500, { error: 'boom' }), { model: 'opus' });
    reportModelRefusal(new Error('x'), { model: 'opus' });
    expect(mockConsoleError).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('the shared classifier is untouched: other commands print only the shared 400 line', async () => {
    const { handleApiError } = await import('../../../../src/cli/utils/api-client');
    expect(handleApiError(null, 400, { error: reason }).message).toBe('Bad request. Check your input parameters.');
  });
});

describe('#4473 (3): the values --model takes are named', () => {
  it('the running-session 400 keeps its sentence and names the values (claude)', async () => {
    const response = refuseModelOnRunningSession('opus', 'claude', true);
    const { error } = (await response?.json()) as { error: string };
    expect(error).toMatch(/^Claude model can only be set when starting a new session/);
    expect(error).toContain(CLAUDE_MODEL_EXAMPLES);
    expect(CLAUDE_MODEL_EXAMPLES).toMatch(/opus/);
    expect(CLAUDE_MODEL_EXAMPLES).toMatch(/sonnet/);
    expect(CLAUDE_MODEL_EXAMPLES).toMatch(/claude-[a-z]+-[0-9]/);
  });

  it('negative control: antigravity keeps its sentence, with no claude values', async () => {
    const { error } = (await refuseModelOnRunningSession('m', 'antigravity', true)?.json()) as { error: string };
    expect(error).not.toContain(CLAUDE_MODEL_EXAMPLES);
  });

  it('send --help names opus, sonnet and a full id', async () => {
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const help = createSendCommand().helpInformation();
    expect(help).toMatch(/opus/);
    expect(help).toMatch(/sonnet/);
    expect(help).toMatch(/claude-opus-4-1/);
  });
});

describe('#4473 P-3 / P-5: instances --help', () => {
  const helpOf = async (): Promise<string> => {
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    return createInstancesCommand().helpInformation();
  };

  it('--agent lists every tool add takes, command-code included', async () => {
    const help = (await helpOf()).replace(/\s+/g, ' ');
    expect(help).toContain(`(${CLI_TOOL_IDS.join(', ')})`);
    expect(help).toContain('command-code');
  });

  it('--id says an underscore id such as claude_x is taken, and the roster validator agrees', async () => {
    const help = (await helpOf()).replace(/\s+/g, ' ');
    expect(help).toContain('claude_x');
    expect(validateAgentInstanceCandidate([], { id: 'claude_x', cliTool: 'claude', alias: '' }).valid).toBe(true);
  });

  it('positive control: the forms the help does not claim are refused by the validator', () => {
    expect(validateAgentInstanceCandidate([], { id: 'claude x', cliTool: 'claude', alias: '' }).valid).toBe(false);
    expect(validateAgentInstanceCandidate([], { id: 'codex', cliTool: 'claude', alias: '' }).valid).toBe(false);
    expect(validateAgentInstanceCandidate([], { id: 'a'.repeat(65), cliTool: 'claude', alias: '' }).valid).toBe(false);
  });
});
