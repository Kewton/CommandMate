/**
 * `capture --json` learning how full a worker's context is (Issue #2042).
 *
 * `structuredEvents.session` (#2040) says what a session has *spent*. It cannot
 * say how full the window is, and the trap is that it looks like it can:
 * `Session.tokens` are cumulative, so summing them answers `2%` where opencode's
 * own footer says `1%` — and the gap grows with every turn. So the measurement
 * is a block of its own, and these are its contract:
 *
 *  - **Additive.** Nothing about `session` moves. The
 *    `.claude/skills/orchestrate-monitor` parsers read this payload in an
 *    unbounded loop.
 *  - **Never in front of the payload.** The build does not await the two HTTP
 *    reads the measurement needs; it publishes what is cached.
 *  - **Present and null**, so a reader can tell "nothing knows" from "this
 *    daemon predates the field".
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null) }));

const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ isRunning: (...args: unknown[]) => isRunning(...args) }) }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-1:opencode'),
}));

// The two reads the measurement needs. Stubbed at the client, so the builder is
// exercised through the real cache in `agent-session-telemetry`.
const fetchOpencodeContextTokens = vi.fn();
const fetchOpencodeModelContextLimit = vi.fn();
vi.mock('@/lib/hooks/sources/opencode/client', () => ({
  fetchOpencodeContextTokens: (...args: unknown[]) => fetchOpencodeContextTokens(...args),
  fetchOpencodeModelContextLimit: (...args: unknown[]) => fetchOpencodeModelContextLimit(...args),
}));
vi.mock('@/lib/hooks/sources/opencode/ports', () => ({
  getAssignedOpencodePort: vi.fn(() => 4242),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { clearAgentStopEvents } from '@/lib/session/agent-event-state';
import {
  recordAgentSessionTelemetry,
  resetAgentSessionContextUsage,
  resetAgentSessionTelemetry,
  type AgentSessionRecord,
} from '@/lib/hooks/agent-session-telemetry';

const db = {} as Database.Database;

const TARGET = { worktreeId: 'wt-1', cliToolId: 'opencode' as const, instanceId: 'opencode' };

/** The measured session, at the instant its second turn ended (§14.2). */
const MEASURED_SESSION: AgentSessionRecord = {
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
  at: 1_700_000_000_000,
};

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  resetAgentSessionTelemetry();
  resetAgentSessionContextUsage();
  isRunning.mockResolvedValue(true);
  vi.mocked(captureSessionOutput).mockResolvedValue('some agent output\n');
  fetchOpencodeContextTokens.mockResolvedValue(8_508);
  fetchOpencodeModelContextLimit.mockResolvedValue(1_000_000);
});

afterEach(() => {
  resetAgentSessionTelemetry();
  resetAgentSessionContextUsage();
  clearAgentStopEvents();
});

describe('structuredEvents.sessionContext', () => {
  it('is present and null on a session nothing has measured', async () => {
    const payload = await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');

    expect(payload.structuredEvents).toHaveProperty('sessionContext');
    expect(payload.structuredEvents.sessionContext).toBeNull();
  });

  it('is null on the first build and measured on the next', async () => {
    recordAgentSessionTelemetry(TARGET, MEASURED_SESSION);

    const first = await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');
    expect(first.structuredEvents.sessionContext).toBeNull();

    await settle();
    const second = await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');
    expect(second.structuredEvents.sessionContext).toEqual(
      expect.objectContaining({
        tokens: 8_508,
        limit: 1_000_000,
        percent: 1,
        sessionAt: MEASURED_SESSION.at,
      })
    );
  });

  it('publishes the percentage opencode itself printed for this session', async () => {
    recordAgentSessionTelemetry(TARGET, MEASURED_SESSION);
    await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');
    await settle();

    const payload = await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');
    expect(payload.structuredEvents.sessionContext?.percent).toBe(1);
    // The number the same payload's `session.tokens` sums to. Published side by
    // side on purpose: they are different quantities, and a reader that mistakes
    // one for the other doubles the figure.
    const spent =
      (payload.structuredEvents.session?.tokens.input ?? 0) +
      (payload.structuredEvents.session?.tokens.output ?? 0) +
      (payload.structuredEvents.session?.tokens.cacheRead ?? 0) +
      (payload.structuredEvents.session?.tokens.cacheWrite ?? 0);
    expect(spent).toBe(16_999);
    expect(payload.structuredEvents.sessionContext?.tokens).not.toBe(spent);
  });

  it('leaves `session` byte-identical to what #2040 published', async () => {
    recordAgentSessionTelemetry(TARGET, MEASURED_SESSION);
    await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');
    await settle();

    const payload = await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');
    // In particular `tokens.total` is still the agent's own null, not this
    // server's sum of the other five.
    expect(payload.structuredEvents.session).toEqual(MEASURED_SESSION);
    expect(payload.structuredEvents.session?.tokens.total).toBeNull();
  });

  it('does not await the reads it needs', async () => {
    recordAgentSessionTelemetry(TARGET, MEASURED_SESSION);
    // A read that never resolves. If the build awaited it, this would hang.
    fetchOpencodeContextTokens.mockReturnValue(new Promise(() => {}));

    const payload = await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');
    expect(payload.structuredEvents.sessionContext).toBeNull();
    expect(payload.content).toContain('some agent output');
  });

  it('asks once across a burst of polls', async () => {
    recordAgentSessionTelemetry(TARGET, MEASURED_SESSION);
    for (let poll = 0; poll < 6; poll += 1) {
      await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');
    }
    await settle();
    expect(fetchOpencodeContextTokens).toHaveBeenCalledTimes(1);
  });

  it('asks nothing for a tool that publishes no session', async () => {
    await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');
    await settle();
    expect(fetchOpencodeContextTokens).not.toHaveBeenCalled();
  });

  it('carries the key on a session that is not running', async () => {
    isRunning.mockResolvedValue(false);

    const payload = await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');
    expect(payload.isRunning).toBe(false);
    expect(payload.structuredEvents).toHaveProperty('sessionContext');
    expect(payload.structuredEvents.sessionContext).toBeNull();
  });
});
