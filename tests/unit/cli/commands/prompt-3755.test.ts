/**
 * `commandmate prompt` and the observation on `wait`'s exit 10 (Issue #3755).
 *
 * `prompt` reads `current-output?observe=1` and prints its `promptObservation`:
 * exit 0 whenever the screen was read (also with nothing asking, and for
 * `unknown`), 21 when there is no running session. `wait` asks for the same
 * field on its polls and adds it to the exit-10 payload — and nothing else
 * changes: the exit code, and the payload of a server that sends none.
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { ExitCode, VerifyExitCode, WaitExitCode } from '../../../../src/cli/types';
import type { PromptObservation } from '../../../../src/lib/prompt-observation/types';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeAll(async () => {
  await import('../../../../src/cli/commands/prompt');
  await import('../../../../src/cli/commands/wait');
});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

const NOW = Date.now();

function observation(over: Partial<PromptObservation> = {}): PromptObservation {
  return {
    schemaVersion: 1,
    observedAt: NOW,
    target: {
      worktreeId: 'wt1',
      cliToolId: 'antigravity',
      instanceId: 'antigravity',
      sessionName: 'mcbd-antigravity-wt1',
      resolvedBy: 'explicit',
    },
    session: { running: true, starting: false, generation: NOW - 60_000 },
    status: 'observed',
    unavailableReason: null,
    screen: {
      kind: 'antigravity-trust',
      token: 'po1.abc.' + 'A'.repeat(43),
      tokenExpiresAt: NOW + 120_000,
      tokenWithheld: null,
      appearedAt: NOW - 5_000,
      question: 'Do you trust the contents of this project?',
      approvalTarget: '/work/project',
      options: [
        { position: 1, label: 'Yes, I trust this folder' },
        { position: 2, label: 'No, exit' },
      ],
      selectedPosition: 1,
      answerVia: 'terminal',
      sessionStatus: 'waiting',
      sessionStatusReason: 'antigravity_selection_list',
    },
    autoYes: {
      enabled: true,
      expiresAt: null,
      stopReason: null,
      pollerActive: true,
      pollerRecord: null,
      contractEvaluation: { state: 'not-evaluated', because: 'no-parsed-prompt', contract: null },
    },
    ...over,
  };
}

/** A current-output frame of a selection list, optionally carrying an observation. */
function frame(promptObservation?: PromptObservation): Record<string, unknown> {
  return {
    isRunning: true,
    isPromptWaiting: false,
    content: '',
    fullOutput: '',
    realtimeSnippet: '',
    lineCount: 1,
    lastCapturedLine: 1,
    promptData: null,
    thinking: false,
    cliToolId: 'antigravity',
    sessionStatus: 'waiting',
    sessionStatusReason: 'antigravity_selection_list',
    isSelectionListActive: true,
    lastServerResponseTimestamp: null,
    serverPollerActive: true,
    ...(promptObservation && { promptObservation }),
  };
}

const requestedUrls = (): string[] =>
  vi.mocked(global.fetch).mock.calls.map((call) => String(call[0])).filter((u) => !u.includes('/api/capabilities'));

async function runPrompt(...args: string[]): Promise<void> {
  const { createPromptCommand } = await import('../../../../src/cli/commands/prompt');
  await createPromptCommand().parseAsync(['node', 'prompt', 'wt1', ...args]);
}

describe('[#3755] commandmate prompt', () => {
  it('--json prints the observation and exits 0', async () => {
    mockFetchSequence([{ data: frame(observation()) }]);
    await runPrompt('--json');

    expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    expect(JSON.parse(String(mockConsoleLog.mock.calls[0][0]))).toEqual(observation());
    expect(requestedUrls()[0]).toContain('/api/worktrees/wt1/current-output?observe=1');
  });

  it('exits 0 when nothing on screen asks (composer)', async () => {
    const composer = observation();
    composer.screen = { ...composer.screen!, kind: 'composer', token: null, tokenExpiresAt: null, tokenWithheld: 'no-decision', appearedAt: null, question: null, approvalTarget: null, options: [], selectedPosition: null, answerVia: 'none' };
    mockFetchSequence([{ data: frame(composer) }]);
    await runPrompt();

    expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    expect(String(mockConsoleLog.mock.calls[0][0])).toContain('kind: composer');
  });

  it('exits 0 for unknown, and says so', async () => {
    const unknown = observation();
    unknown.screen = { ...unknown.screen!, kind: 'unknown', token: null, tokenExpiresAt: null, tokenWithheld: 'unknown-screen', appearedAt: null };
    mockFetchSequence([{ data: frame(unknown) }]);
    await runPrompt();

    expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    expect(String(mockConsoleLog.mock.calls[0][0])).toContain('kind: unknown');
    expect(String(mockConsoleLog.mock.calls[0][0])).toContain('token: none (unknown-screen)');
  });

  it('exits 21 when there is no running session to read', async () => {
    mockFetchSequence([
      { data: frame(observation({ status: 'unavailable', unavailableReason: 'session-not-running', screen: null })) },
    ]);
    await runPrompt('--json');

    expect(mockExit).toHaveBeenCalledWith(VerifyExitCode.NOT_STARTED);
    expect(JSON.parse(String(mockConsoleLog.mock.calls[0][0])).status).toBe('unavailable');
  });

  it('fails loudly against a server that sends no observation', async () => {
    mockFetchSequence([{ data: frame() }]);
    await runPrompt('--json');

    expect(mockExit).toHaveBeenCalledWith(ExitCode.UNEXPECTED_ERROR);
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });

  it('prints the trust screen with its folder, options and token, and never reads a missing record as "can answer"', async () => {
    mockFetchSequence([{ data: frame(observation()) }]);
    await runPrompt();

    const text = String(mockConsoleLog.mock.calls[0][0]);
    expect(text).toContain('kind: antigravity-trust');
    expect(text).toContain('approval target: /work/project');
    expect(text).toContain('> 1. Yes, I trust this folder');
    expect(text).toContain('    2. No, exit');
    expect(text).toContain('token: po1.abc.');
    expect(text).toContain('a missing record does not mean Auto-Yes can answer');
    expect(text).toContain('contract re-evaluation: not-evaluated (no-parsed-prompt)');
  });

  it('declares --instance and --json, and documents the kinds and exit codes in --help', async () => {
    const { createPromptCommand } = await import('../../../../src/cli/commands/prompt');
    const cmd = createPromptCommand();
    expect(cmd.options.map((o) => o.long)).toEqual(expect.arrayContaining(['--instance', '--json', '--token']));
    let help = '';
    cmd.configureOutput({ writeOut: (s) => { help += s; } });
    cmd.outputHelp();
    expect(help).toContain('antigravity-trust');
    expect(help).toContain('21');
  });
});

describe('[#3755] wait adds the observation to exit 10', () => {
  async function runWait(): Promise<void> {
    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1']);
  }

  it('carries the observation of the same poll; exit 10 as before', async () => {
    mockFetchSequence([{ data: frame(observation()) }]);
    await runWait();

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    const payload = JSON.parse(String(mockConsoleLog.mock.calls[0][0]));
    expect(payload.type).toBe('selection_list');
    expect(payload.observation).toEqual(observation());
    // One request: the observation rides the poll, it is not a second read.
    expect(requestedUrls()).toHaveLength(1);
    expect(requestedUrls()[0]).toContain('observe=1');
  });

  it('negative: a server that sends none gets the payload it always got', async () => {
    mockFetchSequence([{ data: frame() }]);
    await runWait();

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    const payload = JSON.parse(String(mockConsoleLog.mock.calls[0][0]));
    expect('observation' in payload).toBe(false);
    expect(payload).toEqual({
      worktreeId: 'wt1',
      cliToolId: 'antigravity',
      type: 'selection_list',
      question: 'antigravity_selection_list',
      options: [],
      status: 'pending',
    });
  });
});
