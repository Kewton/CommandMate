/**
 * Issue #3946: on codex 0.160's split screen the capacity row is above
 * `realtimeSnippet`, and still reaches `wait` / `ask` as exit 11 — while a
 * healthy next turn after it does not.
 *
 * The payload's `upstreamFault` is computed the way current-output does
 * (`matchPaneUpstreamFault(lines, 'codex')`) from the SYNTHETIC 0.160 frames
 * (tests/fixtures/upstream-faults/README.md).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';
import { ExitCode, WaitExitCode } from '../../../../src/cli/types';
import { buildRealtimeSnippet, matchPaneUpstreamFault } from '@/lib/realtime-snippet';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

const NOW = 1_787_500_000_000;
const DRAIN_MS = 90_000;

const read = (name: string): string =>
  readFileSync(join(__dirname, '../../../fixtures/upstream-faults', name), 'utf8');
const FRAME = read('codex-0.160.0-model-capacity-3946.txt');
const NEXT_TURN_FRAME = read('codex-0.160.0-model-capacity-next-turn-3946.txt');

/** `upstreamFault` as current-output-builder publishes it for this frame. */
function faultOf(frame: string): { id: string; matchedText: string; at: number } | null {
  const match = matchPaneUpstreamFault(frame.split('\n'), 'codex');
  return match ? { id: match.fault.id, matchedText: match.matchedText, at: NOW } : null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  vi.useRealTimers();
});

/** codex back at its composer; hooks opened a turn and reported no Stop for it. */
const payload = (frame: string) => ({
  isRunning: true,
  isPromptWaiting: false,
  content: buildRealtimeSnippet(frame),
  fullOutput: frame,
  realtimeSnippet: buildRealtimeSnippet(frame),
  lineCount: 1002,
  lastCapturedLine: 1002,
  promptData: null,
  autoYes: { enabled: false, expiresAt: null },
  thinking: false,
  cliToolId: 'codex',
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: false,
  sessionStatus: 'ready' as const,
  sessionStatusReason: 'input_prompt',
  lastStopEventAt: NOW - 600_000,
  structuredEvents: {
    lastEventType: 'user_prompt_submit',
    lastEventAt: NOW + 1_000,
    lastEventDetail: null,
    promptWaitingSince: null,
    promptWaitingSource: null,
  },
  upstreamFault: faultOf(frame),
});

const json = (data: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }) as unknown as Response;

function startServer(frame: string): void {
  global.fetch = vi.fn((input: unknown) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/capabilities') {
      return Promise.resolve(json({ serverVersion: '0.0.0-test', capabilities: [] }));
    }
    if (url.pathname.endsWith('/send')) return Promise.resolve(json({ id: 1 }, 201));
    if (url.pathname.endsWith('/current-output')) return Promise.resolve(json(payload(frame)));
    if (url.pathname.endsWith('/messages')) return Promise.resolve(json([]));
    if (url.pathname.endsWith('/capture')) return Promise.resolve(json({ output: 'pane text' }));
    return Promise.resolve(json({ error: `unexpected ${url.pathname}` }, 404));
  }) as unknown as typeof fetch;
}

const stderr = (): string => mockConsoleError.mock.calls.map((c) => String(c[0])).join('\n');

describe('wait --fail-on-upstream-fault on codex 0.160 split screen (Issue #3946)', () => {
  it('premise: the capacity row is not in realtimeSnippet', () => {
    expect(buildRealtimeSnippet(FRAME)).not.toContain('Selected model is at capacity');
    expect(faultOf(FRAME)?.id).toBe('model-capacity');
  });

  it('exits 11 with id=model-capacity', async () => {
    startServer(FRAME);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const pending = createWaitCommand().parseAsync(['node', 'wait', 'wt1', '--instance', 'codex', '--fail-on-upstream-fault']);
    await vi.advanceTimersByTimeAsync(6_000);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.UPSTREAM_FAULT);
    expect(stderr()).toContain('id=model-capacity');
    expect(stderr()).toContain('Selected model is at capacity');
  });

  it('past turn: a healthy next turn after the capacity row does not exit 11', async () => {
    expect(faultOf(NEXT_TURN_FRAME)).toBeNull();
    startServer(NEXT_TURN_FRAME);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const pending = createWaitCommand().parseAsync([
      'node', 'wait', 'wt1', '--instance', 'codex', '--fail-on-upstream-fault', '--timeout', '20',
    ]);
    await vi.advanceTimersByTimeAsync(25_000);
    await pending;

    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.UPSTREAM_FAULT);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
  });
});

async function runAsk(argv: string[]): Promise<void> {
  const { createAskCommand } = await import('../../../../src/cli/commands/ask');
  const pending = createAskCommand().parseAsync(['node', 'ask', 'wt1', ...argv]);
  await vi.advanceTimersByTimeAsync(DRAIN_MS);
  await pending;
}

describe('ask on codex 0.160 split screen (Issue #3946)', () => {
  it('exits 11 and puts upstreamFault.id=model-capacity on --json stdout', async () => {
    startServer(FRAME);

    await runAsk(['review this', '--instance', 'codex', '--json']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.UPSTREAM_FAULT);
    expect(mockExit).not.toHaveBeenCalledWith(ExitCode.SUCCESS);
    const printed = mockConsoleLog.mock.calls.map((c) => JSON.parse(String(c[0])));
    const fault = printed.find((p) => p.upstreamFault)?.upstreamFault;
    expect(fault?.id).toBe('model-capacity');
    expect(fault?.matchedText).toContain('Selected model is at capacity');
  });
});
