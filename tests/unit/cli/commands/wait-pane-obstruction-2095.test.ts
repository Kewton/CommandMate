/**
 * Issue #2095: `wait` has to say WHY the frame is unreadable.
 *
 * The Issue text says `commandmate wait` never returns on an opencode pane whose
 * sidebar is on. Re-measured against the committed #2046 fixtures on 2026-08-27,
 * that is not what happens and the measurement wins: the sidebar frame reads
 * `running` / `unknown_frame`, which raises `isUnclassifiedActive`, and `wait`
 * has stopped on that since #1708 — exit 10 with `type: unclassified` after a
 * 60 s dwell. It returns. What it could not say was why, which left the operator
 * with `capture --pane` and a screen full of box drawing.
 *
 * So this Issue adds a cause to a message and moves NO exit code. These tests
 * pin both halves: the sentence is there, and 10 is still 10.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { WaitExitCode } from '../../../../src/cli/types';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  vi.useRealTimers();
});

/**
 * The payload `buildCurrentOutput` produces for
 * `tests/fixtures/opencode-live-2046/w80/sidebar-on.txt`, in the fields `wait`
 * reads. Verdicts and excerpt taken from
 * `tests/unit/lib/current-output-pane-obstruction-2095.test.ts`, which builds
 * this from the real frame through the real detector — this file is about the
 * command, not about the detection.
 */
const sidebarOnPayload = (overrides: Record<string, unknown> = {}) => ({
  isRunning: true,
  isComplete: false,
  isPromptWaiting: false,
  isGenerating: true,
  content: 'frame',
  fullOutput: 'frame',
  realtimeSnippet: 'frame',
  lineCount: 1,
  lastCapturedLine: 1,
  promptData: null,
  autoYes: { enabled: false, expiresAt: null },
  thinking: false,
  thinkingMessage: null,
  cliToolId: 'opencode',
  isSelectionListActive: false,
  isUnclassifiedActive: true,
  lastServerResponseTimestamp: null,
  serverPollerActive: false,
  sessionStatus: 'running' as const,
  sessionStatusReason: 'unknown_frame',
  upstreamFault: null,
  paneObstruction: {
    id: 'opencode_sidebar',
    matchedText: '/private/tmp/claude-501/-Users-',
    at: Date.now(),
  },
  ...overrides,
});

const importWait = async () =>
  (await import('../../../../src/cli/commands/wait')).createWaitCommand();

/** Hold the payload for the full 60 s dwell #1708 set, then read stderr. */
async function waitPastDwell(payload: Record<string, unknown>): Promise<string> {
  vi.useFakeTimers();
  mockFetchSequence(Array.from({ length: 20 }, () => ({ data: payload })));

  const cmd = await importWait();
  const pending = cmd.parseAsync(['node', 'wait', 'wt2095']);
  await vi.advanceTimersByTimeAsync(70_000);
  await pending;

  return mockConsoleError.mock.calls.map((c) => String(c[0])).join('\n');
}

describe('wait names the sidebar on an unclassified opencode frame (Issue #2095)', () => {
  it('reports the cause and the keystroke that fixes it', async () => {
    const stderr = await waitPastDwell(sidebarOnPayload());

    expect(stderr).toContain('Unclassified interactive frame on wt2095');
    expect(stderr).toContain('paneObstruction=opencode_sidebar');
    expect(stderr).toContain('sharing rows with the transcript');
    expect(stderr).toContain('ctrl+x b');
    // The excerpt rides along as the evidence, so the claim can be checked
    // against the pane the operator is being pointed at.
    expect(stderr).toContain('/private/tmp/claude-501/-Users-');
  });

  it('does NOT move the exit code — 10 with `type: unclassified`, exactly as #1708 defined it', async () => {
    // The published branch table. The skills dispatcher switches on these, and
    // #2095 is a message change: a session that exited 10 before this Issue must
    // exit 10 after it.
    await waitPastDwell(sidebarOnPayload());

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    expect(WaitExitCode.PROMPT_DETECTED).toBe(10);
    const emitted = JSON.parse(String(mockConsoleLog.mock.calls[0][0])) as { type: string };
    expect(emitted.type).toBe('unclassified');
  });

  it('prints the #1708 message unchanged when the server publishes no obstruction', async () => {
    // Two servers answer this way: one older than #2095, and one whose frame
    // carries no second column. Neither may see a word about a sidebar.
    const stderr = await waitPastDwell(sidebarOnPayload({ paneObstruction: undefined }));

    expect(stderr).toContain('Unclassified interactive frame on wt2095');
    expect(stderr).toContain('commandmate capture wt2095 --pane');
    expect(stderr).not.toContain('paneObstruction');
    expect(stderr).not.toContain('ctrl+x b');
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
  });

  it('says nothing about a sidebar on a healthy completion carrying the field as null', async () => {
    mockFetchSequence([
      {
        data: sidebarOnPayload({
          sessionStatus: 'ready',
          sessionStatusReason: 'opencode_response_complete',
          isUnclassifiedActive: false,
          isGenerating: false,
          paneObstruction: null,
        }),
      },
    ]);

    const cmd = await importWait();
    await cmd.parseAsync(['node', 'wait', 'wt2095']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(mockConsoleError.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(
      'ctrl+x b',
    );
  });
});
