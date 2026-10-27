/**
 * Issue #3956: under `--fail-on-upstream-fault`, a `hook_stop` completion is
 * judged on the pane once it has settled, not on the frame of the `Stop` poll.
 *
 * Measured 2026-10-27 on codex-cli 0.164.0 (UAT of #3945/#3946): `ask` returned
 * on `basis=hook_stop` with the pane ending at row 441–445 of 480, and the last
 * rows were drawn ~3 s later. A fault printed at the end of the turn is in those
 * rows. The pane, the server and the clock are mocked here (fake timers); the
 * live delay is for the UAT.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { WaitExitCode } from '../../../../src/cli/types';
import {
  HOOK_STOP_SETTLE_INTERVAL_MS,
  HOOK_STOP_SETTLE_MAX_MS,
} from '../../../../src/cli/commands/wait';

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

const FAULT_LINE = '■ Selected model is at capacity. Please try a different model.';

const readyBase = {
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
  cliToolId: 'codex',
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: false,
  sessionStatus: 'ready' as const,
  sessionStatusReason: 'input_prompt',
  upstreamFault: null as { id: string; matchedText: string; at: number } | null,
};

/** A frame of the pane: its text, and the fault the server read off it. */
const frame = (text: string, fault = false) => ({
  content: text,
  fullOutput: text,
  realtimeSnippet: text,
  upstreamFault: fault ? { id: 'model-capacity', matchedText: FAULT_LINE, at: Date.now() } : null,
});

/**
 * Hooks are live and the agent opened a turn; `stopped` adds its `Stop`. Built
 * in the same tick as the wait starts (fake timers), as in
 * wait-upstream-fault-1839.test.ts.
 */
const turn = (now: number, stopped: boolean, text: string, fault = false) => ({
  ...readyBase,
  ...frame(text, fault),
  lastStopEventAt: stopped ? now + 1_000 : now - 600_000,
  structuredEvents: {
    lastEventType: 'user_prompt_submit',
    lastEventAt: now,
    lastEventDetail: null,
    promptWaitingSince: null,
    promptWaitingSource: null,
  },
});

const importWait = async () =>
  (await import('../../../../src/cli/commands/wait')).createWaitCommand();

/** current-output reads, not counting the capability probe. */
const currentOutputReads = (): number =>
  vi.mocked(global.fetch).mock.calls.filter(c => String(c[0]).includes('/current-output')).length;

const stderrText = (): string => mockConsoleError.mock.calls.map(c => String(c[0])).join('\n');

describe('hook_stop settle under --fail-on-upstream-fault (Issue #3956)', () => {
  it('names its bounds: 500 ms between reads, at most 5 s', () => {
    expect(HOOK_STOP_SETTLE_INTERVAL_MS).toBe(500);
    expect(HOOK_STOP_SETTLE_MAX_MS).toBe(5000);
  });

  it('exits 11 when the fault is drawn after the Stop poll', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockFetchSequence([
      { data: turn(now, false, 'rows 1-200') },
      // The Stop poll: no fault on the frame yet.
      { data: turn(now, true, 'rows 1-445') },
      // Settle reads: still drawing, then the fault, then the same frame again.
      { data: turn(now, true, 'rows 1-480') },
      { data: turn(now, true, `rows 1-480\n${FAULT_LINE}`, true) },
      { data: turn(now, true, `rows 1-480\n${FAULT_LINE}`, true) },
    ]);

    const cmd = await importWait();
    const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--fail-on-upstream-fault']);
    await vi.advanceTimersByTimeAsync(12_000);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.UPSTREAM_FAULT);
    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(stderrText()).toContain('id=model-capacity');
    expect(stderrText()).not.toContain('Completed: wt1');
  });

  it('exits 0 on a clean turn, as soon as two reads agree (not at the bound)', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockFetchSequence([
      { data: turn(now, false, 'rows 1-200') },
      { data: turn(now, true, 'rows 1-480') },
      { data: turn(now, true, 'rows 1-480') },
    ]);

    const cmd = await importWait();
    let done = false;
    const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--fail-on-upstream-fault']).then(() => {
      done = true;
    });
    // One poll interval, then a single settle read.
    await vi.advanceTimersByTimeAsync(5_000 + HOOK_STOP_SETTLE_INTERVAL_MS);
    expect(done).toBe(true);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(stderrText()).toContain('Completed: wt1 (basis=hook_stop)');
    expect(currentOutputReads()).toBe(3);
  });

  it('stops at the bound while the pane keeps drawing, and judges the last frame', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const settleReads = HOOK_STOP_SETTLE_MAX_MS / HOOK_STOP_SETTLE_INTERVAL_MS;
    mockFetchSequence([
      { data: turn(now, false, 'rows 1-200') },
      { data: turn(now, true, 'row 0') },
      ...Array.from({ length: settleReads }, (_, i) => ({ data: turn(now, true, `row ${i + 1}`) })),
      // Past the bound: a fault would be here, and must not be read.
      { data: turn(now, true, FAULT_LINE, true) },
    ]);

    const cmd = await importWait();
    const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--fail-on-upstream-fault']);
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(currentOutputReads()).toBe(2 + settleReads);
    expect(stderrText()).toContain('still drawing 5s after its stop');
  });

  it('judges the last frame of the bound: a fault drawn on it exits 11', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const settleReads = HOOK_STOP_SETTLE_MAX_MS / HOOK_STOP_SETTLE_INTERVAL_MS;
    mockFetchSequence([
      { data: turn(now, false, 'rows 1-200') },
      { data: turn(now, true, 'row 0') },
      ...Array.from({ length: settleReads - 1 }, (_, i) => ({ data: turn(now, true, `row ${i + 1}`) })),
      { data: turn(now, true, FAULT_LINE, true) },
    ]);

    const cmd = await importWait();
    const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--fail-on-upstream-fault']);
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.UPSTREAM_FAULT);
  });

  it('without the flag, a hook_stop completion reads the pane no more times', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockFetchSequence([
      { data: turn(now, false, 'rows 1-200') },
      { data: turn(now, true, 'rows 1-445') },
      { data: turn(now, true, `rows 1-480\n${FAULT_LINE}`, true) },
    ]);

    const cmd = await importWait();
    const pending = cmd.parseAsync(['node', 'wait', 'wt1']);
    await vi.advanceTimersByTimeAsync(12_000);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(currentOutputReads()).toBe(2);
  });

  it('a completion that is not hook_stop (the pane alone) is not settled', async () => {
    // No hooks: basis=scraper_ready, judged on its own frame as before.
    mockFetchSequence([
      { data: { ...readyBase, ...frame('rows 1-445') } },
      { data: { ...readyBase, ...frame(FAULT_LINE, true) } },
    ]);

    const cmd = await importWait();
    await cmd.parseAsync(['node', 'wait', 'wt1', '--fail-on-upstream-fault']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(stderrText()).toContain('Completed: wt1 (basis=scraper_ready)');
    expect(currentOutputReads()).toBe(1);
  });

  it('pollWorktree (what `ask` calls, flag always on) returns the settled fault', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockFetchSequence([
      { data: turn(now, false, 'rows 1-200') },
      { data: turn(now, true, 'rows 1-445') },
      { data: turn(now, true, `rows 1-480\n${FAULT_LINE}`, true) },
      { data: turn(now, true, `rows 1-480\n${FAULT_LINE}`, true) },
    ]);

    const { pollWorktree } = await import('../../../../src/cli/commands/wait');
    const { ApiClient } = await import('../../../../src/cli/utils/api-client');
    const client = new ApiClient({ baseUrl: 'http://localhost:3000' });
    const pending = pollWorktree(client, 'wt1', { failOnUpstreamFault: true });
    await vi.advanceTimersByTimeAsync(12_000);
    const result = await pending;

    expect(result.exitCode).toBe(WaitExitCode.UPSTREAM_FAULT);
    expect(result.upstreamFault).toEqual({ id: 'model-capacity', matchedText: FAULT_LINE });
  });
});
