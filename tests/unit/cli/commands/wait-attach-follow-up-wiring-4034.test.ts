/**
 * Issue #4034 (item 1): the #3982 follow-up hints are checked where they are
 * assembled, not only in the helpers they are built from.
 *
 * `wait-attach-follow-up-target-3982.test.ts` compares `followUpCommand(...)`
 * strings and calls `buildAttachHints` with a ready-made target, so neither
 * `wait.ts`'s `waitCommandTarget(poll.options)` wiring nor `attach.ts`'s
 * "name the instance only when --instance was given" rule is under test. Here
 * the output goes through `pollWorktree` and the `attach` action.
 *
 * Positive controls: the hint names the instance / agent asked for. Negative
 * controls: with no flag, none is named (the server echoes the default
 * instance, and that must not leak into the hint).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { ApiClient } from '../../../../src/cli/utils/api-client';

vi.mock('child_process', () => ({
  spawnSync: () => ({ status: 0 }),
}));

vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit');
}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

function stderr(): string {
  return mockConsoleError.mock.calls.map((call) => String(call[0])).join('\n');
}

beforeEach(() => {
  delete process.env.TMUX;
});

afterEach(() => {
  restoreFetch();
  vi.useRealTimers();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

/** Hooks are live and the agent opened a turn, but has reported no `Stop`. */
function turnOpen() {
  const now = Date.now();
  return {
    isRunning: true,
    isPromptWaiting: false,
    content: 'frame',
    fullOutput: 'frame',
    realtimeSnippet: 'frame',
    lineCount: 1,
    lastCapturedLine: 1,
    promptData: null,
    autoYes: { enabled: false, expiresAt: null },
    thinking: false,
    cliToolId: 'claude',
    isSelectionListActive: false,
    lastServerResponseTimestamp: null,
    serverPollerActive: false,
    sessionStatus: 'ready' as const,
    sessionStatusReason: 'input_prompt',
    lastStopEventAt: now - 600_000,
    structuredEvents: {
      lastEventType: 'user_prompt_submit',
      lastEventAt: now,
      lastEventDetail: null,
      promptWaitingSince: null,
      promptWaitingSource: null,
    },
  };
}

async function turnNotReportedHint(options: Record<string, unknown>): Promise<string> {
  vi.useFakeTimers();
  mockFetchSequence(Array.from({ length: 6 }, () => ({ data: turnOpen() })));
  const { pollWorktree } = await import('../../../../src/cli/commands/wait');
  const promise = pollWorktree(new ApiClient({}), 'wt1', { ...options, timeout: 20 });
  await vi.advanceTimersByTimeAsync(25_000);
  await promise;
  const line = mockConsoleError.mock.calls
    .map((call) => String(call[0]))
    .find((text) => text.includes('has not reported the end of this turn'));
  return line ?? '';
}

describe('[#4034] wait: the "turn not reported" hint, through pollWorktree', () => {
  it('positive: names the instance waited on', async () => {
    const line = await turnNotReportedHint({ instance: 'codex-2' });
    expect(line).toContain('`commandmate capture wt1 --instance codex-2 --json`');
  });

  it('negative: with no instance it names none', async () => {
    const line = await turnNotReportedHint({});
    expect(line).toContain('`commandmate capture wt1 --json`');
    expect(line).not.toContain('--instance');
  });
});

function resolved(cliToolId: string, instanceId: string) {
  return { data: { cliToolId, instanceId, resolvedBy: 'worktree-default', conflict: null } };
}

async function runAttach(argv: string[], sessionName: string, instanceId: string): Promise<string> {
  mockFetchSequence([
    resolved('claude', instanceId),
    { data: { agentInstances: [{ id: instanceId, cliToolId: 'claude', sessionName }] } },
    { data: { output: '' } },
  ]);
  const { createAttachCommand } = await import('../../../../src/cli/commands/attach');
  try {
    await createAttachCommand().parseAsync(['node', 'attach', ...argv]);
  } catch (error) {
    if ((error as Error).message !== 'process.exit') throw error;
  }
  return stderr();
}

describe('[#4034] attach: the capture hints, through the action', () => {
  it('positive: --instance names the instance the server resolved', async () => {
    const out = await runAttach(['wt1', '--instance', 'claude-2'], 'mcbd-claude-wt1-2', 'claude-2');
    expect(out).toContain('commandmate capture wt1 --instance claude-2 --pane --tail 60');
    expect(out).not.toContain('--agent');
  });

  it('positive: --agent alone names the agent, not an instance', async () => {
    const out = await runAttach(['wt1', '--agent', 'claude'], 'mcbd-claude-wt1', 'claude');
    expect(out).toContain('commandmate capture wt1 --agent claude --pane --tail 60');
    expect(out).not.toContain('--instance');
  });

  it('negative: no flag names nothing, although the server echoes the default instance', async () => {
    const out = await runAttach(['wt1'], 'mcbd-claude-wt1', 'claude');
    expect(out).toContain('commandmate capture wt1 --pane --tail 60');
    expect(out).not.toContain('--instance');
    expect(out).not.toContain('--agent');
  });
});
