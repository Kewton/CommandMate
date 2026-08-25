/**
 * `session.updated` reaching the telemetry record (Issue #2040).
 *
 * The frame maps to none of the seven event words, so it never reaches
 * `ingestOpencodeEvent` — which is exactly why it has to be read in `deliver`,
 * beside the `message.part.updated` tool-name memo that exists for the same
 * reason. This file is the wiring: the record is written from the stream, and
 * dropped when the subscription that filled it closes.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/sources/opencode/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode/client')>();
  return {
    ...actual,
    fetchOpencodePendingPermissions: vi.fn().mockResolvedValue([]),
    fetchOpencodePendingQuestions: vi.fn().mockResolvedValue([]),
    fetchOpencodeSessionStatuses: vi.fn().mockResolvedValue({}),
    probeOpencodeHealth: vi.fn(),
    openOpencodeEventStream: vi.fn(),
  };
});

import {
  openOpencodeEventStream,
  probeOpencodeHealth,
  type OpencodeFrame,
} from '@/lib/hooks/sources/opencode/client';
import {
  closeOpencodeSubscription,
  openOpencodeSubscription,
  resetOpencodeSubscriptions,
} from '@/lib/hooks/sources/opencode/subscription';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import { resetOpencodeToolCalls } from '@/lib/hooks/sources/opencode/payloads';
import {
  getAgentSessionTelemetry,
  resetAgentSessionTelemetry,
} from '@/lib/hooks/agent-session-telemetry';
import { resetUnknownEventTallies, type NormalizedAgentEvent } from '@/lib/hooks/sources';

const TARGET = { worktreeId: 'wt-tel', cliToolId: 'opencode', instanceId: 'opencode' } as const;
const PORT = 4242;

/** A `session.updated` frame, shaped as 1.18.22's `GET /doc` declares it. */
function sessionUpdated(info: Record<string, unknown> = {}): OpencodeFrame {
  return {
    id: 'evt_0000000000000000000000000',
    type: 'session.updated',
    properties: {
      sessionID: 'ses_0000000000000000000000000',
      info: {
        id: 'ses_0000000000000000000000000',
        title: 'Fix the flaky test',
        agent: 'build',
        model: { id: 'claude-sonnet-4.6', providerID: 'github-copilot' },
        cost: 1.5,
        tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 1, write: 2 } },
        ...info,
      },
    },
  } as unknown as OpencodeFrame;
}

let queued: Array<(signal: AbortSignal) => AsyncGenerator<OpencodeFrame>>;
let received: NormalizedAgentEvent[];

function streamOf(...frames: OpencodeFrame[]) {
  return async function* (): AsyncGenerator<OpencodeFrame> {
    for (const each of frames) yield each;
  };
}

function silentStream(signal: AbortSignal) {
  return async function* (): AsyncGenerator<OpencodeFrame> {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
  };
}

function subscribe() {
  return openOpencodeSubscription(
    TARGET,
    (event) => received.push(event),
    (raw) => opencodeAgentEventSource.normalizeEvent(raw),
    { port: PORT },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOpencodeSubscriptions();
  resetOpencodeToolCalls();
  resetUnknownEventTallies();
  resetAgentSessionTelemetry();
  queued = [];
  received = [];
  vi.mocked(probeOpencodeHealth).mockResolvedValue({
    kind: 'healthy',
    health: { healthy: true, version: '1.18.22' },
  });
  vi.mocked(openOpencodeEventStream).mockImplementation(
    async (_port: number, signal: AbortSignal) => (queued.shift() ?? silentStream(signal))(signal),
  );
});

afterEach(() => {
  resetOpencodeSubscriptions();
  resetAgentSessionTelemetry();
});

describe('session.updated', () => {
  it('records the session even though the frame maps to no event word', async () => {
    queued.push(streamOf(sessionUpdated()));
    await subscribe();

    await vi.waitFor(() => {
      expect(getAgentSessionTelemetry('wt-tel', 'opencode', 'opencode')).toMatchObject({
        id: 'ses_0000000000000000000000000',
        title: 'Fix the flaky test',
        agent: 'build',
        model: 'claude-sonnet-4.6',
        cost: 1.5,
      });
    });
    // The frame carries no word, so nothing was published as an event — which
    // is why reading it here rather than in `ingest` is the whole point.
    expect(received).toHaveLength(0);
  });

  it('ignores a sub-agent session so the pane keeps its own numbers', async () => {
    queued.push(streamOf(sessionUpdated(), sessionUpdated({ id: 'ses_child', parentID: 'ses_0000000000000000000000000', cost: 99 })));
    await subscribe();

    await vi.waitFor(() =>
      expect(getAgentSessionTelemetry('wt-tel', 'opencode', 'opencode')).not.toBeNull(),
    );
    // The child's 99 must not have overwritten the pane's 1.5.
    expect(getAgentSessionTelemetry('wt-tel', 'opencode', 'opencode')?.cost).toBe(1.5);
  });

  it('is dropped when the subscription closes', async () => {
    // The record describes a conversation a process was having, and closing the
    // subscription is what says the process is gone. Left behind, it would
    // report the previous session's cost against the next pane on this instance.
    queued.push(streamOf(sessionUpdated()));
    await subscribe();
    await vi.waitFor(() =>
      expect(getAgentSessionTelemetry('wt-tel', 'opencode', 'opencode')).not.toBeNull(),
    );

    await closeOpencodeSubscription(TARGET);

    expect(getAgentSessionTelemetry('wt-tel', 'opencode', 'opencode')).toBeNull();
  });
});
