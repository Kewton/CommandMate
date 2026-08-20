/**
 * Can the abstraction hold a *pull* source? (Issue #1759 / #1758 §9.4)
 *
 * The interface was designed against Claude, and a design validated only
 * against the tool it was extracted from is a design that will need rewriting
 * for Phase 4-5. `docs/design/opencode-server-live-verification.md` §9.4 lists
 * eleven things it must be able to express; this file works through them by
 * building an opencode-shaped source out of the abstraction and driving it with
 * the SSE frames actually captured from `opencode serve` 1.18.3.
 *
 * **The source below is a test double, not shipped support.** Real opencode
 * support is #1763; what is being proved here is that when it arrives it will
 * be a file, not a redesign. It is written the way a real one would be — the
 * predicates, the field paths and the three-valued reply are all lifted from
 * the captured frames — so that if the interface cannot hold it, this file
 * fails to compile or fails to map.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  boundDetail,
  definePullEventSource,
  getUnknownEventTally,
  isAbstainSafe,
  isPlainObject,
  readNestedString,
  resetUnknownEventTallies,
  whenNamed,
  type AgentEventSource,
  type EventMapper,
  type NormalizedAgentEvent,
  type PendingDecision,
  type SourceLiveness,
  type Subscription,
  type Verdict,
} from '@/lib/hooks/sources';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');

/** One captured SSE frame: `{ id, type, properties }`. */
function frame(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

const props = (payload: Record<string, unknown>): Record<string, unknown> =>
  isPlainObject(payload.properties) ? payload.properties : {};

// ---------------------------------------------------------------------------
// The mappers a real opencode source would carry (C4)
// ---------------------------------------------------------------------------
//
// A `Record<string, AgentEventType>` cannot express any of the three shapes
// below, which is the entire reason `EventMapper` is a function.

const partState = (payload: Record<string, unknown>): string | null =>
  readNestedString(props(payload), ['part', 'state', 'status']);

const partIsTool = (payload: Record<string, unknown>): boolean =>
  readNestedString(props(payload), ['part', 'type']) === 'tool';

const toolName = (payload: Record<string, unknown>): string | null =>
  readNestedString(props(payload), ['part', 'tool']);

const callId = (payload: Record<string, unknown>): string | null =>
  readNestedString(props(payload), ['part', 'callID']);

/**
 * opencode's `sessionID` sits inside `properties`, so the flat
 * `conversationIdFields` path cannot reach it — a source with a nested envelope
 * fills the field in its rules instead. That the interface allows either is the
 * point of C5.
 */
const withConversation =
  (mapper: EventMapper): EventMapper =>
  (type, payload) => {
    const mapped = mapper(type, payload);
    if (!mapped) return null;
    return {
      ...mapped,
      conversationId: mapped.conversationId ?? readNestedString(props(payload), ['sessionID']),
    };
  };

const OPENCODE_MAPPERS: readonly EventMapper[] = [
  // 1:1.
  whenNamed('session.idle', 'stop'),
  whenNamed('session.created', 'session_start'),
  whenNamed('session.deleted', 'session_end'),

  // Composite: the same event name, split on a nested field.
  (type, payload) =>
    type === 'message.updated' && readNestedString(props(payload), ['info', 'role']) === 'user'
      ? { event: 'user_prompt_submit' }
      : null,

  // Partial match: one event name, two words, chosen by `part.state.status`.
  (type, payload) =>
    type === 'message.part.updated' && partIsTool(payload) && partState(payload) === 'running'
      ? {
          event: 'pre_tool_use',
          detail: boundDetail(toolName(payload)),
          toolCallId: callId(payload),
        }
      : null,
  (type, payload) =>
    type === 'message.part.updated' &&
    partIsTool(payload) &&
    ['completed', 'error'].includes(partState(payload) ?? '')
      ? {
          event: 'post_tool_use',
          detail: boundDetail(toolName(payload)),
          toolCallId: callId(payload),
        }
      : null,

  // Bundle: three unrelated events collapse into `notification`, told apart by
  // `detail`. `permission_prompt` is deliberately Claude's spelling — see the
  // assertion about `wait --on-prompt` below.
  whenNamed('permission.asked', 'notification', 'permission_prompt'),
  whenNamed('question.asked', 'notification', 'question_prompt'),
  whenNamed('session.error', 'notification', 'error'),
];

// ---------------------------------------------------------------------------
// The source itself — the "one file" a Phase 4-5 implementer would write
// ---------------------------------------------------------------------------

interface FakeServer {
  /** Reply calls the source made, in order: `POST /…/permissions/:id` etc. */
  replies: Array<{ id: string; verdict: Verdict }>;
  pending: PendingDecision[];
  activity: 'busy' | 'idle' | null;
  liveness: SourceLiveness;
  /** SSE frames to deliver on subscribe. */
  stream: Array<Record<string, unknown>>;
  closed: boolean;
}

function buildOpencodeSource(server: FakeServer): AgentEventSource {
  const source: AgentEventSource = definePullEventSource({
    cliToolId: 'opencode',

    // C3. Measured: a permission left unanswered was still pending after
    // 10 minutes 19 seconds. There is no fall-through to a TUI prompt, because
    // the TUI prompt and the API request are the same object.
    noDecision: { kind: 'blocks' },

    capabilities: {
      // `notification` is here only as the three-event bundle above; there is
      // no `idle_prompt` equivalent. `session_end` is listed but means
      // "somebody called DELETE /session/:id" — `/exit` emits nothing at all,
      // which is why process death stays tmux's job.
      supportedEvents: [
        'stop',
        'session_start',
        'session_end',
        'user_prompt_submit',
        'pre_tool_use',
        'post_tool_use',
        'notification',
      ],
      configScope: 'none',
      decisionTimeoutSeconds: null,
    },

    mappers: OPENCODE_MAPPERS.map(withConversation),
    // The envelope names the event in `type`, not in `hook_event_name`.
    nativeEventNameFields: ['type'],
    conversationIdFields: [],

    parsePermissionRequest: () => null,
    parseQuestion: () => null,

    async subscribe(_target, onEvent): Promise<Subscription> {
      for (const raw of server.stream) {
        const normalized = source.normalizeEvent({ payload: raw, receivedAt: 1_000 });
        if (normalized) onEvent(normalized);
      }
      return {
        close: async () => {
          server.closed = true;
        },
        liveness: server.liveness,
      };
    },

    async decide(_target, decision, verdict) {
      // C2: a second HTTP call, on a connection the event never travelled over.
      server.replies.push({ id: decision.id, verdict });
    },

    async listPending() {
      return server.pending;
    },

    async probeActivity() {
      return server.activity;
    },

    liveness: () => server.liveness,
  });

  return source;
}

const REF = { worktreeId: 'wt-1', cliToolId: 'opencode', instanceId: 'opencode' } as const;

let server: FakeServer;
let source: AgentEventSource;

beforeEach(() => {
  resetUnknownEventTallies();
  server = {
    replies: [],
    pending: [],
    activity: null,
    liveness: { state: 'unknown' },
    stream: [],
    closed: false,
  };
  source = buildOpencodeSource(server);
});

describe('#1758 §9.4 checklist', () => {
  it('1. declares transport, and subscribe/close mean something on both', async () => {
    expect(source.transport).toBe('pull');

    server.stream = [frame('session-created'), frame('session-idle')];
    const seen: NormalizedAgentEvent[] = [];
    const subscription = await source.subscribe(REF, (event) => seen.push(event));

    expect(seen.map((e) => e.event)).toEqual(['session_start', 'stop']);
    await subscription.close();
    expect(server.closed).toBe(true);
  });

  it('2. decide() hides "write the body" from "call a different REST endpoint"', async () => {
    // The same call the permission receiver makes for Claude. Here nothing is
    // written to any response — the verdict leaves over its own connection.
    expect(source.encodeVerdict({ kind: 'allowOnce' })).toEqual({ kind: 'outOfBand' });

    const decision: PendingDecision = {
      kind: 'permission',
      id: 'per_0000000000000000000000000',
      conversationId: 'ses_0000000000000000000000000',
      subject: { kind: 'permission', toolName: 'bash', toolInput: {} },
      raw: frame('permission-asked'),
      askedAt: 0,
    };
    await source.decide(REF, decision, { kind: 'allowAlways' });

    expect(server.replies).toEqual([
      { id: 'per_0000000000000000000000000', verdict: { kind: 'allowAlways' } },
    ]);
  });

  it('3. noDecision exists as a type and says abstaining blocks here', () => {
    // Without this the receiver abstains politely and the opencode session
    // stops for good, with nothing in any log to say so.
    expect(source.noDecision).toEqual({ kind: 'blocks' });
    expect(isAbstainSafe(source)).toBe(false);
  });

  it('4. Verdict covers once / always / reject and a question answer', async () => {
    const verdicts: Verdict[] = [
      { kind: 'allowOnce' },
      { kind: 'allowAlways' },
      { kind: 'deny', message: 'not this time' },
      { kind: 'answer', answers: [['Blue'], ['VS Code']] },
    ];
    for (const verdict of verdicts) {
      await source.decide(REF, { ...basePending(), id: `d-${verdict.kind}` }, verdict);
    }
    expect(server.replies.map((r) => r.verdict.kind)).toEqual([
      'allowOnce',
      'allowAlways',
      'deny',
      'answer',
    ]);
  });

  it('5. the mapper is predicate-based, so one event name yields two words', () => {
    // The thing a name table cannot do. Both frames are `message.part.updated`.
    const running = source.normalizeEvent({ payload: frame('message-part-updated-tool-running') });
    const completed = source.normalizeEvent({
      payload: frame('message-part-updated-tool-completed'),
    });
    const errored = source.normalizeEvent({ payload: frame('message-part-updated-tool-error') });
    const pendingPart = source.normalizeEvent({
      payload: frame('message-part-updated-tool-pending'),
    });

    expect(running?.event).toBe('pre_tool_use');
    expect(completed?.event).toBe('post_tool_use');
    expect(errored?.event).toBe('post_tool_use');
    // `pending` is the frame just before `running`; mapping it too would report
    // a tool call twice.
    expect(pendingPart).toBeNull();

    expect(running?.detail).toBe('bash');
    expect(running?.toolCallId).toBe('toolu_0000000000000000000000000');
  });

  it('5b. a composite rule reads a nested field to find user_prompt_submit', () => {
    // There is no dedicated event: it is `message.updated` with role `user`.
    expect(source.normalizeEvent({ payload: frame('message-updated-user') })?.event).toBe(
      'user_prompt_submit'
    );
  });

  it('5c. three unrelated events land on notification, told apart by detail', () => {
    const details = (['permission-asked', 'question-asked', 'session-error'] as const).map(
      (name) => source.normalizeEvent({ payload: frame(name) })
    );
    expect(details.map((d) => d?.event)).toEqual(['notification', 'notification', 'notification']);
    expect(details.map((d) => d?.detail)).toEqual([
      'permission_prompt',
      'question_prompt',
      'error',
    ]);
    // §9.3: `wait --on-prompt` has to mean the same thing on both sources, so
    // "a human is being waited on" must be spelled identically. It is Claude's
    // `permission_prompt`, reused deliberately rather than renamed.
    expect(details[0]?.detail).toBe('permission_prompt');
  });

  it('6. liveness / listPending / probeActivity exist and can answer richly', async () => {
    server.liveness = { state: 'live', lastHeartbeatAt: 1_700 };
    server.activity = 'busy';
    server.pending = [basePending()];

    expect(source.liveness(REF)).toEqual({ state: 'live', lastHeartbeatAt: 1_700 });
    expect(await source.probeActivity(REF)).toBe('busy');
    expect((await source.listPending(REF)).map((p) => p.id)).toEqual(['per_1']);

    server.liveness = { state: 'lost', since: 1_800, reason: 'ECONNREFUSED' };
    expect(source.liveness(REF)).toMatchObject({ state: 'lost', reason: 'ECONNREFUSED' });
  });

  it('7. an unknown type is dropped and counted, not thrown', () => {
    // `server.heartbeat` is not in the server's own OpenAPI document and
    // arrives every ten seconds; `server.connected` opens every stream.
    for (const name of ['server-heartbeat', 'server-connected', 'session-status-busy']) {
      expect(() => source.normalizeEvent({ payload: frame(name) })).not.toThrow();
      expect(source.normalizeEvent({ payload: frame(name) })).toBeNull();
    }
    const tally = getUnknownEventTally('opencode');
    expect(tally.count).toBe(6); // each frame normalised twice above
    expect(tally.names).toEqual(['server.heartbeat', 'server.connected', 'session.status']);
  });

  it('8. session_end is expressible but not a substitute for process death', () => {
    // `session.deleted` only fires for an explicit `DELETE /session/:id`; the
    // TUI's `/exit` emits nothing. Whatever decides "the agent is gone" has to
    // keep being tmux.
    expect(source.normalizeEvent({ payload: frame('session-deleted') })?.event).toBe('session_end');
    expect(source.capabilities.supportedEvents).toContain('session_end');
    // And a source is allowed to say it never emits one — antigravity's case.
    const noEnd = buildOpencodeSource(server);
    expect(
      noEnd.capabilities.supportedEvents.filter((e) => e === 'notification')
    ).toHaveLength(1);
  });

  it('9. the registry it plugs into lives on globalThis', async () => {
    // Asserted in full in agent-event-source.test.ts; restated here because it
    // is item 9 of the checklist and a pull source is registered the same way.
    //
    // The teardown **restores** rather than unregisters (Issue #1763). Since
    // Phase 4-5 landed, `opencode` has a real registration, and a bare
    // `unregisterAgentEventSource('opencode')` here would delete it — while
    // every assertion in this file still passed. Under CI's
    // `fileParallelism: false` the whole run shares one process, so the deleted
    // registration would silently drop every later file's opencode back to the
    // legacy relay. Locally, where files run in parallel, it is invisible.
    const {
      registerAgentEventSource,
      unregisterAgentEventSource,
      getAgentEventSource,
      hasAgentEventSource,
    } = await import('@/lib/hooks/sources/registry');
    const previous = hasAgentEventSource('opencode') ? getAgentEventSource('opencode') : null;
    registerAgentEventSource(source);
    try {
      expect(globalThis.__agentEventSources?.get('opencode')).toBe(source);
      expect(getAgentEventSource('opencode').transport).toBe('pull');
    } finally {
      if (previous) registerAgentEventSource(previous);
      else unregisterAgentEventSource('opencode');
    }
    expect(globalThis.__agentEventSources?.get('opencode')).toBe(previous ?? undefined);
  });

  it('10. conversationId is carried but is not the key anything is stored under', () => {
    // opencode's `sessionID` is stable, unlike Claude's, but `GET /session`
    // returns sessions belonging to other processes — so it identifies a
    // conversation, never an instance.
    const idle = source.normalizeEvent({ payload: frame('session-idle') });
    expect(idle?.event).toBe('stop');
    expect(idle?.conversationId).toBe('ses_0000000000000000000000000');
    // …and it is not part of the key anything is stored under. `AgentInstanceRef`
    // is (worktree, tool, instance) and nothing else, which is what survives a
    // `/clear` on Claude and a foreign process's session appearing on opencode.
    expect(Object.keys(REF).sort()).toEqual(['cliToolId', 'instanceId', 'worktreeId']);
  });

  it('11. no config is written for a source that is subscribed to', () => {
    const plan = source.prepareLaunch({
      target: REF,
      executablePath: '/usr/local/bin/opencode',
      worktreePath: '/repo/wt-1',
    });
    expect(plan.command).toBe('/usr/local/bin/opencode');
    expect(plan.settingsPath).toBeNull();
    // #1846: a pull source needs no correlation variable — CommandMate holds
    // the connection, so it already knows whose frames these are.
    expect(plan.env).toEqual({});
    expect(source.capabilities.configScope).toBe('none');
  });
});

function basePending(): PendingDecision {
  return {
    kind: 'permission',
    id: 'per_1',
    conversationId: 'ses_0000000000000000000000000',
    subject: { kind: 'permission', toolName: 'bash', toolInput: {} },
    raw: {},
    askedAt: 0,
  };
}
