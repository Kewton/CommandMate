/**
 * The relay is not raised for a wait answered over the agent's API
 * (Issue #3184, design §6-2).
 *
 * Such a wait is now published as `prompt` (for the dots and the push body),
 * which is the kind the relay subscribes to. Its notice lists the stored row's
 * screen options, and an API-answered wait has none, so the relay keeps
 * ignoring it — relaying it is a separate Issue.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const notifyRelayPromptWaiting = vi.fn();

vi.mock('@/lib/relay/relay-delivery', () => ({
  notifyRelayPromptWaiting: (...a: unknown[]) => notifyRelayPromptWaiting(...(a as [])),
  notifyRelayTurnCompleted: vi.fn(async () => {}),
  runRelayMaintenanceTick: vi.fn(async () => {}),
}));

import { startRelayTriggers, stopRelayTriggers } from '@/lib/relay/relay-triggers';
import { clearWaitingEpisodes, observeWaitingEdge } from '@/lib/session/waiting-episode-state';
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';

const WT = 'wt-3184-relay';

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function openApproval(tool: 'opencode-v2' | 'claude'): void {
  recordAgentEvent(WT, tool, tool, {
    event: 'notification',
    at: Date.now() - 1_000,
    detail: 'permission_prompt',
    sessionId: 'ses-3184',
    message: 'edit hello.txt',
    decisionId: 'per_3184relayPermission000000',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearWaitingEpisodes();
  clearAgentStopEvents();
  stopRelayTriggers();
});

afterEach(() => {
  stopRelayTriggers();
});

describe('[#3184] relay and API-answered waits', () => {
  it('does not relay an OpenCode V2 approval published as prompt', async () => {
    startRelayTriggers();
    openApproval('opencode-v2');
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'opencode-v2', instanceId: 'opencode-v2', waiting: true, kind: 'prompt' });
    await flush();

    expect(notifyRelayPromptWaiting).not.toHaveBeenCalled();
  });

  it('positive control: a prompt the source cannot answer by id is still relayed', async () => {
    startRelayTriggers();
    openApproval('claude');
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude', waiting: true, kind: 'prompt' });
    await flush();

    expect(notifyRelayPromptWaiting).toHaveBeenCalledWith({
      worktreeId: WT,
      cliToolId: 'claude',
      instanceId: 'claude',
    });
  });
});
