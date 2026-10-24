/**
 * Issue #3881 (横展開 (b)): `wait`'s exit-10 payload copies the prompt's
 * fields one by one, and dropped `approvalTargetCompleteness` and `reading`
 * — so a `deny-pattern-unusable` withholding on a cut target reached the
 * pipeline with the cut target and no word that it was cut.
 *
 * Positive control (fails before): both fields are on the payload when the
 * server sent them. Negative control: a payload without them stays without
 * them (no `undefined` keys, the shape older servers get).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { WaitExitCode } from '../../../../src/cli/types';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
});

const READING = {
  version: 1,
  kind: 'permission',
  approvalTarget: 'truncated',
  evidence: ['yes-no-pattern'],
};

function waitingOn(promptData: Record<string, unknown>) {
  return {
    isRunning: true,
    isPromptWaiting: true,
    content: '',
    fullOutput: '',
    realtimeSnippet: '',
    lineCount: 1,
    lastCapturedLine: 1,
    promptData,
    autoYes: {
      enabled: true,
      expiresAt: null,
      lastSuppression: { reason: 'deny-pattern-unusable', mode: null, promptType: 'yes_no', at: Date.now() },
    },
    thinking: false,
    cliToolId: 'gemini',
    isSelectionListActive: false,
    lastServerResponseTimestamp: null,
    serverPollerActive: false,
    sessionStatus: 'waiting' as const,
  };
}

const YES_NO = {
  type: 'yes_no',
  question: 'Proceed?',
  options: ['yes', 'no'],
  status: 'pending',
  approvalTarget: 'Proceed? (y/n)',
};

async function exit10Payload(promptData: Record<string, unknown>): Promise<Record<string, unknown>> {
  mockFetchSequence([{ data: waitingOn(promptData) }]);
  const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
  await createWaitCommand().parseAsync(['node', 'wait', 'wt1']);
  expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
  return JSON.parse(mockConsoleLog.mock.calls[0][0]) as Record<string, unknown>;
}

describe('[#3881] wait carries the target\'s completeness and the reading', () => {
  it('copies both when the server sent them, beside the withholding', async () => {
    const output = await exit10Payload({ ...YES_NO, approvalTargetCompleteness: 'truncated', reading: READING });
    expect(output.approvalTarget).toBe('Proceed? (y/n)');
    expect(output.approvalTargetCompleteness).toBe('truncated');
    expect(output.reading).toEqual(READING);
    expect(output.autoYesSuppression).toMatchObject({ reason: 'deny-pattern-unusable' });
  });

  it('陰性対照: a payload without them stays without them', async () => {
    const output = await exit10Payload(YES_NO);
    expect('approvalTargetCompleteness' in output).toBe(false);
    expect('reading' in output).toBe(false);
  });
});
