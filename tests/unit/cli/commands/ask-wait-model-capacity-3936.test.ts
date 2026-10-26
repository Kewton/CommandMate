/**
 * Issue #3936: codex's "Selected model is at capacity" reaches `wait` / `ask`
 * as an upstream fault (exit 11), ahead of the turn-boundary gate that made a
 * consistency review wait out its 2400 s.
 *
 * The payload's `upstreamFault` is computed here the way current-output does
 * (`matchUpstreamFault(realtimeSnippet)`) from the SYNTHETIC capacity frame
 * (tests/fixtures/upstream-faults/README.md), so the rule and the CLI are
 * exercised together; the frame itself is not a measured codex screen.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';
import { ExitCode, WaitExitCode } from '../../../../src/cli/types';
import { matchUpstreamFault } from '@/lib/detection/upstream-faults';
import { buildRealtimeSnippet } from '@/lib/realtime-snippet';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

const NOW = 1_787_500_000_000;
const DRAIN_MS = 90_000;

const FRAME = readFileSync(
  join(__dirname, '../../../fixtures/upstream-faults/codex-model-capacity-3936.txt'),
  'utf8',
);
const SNIPPET = buildRealtimeSnippet(FRAME);

/** `upstreamFault` as current-output-builder publishes it for this frame. */
function faultOf(snippet: string): { id: string; matchedText: string; at: number } | null {
  const match = matchUpstreamFault(snippet);
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
const payload = (snippet: string) => ({
  isRunning: true,
  isPromptWaiting: false,
  content: snippet,
  fullOutput: FRAME,
  realtimeSnippet: snippet,
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
  upstreamFault: faultOf(snippet),
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

function startServer(snippet: string): void {
  global.fetch = vi.fn((input: unknown) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/capabilities') {
      return Promise.resolve(json({ serverVersion: '0.0.0-test', capabilities: [] }));
    }
    if (url.pathname.endsWith('/send')) return Promise.resolve(json({ id: 1 }, 201));
    if (url.pathname.endsWith('/current-output')) return Promise.resolve(json(payload(snippet)));
    if (url.pathname.endsWith('/messages')) return Promise.resolve(json([]));
    if (url.pathname.endsWith('/capture')) return Promise.resolve(json({ output: 'pane text' }));
    return Promise.resolve(json({ error: `unexpected ${url.pathname}` }, 404));
  }) as unknown as typeof fetch;
}

const stderr = (): string => mockConsoleError.mock.calls.map((c) => String(c[0])).join('\n');

describe('wait --fail-on-upstream-fault on codex capacity (Issue #3936)', () => {
  it('exits 11 with id=model-capacity although the turn has no Stop', async () => {
    startServer(SNIPPET);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const pending = createWaitCommand().parseAsync(['node', 'wait', 'wt1', '--instance', 'codex', '--fail-on-upstream-fault']);
    await vi.advanceTimersByTimeAsync(6_000);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.UPSTREAM_FAULT);
    expect(stderr()).toContain('id=model-capacity');
    expect(stderr()).toContain('Selected model is at capacity');
    // Not the context-limit advice: a fresh session of the same model does not help.
    expect(stderr()).not.toContain('instances wt1 kill');
    expect(stderr()).not.toContain('has not reported the end of this turn');
  });

  it('negative control: the same frame without the capacity line waits on the turn boundary', async () => {
    const healthy = SNIPPET.replace(/^■ Selected model is at capacity.*$/m, '');
    expect(faultOf(healthy)).toBeNull();
    startServer(healthy);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const pending = createWaitCommand().parseAsync([
      'node', 'wait', 'wt1', '--instance', 'codex', '--fail-on-upstream-fault', '--timeout', '20',
    ]);
    await vi.advanceTimersByTimeAsync(25_000);
    await pending;

    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.UPSTREAM_FAULT);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
    expect(stderr()).toContain('has not reported the end of this turn');
  });
});

async function runAsk(argv: string[]): Promise<void> {
  const { createAskCommand } = await import('../../../../src/cli/commands/ask');
  const pending = createAskCommand().parseAsync(['node', 'ask', 'wt1', ...argv]);
  await vi.advanceTimersByTimeAsync(DRAIN_MS);
  await pending;
}

describe('ask on codex capacity (Issue #3936)', () => {
  it('exits 11 and puts upstreamFault.id=model-capacity on --json stdout', async () => {
    startServer(SNIPPET);

    await runAsk(['review this', '--instance', 'codex', '--json']);

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.UPSTREAM_FAULT);
    expect(mockExit).not.toHaveBeenCalledWith(ExitCode.SUCCESS);
    const printed = mockConsoleLog.mock.calls.map((c) => JSON.parse(String(c[0])));
    const fault = printed.find((p) => p.upstreamFault)?.upstreamFault;
    expect(fault?.id).toBe('model-capacity');
    expect(fault?.matchedText).toContain('Selected model is at capacity');
  });
});
