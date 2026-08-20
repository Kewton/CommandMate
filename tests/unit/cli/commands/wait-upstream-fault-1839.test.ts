/**
 * Issue #1839: `wait` must be able to tell "the turn finished" from "the turn
 * never ran".
 *
 * Both halves are measured, not imagined. On 2026-08-20 a real `claude` 2.1.236
 * was pointed at a stub upstream answering 529 (no real API call) inside a
 * private tmux server, and produced exactly the shape below:
 *
 *   +0.6 s  UserPromptSubmit hook
 *   +0.6 s  four POSTs to the stub, all 529
 *   +3 s    scraper reads `ready` / `input_prompt`, pane carries
 *           `API Error: Repeated 529 Overloaded errors …`
 *   ever    NO Stop hook
 *   +62 s   Notification(idle_prompt) — "Claude is waiting for your input"
 *
 * See docs/design/upstream-fault-turn-boundary-1839.md.
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

const MEASURED_529_LINE =
  '⏺ API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary.';

/** A session at its composer: what every path below starts from. */
const readyBase = {
  isRunning: true,
  isComplete: false,
  isPromptWaiting: false,
  isGenerating: false,
  content: 'frame',
  fullOutput: 'frame',
  realtimeSnippet: 'frame',
  lineCount: 1,
  lastCapturedLine: 1,
  promptData: null,
  autoYes: { enabled: false, expiresAt: null },
  thinking: false,
  thinkingMessage: null,
  cliToolId: 'claude',
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: false,
  sessionStatus: 'ready' as const,
  sessionStatusReason: 'input_prompt',
  upstreamFault: null as { id: string; matchedText: string; at: number } | null,
};

const withFault = () => ({
  ...readyBase,
  realtimeSnippet: MEASURED_529_LINE,
  upstreamFault: { id: 'overloaded', matchedText: MEASURED_529_LINE, at: Date.now() },
});

/** Hooks are live and the agent opened a turn, but has reported no `Stop`. */
const turnOpen = (overrides: Record<string, unknown> = {}) => {
  const now = Date.now();
  return {
    ...readyBase,
    // Older than this wait's start: the previous turn's Stop, not this one's.
    lastStopEventAt: now - 600_000,
    structuredEvents: {
      lastEventType: 'user_prompt_submit',
      lastEventAt: now,
      lastEventDetail: null,
      promptWaitingSince: null,
      promptWaitingSource: null,
    },
    ...overrides,
  };
};

const importWait = async () =>
  (await import('../../../../src/cli/commands/wait')).createWaitCommand();

describe('--fail-on-upstream-fault (Issue #1839)', () => {
  it('exits 11 when the agent is back at its composer with a 529 on the frame', async () => {
    mockFetchSequence([{ data: withFault() }]);

    const cmd = await importWait();
    await cmd.parseAsync(['node', 'wait', 'wt1', '--fail-on-upstream-fault']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.UPSTREAM_FAULT);
    expect(WaitExitCode.UPSTREAM_FAULT).toBe(11);
  });

  it('names the signature and the line on stderr', async () => {
    mockFetchSequence([{ data: withFault() }]);

    const cmd = await importWait();
    await cmd.parseAsync(['node', 'wait', 'wt1', '--fail-on-upstream-fault']);

    const stderr = mockConsoleError.mock.calls.map(c => String(c[0])).join('\n');
    expect(stderr).toContain('id=overloaded');
    expect(stderr).toContain('529 Overloaded');
  });

  it('BY DEFAULT still exits 0 on the very same payload', async () => {
    // The exit codes are a published branch table (the skills dispatcher reads
    // them). Anything that changes without the flag breaks callers that never
    // asked for this.
    mockFetchSequence([{ data: withFault() }]);

    const cmd = await importWait();
    await cmd.parseAsync(['node', 'wait', 'wt1']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });

  it('does not fire on a clean completion even with the flag on', async () => {
    mockFetchSequence([{ data: readyBase }]);

    const cmd = await importWait();
    await cmd.parseAsync(['node', 'wait', 'wt1', '--fail-on-upstream-fault']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });
});

describe('turn boundary from the agent’s own Stop (Issue #1839)', () => {
  it('does NOT report completion while `ready` has no Stop newer than the send', async () => {
    vi.useFakeTimers();
    // Six identical polls: the scraper is certain, and it is certain of the
    // wrong thing. Measured: this state persists for the whole life of the
    // faulted session.
    mockFetchSequence(Array.from({ length: 6 }, () => ({ data: turnOpen() })));

    const cmd = await importWait();
    const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--timeout', '20']);
    await vi.advanceTimersByTimeAsync(25_000);
    await pending;

    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
    expect(mockConsoleError.mock.calls.map(c => String(c[0])).join('\n')).toContain(
      'has not reported the end of this turn',
    );
  });

  it('reports completion as soon as the Stop arrives, with basis=hook_stop', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockFetchSequence([
      { data: turnOpen() },
      // The same turn, now ended by the agent's own report.
      { data: turnOpen({ lastStopEventAt: now + 1_000 }) },
    ]);

    const cmd = await importWait();
    const pending = cmd.parseAsync(['node', 'wait', 'wt1']);
    await vi.advanceTimersByTimeAsync(6_000);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    const stderr = mockConsoleError.mock.calls.map(c => String(c[0]));
    expect(stderr.join('\n')).toContain('Completed: wt1 (basis=hook_stop)');
    // The gate has to have HELD on poll 1 and released on poll 2. Without this
    // the test also passes when the stale Stop of the previous turn is accepted,
    // which is the exact confusion the comparison exists to prevent.
    expect(stderr[0]).toContain('has not reported the end of this turn');
  });

  it('exits 11 rather than hanging when the flag explains the missing Stop', async () => {
    // The two halves together: hooks say the turn never ended, the frame says
    // why. Without the flag this same session runs to --timeout.
    mockFetchSequence([{ data: { ...turnOpen(), ...withFault() } }]);

    const cmd = await importWait();
    await cmd.parseAsync(['node', 'wait', 'wt1', '--fail-on-upstream-fault']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.UPSTREAM_FAULT);
  });

  it('ignores a turn-opening event that predates this wait', async () => {
    // Structured events are NOT generation-fenced on the wire, so a stale
    // `user_prompt_submit` from a previous agent process can be the last event.
    // Adopting it would hang a `wait` on an already-idle session forever.
    const stale = turnOpen({
      structuredEvents: {
        lastEventType: 'user_prompt_submit',
        lastEventAt: Date.now() - 600_000,
        lastEventDetail: null,
        promptWaitingSince: null,
        promptWaitingSource: null,
      },
    });
    mockFetchSequence([{ data: stale }]);

    const cmd = await importWait();
    await cmd.parseAsync(['node', 'wait', 'wt1']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(mockConsoleError.mock.calls.map(c => String(c[0])).join('\n')).toContain(
      'basis=scraper_ready',
    );
  });

  it('does not treat Notification(idle_prompt) as the end of a turn', async () => {
    vi.useFakeTimers();
    // MEASURED DEVIATION from the design sketched in Issue #1839, which proposed
    // `stop` OR `idle_prompt`. Claude fires idle_prompt 62 s into a turn that ran
    // nothing, purely because the composer sat idle — reading it as a boundary
    // reinstates the false completion one minute later.
    const now = Date.now();
    const idle = turnOpen({
      structuredEvents: {
        lastEventType: 'notification',
        lastEventAt: now + 62_000,
        lastEventDetail: 'idle_prompt',
        promptWaitingSince: null,
        promptWaitingSource: null,
      },
    });
    mockFetchSequence([{ data: turnOpen() }, { data: idle }, { data: idle }, { data: idle }]);

    const cmd = await importWait();
    const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--timeout', '15']);
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;

    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
  });
});

describe('completion basis on stderr (Issue #1839)', () => {
  it('says scraper_ready when nothing but the screen reported it', async () => {
    mockFetchSequence([{ data: readyBase }]);

    const cmd = await importWait();
    await cmd.parseAsync(['node', 'wait', 'wt1']);

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('Completed: wt1 (basis=scraper_ready)'),
    );
  });

  it('says session_gone when the tmux session went away', async () => {
    vi.useFakeTimers();
    mockFetchSequence([
      { data: { ...readyBase, sessionStatus: 'running' as const } },
      { data: { ...readyBase, isRunning: false, sessionStatus: 'idle' as const } },
    ]);

    const cmd = await importWait();
    const pending = cmd.parseAsync(['node', 'wait', 'wt1']);
    await vi.advanceTimersByTimeAsync(6_000);
    await pending;

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('Completed: wt1 (basis=session_gone)'),
    );
  });
});
