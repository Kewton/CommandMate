/**
 * The worktree list path stops calling an unreadable frame "processing"
 * (Issue #2775).
 *
 * The detector's floors — `default`, `unknown_frame`, `no_recent_output` — answer
 * `running` with `evidence: 'none'`. That verdict is untouched; what this suite
 * pins is how `detectWorktreeSessionStatus` PROJECTS it:
 *
 *  - no `isProcessing` (per instance, per tool, per worktree), so no dot glows
 *    and `commandmate ls` / `peers` do not print `running`;
 *  - `isUnclassified: true`, from `isUnclassifiedFrame` — the single producer,
 *    which the suite proves by overriding it and watching the flags follow;
 *  - a `running` with positive evidence publishes the same object, key for key,
 *    that it published before this Issue.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CLIToolType, AgentInstance } from '@/lib/cli-tools/types';
import type { SessionStatus } from '@/lib/detection/status-detector';

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
  return {
    ...original,
    CLI_TOOL_IDS: ['codex'] as readonly CLIToolType[],
  };
});

// The capture returns the INSTANCE id, so a test can give two instances of one
// tool two different frames through the detector mock below.
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(
    async (_worktreeId: string, _cliToolId: string, _lines: number, instanceId?: string) =>
      instanceId ?? 'codex',
  ),
  publishSessionSurface: vi.fn().mockResolvedValue(undefined),
  forgetSessionSurface: vi.fn(),
}));

vi.mock('@/lib/detection/status-detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detection/status-detector')>()),
  detectSessionStatus: vi.fn(),
}));

// Wrapped, not replaced: the real function answers unless a test overrides it,
// which is how the suite proves the helper asks it rather than restating it.
vi.mock('@/lib/session/status-evidence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/status-evidence')>();
  return { ...actual, isUnclassifiedFrame: vi.fn(actual.isUnclassifiedFrame) };
});

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
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import { publishSessionSurface } from '@/lib/session/cli-session';
import {
  clearLastKnownStatuses,
  isUnclassifiedFrame,
  type StatusEvidence,
} from '@/lib/session/status-evidence';
import {
  deriveCliStatus,
  deriveSessionStatus,
  isUnclassifiedCliStatus,
} from '@/lib/session/status-mapping';

const mockDb = {} as ReturnType<typeof import('@/lib/db/db-instance').getDbInstance>;
const mockGetMessages = vi.fn().mockReturnValue([]);
const mockMarkPending = vi.fn();
const mockGetAgentInstances = vi.fn(() => [] as AgentInstance[]);

type Verdict = { status: SessionStatus; reason: string; evidence: StatusEvidence };

/** Answer every frame with `verdict`, or per instance id with `byInstance`. */
function mockDetector(verdict: Verdict, byInstance: Record<string, Verdict> = {}): void {
  vi.mocked(detectSessionStatus).mockImplementation((output: string) => {
    const v = byInstance[output] ?? verdict;
    return {
      status: v.status,
      confidence: 'high',
      reason: v.reason,
      hasActivePrompt: false,
      evidence: v.evidence,
      promptDetection: { isPrompt: false, cleanContent: '' },
    };
  });
}

async function detect(sessions: string[] = ['codex-wt-1']) {
  return detectWorktreeSessionStatus(
    'wt-1',
    new Set(sessions),
    mockDb,
    mockGetMessages,
    mockMarkPending,
    mockGetAgentInstances,
  );
}

/** The three verdicts `isUnclassifiedFrame` calls unclassified — written out. */
const FLOORS: ReadonlyArray<[string, Verdict]> = [
  ['default', { status: 'running', reason: STATUS_REASON.DEFAULT, evidence: 'none' }],
  ['unknown_frame', { status: 'running', reason: STATUS_REASON.UNKNOWN_FRAME, evidence: 'none' }],
  ['no_recent_output', { status: 'running', reason: STATUS_REASON.NO_RECENT_OUTPUT, evidence: 'none' }],
];

const THINKING: Verdict = { status: 'running', reason: STATUS_REASON.THINKING_INDICATOR, evidence: 'positive' };
const COMPOSER: Verdict = { status: 'ready', reason: STATUS_REASON.INPUT_PROMPT, evidence: 'positive' };

beforeEach(() => {
  vi.clearAllMocks();
  clearLastKnownStatuses();
  mockGetMessages.mockReturnValue([]);
  mockGetAgentInstances.mockReturnValue([]);
});

describe('[#2775] an unclassified frame is not published as processing', () => {
  it.each(FLOORS)('%s: no activity flag, isUnclassified set, at every level', async (_name, verdict) => {
    mockDetector(verdict);

    const result = await detect();

    for (const entry of [result.sessionStatusByInstance.codex, result.sessionStatusByCli.codex]) {
      expect(entry).toMatchObject({
        isRunning: true,
        isWaitingForResponse: false,
        isProcessing: false,
        isUnclassified: true,
        // The reason and the evidence are still published as the detector said.
        sessionStatusReason: verdict.reason,
        statusEvidence: 'none',
      });
      // Nothing downstream can turn it back into `running`.
      expect(deriveCliStatus(entry)).toBe('ready');
      expect(isUnclassifiedCliStatus(entry)).toBe(true);
    }

    // The worktree-level triple is what `commandmate ls` / `peers` read, and
    // what the route folds into `sessionStatus`.
    expect(result.isSessionRunning).toBe(true);
    expect(result.isProcessing).toBe(false);
    expect(result.isWaitingForResponse).toBe(false);
    expect(
      deriveSessionStatus({
        isSessionRunning: result.isSessionRunning,
        isWaitingForResponse: result.isWaitingForResponse,
        isProcessing: result.isProcessing,
      }),
    ).toBe('ready');
  });

  it.each(FLOORS)('%s: the tmux status surface does not say running either', async (_name, verdict) => {
    mockDetector(verdict);

    await detect();

    expect(publishSessionSurface).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'codex', status: 'ready' }),
    );
  });
});

describe('[#2775] a running with positive evidence is untouched', () => {
  it('publishes the same object it always did — no isUnclassified key', async () => {
    mockDetector(THINKING);

    const result = await detect();

    expect(result.sessionStatusByInstance.codex).toEqual({
      isRunning: true,
      isWaitingForResponse: false,
      isProcessing: true,
      waitingKind: null,
      waitingSince: null,
      awaitingInstruction: false,
      statusEvidence: 'positive',
      sessionStatusReason: STATUS_REASON.THINKING_INDICATOR,
      lastKnownStatus: 'running',
      lastKnownStatusAt: expect.any(Number),
    });
    expect(result.isProcessing).toBe(true);
    expect(deriveCliStatus(result.sessionStatusByCli.codex)).toBe('running');
    expect(isUnclassifiedCliStatus(result.sessionStatusByCli.codex)).toBe(false);
    expect(publishSessionSurface).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'codex', status: 'running' }),
    );
  });

  it('a classified frame with no evidence is not "unclassified" (#2011)', async () => {
    // An idle composer whose idle rule declined to vouch for it: evidence
    // `none`, but a rule DID read the frame.
    mockDetector({ status: 'ready', reason: STATUS_REASON.INPUT_PROMPT, evidence: 'none' });

    const result = await detect();

    expect(result.sessionStatusByInstance.codex).not.toHaveProperty('isUnclassified');
    expect(isUnclassifiedCliStatus(result.sessionStatusByInstance.codex)).toBe(false);
  });

  it('a session that is not running carries no isUnclassified key', async () => {
    mockDetector(FLOORS[0][1]);

    const result = await detect([]);

    expect(result.sessionStatusByInstance.codex).not.toHaveProperty('isUnclassified');
  });
});

describe('[#2775] isUnclassifiedFrame is the producer, not a restatement of it', () => {
  it('is asked with the detector\'s own status and reason', async () => {
    mockDetector(FLOORS[0][1]);

    await detect();

    expect(isUnclassifiedFrame).toHaveBeenCalledWith('running', STATUS_REASON.DEFAULT);
  });

  it('the flags follow its answer for `default` — no second expression decides', async () => {
    mockDetector(FLOORS[0][1]);
    // Once: `clearAllMocks` keeps implementations, and one probe asks once.
    vi.mocked(isUnclassifiedFrame).mockReturnValueOnce(false);

    const result = await detect();

    expect(result.sessionStatusByInstance.codex?.isProcessing).toBe(true);
    expect(result.sessionStatusByInstance.codex).not.toHaveProperty('isUnclassified');
  });

  it('and for a reason it would never name — the helper holds no list of its own', async () => {
    mockDetector(THINKING);
    vi.mocked(isUnclassifiedFrame).mockReturnValueOnce(true);

    const result = await detect();

    expect(result.sessionStatusByInstance.codex).toMatchObject({
      isProcessing: false,
      isUnclassified: true,
    });
  });
});

describe('[#2775] the per-tool aggregate folds isUnclassified as a logical-OR', () => {
  beforeEach(() => {
    mockGetAgentInstances.mockReturnValue([
      { id: 'codex-2', cliTool: 'codex', alias: 'second', order: 1 } as AgentInstance,
    ]);
  });

  it('an unreadable instance next to an idle one: the fold reads "cannot tell"', async () => {
    mockDetector(COMPOSER, { codex: FLOORS[0][1] });

    const result = await detect(['codex-wt-1', 'codex-wt-1-codex-2']);

    expect(result.sessionStatusByInstance['codex-2']).not.toHaveProperty('isUnclassified');
    expect(result.sessionStatusByCli.codex).toMatchObject({
      isRunning: true,
      isProcessing: false,
      isUnclassified: true,
    });
    expect(isUnclassifiedCliStatus(result.sessionStatusByCli.codex)).toBe(true);
  });

  it('an unreadable instance next to a working one: the working one wins', async () => {
    mockDetector(THINKING, { codex: FLOORS[0][1] });

    const result = await detect(['codex-wt-1', 'codex-wt-1-codex-2']);

    expect(result.sessionStatusByCli.codex).toMatchObject({
      isProcessing: true,
      isUnclassified: true,
    });
    expect(deriveCliStatus(result.sessionStatusByCli.codex)).toBe('running');
    expect(isUnclassifiedCliStatus(result.sessionStatusByCli.codex)).toBe(false);
    expect(result.isProcessing).toBe(true);
  });

  it('two readable instances fold with no isUnclassified key', async () => {
    mockDetector(THINKING);

    const result = await detect(['codex-wt-1', 'codex-wt-1-codex-2']);

    expect(result.sessionStatusByCli.codex).not.toHaveProperty('isUnclassified');
  });
});
