/**
 * Issue #3798 (PR 3): `wait` holds the policy-suppression record against the
 * waiting episode it was written for (`docs/design/issue-3798-waiting-episode.md`
 * §6.4), as the push gate does.
 *
 * `autoYes.lastSuppression.episodeId` names the wait the record was written
 * for and `autoYes.waitingEpisodeId` the wait open when the payload was built.
 * Both present, the ids decide: another id (or no wait open) is a record of an
 * earlier wait however recent its `at`, the same id is this wait's however old.
 * Either one missing — a server older than the fields, a record written before
 * any wait was open — the 60 s window of #1699 / #2463 decides as before.
 *
 * Scaffold as in `commands/wait-auto-yes-grace-2463.test.ts`.
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../helpers/mock-api';
import { WaitExitCode } from '../../../src/cli/types';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

// Loaded under real timers, as in the #2463 suite.
beforeAll(async () => {
  await import('../../../src/cli/commands/wait');
  await import('../../../src/cli/utils/api-client');
});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  vi.useRealTimers();
});

const HOLD_LINE = "Prompt detected; the target's Auto-Yes is answering, waiting up to";

const baseOutput = {
  isRunning: true,
  isPromptWaiting: true,
  content: 'agy',
  fullOutput: 'agy',
  realtimeSnippet: '',
  lineCount: 1,
  lastCapturedLine: 1,
  thinking: false,
  cliToolId: 'antigravity',
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: true,
  sessionStatus: 'waiting' as const,
  sessionStatusReason: 'prompt_detected',
  promptData: {
    type: 'multiple_choice',
    question: 'Do you want to proceed?',
    options: [
      { number: 1, label: 'Yes, allow git log && npm test', isDefault: true },
      { number: 2, label: 'No' },
    ],
    status: 'pending',
  },
};

/** A prompt frame whose record was written at `at`, for `episodeId`, while `waitingEpisodeId` is open. */
function promptFrame(record: { at: number; episodeId?: string }, waitingEpisodeId?: string | null) {
  return {
    ...baseOutput,
    autoYes: {
      enabled: true,
      expiresAt: null,
      lastSuppression: {
        reason: 'deny-pattern',
        mode: 'allow-listed',
        promptType: 'multiple_choice',
        pattern: 'npm test',
        at: record.at,
        ...(record.episodeId !== undefined ? { episodeId: record.episodeId } : {}),
      },
      ...(waitingEpisodeId !== undefined ? { waitingEpisodeId } : {}),
    },
  };
}

const repeat = <T,>(data: T, times: number) => Array.from({ length: times }, () => ({ data }));
const stderr = () => mockConsoleError.mock.calls.map((c) => String(c[0])).join('\n');
const payload = () => JSON.parse(mockConsoleLog.mock.calls[0][0]) as { autoYesSuppression?: unknown };

async function startWait(): Promise<unknown> {
  const { createWaitCommand } = await import('../../../src/cli/commands/wait');
  return createWaitCommand().parseAsync(['node', 'wait', 'wt1']);
}

/** Wait until the grace runs out; the exit-10 payload then says whether the record counted. */
async function waitThroughGrace(frames: unknown[]): Promise<void> {
  vi.useFakeTimers();
  mockFetchSequence(frames.map((data) => ({ data })));
  const promise = startWait();
  await vi.advanceTimersByTimeAsync(35_000);
  await promise;
}

describe('[#3798] wait: the suppression record and the waiting episode', () => {
  it('different episode ids make the suppression stale', async () => {
    // Stamped a moment ago — the 60 s window alone would report it — but for another wait.
    await waitThroughGrace(repeat(promptFrame({ at: Date.now(), episodeId: 'wep-a' }, 'wep-b'), 12).map((f) => f.data));

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    expect(stderr()).toContain(HOLD_LINE);
    expect(payload().autoYesSuppression).toBeUndefined();
    expect(stderr()).not.toContain('auto-yes suppressed');
  });

  it('a record for a wait while none is open is stale too', async () => {
    await waitThroughGrace(repeat(promptFrame({ at: Date.now(), episodeId: 'wep-a' }, null), 12).map((f) => f.data));
    expect(payload().autoYesSuppression).toBeUndefined();
  });

  it('control: the same id is this wait\'s reason — exit 10 at once, however old the record', async () => {
    mockFetchSequence([{ data: promptFrame({ at: Date.now() - 10 * 60_000, episodeId: 'wep-a' }, 'wep-a') }]);
    await startWait();

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    expect(payload().autoYesSuppression).toMatchObject({ reason: 'deny-pattern', pattern: 'npm test' });
    expect(stderr()).not.toContain(HOLD_LINE);
  });

  it('missing ids fall back to the 60 s window', async () => {
    // The payload names no wait (an older server): a fresh record counts…
    mockFetchSequence([{ data: promptFrame({ at: Date.now(), episodeId: 'wep-a' }) }]);
    await startWait();
    expect(payload().autoYesSuppression).toMatchObject({ reason: 'deny-pattern' });
    mockConsoleLog.mockClear();
    mockExit.mockClear();
    restoreFetch();

    // …and so does a fresh record that names no wait, whatever wait is open…
    mockFetchSequence([{ data: promptFrame({ at: Date.now() }, 'wep-b') }]);
    await startWait();
    expect(payload().autoYesSuppression).toMatchObject({ reason: 'deny-pattern' });
    mockConsoleLog.mockClear();
    mockExit.mockClear();
    restoreFetch();

    // …while an old one does not.
    await waitThroughGrace(repeat(promptFrame({ at: Date.now() - 10 * 60_000 }, 'wep-b'), 12).map((f) => f.data));
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    expect(payload().autoYesSuppression).toBeUndefined();
  });
});
