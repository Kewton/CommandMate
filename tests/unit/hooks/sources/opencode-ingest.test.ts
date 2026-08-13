/**
 * What an opencode event does to CommandMate's state (Issue #1763).
 *
 * The consuming layer was already tool-agnostic, so the question these tests
 * answer is not "does `agent-event-state` work" — it does, and #1723/#1725/#1726
 * cover it — but "does an opencode frame actually reach it, and does the verdict
 * actually reach the agent". An integration that normalises perfectly and wires
 * to nothing would pass every test in `opencode.test.ts`.
 *
 * The adjudicator is stubbed at `resolvePermissionRequest`, which is the seam
 * between "should this be approved" (tool-independent, #1724, unchanged) and
 * "how is the approval delivered" (the only opencode-specific part).
 *
 * @vitest-environment node
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

// `vi.hoisted` so the mock exists by the time `vi.mock` is lifted to the top.
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  },
}));
mockLogger.withContext.mockReturnValue(mockLogger);

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

vi.mock('@/lib/hooks/permission-decision-service', () => ({
  resolvePermissionRequest: vi.fn(),
  PERMISSION_DECISION_SLOW_MS: 500,
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({}) as never) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn() }));
vi.mock('@/lib/hooks/agent-event-service', () => ({
  applyAgentStopEvent: vi
    .fn()
    .mockResolvedValue({ taskId: null, taskEventApplied: false, verificationRunId: null }),
}));

vi.mock('@/lib/hooks/sources/opencode/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode/client')>();
  return {
    ...actual,
    replyOpencodePermission: vi.fn().mockResolvedValue(true),
    replyOpencodeQuestion: vi.fn().mockResolvedValue(true),
    readOpencodeEventStream: vi.fn(),
  };
});

import { ingestOpencodeEvent } from '@/lib/hooks/sources/opencode/ingest';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import { replyOpencodePermission } from '@/lib/hooks/sources/opencode/client';
import {
  rememberOpencodePort,
  resetOpencodePortAssignments,
} from '@/lib/hooks/sources/opencode/ports';
import { resolvePermissionRequest } from '@/lib/hooks/permission-decision-service';
import { applyAgentStopEvent } from '@/lib/hooks/agent-event-service';
import { getWorktreeById } from '@/lib/db';
import {
  clearAgentStopEvents,
  getAskUserQuestion,
  getLastAgentEvent,
  getStructuredPromptWaiting,
} from '@/lib/session/agent-event-state';
import { resetPendingDecisions, type NormalizedAgentEvent } from '@/lib/hooks/sources';
import type { Worktree } from '@/types/models';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');

function frame(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

/** The event the subscription would hand to `ingestOpencodeEvent`. */
function normalized(name: string): NormalizedAgentEvent {
  const event = opencodeAgentEventSource.normalizeEvent({
    payload: frame(name),
    receivedAt: NOW,
  });
  if (!event) throw new Error(`fixture ${name} did not normalise`);
  return event;
}

const NOW = 1_800_000_000_000;
const TARGET = { worktreeId: 'wt-ing', cliToolId: 'opencode', instanceId: 'opencode' } as const;
const WORKTREE = { id: 'wt-ing', path: '/tmp/wt-ing' } as unknown as Worktree;

let sandbox: string;

beforeAll(() => {
  sandbox = makeTempDir('opencode-ingest-');
});

afterAll(() => {
  removeTempDir(sandbox);
});

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  resetPendingDecisions();
  resetOpencodePortAssignments();
  vi.stubEnv('CM_OPENCODE_PORT_FILE', join(sandbox, 'opencode-ports.json'));
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '1');
  rememberOpencodePort(TARGET, 4242, '/tmp/wt-ing');
  vi.mocked(getWorktreeById).mockReturnValue(WORKTREE);
  vi.mocked(resolvePermissionRequest).mockReturnValue({
    behavior: null,
    reason: 'auto-yes-disabled',
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetOpencodePortAssignments();
});

/** Every `warn`/`info` action name the ingest emitted. */
function loggedActions(level: 'info' | 'warn'): string[] {
  return mockLogger[level].mock.calls.map((call) => String(call[0]));
}

describe('recording', () => {
  it('files a completed turn against the instance', async () => {
    await ingestOpencodeEvent(TARGET, normalized('session-idle'));

    expect(getLastAgentEvent('wt-ing', 'opencode', 'opencode')).toMatchObject({
      event: 'stop',
      sessionId: 'ses_0000000000000000000000000',
    });
    // The effect `commandmate wait` is actually waiting on: the active task
    // gets `agent_idle` and, under a contract, the verification gate runs.
    expect(vi.mocked(applyAgentStopEvent)).toHaveBeenCalledWith(
      expect.anything(),
      WORKTREE,
      'opencode',
      'opencode'
    );
  });

  it('drops a stop for a worktree that no longer exists', async () => {
    vi.mocked(getWorktreeById).mockReturnValue(null);
    await ingestOpencodeEvent(TARGET, normalized('session-idle'));
    expect(vi.mocked(applyAgentStopEvent)).not.toHaveBeenCalled();
  });

  it('opens the prompt-waiting record on an approval', async () => {
    // This is what makes `commandmate wait` exit 10 on an opencode approval.
    // It works because the detail is spelled `permission_prompt`, which is what
    // `applyPromptWaitingTransition` keys off.
    await ingestOpencodeEvent(TARGET, normalized('permission-asked'));

    const waiting = getStructuredPromptWaiting('wt-ing', 'opencode', 'opencode', NOW);
    expect(waiting).toMatchObject({ source: 'notification', confirmedAt: NOW });
    // The command the human is being asked about, for display beside the prompt.
    expect(waiting?.message).toContain('touch /tmp/cmate-oc-spike-marker.txt');
  });

  it('records a question with its structured choices', async () => {
    await ingestOpencodeEvent(TARGET, normalized('question-asked'));

    const question = getAskUserQuestion('wt-ing', 'opencode', 'opencode', NOW);
    expect(question?.spec.questions[0].choices.map((choice) => choice.label)).toEqual([
      'Red',
      'Blue',
    ]);
    // A question blocks exactly as an approval does — the session reads `busy`
    // and no `session.idle` arrives until it is answered (#1758 §5.3.1).
    expect(getStructuredPromptWaiting('wt-ing', 'opencode', 'opencode', NOW)).not.toBeNull();
  });

  it('drops a second delivery of the same event', async () => {
    await ingestOpencodeEvent(TARGET, normalized('message-part-updated-tool-running'));
    await ingestOpencodeEvent(TARGET, normalized('message-part-updated-tool-running'));
    expect(loggedActions('info')).toContain('opencode-event-duplicate-dropped');
  });
});

describe('adjudication', () => {
  it('POSTs an allow when Auto-Yes approves', async () => {
    vi.mocked(resolvePermissionRequest).mockReturnValue({ behavior: 'allow', reason: 'auto-yes' });

    await ingestOpencodeEvent(TARGET, normalized('permission-asked'));

    // C2: the verdict leaves over its own connection, addressed to the
    // permission id from the frame.
    expect(vi.mocked(replyOpencodePermission)).toHaveBeenCalledWith(
      4242,
      'per_0000000000000000000000000',
      'once',
      undefined
    );
  });

  it('sends nothing when it has no decision', async () => {
    // Every uncertainty — Auto-Yes off, an unreadable payload, a deny pattern —
    // ends here, and here nothing is sent at all.
    await ingestOpencodeEvent(TARGET, normalized('permission-asked'));
    expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
  });

  it('tells the operator that abstaining has blocked the agent', async () => {
    // Mutation target: `noDecision: { kind: 'proceeds' }` makes
    // `describeAbstain(...).safe` true and this warning disappears — and with
    // it the only trace that a session stopped. There is no timeout and no
    // fall-through: an unanswered approval was still pending after 10m19s
    // (#1758 §5.5.3), and a blocked opencode session is indistinguishable from
    // one that is thinking.
    await ingestOpencodeEvent(TARGET, normalized('permission-asked'));

    expect(loggedActions('warn')).toContain('permission-request-abstain-blocks-agent');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'permission-request-abstain-blocks-agent',
      expect.objectContaining({
        worktreeId: 'wt-ing',
        cliToolId: 'opencode',
        consequence: 'the agent waits indefinitely; nothing else will unblock it',
        blocksForMs: null,
      })
    );
  });

  it('says nothing of the sort when it did decide', async () => {
    vi.mocked(resolvePermissionRequest).mockReturnValue({ behavior: 'allow', reason: 'auto-yes' });
    await ingestOpencodeEvent(TARGET, normalized('permission-asked'));
    expect(loggedActions('warn')).not.toContain('permission-request-abstain-blocks-agent');
  });

  it('adjudicates with the tool name the frame does not carry', async () => {
    // `permission.asked` has no tool name; the approval kind stands in when the
    // correlating tool frame was never seen. Either way the deny patterns get a
    // non-empty surface containing the command.
    await ingestOpencodeEvent(TARGET, normalized('permission-asked'));

    const payload = vi.mocked(resolvePermissionRequest).mock.calls[0][1];
    expect(payload?.toolName).toBe('external_directory');
    expect(JSON.stringify(payload?.toolInput)).toContain('touch /tmp/cmate-oc-spike-marker.txt');
  });
});

describe('failure handling', () => {
  it('never lets a state failure reach the stream', async () => {
    // An event is a fact about a session that is still running; failing to
    // record it must cost the record, never the session.
    vi.mocked(getWorktreeById).mockImplementation(() => {
      throw new Error('database is locked');
    });

    await expect(ingestOpencodeEvent(TARGET, normalized('session-idle'))).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(
      'opencode-event-ingest-failed',
      expect.objectContaining({ error: 'database is locked' })
    );
  });
});
