/**
 * De-duplication on the SSE path, keyed by the frame's own id (Issue #1899).
 *
 * The ingest ran every frame through `isDuplicateAgentEvent`, whose key is
 * `(worktree, tool, instance, event, detail, sessionID)` over a 3-second
 * window. None of the ids opencode publishes are in that key, so **two
 * different facts about the same session inside three seconds read as one
 * delivery**. Measured (Issue text):
 *
 *  - `permission.asked per_1` at t0 and `permission.asked per_2` at t0+1000 —
 *    the second was neither adjudicated nor recorded, and opencode blocks on an
 *    unanswered approval indefinitely (10m19s in #1758 §5.5.3). Auto-Yes could
 *    not answer it, and the structured layer did not even know a human was
 *    needed;
 *  - `stop` twice 2500 ms apart — the second turn's completion vanished,
 *    leaving the newest event at `user_prompt_submit`, the instance reading
 *    `running`, and `commandmate wait` blocked to the 30-minute staleness
 *    bound;
 *  - `question.asked` 1500 ms apart and `pre_tool_use(bash)` 500 ms apart —
 *    same shape.
 *
 * ## What replaces it, and why it is not "skip the guard for opencode"
 *
 * The guard is not skipped and no tool name is read. `AgentSourceCapabilities`
 * already declares where a frame-unique id comes from (#1924); opencode says
 * `'permission-id'` and every push source says `null`.
 * `classifyAgentEventDelivery` reads the declaration:
 *
 *  - id present -> key on it, **with no time bound**, which is stricter than
 *    the window for the case the window was reaching for (a re-sync replaying a
 *    frame minutes after the live stream delivered it);
 *  - no id, and the word ends something (`stop` / `session_end`) -> not
 *    suppressed, because opencode's `session.idle` is `{ sessionID }` and
 *    carries nothing that could tell two turns apart. `TurnGate` counts turns
 *    on this path; the window never could;
 *  - anything else -> the time window, unchanged.
 *
 * The last clause is what keeps push hooks exactly as they were: #1722's
 * concatenated settings post two `Stop`s for one turn, and nothing but the
 * window separates them.
 *
 * ## Why the `stop` cases drive the subscription
 *
 * Because dropping the window from the ingest moves the duty of counting turns
 * onto the gate, and a pin written against synthesised ingest calls would be
 * green whether or not the gate is still there. `an aborted turn still applies
 * exactly one stop` is the other half of the argument, and it only exists end
 * to end.
 *
 * @vitest-environment node
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

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
    fetchOpencodePendingPermissions: vi.fn().mockResolvedValue([]),
    fetchOpencodePendingQuestions: vi.fn().mockResolvedValue([]),
    replyOpencodePermission: vi.fn().mockResolvedValue(true),
    replyOpencodeQuestion: vi.fn().mockResolvedValue(true),
    // Issue #1900 put two more client calls in front of the stream: the
    // reconnect loop will not open `/event` until `/global/health` has named
    // the process on the port, and it polls `/session/status` once the stream
    // is up. Left unmocked they are real `fetch`es to a port nothing is
    // listening on, the health probe answers `refused`, and the loop backs off
    // without ever subscribing — which is exactly how this file broke when
    // #1899 and #1900 were merged (Issue #1963).
    probeOpencodeHealth: vi.fn(),
    fetchOpencodeSessionStatuses: vi.fn().mockResolvedValue({}),
    openOpencodeEventStream: vi.fn(),
  };
});

import {
  fetchOpencodeSessionStatuses,
  openOpencodeEventStream,
  probeOpencodeHealth,
  replyOpencodePermission,
  type OpencodeFrame,
} from '@/lib/hooks/sources/opencode/client';
import { ingestOpencodeEvent } from '@/lib/hooks/sources/opencode/ingest';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import { opencodeEventIdentity } from '@/lib/hooks/sources/opencode/mappers';
import { resetOpencodeToolCalls } from '@/lib/hooks/sources/opencode/payloads';
import {
  rememberOpencodePort,
  resetOpencodePortAssignments,
} from '@/lib/hooks/sources/opencode/ports';
import { resetOpencodeSubscriptions } from '@/lib/hooks/sources/opencode/subscription';
import { readEventIdentity, MAX_EVENT_IDENTITY_LENGTH } from '@/lib/hooks/sources/event-mapper';
import { resolvePermissionRequest } from '@/lib/hooks/permission-decision-service';
import { applyAgentStopEvent } from '@/lib/hooks/agent-event-service';
import { getWorktreeById } from '@/lib/db';
import {
  classifyAgentEventDelivery,
  clearAgentStopEvents,
  getAskUserQuestion,
  getLastAgentEvent,
  getRecentEventIdentityCount,
  LIFECYCLE_AGENT_EVENT_TYPES,
} from '@/lib/session/agent-event-state';
import { resetPendingDecisions, type NormalizedAgentEvent } from '@/lib/hooks/sources';
import type { Worktree } from '@/types/models';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');

function frame(name: string): OpencodeFrame {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

/** `properties` of a fixture frame, for the clones below. */
function properties(payload: OpencodeFrame): Record<string, unknown> {
  return payload.properties as Record<string, unknown>;
}

/** A `permission.asked` for a different approval. */
function permissionAsked(id: string): OpencodeFrame {
  const payload = frame('permission-asked');
  properties(payload).id = id;
  return payload;
}

/** A `question.asked` for a different question. */
function questionAsked(id: string, text: string): OpencodeFrame {
  const payload = frame('question-asked');
  properties(payload).id = id;
  (properties(payload).questions as Record<string, unknown>[])[0].question = text;
  return payload;
}

/** A `message.part.updated(running)` for a different tool call. */
function toolRunning(callId: string): OpencodeFrame {
  const payload = frame('message-part-updated-tool-running');
  (properties(payload).part as Record<string, unknown>).callID = callId;
  return payload;
}

/** The event the subscription would hand to `ingestOpencodeEvent`. */
function normalized(payload: OpencodeFrame, receivedAt: number): NormalizedAgentEvent {
  const event = opencodeAgentEventSource.normalizeEvent({ payload, receivedAt });
  if (!event) throw new Error(`frame ${String(payload.type)} did not normalise`);
  return event;
}

/** Every action name logged at one level. */
function loggedActions(level: 'info' | 'warn'): string[] {
  return mockLogger[level].mock.calls.map((call) => String(call[0]));
}

/** How many frames the ingest refused as repeats. */
function droppedCount(): number {
  return loggedActions('info').filter((action) => action === 'opencode-event-duplicate-dropped')
    .length;
}

const T0 = 1_800_000_000_000;
const PORT = 4242;
/** What `/global/health` answers. Constant, so no reconnect reads a new process. */
const SERVER_VERSION = '1.18.21';
const TARGET = { worktreeId: 'wt-1899', cliToolId: 'opencode', instanceId: 'opencode' } as const;
const WORKTREE = { id: 'wt-1899', path: '/tmp/wt-1899' } as unknown as Worktree;

let sandbox: string;

beforeAll(() => {
  sandbox = makeTempDir('opencode-dedup-1899-');
});

afterAll(() => {
  removeTempDir(sandbox);
});

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  resetPendingDecisions();
  resetOpencodeToolCalls();
  resetOpencodeSubscriptions();
  resetOpencodePortAssignments();
  vi.stubEnv('CM_OPENCODE_PORT_FILE', join(sandbox, 'opencode-ports.json'));
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '1');
  rememberOpencodePort(TARGET, PORT, '/tmp/wt-1899');
  vi.mocked(getWorktreeById).mockReturnValue(WORKTREE);
  vi.mocked(replyOpencodePermission).mockResolvedValue(true);
  vi.mocked(probeOpencodeHealth).mockResolvedValue({
    kind: 'healthy',
    health: { healthy: true, version: SERVER_VERSION },
  });
  vi.mocked(fetchOpencodeSessionStatuses).mockResolvedValue({});
  vi.mocked(resolvePermissionRequest).mockReturnValue({
    behavior: null,
    reason: 'auto-yes-disabled',
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetOpencodeSubscriptions();
  resetOpencodePortAssignments();
});

// ===========================================================================
// The four measured cases
// ===========================================================================

describe('two facts inside the window are two facts (#1899)', () => {
  it('adjudicates a second approval that arrives 1000 ms after the first', async () => {
    // The case with teeth: Auto-Yes is on, the first approval is answered, and
    // the second one arrives while the window is still warm. Before this Issue
    // it was dropped before `adjudicatePermission` ever ran, so the agent sat
    // on a dialog nobody had answered and nothing above the ingest knew.
    vi.mocked(resolvePermissionRequest).mockReturnValue({ behavior: 'allow', reason: 'auto-yes' });

    await ingestOpencodeEvent(TARGET, normalized(permissionAsked('per_first'), T0));
    await ingestOpencodeEvent(TARGET, normalized(permissionAsked('per_second'), T0 + 1000));

    expect(droppedCount()).toBe(0);
    expect(vi.mocked(replyOpencodePermission).mock.calls.map((call) => call[1])).toEqual([
      'per_first',
      'per_second',
    ]);
  });

  it('applies a stop 2500 ms after the previous stop', async () => {
    await ingestOpencodeEvent(TARGET, normalized(frame('session-idle'), T0));
    await ingestOpencodeEvent(TARGET, normalized(frame('session-idle'), T0 + 2500));

    expect(droppedCount()).toBe(0);
    // The effect `commandmate wait` is waiting on. One call is the pre-#1899
    // behaviour: the second turn never completed as far as anything above the
    // ingest could tell.
    expect(vi.mocked(applyAgentStopEvent)).toHaveBeenCalledTimes(2);
    expect(getLastAgentEvent('wt-1899', 'opencode', 'opencode')).toMatchObject({
      event: 'stop',
      at: T0 + 2500,
    });
  });

  it('records a second question that arrives 1500 ms after the first', async () => {
    await ingestOpencodeEvent(TARGET, normalized(questionAsked('que_first', 'Red or blue?'), T0));
    await ingestOpencodeEvent(
      TARGET,
      normalized(questionAsked('que_second', 'Ship it or hold it?'), T0 + 1500)
    );

    expect(droppedCount()).toBe(0);
    // The picker on screen is the second question. Dropping it left the human
    // looking at one dialog while CommandMate described another.
    expect(
      getAskUserQuestion('wt-1899', 'opencode', 'opencode', T0 + 1500)?.spec.questions[0].question
    ).toBe('Ship it or hold it?');
  });

  it('records a second tool call that arrives 500 ms after the first', async () => {
    await ingestOpencodeEvent(TARGET, normalized(toolRunning('toolu_first'), T0));
    await ingestOpencodeEvent(TARGET, normalized(toolRunning('toolu_second'), T0 + 500));

    expect(droppedCount()).toBe(0);
    expect(getLastAgentEvent('wt-1899', 'opencode', 'opencode')).toMatchObject({
      event: 'pre_tool_use',
      detail: 'bash',
      at: T0 + 500,
    });
  });
});

// ===========================================================================
// What the identity key still collapses
// ===========================================================================

describe('the same frame is still one delivery', () => {
  it('drops a re-sync replay of an approval the live stream already delivered', async () => {
    // The case the 3-second window was *reaching* for and never covered: a
    // re-sync is under no obligation to land inside three seconds. Ten minutes
    // later, `per_first` is still the same approval.
    await ingestOpencodeEvent(TARGET, normalized(permissionAsked('per_first'), T0));
    await ingestOpencodeEvent(TARGET, normalized(permissionAsked('per_first'), T0 + 600_000));

    expect(droppedCount()).toBe(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      'opencode-event-duplicate-dropped',
      expect.objectContaining({ by: 'identity' })
    );
  });

  it('drops a second delivery of the same tool call', async () => {
    await ingestOpencodeEvent(TARGET, normalized(toolRunning('toolu_first'), T0));
    await ingestOpencodeEvent(TARGET, normalized(toolRunning('toolu_first'), T0 + 40));

    expect(droppedCount()).toBe(1);
  });

  it('lets the reply through although it carries the id of the ask (#1898)', async () => {
    // `permission.asked` puts the approval id in `properties.id`;
    // `permission.replied` puts the *same* value in `properties.requestID`.
    // A key made of the identity alone would read the reply as a repeat and
    // drop the only positive statement any source makes that a dialog is gone.
    expect(opencodeEventIdentity(frame('permission-replied'))).toBe(
      opencodeEventIdentity(frame('permission-asked'))
    );

    await ingestOpencodeEvent(TARGET, normalized(frame('permission-asked'), T0));
    await ingestOpencodeEvent(TARGET, normalized(frame('permission-replied'), T0 + 200));

    expect(droppedCount()).toBe(0);
    expect(loggedActions('info')).toContain('opencode-permission-reply-observed');
  });

  it('keeps the pre/post pair of one tool call apart', async () => {
    // Same `callID`, two different words. Collapsing them would leave a tool
    // call that started and never finished.
    await ingestOpencodeEvent(TARGET, normalized(frame('message-part-updated-tool-running'), T0));
    await ingestOpencodeEvent(
      TARGET,
      normalized(frame('message-part-updated-tool-completed'), T0 + 300)
    );

    expect(droppedCount()).toBe(0);
    expect(getLastAgentEvent('wt-1899', 'opencode', 'opencode')).toMatchObject({
      event: 'post_tool_use',
      detail: 'bash',
    });
  });
});

// ===========================================================================
// The other half of the safety argument: the gate still counts turns
// ===========================================================================

describe('the turn gate is what counts turns now', () => {
  /** A stream the test feeds one frame at a time. */
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

  let pump: ReturnType<typeof makePump>;
  /** How many times the loop reached `openOpencodeEventStream`. */
  let pumpStreams: number;

  beforeEach(async () => {
    pump = makePump();
    pumpStreams = 0;
    // Issue #1900 split the connect from the iteration: `readOpencodeEventStream`
    // became `openOpencodeEventStream`, which is `async` and resolves only once
    // the `fetch` has settled — that is what lets the loop re-read `GET
    // /permission` on a stream it has already subscribed to. The mock resolves
    // the pump for the same reason.
    vi.mocked(openOpencodeEventStream).mockImplementation(
      async (_port: number, signal: AbortSignal) => {
        pumpStreams += 1;
        return pump.stream(signal);
      }
    );

    let chain = Promise.resolve();
    // Subscribed the way production does, through the source, so the declared
    // `capabilities.resync` is the one in play rather than a hand-written
    // option object that cannot go stale (#1900). The port comes off the
    // recorded assignment `rememberOpencodePort` made above.
    await opencodeAgentEventSource.subscribe(TARGET, (event) => {
      chain = chain.then(() => ingestOpencodeEvent(TARGET, event));
    });

    // The precondition every case below rests on, asserted rather than assumed.
    // `openOpencodeSubscription` resolves when the reconnect *loop* starts, not
    // when the stream is open, and since #1900 three awaits sit in between:
    // `/global/health`, the stream itself, then `GET /permission` and
    // `GET /session/status`. Frames pushed before the loop gets there are held
    // by the pump, so the wait is about legibility — a health probe that says
    // `refused` fails here, naming the cause, instead of surfacing three
    // screens down as a `stop` that was never applied (Issue #1963).
    await vi.waitFor(() => expect(pumpStreams).toBe(1));
  });

  afterEach(() => {
    pump.end();
  });

  it('applies both stops of two turns delivered back to back', async () => {
    // Two complete turns with no wall-clock gap at all — strictly harder than
    // the 2500 ms the Issue measured, and impossible to pass with a time
    // window of any length.
    pump.push(
      'session-status-busy',
      'session-idle',
      'session-status-busy',
      'session-idle'
    );

    await vi.waitFor(() => expect(vi.mocked(applyAgentStopEvent)).toHaveBeenCalledTimes(2));
    expect(droppedCount()).toBe(0);
  });

  it('applies exactly one stop for an aborted turn that fires session.idle twice', async () => {
    // The measured abort (#1758 §5.3.2b): one turn, two idles 19 ms apart. The
    // ingest no longer has a window to catch it with, so this is the pin that
    // the gate really is doing the job the window used to be credited with.
    //
    // Mutation target: drop the `already-completed` arm of `TurnGate` and one
    // aborted turn resolves two `commandmate wait`s.
    pump.push(
      'session-status-busy',
      'session-error',
      'session-status-idle',
      'session-idle',
      'session-status-idle',
      'session-idle'
    );

    await vi.waitFor(() => expect(vi.mocked(applyAgentStopEvent)).toHaveBeenCalledTimes(1));
    // Give the second idle every chance to arrive before believing the count.
    await vi.waitFor(() => expect(loggedActions('info')).toContain('opencode-event-received'));
    expect(vi.mocked(applyAgentStopEvent)).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// The capability, not the tool name
// ===========================================================================

describe('the rule is chosen by the declared capability', () => {
  it('puts every frame back on the time window when the declaration is null', async () => {
    // The non-vacuity control for the whole file: flip the one declared value
    // and the four cases above go back to being dropped. Nothing here reads a
    // tool name, so this is the only thing that can select the rule.
    const declared = opencodeAgentEventSource.capabilities;
    Object.defineProperty(opencodeAgentEventSource, 'capabilities', {
      value: { ...declared, eventIdentity: null },
      configurable: true,
    });

    try {
      await ingestOpencodeEvent(TARGET, normalized(permissionAsked('per_first'), T0));
      await ingestOpencodeEvent(TARGET, normalized(permissionAsked('per_second'), T0 + 1000));
      await ingestOpencodeEvent(TARGET, normalized(frame('session-idle'), T0));
      await ingestOpencodeEvent(TARGET, normalized(frame('session-idle'), T0 + 2500));

      expect(droppedCount()).toBe(2);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'opencode-event-duplicate-dropped',
        expect.objectContaining({ by: 'time-window' })
      );
    } finally {
      Object.defineProperty(opencodeAgentEventSource, 'capabilities', {
        value: declared,
        configurable: true,
      });
    }
  });

  it('declares the identity and the reader that finds it together', () => {
    // Declaring the capability without wiring `extractEventIdentity` would
    // announce an id nothing can read, and every frame would silently fall back
    // to the window with no test able to tell.
    expect(opencodeAgentEventSource.capabilities.eventIdentity).toBe('permission-id');
    expect(opencodeAgentEventSource.eventIdentityOf(frame('permission-asked'))).toBe(
      'per_0000000000000000000000000'
    );
  });

  it('answers null for the frames that publish no id', () => {
    // `session.idle` is `{ sessionID }` and nothing else — the measurement the
    // lifecycle exemption rests on.
    expect(opencodeAgentEventSource.eventIdentityOf(frame('session-idle'))).toBeNull();
    expect(opencodeAgentEventSource.eventIdentityOf(frame('session-created'))).toBeNull();
    expect(opencodeAgentEventSource.eventIdentityOf(frame('session-error'))).toBeNull();
    expect(opencodeAgentEventSource.eventIdentityOf(frame('server-heartbeat'))).toBeNull();
  });

  it('answers null for every push source, which is what keeps them on the window', () => {
    // #1722 ships two `Stop` hooks per turn on any host that followed the
    // #1549 manual setup, and the window is the only thing separating them.
    for (const source of ['claude', 'codex', 'gemini', 'copilot', 'antigravity'] as const) {
      const verdict = classifyAgentEventDelivery({
        worktreeId: 'wt-push',
        cliToolId: source,
        instanceId: source,
        event: 'stop',
        detail: null,
        sessionId: 'sess-push',
        at: T0,
        identity: null,
        identityKind: null,
      });
      expect(verdict).toEqual({ duplicate: false });

      expect(
        classifyAgentEventDelivery({
          worktreeId: 'wt-push',
          cliToolId: source,
          instanceId: source,
          event: 'stop',
          detail: null,
          sessionId: 'sess-push',
          at: T0 + 100,
          identity: null,
          identityKind: null,
        })
      ).toEqual({ duplicate: true, by: 'time-window' });
    }
  });
});

// ===========================================================================
// The policy, on its own
// ===========================================================================

describe('classifyAgentEventDelivery', () => {
  const BASE = {
    worktreeId: 'wt-policy',
    cliToolId: 'opencode',
    instanceId: 'opencode',
    detail: null,
    sessionId: 'ses_policy',
    identityKind: 'permission-id',
  } as const;

  it('exempts the two words that end something, and only for a declared source', () => {
    expect(LIFECYCLE_AGENT_EVENT_TYPES).toEqual(['stop', 'session_end']);

    for (const event of LIFECYCLE_AGENT_EVENT_TYPES) {
      expect(
        classifyAgentEventDelivery({ ...BASE, event, at: T0, identity: null })
      ).toEqual({ duplicate: false });
      expect(
        classifyAgentEventDelivery({ ...BASE, event, at: T0 + 10, identity: null })
      ).toEqual({ duplicate: false });
    }
  });

  it('still windows an id-less frame that is not a turn boundary', () => {
    // `session.created` and `session.error` carry no id either, but neither of
    // them ends a turn — so they keep the behaviour they had.
    expect(
      classifyAgentEventDelivery({ ...BASE, event: 'session_start', at: T0, identity: null })
    ).toEqual({ duplicate: false });
    expect(
      classifyAgentEventDelivery({ ...BASE, event: 'session_start', at: T0 + 10, identity: null })
    ).toEqual({ duplicate: true, by: 'time-window' });
  });

  it('bounds the retained ids per instance, not across the server', () => {
    // A chatty pane must not be able to evict a quiet one's ids and let a
    // genuine re-delivery through there (DR4-009). Order matters: the quiet id
    // is claimed *first*, so under one flat 512-entry map it would be the
    // oldest of 601 and gone by the end of the loop.
    classifyAgentEventDelivery({
      ...BASE,
      worktreeId: 'wt-quiet',
      event: 'pre_tool_use',
      at: T0,
      identity: 'toolu_quiet',
    });
    for (let i = 0; i < 600; i += 1) {
      classifyAgentEventDelivery({
        ...BASE,
        event: 'pre_tool_use',
        at: T0 + i,
        identity: `toolu_busy_${i}`,
      });
    }

    // The chatty instance is still bounded — it is the *sharing* that is gone.
    expect(getRecentEventIdentityCount('wt-policy', 'opencode', 'opencode')).toBe(512);
    expect(getRecentEventIdentityCount('wt-quiet', 'opencode', 'opencode')).toBe(1);
    expect(
      classifyAgentEventDelivery({
        ...BASE,
        worktreeId: 'wt-quiet',
        event: 'pre_tool_use',
        at: T0 + 1,
        identity: 'toolu_quiet',
      })
    ).toEqual({ duplicate: true, by: 'identity' });
  });
});

describe('readEventIdentity', () => {
  it('discards an over-long id rather than truncating it', () => {
    // Truncating would make every id sharing a prefix collide, which turns one
    // over-long value into a way of making unrelated frames look like repeats.
    // Null instead puts the frame back on the window (DR4-001).
    expect(readEventIdentity('a'.repeat(MAX_EVENT_IDENTITY_LENGTH))).toBe(
      'a'.repeat(MAX_EVENT_IDENTITY_LENGTH)
    );
    expect(readEventIdentity('a'.repeat(MAX_EVENT_IDENTITY_LENGTH + 1))).toBeNull();
  });

  it('discards anything outside the id alphabet', () => {
    expect(readEventIdentity('per_0123-AB.c:d')).toBe('per_0123-AB.c:d');
    expect(readEventIdentity('per 0123')).toBeNull();
    expect(readEventIdentity('')).toBeNull();
    expect(readEventIdentity(null)).toBeNull();
  });
});
