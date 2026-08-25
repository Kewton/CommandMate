/**
 * The context measurement that hangs off the session record (Issue #2042).
 *
 * Three properties, each of which the payload would be wrong without:
 *
 *  - **It never blocks the caller.** `buildCurrentOutput` runs on every terminal
 *    pane poll — twice a second per open split — and this needs two HTTP round
 *    trips to a process CommandMate did not start. `ensureAgentSessionContextUsage`
 *    therefore answers from a cache and refreshes behind it.
 *  - **It refreshes per turn, not per poll.** Staleness is the session record's
 *    `at`, which moves when the agent speaks, so a session nobody is talking to
 *    makes no requests at all.
 *  - **It dies with the record it describes.** A pane that was killed must not
 *    keep reporting how full its context was.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchOpencodeContextTokens = vi.fn();
const fetchOpencodeModelContextLimit = vi.fn();
const getAssignedOpencodePort = vi.fn();

vi.mock('@/lib/hooks/sources/opencode/client', () => ({
  fetchOpencodeContextTokens: (...args: unknown[]) => fetchOpencodeContextTokens(...args),
  fetchOpencodeModelContextLimit: (...args: unknown[]) => fetchOpencodeModelContextLimit(...args),
}));
vi.mock('@/lib/hooks/sources/opencode/ports', () => ({
  getAssignedOpencodePort: (...args: unknown[]) => getAssignedOpencodePort(...args),
}));

import {
  agentSessionContextPercent,
  ensureAgentSessionContextUsage,
  forgetAgentSessionTelemetry,
  getAgentSessionContextUsage,
  recordAgentSessionTelemetry,
  refreshAgentSessionContextUsage,
  resetAgentSessionContextUsage,
  resetAgentSessionTelemetry,
  type AgentSessionRecord,
} from '@/lib/hooks/agent-session-telemetry';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';

const TARGET: AgentInstanceRef = {
  worktreeId: 'wt-1',
  cliToolId: 'opencode',
  instanceId: 'opencode',
};

/** The measured session, at the instant its second turn ended (§14.2). */
function sessionRecord(at = 1_000): AgentSessionRecord {
  return {
    id: 'ses_measured',
    title: 'One-word response: PONG',
    agent: 'build',
    model: 'claude-sonnet-4.6',
    provider: 'github-copilot',
    cost: 0.0346026,
    tokens: {
      input: 6,
      output: 11,
      reasoning: 0,
      cacheRead: 8482,
      cacheWrite: 8500,
      total: null,
    },
    at,
  };
}

/** Let the fire-and-forget refresh settle without a timer. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAgentSessionTelemetry();
  resetAgentSessionContextUsage();
  getAssignedOpencodePort.mockReturnValue(4242);
  fetchOpencodeContextTokens.mockResolvedValue(8_508);
  fetchOpencodeModelContextLimit.mockResolvedValue(1_000_000);
});

afterEach(() => {
  resetAgentSessionTelemetry();
  resetAgentSessionContextUsage();
});

describe('agentSessionContextPercent', () => {
  it('reproduces the percentage opencode printed for the measured session', () => {
    // 8,508 / 1,000,000 → 0.85% → `1% used` in the TUI's own sidebar.
    expect(agentSessionContextPercent(8_508, 1_000_000)).toBe(1);
  });

  it('rounds rather than ceils, so a nearly-empty window reads 0%', () => {
    // The distinction the bundle settles: `Math.round`, not `Math.ceil`. A
    // session holding 0.4% would otherwise be advertised as 1% full forever.
    expect(agentSessionContextPercent(4_000, 1_000_000)).toBe(0);
    expect(agentSessionContextPercent(5_000, 1_000_000)).toBe(1);
  });

  it('answers null when either half is unknown', () => {
    expect(agentSessionContextPercent(null, 1_000_000)).toBeNull();
    expect(agentSessionContextPercent(8_508, null)).toBeNull();
    expect(agentSessionContextPercent(null, null)).toBeNull();
  });

  it('answers null for a non-positive limit instead of dividing by it', () => {
    expect(agentSessionContextPercent(8_508, 0)).toBeNull();
    expect(agentSessionContextPercent(8_508, -1)).toBeNull();
  });
});

describe('ensureAgentSessionContextUsage', () => {
  it('answers null on the first call and does not await the fetch', () => {
    expect(ensureAgentSessionContextUsage(TARGET, sessionRecord())).toBeNull();
  });

  it('publishes the measurement on the next call', async () => {
    ensureAgentSessionContextUsage(TARGET, sessionRecord());
    await settle();
    expect(ensureAgentSessionContextUsage(TARGET, sessionRecord())).toEqual(
      expect.objectContaining({ tokens: 8_508, limit: 1_000_000, percent: 1, sessionAt: 1_000 })
    );
  });

  it('makes ONE pair of requests across a burst of polls', async () => {
    for (let poll = 0; poll < 10; poll += 1) {
      ensureAgentSessionContextUsage(TARGET, sessionRecord());
    }
    await settle();
    expect(fetchOpencodeContextTokens).toHaveBeenCalledTimes(1);
    expect(fetchOpencodeModelContextLimit).toHaveBeenCalledTimes(1);
  });

  it('does not re-ask while the session record has not moved', async () => {
    ensureAgentSessionContextUsage(TARGET, sessionRecord());
    await settle();
    for (let poll = 0; poll < 10; poll += 1) {
      ensureAgentSessionContextUsage(TARGET, sessionRecord());
    }
    await settle();
    expect(fetchOpencodeContextTokens).toHaveBeenCalledTimes(1);
  });

  it('re-asks once the agent has spoken again', async () => {
    ensureAgentSessionContextUsage(TARGET, sessionRecord(1_000));
    await settle();
    fetchOpencodeContextTokens.mockResolvedValue(20_000);
    ensureAgentSessionContextUsage(TARGET, sessionRecord(2_000));
    await settle();
    expect(fetchOpencodeContextTokens).toHaveBeenCalledTimes(2);
    expect(ensureAgentSessionContextUsage(TARGET, sessionRecord(2_000))).toEqual(
      expect.objectContaining({ tokens: 20_000, percent: 2, sessionAt: 2_000 })
    );
  });

  it('keeps serving the previous turn’s numbers while the new ones are in flight', async () => {
    ensureAgentSessionContextUsage(TARGET, sessionRecord(1_000));
    await settle();
    // A turn just ended; the refresh for it has not resolved yet.
    let release: () => void = () => {};
    fetchOpencodeContextTokens.mockReturnValue(
      new Promise<number>((resolve) => {
        release = () => resolve(20_000);
      })
    );
    expect(ensureAgentSessionContextUsage(TARGET, sessionRecord(2_000))).toEqual(
      expect.objectContaining({ tokens: 8_508, sessionAt: 1_000 })
    );
    release();
    await settle();
    expect(ensureAgentSessionContextUsage(TARGET, sessionRecord(2_000))?.sessionAt).toBe(2_000);
  });

  it('asks nothing at all when the agent has published no session', async () => {
    expect(ensureAgentSessionContextUsage(TARGET, null)).toBeNull();
    await settle();
    expect(fetchOpencodeContextTokens).not.toHaveBeenCalled();
    expect(getAssignedOpencodePort).not.toHaveBeenCalled();
  });

  it('asks nothing when the agent named no session id', async () => {
    ensureAgentSessionContextUsage(TARGET, { ...sessionRecord(), id: null });
    await settle();
    expect(fetchOpencodeContextTokens).not.toHaveBeenCalled();
  });

  it('records a dated pair of nulls so a fruitless ask is not repeated', async () => {
    fetchOpencodeContextTokens.mockResolvedValue(null);
    fetchOpencodeModelContextLimit.mockResolvedValue(null);
    ensureAgentSessionContextUsage(TARGET, sessionRecord());
    await settle();
    expect(ensureAgentSessionContextUsage(TARGET, sessionRecord())).toEqual(
      expect.objectContaining({ tokens: null, limit: null, percent: null, sessionAt: 1_000 })
    );
    await settle();
    expect(fetchOpencodeContextTokens).toHaveBeenCalledTimes(1);
  });

  it('publishes the token count even when the model has no known window', async () => {
    fetchOpencodeModelContextLimit.mockResolvedValue(null);
    ensureAgentSessionContextUsage(TARGET, sessionRecord());
    await settle();
    // "8,508 tokens, share of the window unknown" is a true statement and a
    // useful one; dropping it because the percentage is unavailable is not.
    expect(ensureAgentSessionContextUsage(TARGET, sessionRecord())).toEqual(
      expect.objectContaining({ tokens: 8_508, limit: null, percent: null })
    );
  });
});

describe('refreshAgentSessionContextUsage', () => {
  it('answers null and asks nothing for an instance with no server', async () => {
    getAssignedOpencodePort.mockReturnValue(null);
    await expect(refreshAgentSessionContextUsage(TARGET, sessionRecord())).resolves.toBeNull();
    expect(fetchOpencodeContextTokens).not.toHaveBeenCalled();
  });

  it('skips the providers call when the agent named no model', async () => {
    await refreshAgentSessionContextUsage(TARGET, {
      ...sessionRecord(),
      model: null,
      provider: null,
    });
    expect(fetchOpencodeModelContextLimit).not.toHaveBeenCalled();
    expect(fetchOpencodeContextTokens).toHaveBeenCalledTimes(1);
  });

  it('asks the provider and model the agent named', async () => {
    await refreshAgentSessionContextUsage(TARGET, sessionRecord());
    expect(fetchOpencodeModelContextLimit).toHaveBeenCalledWith(
      4242,
      'github-copilot',
      'claude-sonnet-4.6'
    );
    expect(fetchOpencodeContextTokens).toHaveBeenCalledWith(4242, 'ses_measured');
  });
});

describe('lifetime', () => {
  it('drops the measurement with the record it describes', async () => {
    recordAgentSessionTelemetry(TARGET, sessionRecord());
    ensureAgentSessionContextUsage(TARGET, sessionRecord());
    await settle();
    expect(getAgentSessionContextUsage('wt-1', 'opencode', 'opencode')).not.toBeNull();

    forgetAgentSessionTelemetry(TARGET);
    expect(getAgentSessionContextUsage('wt-1', 'opencode', 'opencode')).toBeNull();
  });

  it('keeps one instance’s measurement out of another’s', async () => {
    const other: AgentInstanceRef = { ...TARGET, instanceId: 'opencode-2' };
    ensureAgentSessionContextUsage(TARGET, sessionRecord());
    await settle();
    expect(getAgentSessionContextUsage('wt-1', 'opencode', 'opencode-2')).toBeNull();
    fetchOpencodeContextTokens.mockResolvedValue(1_234);
    ensureAgentSessionContextUsage(other, sessionRecord());
    await settle();
    expect(getAgentSessionContextUsage('wt-1', 'opencode', 'opencode')?.tokens).toBe(8_508);
    expect(getAgentSessionContextUsage('wt-1', 'opencode', 'opencode-2')?.tokens).toBe(1_234);
  });
});
