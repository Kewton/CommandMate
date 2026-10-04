/**
 * Issue #3179 — the list API's per-instance status while an agent is launching.
 *
 * Same record as `current-output-builder`: `startingSince` is published, the
 * frame's dialog / unclassified reading is neutralised, and the liveness probe
 * (which would read the bare shell prompt of a launch as "the tool exited") is
 * not consulted.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CLIToolType, AgentInstance } from '@/lib/cli-tools/types';

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (cliToolId: string) => ({
        getSessionName: (worktreeId: string) => `${cliToolId}-${worktreeId}`,
        name: cliToolId,
      }),
    }),
  },
}));

vi.mock('@/lib/cli-tools/types', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/cli-tools/types')>();
  return { ...original, CLI_TOOL_IDS: ['antigravity'] as readonly CLIToolType[] };
});

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue(''),
}));

vi.mock('@/lib/detection/status-detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detection/status-detector')>()),
  detectSessionStatus: vi.fn().mockReturnValue({
    status: 'waiting',
    confidence: 'high',
    reason: 'prompt_detected',
    hasActivePrompt: true,
    evidence: 'positive',
    promptDetection: { isPrompt: true, cleanContent: '' },
  }),
}));

vi.mock('@/lib/cli-tools/session-liveness', () => ({
  probeToolSessionLiveness: vi.fn().mockResolvedValue({ alive: false, reason: 'shell prompt detected: %' }),
}));

vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getLastServerResponseTimestamp: vi.fn().mockReturnValue(null),
  buildCompositeKey: vi.fn(
    (worktreeId: string, cliToolId: string, instanceId?: string) =>
      `${worktreeId}:${cliToolId}:${instanceId ?? cliToolId}`,
  ),
}));

import { detectWorktreeSessionStatus } from '@/lib/session/worktree-status-helper';
import { probeToolSessionLiveness } from '@/lib/cli-tools/session-liveness';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import {
  markSessionStarting,
  resetSessionStartingState,
} from '@/lib/session/session-starting-state';

const WT = 'wt-3179';
const mockDb = {} as ReturnType<typeof import('@/lib/db/db-instance').getDbInstance>;

async function detect(sessionNames: string[]) {
  return detectWorktreeSessionStatus(
    WT,
    new Set(sessionNames),
    mockDb,
    vi.fn().mockReturnValue([]),
    vi.fn(),
    vi.fn(() => [] as AgentInstance[]),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionStartingState();
});

describe('[#3179] worktree status while the agent is launching', () => {
  it('publishes startingSince and a running, non-waiting status', async () => {
    const since = Date.now();
    markSessionStarting(WT, 'antigravity', undefined, since);

    const result = await detect([`antigravity-${WT}`]);
    const entry = result.sessionStatusByInstance.antigravity;

    expect(entry?.startingSince).toBe(since);
    expect(entry?.isRunning).toBe(true);
    expect(entry?.isWaitingForResponse).toBe(false);
    expect(entry?.isProcessing).toBe(true);
    expect(entry?.waitingKind).toBeNull();
    expect(entry?.isUnclassified).toBeUndefined();
    expect(entry?.sessionStatusReason).toBe(STATUS_REASON.STARTING);
    // The bare shell prompt of a launch is not "the tool exited".
    expect(probeToolSessionLiveness).not.toHaveBeenCalled();
  });

  it('omits the key and keeps the old reading when nothing is starting', async () => {
    const result = await detect([`antigravity-${WT}`]);
    const entry = result.sessionStatusByInstance.antigravity;

    expect(entry && 'startingSince' in entry).toBe(false);
    expect(probeToolSessionLiveness).toHaveBeenCalled();
    expect(entry?.sessionStatusReason).toBe(STATUS_REASON.EXITED);
  });
});
