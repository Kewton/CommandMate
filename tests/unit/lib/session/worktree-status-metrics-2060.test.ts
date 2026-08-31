/**
 * What a status pass actually costs in tmux round-trips (Issue #2060).
 *
 * The Issue this work came from asserted that `GET /api/worktrees` fans out
 * "every worktree × 7 CLI tools" of `capture-pane`. It does not: the batched
 * `listSessions()` runs first, and `detectInstanceSessionStatus` captures only
 * for a probe whose session name came back in that set. A worktree with nothing
 * running costs ZERO captures however many tools the build knows about.
 *
 * That is the claim `StatusDetectionMetrics` exists to make checkable, so this
 * suite is the counter-example generator for it: seven tools, three of them
 * with a live session, and the assertion that `captureCount` follows the
 * sessions rather than the tools.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentInstance } from '@/lib/cli-tools/types';

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (cliToolId: string) => ({
        getSessionName: (worktreeId: string, instanceId?: string) =>
          instanceId && instanceId !== cliToolId
            ? `${cliToolId}-${worktreeId}-${instanceId}`
            : `${cliToolId}-${worktreeId}`,
        name: cliToolId,
      }),
    }),
  },
}));

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue(''),
}));

// Issue #2070: the health check is no longer claude's and no longer reached
// through `claude-session`. Every running session is probed through
// `probeToolSessionLiveness`, which is what `healthCheckCount` now counts.
vi.mock('@/lib/cli-tools/session-liveness', () => ({
  probeToolSessionLiveness: vi.fn().mockResolvedValue({ alive: true }),
}));

vi.mock('@/lib/cli-tools/opencode', () => ({ OPENCODE_PANE_HEIGHT: 200 }));
vi.mock('@/lib/cli-tools/gemini', () => ({ GEMINI_PANE_HEIGHT: 200 }));

vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getLastServerResponseTimestamp: vi.fn().mockReturnValue(null),
  buildCompositeKey: vi.fn(
    (worktreeId: string, cliToolId: string, instanceId?: string) =>
      `${worktreeId}:${cliToolId}:${instanceId ?? cliToolId}`
  ),
}));

import {
  createStatusDetectionMetrics,
  detectWorktreeSessionStatus,
} from '@/lib/session/worktree-status-helper';
import { captureSessionOutput } from '@/lib/session/cli-session';
import { probeToolSessionLiveness } from '@/lib/cli-tools/session-liveness';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';

const WT = 'wt-2060';
const mockDb = {} as ReturnType<typeof import('@/lib/db/db-instance').getDbInstance>;
const mockGetMessages = vi.fn().mockReturnValue([]);
const mockMarkPending = vi.fn();
let roster: AgentInstance[] = [];
const mockGetAgentInstances = vi.fn(() => roster);

async function detect(sessionNames: string[]) {
  const metrics = createStatusDetectionMetrics();
  await detectWorktreeSessionStatus(
    WT,
    new Set(sessionNames),
    mockDb,
    mockGetMessages,
    mockMarkPending,
    mockGetAgentInstances,
    metrics,
  );
  return metrics;
}

beforeEach(() => {
  roster = [];
  vi.mocked(captureSessionOutput).mockClear().mockResolvedValue('');
  vi.mocked(probeToolSessionLiveness).mockClear().mockResolvedValue({ alive: true });
});

describe('[#2060] StatusDetectionMetrics', () => {
  it('starts at zero on every axis', () => {
    expect(createStatusDetectionMetrics()).toEqual({
      probeCount: 0,
      captureCount: 0,
      healthCheckCount: 0,
    });
  });

  it('costs ZERO captures when no session is running, however many tools exist', async () => {
    const metrics = await detect([]);

    expect(metrics.probeCount).toBe(CLI_TOOL_IDS.length);
    expect(metrics.captureCount).toBe(0);
    expect(metrics.healthCheckCount).toBe(0);
    expect(captureSessionOutput).not.toHaveBeenCalled();
  });

  it('captures once per RUNNING session, not once per tool', async () => {
    const metrics = await detect([`claude-${WT}`, `codex-${WT}`, `gemini-${WT}`]);

    // Seven probes were constructed; three of them found a session.
    expect(metrics.probeCount).toBe(CLI_TOOL_IDS.length);
    expect(metrics.captureCount).toBe(3);
    expect(vi.mocked(captureSessionOutput).mock.calls).toHaveLength(3);
  });

  it('counts the liveness probe separately from the capture, for EVERY tool', async () => {
    // A running session costs TWO tmux round-trips, not one: the liveness probe
    // (uncached `capture-pane`) and then the status capture. Issue #2070: this
    // used to be true of claude alone, because the probe was claude's alone —
    // which is precisely why a dead codex kept its dot.
    const metrics = await detect([`claude-${WT}`, `codex-${WT}`]);

    expect(metrics.healthCheckCount).toBe(2);
    expect(metrics.captureCount).toBe(2);
  });

  it('does not capture for a session the liveness probe condemned', async () => {
    vi.mocked(probeToolSessionLiveness).mockResolvedValue({
      alive: false,
      reason: 'shell prompt ending detected: host work %',
    });

    const metrics = await detect([`codex-${WT}`]);

    expect(metrics.healthCheckCount).toBe(1);
    expect(metrics.captureCount).toBe(0);
  });

  it('counts a capture that threw — the round-trip was still paid for', async () => {
    vi.mocked(captureSessionOutput).mockRejectedValue(new Error('no server running'));

    const metrics = await detect([`codex-${WT}`]);

    expect(metrics.captureCount).toBe(1);
  });

  it('counts alias instances on top of the per-tool primaries', async () => {
    roster = [
      { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 },
      { id: 'codex-2', cliTool: 'codex', alias: 'Codex 2', order: 1 },
    ];

    const metrics = await detect([`codex-${WT}`, `codex-${WT}-codex-2`]);

    // The primary `codex` entry in the roster is de-duplicated against the
    // per-tool probe list; only the alias adds a probe.
    expect(metrics.probeCount).toBe(CLI_TOOL_IDS.length + 1);
    expect(metrics.captureCount).toBe(2);
  });

  it('accumulates across worktrees, so one route request can sum one number', async () => {
    const metrics = createStatusDetectionMetrics();
    for (const worktreeId of ['a', 'b', 'c']) {
      await detectWorktreeSessionStatus(
        worktreeId,
        new Set([`claude-${worktreeId}`]),
        mockDb,
        mockGetMessages,
        mockMarkPending,
        mockGetAgentInstances,
        metrics,
      );
    }
    expect(metrics.probeCount).toBe(CLI_TOOL_IDS.length * 3);
    expect(metrics.captureCount).toBe(3);
    expect(metrics.healthCheckCount).toBe(3);
  });

  it('is optional: omitting it changes nothing about the result', async () => {
    const withMetrics = await detectWorktreeSessionStatus(
      WT, new Set([`codex-${WT}`]), mockDb, mockGetMessages, mockMarkPending,
      mockGetAgentInstances, createStatusDetectionMetrics(),
    );
    const without = await detectWorktreeSessionStatus(
      WT, new Set([`codex-${WT}`]), mockDb, mockGetMessages, mockMarkPending,
      mockGetAgentInstances,
    );
    expect(without).toEqual(withMetrics);
  });
});
