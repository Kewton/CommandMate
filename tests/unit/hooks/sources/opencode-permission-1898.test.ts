/**
 * The opencode approval lifecycle, driven through the real SSE sequence
 * (Issue #1898).
 *
 * Three defects were measured on an isolated server and all three are about
 * *when* CommandMate decides something rather than about what it decides:
 *
 *  1. an approval Auto-Yes answered in the same breath it arrived went on
 *     reading `waiting / hook_permission_prompt` for the whole of the tool call
 *     it had gated — eight seconds on `sleep 8; pwd`, with `wait --on-prompt
 *     agent` exiting 10 and `send` refused by the guard the entire time;
 *  2. `permission.replied` — the one positive "the dialog is gone" any of the
 *     six tools publishes — was mapped to nothing, so a human answering in the
 *     terminal changed no state either;
 *  3. `respond` could not answer the dialog at all (covered by
 *     `../structured-decision-response-1898.test.ts`).
 *
 * ## Why this drives the subscription rather than the ingest
 *
 * Because the ordering being asserted only exists end to end. `ingest` decides,
 * records and releases; the *turn gate* in `subscription` decides which frames
 * reach it at all, and opencode re-sends boundary frames — a
 * `message.updated(role:user)` arrives **after** `session.idle` on 1.18.3. A
 * pin written against synthesised calls into `ingestOpencodeEvent` would be
 * green with the gate removed and green with the resend reopening the turn.
 *
 * Every frame here is a captured one from `tests/fixtures/hooks/opencode/`. The
 * live tap's own ordering (`docs/design/opencode-server-live-verification.md`
 * §5.3.1 / §5.5.1) is: `permission.asked` → reply → `permission.replied` →
 * the gated tool runs → `session.idle`. The Issue text spells the fourth step
 * `message.updated(assistant)`; no such frame was captured, and it maps to
 * nothing anyway (only `info.role === "user"` is a word), so the tool-part
 * frames the tap did capture stand in for the same interval.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('@/lib/hooks/sources/opencode/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode/client')>();
  return {
    ...actual,
    fetchOpencodePendingPermissions: vi.fn().mockResolvedValue([]),
    fetchOpencodePendingQuestions: vi.fn().mockResolvedValue([]),
    replyOpencodePermission: vi.fn().mockResolvedValue(true),
    replyOpencodeQuestion: vi.fn().mockResolvedValue(true),
    fetchOpencodeSessionStatuses: vi.fn().mockResolvedValue({}),
    probeOpencodeHealth: vi
      .fn()
      .mockResolvedValue({ kind: 'healthy', health: { healthy: true, version: '1.18.3' } }),
    openOpencodeEventStream: vi.fn(),
  };
});

vi.mock('@/lib/hooks/permission-decision-service', () => ({
  resolvePermissionRequest: vi.fn(),
  PERMISSION_DECISION_SLOW_MS: 500,
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({}) as never) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn(() => ({ id: 'wt-1898', path: '/tmp/wt' })) }));
vi.mock('@/lib/hooks/agent-event-service', () => ({
  applyAgentStopEvent: vi
    .fn()
    .mockResolvedValue({ taskId: null, taskEventApplied: false, verificationRunId: null }),
}));

import { openOpencodeEventStream, replyOpencodePermission, type OpencodeFrame } from '@/lib/hooks/sources/opencode/client';
import { ingestOpencodeEvent } from '@/lib/hooks/sources/opencode/ingest';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import { resetOpencodeToolCalls } from '@/lib/hooks/sources/opencode/payloads';
import {
  rememberOpencodePort,
  resetOpencodePortAssignments,
} from '@/lib/hooks/sources/opencode/ports';
import {
  openOpencodeSubscription,
  resetOpencodeSubscriptions,
} from '@/lib/hooks/sources/opencode/subscription';
import { resolvePermissionRequest } from '@/lib/hooks/permission-decision-service';
import { clearPermissionDecisions, getLastPermissionDecision } from '@/lib/hooks/permission-decision-state';
import {
  clearAgentStopEvents,
  getLastAgentEvent,
  getStructuredPromptWaiting,
} from '@/lib/session/agent-event-state';
import { resetPendingDecisions } from '@/lib/hooks/sources';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');

function frame(name: string): OpencodeFrame {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

const TARGET = { worktreeId: 'wt-1898', cliToolId: 'opencode', instanceId: 'opencode' } as const;
const PORT = 4242;
const PERMISSION_ID = 'per_0000000000000000000000000';

/** The open dialog the structured layer is publishing right now, or null. */
function waiting() {
  return getStructuredPromptWaiting('wt-1898', 'opencode', 'opencode');
}

/**
 * A stream the test feeds one frame at a time.
 *
 * The subscription's own loop is untouched: it reads frames off this generator
 * exactly as it reads them off the socket, so the turn gate runs for real.
 */
function makePump() {
  const queued: OpencodeFrame[] = [];
  let wake: (() => void) | null = null;
  let ended = false;

  const stream = async function* (signal: AbortSignal): AsyncGenerator<OpencodeFrame> {
    for (;;) {
      while (queued.length > 0) yield queued.shift()!;
      if (ended || signal.aborted) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      wake = null;
    }
  };

  return {
    stream,
    push(...names: string[]): void {
      for (const name of names) queued.push(frame(name));
      wake?.();
    },
    end(): void {
      ended = true;
      wake?.();
    },
  };
}

/** Frames that actually reached the state machine, in order. */
let applied: string[];
let pump: ReturnType<typeof makePump>;

/** Open the subscription and wire it to the real ingest. */
async function subscribe(): Promise<void> {
  let chain = Promise.resolve();
  await openOpencodeSubscription(
    TARGET,
    (event) => {
      chain = chain.then(async () => {
        await ingestOpencodeEvent(TARGET, event);
        applied.push(`${event.event}${event.detail ? `:${event.detail}` : ''}`);
      });
    },
    (raw) => opencodeAgentEventSource.normalizeEvent(raw),
    { port: PORT }
  );
}

/** Wait until exactly these frames have been applied, in this order. */
async function appliedIs(...expected: string[]): Promise<void> {
  await vi.waitFor(() => expect(applied).toEqual(expected));
}

beforeEach(() => {
  vi.clearAllMocks();
  applied = [];
  pump = makePump();
  resetOpencodeSubscriptions();
  resetOpencodeToolCalls();
  resetOpencodePortAssignments();
  resetPendingDecisions();
  clearAgentStopEvents();
  clearPermissionDecisions();
  rememberOpencodePort(TARGET, PORT, '/tmp/wt');
  vi.mocked(openOpencodeEventStream).mockImplementation(
    async (_port: number, signal: AbortSignal) => pump.stream(signal)
  );
  vi.mocked(replyOpencodePermission).mockResolvedValue(true);
  // Auto-Yes off: the pre-#1898 default, and the branch where a human really is
  // blocked.
  vi.mocked(resolvePermissionRequest).mockReturnValue({
    behavior: null,
    reason: 'auto-yes-disabled',
  });
});

afterEach(() => {
  pump.end();
  resetOpencodeSubscriptions();
});

describe('an approval Auto-Yes answers (#1898-1)', () => {
  beforeEach(() => {
    vi.mocked(resolvePermissionRequest).mockReturnValue({ behavior: 'allow', reason: 'auto-yes' });
  });

  it('never opens the prompt-waiting record, through the whole live sequence', async () => {
    await subscribe();

    // The frame that names the tool. Maps to nothing, which is why the
    // subscription reads it separately (see ./payloads).
    pump.push('message-part-updated-tool-pending');

    // 1. `permission.asked`. The verdict leaves before the record is written,
    //    so there is no instant at which a human is reported blocked.
    pump.push('permission-asked');
    await appliedIs('notification:permission_prompt');
    expect(vi.mocked(replyOpencodePermission)).toHaveBeenCalledWith(PORT, PERMISSION_ID, 'once', undefined);
    expect(waiting()).toBeNull();

    // 2. `permission.replied` — the agent echoing our own reply. Still nothing
    //    open, and nothing reopened.
    pump.push('permission-replied');
    await appliedIs('notification:permission_prompt', 'notification:permission_replied');
    expect(waiting()).toBeNull();

    // 3. The gated tool runs. This is the eight seconds the Issue measured:
    //    `pre_tool_use` does not release the record, so before #1898 the whole
    //    of it read `waiting`.
    pump.push('message-part-updated-tool-running');
    await appliedIs(
      'notification:permission_prompt',
      'notification:permission_replied',
      'pre_tool_use:bash'
    );
    expect(waiting()).toBeNull();

    // 4. …and finishes, and the turn ends.
    pump.push('message-part-updated-tool-completed', 'session-status-busy', 'session-idle');
    await appliedIs(
      'notification:permission_prompt',
      'notification:permission_replied',
      'pre_tool_use:bash',
      'post_tool_use:bash',
      'stop'
    );
    expect(waiting()).toBeNull();
    expect(getLastAgentEvent('wt-1898', 'opencode', 'opencode')?.event).toBe('stop');
  });

  it('records what it decided, so the operator can see it happened', async () => {
    await subscribe();
    pump.push('permission-asked');
    await appliedIs('notification:permission_prompt');

    // §7 discoverability: an allow that dismisses a dialog nobody saw is
    // invisible unless something publishes it. This is what `capture --json`
    // prints as `structuredEvents.permissionDecision`.
    expect(getLastPermissionDecision('wt-1898', 'opencode', 'opencode')).toMatchObject({
      decisionId: PERMISSION_ID,
      behavior: 'allow',
      reason: 'auto-yes',
      delivered: true,
      releasedPrompt: true,
      trigger: 'event',
    });
  });

  it('keeps the human blocked when the reply could not be delivered', async () => {
    // The other half of `settled`. A refused POST leaves the dialog on screen,
    // and reporting it as answered would be worse than the bug being fixed.
    vi.mocked(replyOpencodePermission).mockResolvedValue(false);
    await subscribe();
    pump.push('permission-asked');
    await appliedIs('notification:permission_prompt');

    expect(waiting()).toMatchObject({ source: 'notification', decisionId: PERMISSION_ID });
    expect(getLastPermissionDecision('wt-1898', 'opencode', 'opencode')).toMatchObject({
      delivered: false,
      releasedPrompt: false,
    });
  });
});

describe('an approval a human answers in the terminal (#1898-2 release path)', () => {
  it('opens on `permission.asked` and releases on `permission.replied`', async () => {
    await subscribe();
    pump.push('message-part-updated-tool-pending', 'permission-asked');
    await appliedIs('notification:permission_prompt');

    // Auto-Yes abstained, so a human really is blocked — and on this tool that
    // costs the session, not a dialog (#1758 §5.5.3).
    expect(waiting()).toMatchObject({
      source: 'notification',
      confirmedAt: expect.any(Number),
      decisionId: PERMISSION_ID,
      // Issue #2031: `bash`, not null. The tool name is not in
      // `permission.asked` at all (#1758 §5.4) — it is the `message.part.updated`
      // frame pumped on the line above, correlated by `callID`. Until #2031 the
      // notification path passed `toolName: null` unconditionally and threw the
      // correlation away, so the browser was told a dialog was open and never
      // what it was for. `patterns` is the same frame's `["/tmp/*"]`, retained
      // because it is what answering `Allow always` would save.
      toolName: 'bash',
      patterns: ['/tmp/*'],
    });
    expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();

    // Somebody pressed a key in the pane. Before #1898 this frame mapped to
    // nothing and the record stayed open until `post_tool_use`.
    pump.push('permission-replied');
    await appliedIs('notification:permission_prompt', 'notification:permission_replied');
    expect(waiting()).toBeNull();
  });

  it('does not let one approval’s reply retire another’s record', async () => {
    await subscribe();
    pump.push('permission-asked');
    await appliedIs('notification:permission_prompt');

    // A reply for an approval this record is not about. `requestID` is the
    // decision identity the `eventIdentity` capability declares, and it is the
    // whole reason the record carries one.
    const other = frame('permission-replied') as { properties: Record<string, unknown> };
    other.properties.requestID = 'per_someone_elses_dialog';
    await ingestOpencodeEvent(
      TARGET,
      opencodeAgentEventSource.normalizeEvent({ payload: other, receivedAt: Date.now() })!
    );

    expect(waiting()).toMatchObject({ decisionId: PERMISSION_ID });
  });
});

describe('the boundary frame opencode re-sends', () => {
  it('does not reopen or restart anything after the turn ended', async () => {
    // Measured on 1.18.3: `message.updated(role:user)` arrives 46 ms AFTER
    // `session.idle`, byte-identical to the copy that opened the turn. The turn
    // gate suppresses it (`opencode-repeat-suppressed`); if a future release
    // stops suppressing it, the finished turn reads `running` for the next
    // thirty minutes — and, with #1898's release rules, would also be a second
    // chance to disturb the dialog state.
    vi.mocked(resolvePermissionRequest).mockReturnValue({ behavior: 'allow', reason: 'auto-yes' });
    await subscribe();

    pump.push('message-updated-user', 'session-status-busy', 'permission-asked', 'permission-replied');
    await appliedIs(
      'user_prompt_submit',
      'notification:permission_prompt',
      'notification:permission_replied'
    );

    pump.push('session-idle');
    await appliedIs(
      'user_prompt_submit',
      'notification:permission_prompt',
      'notification:permission_replied',
      'stop'
    );

    // The resend. Same fixture, same message id.
    pump.push('message-updated-user');
    // Nothing new may be applied. Asserted by pushing a frame that IS applied
    // afterwards, so the wait is on a real signal rather than on a timeout.
    pump.push('session-created');
    await appliedIs(
      'user_prompt_submit',
      'notification:permission_prompt',
      'notification:permission_replied',
      'stop',
      'session_start'
    );
    expect(waiting()).toBeNull();
  });
});

describe('the capability is read, not assumed', () => {
  it('stops releasing when `permissionReplyReleasesPrompt` is declared false', async () => {
    // The mutation case §4 D3 asks for: flip the declared value and the
    // behaviour this Issue added must disappear. If this test stays green with
    // the capability flipped, the state machine is not reading it.
    const declared = opencodeAgentEventSource.capabilities;
    const patched = { ...declared, permissionReplyReleasesPrompt: false };
    Object.defineProperty(opencodeAgentEventSource, 'capabilities', {
      value: patched,
      configurable: true,
    });

    try {
      await subscribe();
      pump.push('permission-asked');
      await appliedIs('notification:permission_prompt');
      expect(waiting()).not.toBeNull();

      pump.push('permission-replied');
      await appliedIs('notification:permission_prompt', 'notification:permission_replied');
      // Pre-#1898 behaviour: the reply says nothing, and only `post_tool_use`
      // or `stop` retires the record.
      expect(waiting()).not.toBeNull();
    } finally {
      Object.defineProperty(opencodeAgentEventSource, 'capabilities', {
        value: declared,
        configurable: true,
      });
    }
  });

  it('stops settling an allow when the same value is declared false', async () => {
    vi.mocked(resolvePermissionRequest).mockReturnValue({ behavior: 'allow', reason: 'auto-yes' });
    const declared = opencodeAgentEventSource.capabilities;
    Object.defineProperty(opencodeAgentEventSource, 'capabilities', {
      value: { ...declared, permissionReplyReleasesPrompt: false },
      configurable: true,
    });

    try {
      await subscribe();
      pump.push('permission-asked');
      await appliedIs('notification:permission_prompt');
      // Delivered, but this source no longer claims that settles the screen —
      // which is exactly what every hook source declares, and why they are
      // unaffected by this Issue.
      expect(vi.mocked(replyOpencodePermission)).toHaveBeenCalled();
      expect(waiting()).not.toBeNull();
    } finally {
      Object.defineProperty(opencodeAgentEventSource, 'capabilities', {
        value: declared,
        configurable: true,
      });
    }
  });
});
