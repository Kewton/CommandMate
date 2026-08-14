/**
 * `AgentEventSource`, the registry, and Claude as its first implementation
 * (Issue #1759).
 *
 * The risk this suite is written against is not "the code is wrong" — it is
 * that an extraction can be *inert*: the abstraction exists, the tests pass, and
 * nothing actually goes through it, so the day a second tool is added the seams
 * turn out never to have been seams. Every assertion here is therefore aimed at
 * a specific way that could be true, and the Issue's three mutations
 * (unregister Claude / break one name mapping / force every source to
 * `proceeds`) are each covered by something below.
 *
 * Inputs are the real captured payloads in `tests/fixtures/hooks/`, never
 * hand-written approximations of them. Four of the six tools auto-updated
 * themselves mid-capture (#1757 P12), so a payload shape invented from
 * documentation is a payload shape that was never sent by anything.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  answerPendingDecision,
  CLAUDE_CLI_TOOL_ID,
  describeAbstain,
  describeNoDecision,
  getAgentEventSource,
  getUnknownEventTally,
  hasAgentEventSource,
  isAbstainSafe,
  listAgentEventSources,
  listOpenDecisions,
  openDecisionSlot,
  registerAgentEventSource,
  resetPendingDecisions,
  resetUnknownEventTallies,
  unregisterAgentEventSource,
  type AgentEventSource,
  type PendingDecision,
  type Verdict,
} from '@/lib/hooks/sources';
import { claudeAgentEventSource } from '@/lib/hooks/sources/claude/source';
import { AGENT_EVENT_TYPES } from '@/lib/hooks/agent-event-types';
import { PERMISSION_REQUEST_EVENT_NAME } from '@/lib/hooks/permission-request-payload';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks');

/** One captured payload, as it was actually received. */
function fixture(tool: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, tool, `${name}.json`), 'utf8'));
}

const REF = { worktreeId: 'wt-1', cliToolId: CLAUDE_CLI_TOOL_ID, instanceId: 'claude' } as const;

beforeEach(() => {
  resetUnknownEventTallies();
  resetPendingDecisions();
});

afterEach(() => {
  // The registry is process-wide (globalThis), so a suite that swaps sources
  // has to put Claude back or it leaks into whatever runs next in this worker.
  registerAgentEventSource(claudeAgentEventSource);
});

describe('registry', () => {
  it('answers for claude with the real implementation', () => {
    expect(hasAgentEventSource('claude')).toBe(true);
    expect(getAgentEventSource('claude')).toBe(claudeAgentEventSource);
    expect(listAgentEventSources().map((s) => s.cliToolId)).toContain('claude');
  });

  it('is reached through globalThis, not module scope', async () => {
    // The failure this guards is #1736's: under `next dev` each route handler
    // is bundled separately, so a module-scoped Map is one Map per bundle and a
    // source registered by the receiver is absent in the adjudicator. Nothing
    // errors — the registry just answers "not registered" forever and the
    // fallback quietly takes over.
    const registryModule = await import('@/lib/hooks/sources/registry');
    expect(globalThis.__agentEventSources).toBeInstanceOf(Map);
    expect(globalThis.__agentEventSources?.get('claude')).toBe(claudeAgentEventSource);
    expect(registryModule.getAgentEventSource('claude')).toBe(
      globalThis.__agentEventSources?.get('claude')
    );
  });

  it('falls back for a tool with no implementation, and says it is a fallback', () => {
    // The #1549 receiver applied one table to every tool. Un-porting that on
    // the day this abstraction landed would have broken every hand-configured
    // hook for a reason unrelated to anything that changed.
    //
    // Issue #1760: `vibe-local`, not codex. Phase 4-2…4-5 registers a real
    // source for codex, copilot, gemini, antigravity and opencode, so any of
    // those five would turn this assertion into a countdown; `vibe-local` is
    // outside Phase 4 entirely and stays unregistered.
    expect(hasAgentEventSource('vibe-local')).toBe(false);

    const fallback = getAgentEventSource('vibe-local');
    expect(fallback.cliToolId).toBe('vibe-local');
    expect(fallback.transport).toBe('push');
    // "Nothing measured", not a copy of Claude's list presented as a promise.
    expect(fallback.capabilities.supportedEvents).toEqual([]);

    // Memoised: repeated lookups are one object, so a slot opened against one
    // is visible to the other.
    expect(getAgentEventSource('vibe-local')).toBe(fallback);
  });

  it('replaces the fallback the moment a real source registers', () => {
    // Also `vibe-local` (Issue #1760), and here the tool name matters more than
    // it looks: the `finally` below *unregisters* whatever it names. Run
    // against a tool that has a real source, this test passes — and takes that
    // source out of a registry the rest of the suite shares, in a process CI
    // does not fork per file (`vitest.config.ts`: `fileParallelism` is off when
    // `CI=true`). Green here, and the receiver falls back to legacy-relay for
    // every file that runs afterwards.
    const before = getAgentEventSource('vibe-local');
    const stub: AgentEventSource = { ...before, cliToolId: 'vibe-local', transport: 'pull' };
    registerAgentEventSource(stub);
    try {
      expect(getAgentEventSource('vibe-local')).toBe(stub);
      expect(hasAgentEventSource('vibe-local')).toBe(true);
    } finally {
      unregisterAgentEventSource('vibe-local');
    }
    expect(hasAgentEventSource('vibe-local')).toBe(false);
  });
});

describe('claude source: event mapping (S1/S2)', () => {
  /** Every captured Claude payload, with the word it must produce. */
  const CASES: ReadonlyArray<[string, string, string | null]> = [
    ['stop', 'stop', null],
    ['session-start', 'session_start', 'startup'],
    ['session-start-clear', 'session_start', 'clear'],
    ['session-end', 'session_end', 'prompt_input_exit'],
    ['session-end-clear', 'session_end', 'clear'],
    ['user-prompt-submit', 'user_prompt_submit', null],
    ['notification-permission-prompt', 'notification', 'permission_prompt'],
    ['notification-idle-prompt', 'notification', 'idle_prompt'],
    ['pre-tool-use-bash', 'pre_tool_use', 'Bash'],
    ['pre-tool-use-ask-user-question', 'pre_tool_use', 'AskUserQuestion'],
    ['post-tool-use-ask-user-question', 'post_tool_use', 'AskUserQuestion'],
  ];

  it.each(CASES)('maps the captured %s payload to %s', (name, event, detail) => {
    const normalized = claudeAgentEventSource.normalizeEvent({
      payload: fixture('claude', name),
      receivedAt: 1_000,
    });

    expect(normalized, `${name} did not map`).not.toBeNull();
    expect(normalized!.event).toBe(event);
    expect(normalized!.detail).toBe(detail);
    expect(normalized!.receivedAt).toBe(1_000);
  });

  it('carries the session id through as conversationId, and never as identity', () => {
    const normalized = claudeAgentEventSource.normalizeEvent({ payload: fixture('claude', 'stop') });
    // Present, because correlating a duplicate delivery needs it…
    expect(normalized!.conversationId).toBe('00000000-0000-4000-8000-000000000000');
    // …and separate from the instance key, because `/clear` mints a new one
    // while the pane, the worktree and the instance are unchanged (#1721 D7).
    expect(normalized!.conversationId).not.toBe(REF.instanceId);
  });

  it('picks up tool_use_id where the payload has one, and tolerates its absence', () => {
    // D2: `PreToolUse` carries it, `PermissionRequest` does not. Nothing may
    // require it.
    expect(
      claudeAgentEventSource.normalizeEvent({ payload: fixture('claude', 'pre-tool-use-bash') })!
        .toolCallId
    ).toBe('toolu_0000000000000000000000000');
    expect(
      claudeAgentEventSource.normalizeEvent({ payload: fixture('claude', 'stop') })!.toolCallId
    ).toBeNull();
  });

  it('refuses PermissionRequest as a lifecycle event', () => {
    // It has its own receiver, whose response body is obeyed — the opposite
    // contract to the fire-and-forget event route (#1724).
    expect(
      claudeAgentEventSource.normalizeEvent({
        payload: fixture('claude', 'permission-request'),
      })
    ).toBeNull();
  });

  it('keeps the raw payload', () => {
    const payload = fixture('claude', 'session-start');
    const normalized = claudeAgentEventSource.normalizeEvent({ payload });
    expect(normalized!.raw).toBe(payload);
    // #1757 P12: three of these CLIs updated themselves during a single
    // afternoon of capture. The only defence against a shape change is keeping
    // what arrived.
    expect(normalized!.raw.model).toBe('claude-opus-5[1m]');
  });

  it('takes the caller-supplied word over the payload', () => {
    // The relay's `--event`. For antigravity it is the only channel there is:
    // its payloads carry no event name at all (#1757 R2).
    const normalized = claudeAgentEventSource.normalizeEvent({
      payload: { hook_event_name: 'Stop' },
      event: 'session_end',
    });
    expect(normalized!.event).toBe('session_end');
  });

  it('declares all seven words as supported', () => {
    expect(claudeAgentEventSource.capabilities.supportedEvents).toEqual(AGENT_EVENT_TYPES);
  });
});

describe('unknown events are counted, never thrown (C8)', () => {
  it('answers null and tallies an unmapped name', () => {
    // opencode's `/doc` does not list `server.heartbeat` and it arrives every
    // ten seconds; a receiver that threw would fail six times a minute on a
    // healthy connection.
    expect(getUnknownEventTally('claude').count).toBe(0);

    for (const name of ['PreCompact', 'PreCompact', 'SubagentStart']) {
      expect(
        claudeAgentEventSource.normalizeEvent({ payload: { hook_event_name: name } })
      ).toBeNull();
    }

    const tally = getUnknownEventTally('claude');
    expect(tally.count).toBe(3);
    expect(tally.names).toEqual(['PreCompact', 'SubagentStart']);
  });

  it('survives a payload with no event name at all', () => {
    expect(() => claudeAgentEventSource.normalizeEvent({ payload: {} })).not.toThrow();
    expect(claudeAgentEventSource.normalizeEvent({ payload: {} })).toBeNull();
    expect(getUnknownEventTally('claude').names).toEqual(['(unnamed)']);
  });

  it('survives a payload whose event name is not a string', () => {
    expect(
      claudeAgentEventSource.normalizeEvent({ payload: { hook_event_name: { nested: true } } })
    ).toBeNull();
  });
});

describe('claude source: verdicts (S6)', () => {
  it('encodes an allow in the shape the live session was measured obeying', () => {
    const encoded = claudeAgentEventSource.encodeVerdict({ kind: 'allowOnce' });
    expect(encoded).toEqual({
      kind: 'responseBody',
      body: {
        hookSpecificOutput: {
          hookEventName: PERMISSION_REQUEST_EVENT_NAME,
          decision: { behavior: 'allow' },
        },
      },
    });
  });

  it('collapses everything it cannot express to no-decision, not to a guess', () => {
    // `allowAlways` has no Claude spelling, `deny` is never emitted by design,
    // and `answer` belongs to a picker that is drawn regardless of what this
    // hook says (#1721 §5.6).
    const verdicts: Verdict[] = [
      { kind: 'allowAlways' },
      { kind: 'deny', message: 'no' },
      { kind: 'answer', answers: [['Blue']] },
      { kind: 'abstain' },
    ];
    for (const verdict of verdicts) {
      expect(claudeAgentEventSource.encodeVerdict(verdict)).toEqual({
        kind: 'responseBody',
        body: {},
      });
    }
  });
});

describe('answering a decision hides the transport (C2)', () => {
  const decision: PendingDecision = {
    kind: 'permission',
    id: 'prompt-1',
    conversationId: 'ses-1',
    subject: { kind: 'permission', toolName: 'Bash', toolInput: { command: 'ls' } },
    raw: {},
    askedAt: 0,
  };

  it('returns the body a push source wrote', async () => {
    const body = await answerPendingDecision(claudeAgentEventSource, REF, decision, {
      kind: 'allowOnce',
    });
    expect(body).toEqual({
      hookSpecificOutput: {
        hookEventName: PERMISSION_REQUEST_EVENT_NAME,
        decision: { behavior: 'allow' },
      },
    });
  });

  it('returns {} when the source answered out of band', async () => {
    // A pull source's `decide()` opens its own connection and leaves the slot
    // empty; the receiver still has to write *something*, and `{}` is the
    // no-decision body every hook tool reads as "carry on".
    const outOfBand: AgentEventSource = {
      ...claudeAgentEventSource,
      transport: 'pull',
      encodeVerdict: () => ({ kind: 'outOfBand' }),
      decide: async () => {},
    };
    expect(await answerPendingDecision(outOfBand, REF, decision, { kind: 'allowOnce' })).toEqual({});
  });

  it('still returns a body when the source throws', async () => {
    // Fail-open. A source that could not deliver must not leave the receiver
    // holding an open slot or a 500.
    const broken: AgentEventSource = {
      ...claudeAgentEventSource,
      decide: async () => {
        throw new Error('connection refused');
      },
    };
    expect(await answerPendingDecision(broken, REF, decision, { kind: 'allowOnce' })).toEqual({});
    expect(listOpenDecisions(REF)).toEqual([]);
  });

  it('leaves no slot open afterwards', async () => {
    await answerPendingDecision(claudeAgentEventSource, REF, decision, { kind: 'abstain' });
    expect(listOpenDecisions(REF)).toEqual([]);
  });
});

describe('push-source lifecycle is callable and honest (C1/C6/C7)', () => {
  it('subscribes and closes without doing anything', async () => {
    const subscription = await claudeAgentEventSource.subscribe(REF, () => {});
    expect(subscription.liveness).toEqual({ state: 'unknown' });
    await expect(subscription.close()).resolves.toBeUndefined();
  });

  it('reports liveness as unknown rather than inventing one', () => {
    // A hook that has not fired and an agent that died look identical from here.
    expect(claudeAgentEventSource.liveness(REF)).toEqual({ state: 'unknown' });
  });

  it('cannot re-read activity', async () => {
    // An event is not a state. Callers fall back to the scraper, which is what
    // `current-output-builder` already does when no event has arrived.
    expect(await claudeAgentEventSource.probeActivity(REF)).toBeNull();
  });

  it('lists the requests currently in flight as its pending set', async () => {
    const slot = openDecisionSlot(REF, {
      kind: 'permission',
      id: 'in-flight',
      conversationId: null,
      subject: { kind: 'permission', toolName: 'Bash', toolInput: {} },
      raw: {},
      askedAt: 0,
    });
    expect((await claudeAgentEventSource.listPending(REF)).map((d) => d.id)).toEqual(['in-flight']);
    expect(slot.body).toBeNull();
  });
});

describe('no-decision is a declared property, not an assumption (C3)', () => {
  it('says abstaining is safe on claude, because that was measured', () => {
    expect(claudeAgentEventSource.noDecision).toEqual({ kind: 'proceeds' });
    expect(isAbstainSafe(claudeAgentEventSource)).toBe(true);
    expect(describeAbstain(claudeAgentEventSource).blocksForMs).toBe(0);
  });

  it('says abstaining stops the agent when the source blocks', () => {
    // opencode: no timeout at all — #1758 §5.5.3 left one pending for 10m19s.
    // If this ever reads `safe: true`, Auto-Yes v2 will stop opencode sessions
    // silently and nothing will report it.
    const blocking = describeNoDecision({ kind: 'blocks' });
    expect(blocking.safe).toBe(false);
    expect(blocking.blocksForMs).toBeNull();
    expect(blocking.summary).toContain('indefinitely');
  });

  it('says how long a bounded block lasts', () => {
    const bounded = describeNoDecision({ kind: 'blocksUntil', timeoutMs: 10_000 });
    expect(bounded.safe).toBe(false);
    expect(bounded.blocksForMs).toBe(10_000);
  });

  it('is read off the source, so a blocking source is never treated as safe', () => {
    // The mutation this kills: hard-coding `{ kind: 'proceeds' }` for every
    // source. That is green against Claude alone, which is why the assertion is
    // written against a source that declares otherwise.
    const blockingSource: AgentEventSource = {
      ...claudeAgentEventSource,
      cliToolId: 'opencode',
      transport: 'pull',
      noDecision: { kind: 'blocks' },
    };
    expect(isAbstainSafe(blockingSource)).toBe(false);
    expect(describeAbstain(blockingSource).safe).toBe(false);
  });
});

describe('claude source: payload parsers (S7)', () => {
  it('reads a captured PermissionRequest', () => {
    const parsed = claudeAgentEventSource.parsePermissionRequest(
      fixture('claude', 'permission-request')
    );
    expect(parsed?.toolName).toBe('Bash');
    expect(parsed?.promptId).toBe('11111111-1111-4111-8111-111111111111');
    expect(parsed?.toolInput.command).toContain('touch /tmp/example-marker.txt');
  });

  it('reads a captured AskUserQuestion', () => {
    const spec = claudeAgentEventSource.parseQuestion(
      fixture('claude', 'pre-tool-use-ask-user-question')
    );
    expect(spec?.questions.map((q) => q.header)).toEqual(['Color', 'Editor']);
  });

  it('answers null for a payload that is not one', () => {
    expect(claudeAgentEventSource.parsePermissionRequest(fixture('claude', 'stop'))).toBeNull();
    expect(claudeAgentEventSource.parseQuestion(fixture('claude', 'stop'))).toBeNull();
  });
});
