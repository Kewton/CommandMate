/**
 * The second contract change: `CliToolSessionStatus` (Issue #1926, DR3-005).
 *
 * §7's rows 「スクレイパが肯定的証拠を得られない」 and 「直前の確定状態」 name the
 * header status chip, `BranchStatusIndicator` and `commandmate ls` as their Web
 * UI / operator receptacles — and none of those read `CurrentOutputResponse`.
 * They read `sessionStatusByCli` from `GET /api/worktrees`, which carried three
 * booleans and no reason at all. Adding `statusEvidence` to `current-output`
 * alone would have left those four rows unimplementable, which is why the design
 * calls this a second contract change rather than a detail of the first.
 *
 * The table below is written out literally: this suite's job is to catch a
 * re-inlined `(status, reason) -> evidence` derivation in
 * `worktree-status-helper`, and a table that computed its own expectations from
 * one would agree with any copy that had drifted the same way. Since Issue #1927
 * there is no shared derivation left to call — the detector is the producer —
 * and the table carries two `ready`/`input_prompt` rows with different evidence
 * to pin that the helper cannot be re-deriving anything.
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
    CLI_TOOL_IDS: ['claude'] as readonly CLIToolType[],
  };
});

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue('$ '),
}));

vi.mock('@/lib/detection/status-detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detection/status-detector')>()),
  detectSessionStatus: vi.fn(),
}));

// Issue #2070: the health check is no longer claude's, so it is no longer
// reached through `claude-session`. Every tool's session is probed through
// `probeToolSessionLiveness`; `{ alive: true }` here is what the old
// `{ healthy: true }` meant.
vi.mock('@/lib/cli-tools/session-liveness', () => ({
  probeToolSessionLiveness: vi.fn().mockResolvedValue({ alive: true }),
}));

vi.mock('@/lib/cli-tools/opencode', () => ({ OPENCODE_PANE_HEIGHT: 200 }));
vi.mock('@/lib/cli-tools/gemini', () => ({ GEMINI_PANE_HEIGHT: 200 }));

vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getLastServerResponseTimestamp: vi.fn().mockReturnValue(null),
  // Includes the instance, unlike the two-argument stub the neighbouring suites
  // use: this one has a multi-instance case, and a key that collapsed two
  // instances onto one entry would make the latch assertions lie.
  buildCompositeKey: vi.fn(
    (worktreeId: string, cliToolId: string, instanceId?: string) =>
      `${worktreeId}:${cliToolId}:${instanceId ?? cliToolId}`,
  ),
}));

import { detectWorktreeSessionStatus } from '@/lib/session/worktree-status-helper';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import { captureSessionOutput } from '@/lib/session/cli-session';
import {
  clearLastKnownStatuses,
  type StatusEvidence,
} from '@/lib/session/status-evidence';

const mockDb = {} as ReturnType<typeof import('@/lib/db/db-instance').getDbInstance>;
const mockGetMessages = vi.fn().mockReturnValue([]);
const mockMarkPending = vi.fn();
const mockGetAgentInstances = vi.fn(() => [] as AgentInstance[]);

function mockDetectedStatus(
  status: SessionStatus,
  reason: string,
  // Issue #1927: the detector produces `evidence` now, so the mock has to as
  // well. The table below stopped being "the helper re-derives this from
  // (status, reason)" and became "the helper publishes what the detector said",
  // which is the point of moving the producer — see `status-detector.ts`.
  //
  // Issue #2011 made the default a literal rather than a call into
  // `status-evidence.ts`: the downstream re-derivation is gone, and a test
  // double that reached for one would be reintroducing the second expression
  // §4 D1 決定 2 forbids. Every caller that needs `'none'` now says so.
  evidence: StatusEvidence = 'positive',
): void {
  vi.mocked(detectSessionStatus).mockReturnValue({
    status,
    confidence: 'high',
    reason,
    hasActivePrompt: false,
    evidence,
    promptDetection: { isPrompt: false, cleanContent: '' },
  });
}

async function detect(sessions: string[] = ['claude-wt-1']) {
  return detectWorktreeSessionStatus(
    'wt-1',
    new Set(sessions),
    mockDb,
    mockGetMessages,
    mockMarkPending,
    mockGetAgentInstances,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearLastKnownStatuses();
  mockGetMessages.mockReturnValue([]);
  mockGetAgentInstances.mockReturnValue([]);
  vi.mocked(captureSessionOutput).mockResolvedValue('$ ');
});

describe('[#1926] sessionStatusByCli carries the reason and the evidence', () => {
  /** status, reason, expected evidence — see the header for why it is literal. */
  const ROWS: ReadonlyArray<[SessionStatus, string, 'positive' | 'none']> = [
    ['running', STATUS_REASON.DEFAULT, 'none'],
    // Issue #1927 §4 D1 決定 3 moved this row off `ready`; Issue #2011 corrects
    // the table, which had kept the pre-#1927 status next to the post-#1927
    // producer.
    ['running', STATUS_REASON.NO_RECENT_OUTPUT, 'none'],
    ['ready', STATUS_REASON.INPUT_PROMPT, 'positive'],
    // The row the rollout adds: a composer frame whose tool-specific idle rule
    // declined. Same status and same reason as the row above it, different
    // evidence — which is exactly why the helper must publish rather than
    // re-derive.
    ['ready', STATUS_REASON.INPUT_PROMPT, 'none'],
    ['running', STATUS_REASON.THINKING_INDICATOR, 'positive'],
    ['waiting', STATUS_REASON.PROMPT_DETECTED, 'positive'],
  ];

  it.each(ROWS)('%s / %s publishes evidence %s', async (status, reason, evidence) => {
    mockDetectedStatus(status, reason, evidence);

    const result = await detect();

    expect(result.sessionStatusByCli.claude).toMatchObject({
      sessionStatusReason: reason,
      statusEvidence: evidence,
    });
  });

  it('reports the scraper reason, not a hook one', async () => {
    // The list API does not run `mergeStructuredStatus`, so labelling its
    // verdict with a `hook_` reason would misreport which layer decided. The
    // merged reason lives on `CurrentOutputResponse.sessionStatusReason`.
    mockDetectedStatus('ready', STATUS_REASON.INPUT_PROMPT);

    const result = await detect();

    expect(result.sessionStatusByCli.claude?.sessionStatusReason).not.toMatch(/^hook_/);
  });

  it('omits both keys for a session that is not running', async () => {
    mockDetectedStatus('running', STATUS_REASON.THINKING_INDICATOR);

    const result = await detect([]);

    expect(detectSessionStatus).not.toHaveBeenCalled();
    expect(result.sessionStatusByCli.claude).not.toHaveProperty('statusEvidence');
    expect(result.sessionStatusByCli.claude).not.toHaveProperty('sessionStatusReason');
  });

  it('omits both keys when the capture threw — there was no frame to read', async () => {
    mockDetectedStatus('ready', STATUS_REASON.INPUT_PROMPT);
    vi.mocked(captureSessionOutput).mockRejectedValue(new Error('tmux is gone'));

    const result = await detect();

    // The pre-existing behaviour on this path is `isProcessing: true` — a guess.
    // #1926's fields must not dress that guess up as a reading.
    expect(result.sessionStatusByCli.claude?.isProcessing).toBe(true);
    expect(result.sessionStatusByCli.claude).not.toHaveProperty('statusEvidence');
    expect(result.sessionStatusByCli.claude).not.toHaveProperty('sessionStatusReason');
  });
});

describe('[#1926] lastKnownStatus on sessionStatusByCli', () => {
  it('reports the verdict the current probe confirmed, stamped with the probe\'s own clock', async () => {
    mockDetectedStatus('waiting', STATUS_REASON.PROMPT_DETECTED);

    const before = Date.now();
    const result = await detect();
    const after = Date.now();

    const status = result.sessionStatusByCli.claude;
    expect(status?.lastKnownStatus).toBe('waiting');
    // A range, not `expect.any(Number)`: "when the status was last known" is the
    // meaning of the field, and a stamp that came from anywhere but this probe
    // would still be a number.
    expect(status?.lastKnownStatusAt).toBeGreaterThanOrEqual(before);
    expect(status?.lastKnownStatusAt).toBeLessThanOrEqual(after);
  });

  it('keeps the previous verdict while the frame carries no evidence', async () => {
    mockDetectedStatus('waiting', STATUS_REASON.PROMPT_DETECTED);
    await detect();

    mockDetectedStatus('running', STATUS_REASON.DEFAULT, 'none');
    const blind = await detect();

    expect(blind.sessionStatusByCli.claude).toMatchObject({
      statusEvidence: 'none',
      isProcessing: true,
      lastKnownStatus: 'waiting',
    });
  });

  it('is absent until something has been confirmed', async () => {
    mockDetectedStatus('running', STATUS_REASON.DEFAULT, 'none');

    const result = await detect();

    expect(result.sessionStatusByCli.claude).not.toHaveProperty('lastKnownStatus');
  });

  it('is dropped when the session stops', async () => {
    mockDetectedStatus('ready', STATUS_REASON.INPUT_PROMPT);
    await detect();

    const stopped = await detect([]);
    expect(stopped.sessionStatusByCli.claude).not.toHaveProperty('lastKnownStatus');

    // And the next session on the same key starts with no history rather than
    // inheriting the dead one's verdict.
    mockDetectedStatus('running', STATUS_REASON.DEFAULT, 'none');
    const restarted = await detect();
    expect(restarted.sessionStatusByCli.claude).not.toHaveProperty('lastKnownStatus');
  });
});

describe('[#1926] the aggregate drops what it cannot fold', () => {
  it('keeps the four fields per instance and drops them from the per-tool fold', async () => {
    // Two instances of one tool can be at different reasons in the same moment,
    // and there is no logical-OR of two reasons — an aggregate that picked one
    // would tell the header chip a reason that is true of the other session.
    mockGetAgentInstances.mockReturnValue([
      { id: 'claude-2', cliTool: 'claude', alias: 'second', order: 1 } as AgentInstance,
    ]);
    mockDetectedStatus('ready', STATUS_REASON.INPUT_PROMPT);

    const result = await detect(['claude-wt-1', 'claude-wt-1-claude-2']);

    expect(result.sessionStatusByInstance.claude).toMatchObject({
      statusEvidence: 'positive',
      sessionStatusReason: STATUS_REASON.INPUT_PROMPT,
    });
    expect(result.sessionStatusByInstance['claude-2']).toMatchObject({
      statusEvidence: 'positive',
      sessionStatusReason: STATUS_REASON.INPUT_PROMPT,
    });

    for (const key of ['statusEvidence', 'sessionStatusReason', 'lastKnownStatus', 'lastKnownStatusAt']) {
      expect(result.sessionStatusByCli.claude).not.toHaveProperty(key);
    }
  });
});
