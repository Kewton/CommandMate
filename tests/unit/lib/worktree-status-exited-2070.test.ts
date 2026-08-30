/**
 * Issue #2070 — the status poll asks EVERY tool whether its agent is still
 * there, and publishes `exited` when it is not.
 *
 * Before this, `detectInstanceSessionStatus` ran its health check behind
 * `cliToolId === 'claude'`, so a codex / copilot / opencode / gemini pane whose
 * agent had quit kept `isRunning: true` — a green dot in the sidebar and a
 * `ready` row in `commandmate ls` for a session holding nothing but a shell
 * prompt.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CLIToolType, AgentInstance } from '@/lib/cli-tools/types';

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

vi.mock('@/lib/cli-tools/types', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/cli-tools/types')>();
  return { ...original, CLI_TOOL_IDS: ['claude', 'codex'] as readonly CLIToolType[] };
});

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue('› '),
}));

vi.mock('@/lib/detection/status-detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detection/status-detector')>()),
  detectSessionStatus: vi.fn().mockReturnValue({
    status: 'ready',
    confidence: 'high',
    reason: 'input_prompt',
    hasActivePrompt: false,
    evidence: 'positive',
    promptDetection: { isPrompt: false, cleanContent: '' },
  }),
}));

vi.mock('@/lib/cli-tools/session-liveness', () => ({
  probeToolSessionLiveness: vi.fn().mockResolvedValue({ alive: true }),
}));

vi.mock('@/lib/cli-tools/opencode', () => ({ OPENCODE_PANE_HEIGHT: 200 }));
vi.mock('@/lib/cli-tools/gemini', () => ({ GEMINI_PANE_HEIGHT: 200 }));

vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getLastServerResponseTimestamp: vi.fn().mockReturnValue(null),
  buildCompositeKey: vi.fn(
    (worktreeId: string, cliToolId: string, instanceId?: string) =>
      `${worktreeId}:${cliToolId}:${instanceId ?? cliToolId}`,
  ),
}));

import { detectWorktreeSessionStatus } from '@/lib/session/worktree-status-helper';
import { probeToolSessionLiveness } from '@/lib/cli-tools/session-liveness';
import { captureSessionOutput } from '@/lib/session/cli-session';
import { STATUS_REASON } from '@/lib/detection/status-reason';

const WT = 'wt-2070';
const mockDb = {} as ReturnType<typeof import('@/lib/db/db-instance').getDbInstance>;
const mockGetMessages = vi.fn().mockReturnValue([]);
const mockMarkPending = vi.fn();
const mockGetAgentInstances = vi.fn(() => [] as AgentInstance[]);

async function detect(sessionNames: string[]) {
  return detectWorktreeSessionStatus(
    WT,
    new Set(sessionNames),
    mockDb,
    mockGetMessages,
    mockMarkPending,
    mockGetAgentInstances,
  );
}

/** The liveness answer, per tool, from the session name the probe was given. */
function livenessByTool(answers: Partial<Record<CLIToolType, { alive: boolean; reason?: string }>>) {
  vi.mocked(probeToolSessionLiveness).mockImplementation(async (_session, cliToolId) => {
    const answer = answers[cliToolId] ?? { alive: true };
    return answer.alive
      ? { alive: true }
      : { alive: false, reason: answer.reason ?? 'shell prompt detected: host dir %' };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMessages.mockReturnValue([]);
  vi.mocked(captureSessionOutput).mockResolvedValue('› ');
  vi.mocked(probeToolSessionLiveness).mockResolvedValue({ alive: true });
});

describe('[#2070] the liveness probe is no longer claude-only', () => {
  it('probes every RUNNING session, whichever tool it belongs to', async () => {
    await detect([`claude-${WT}`, `codex-${WT}`]);

    const tools = vi.mocked(probeToolSessionLiveness).mock.calls.map(([, id]) => id);
    expect(tools.sort()).toEqual(['claude', 'codex']);
  });

  it('probes nothing for a worktree with no session', async () => {
    await detect([]);
    expect(probeToolSessionLiveness).not.toHaveBeenCalled();
  });

  it('stops reporting a codex whose agent has exited as running', async () => {
    livenessByTool({ codex: { alive: false } });

    const result = await detect([`codex-${WT}`]);

    expect(result.sessionStatusByCli.codex?.isRunning).toBe(false);
    expect(result.isSessionRunning).toBe(false);
    // The frame is never read: there is no agent whose status it could describe.
    expect(captureSessionOutput).not.toHaveBeenCalled();
  });

  it('publishes `exited` as the reason, with positive evidence', async () => {
    livenessByTool({ codex: { alive: false } });

    const result = await detect([`codex-${WT}`]);

    expect(result.sessionStatusByCli.codex?.sessionStatusReason).toBe(STATUS_REASON.EXITED);
    expect(result.sessionStatusByCli.codex?.statusEvidence).toBe('positive');
    expect(result.sessionStatusByInstance.codex?.sessionStatusReason).toBe(STATUS_REASON.EXITED);
  });

  it('says nothing about a session that was never running — `exited` means it died', async () => {
    const result = await detect([]);
    expect(result.sessionStatusByCli.codex?.sessionStatusReason).toBeUndefined();
    expect(result.sessionStatusByCli.codex?.isRunning).toBe(false);
  });

  it('leaves a live session exactly as it was: no exited reason, real status', async () => {
    const result = await detect([`codex-${WT}`]);

    expect(result.sessionStatusByCli.codex?.isRunning).toBe(true);
    expect(result.sessionStatusByCli.codex?.sessionStatusReason).toBe('input_prompt');
  });

  it('condemns one tool without touching the other', async () => {
    livenessByTool({ codex: { alive: false }, claude: { alive: true } });

    const result = await detect([`claude-${WT}`, `codex-${WT}`]);

    expect(result.sessionStatusByCli.claude?.isRunning).toBe(true);
    expect(result.sessionStatusByCli.claude?.sessionStatusReason).toBe('input_prompt');
    expect(result.sessionStatusByCli.codex?.isRunning).toBe(false);
    expect(result.sessionStatusByCli.codex?.sessionStatusReason).toBe(STATUS_REASON.EXITED);
    // The worktree still has a running agent, so the aggregate says so.
    expect(result.isSessionRunning).toBe(true);
  });
});
