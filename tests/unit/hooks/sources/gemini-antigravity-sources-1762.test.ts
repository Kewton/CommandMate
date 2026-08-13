/**
 * The gemini and antigravity {@link AgentEventSource}s (Issue #1762).
 *
 * Both are driven by the payloads captured from live sessions in #1757
 * (`tests/fixtures/hooks/{gemini,antigravity}/*.json`) rather than by bodies
 * invented to match the parsers. Three of the four tools in that spike updated
 * themselves mid-capture, so a payload shape taken from documentation is a
 * payload shape nothing has ever sent.
 *
 * The two tools are tested together because they are the same Issue for the
 * same reason — they share the `~/.gemini` tree — and because the contrast is
 * the point: they disagree about the spelling of every event, about where the
 * event name lives, about the case convention of the payload, and, most
 * consequentially, about what silence means.
 *
 * Assertions are named against the mutations Issue #1762 asks to be proved
 * lethal: unregistering either source, breaking one event-name mapping, and
 * turning antigravity's `noDecision` into `proceeds`.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ANTIGRAVITY_CLI_TOOL_ID,
  describeAbstain,
  GEMINI_CLI_TOOL_ID,
  getAgentEventSource,
  getUnknownEventTally,
  hasAgentEventSource,
  isAbstainSafe,
  resetUnknownEventTallies,
} from '@/lib/hooks/sources';
import type { AgentEventType } from '@/lib/hooks/agent-event-types';
import { antigravityAgentEventSource } from '@/lib/hooks/sources/antigravity/source';
import { geminiAgentEventSource } from '@/lib/hooks/sources/gemini/source';
import { GEMINI_NOTIFICATION_SUBTYPES } from '@/lib/hooks/sources/gemini/event-vocabulary';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks');

/** One captured payload, exactly as it was received. */
function fixture(tool: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, tool, `${name}.json`), 'utf8'));
}

beforeEach(() => resetUnknownEventTallies());

// ===========================================================================
// registry — mutation 1
// ===========================================================================

describe('registration', () => {
  it('answers for gemini and antigravity with their own implementations', () => {
    // Named one tool at a time, never as a count: #1760 / #1761 / #1763 are
    // adding three more sources on branches that merge into this one, and an
    // assertion about how many sources exist would go red for all four of us on
    // the day they are merged.
    expect(hasAgentEventSource(GEMINI_CLI_TOOL_ID)).toBe(true);
    expect(getAgentEventSource(GEMINI_CLI_TOOL_ID)).toBe(geminiAgentEventSource);

    expect(hasAgentEventSource(ANTIGRAVITY_CLI_TOOL_ID)).toBe(true);
    expect(getAgentEventSource(ANTIGRAVITY_CLI_TOOL_ID)).toBe(antigravityAgentEventSource);
  });

  it('still falls back to the compatibility source for a tool nobody has written one for', () => {
    // `vibe-local` rather than another agent CLI: every other tool id in this
    // repo is somebody's Phase 4 branch, and naming one here would make this
    // assertion false the moment that branch lands.
    expect(hasAgentEventSource('vibe-local')).toBe(false);
    expect(getAgentEventSource('vibe-local').capabilities.supportedEvents).toEqual([]);
  });

  it('does not let either tool answer with the other one', () => {
    // They share a config tree, a vendor and half a name. They do not share a
    // vocabulary: `Stop` is a real antigravity event and no gemini session has
    // ever sent one.
    expect(geminiAgentEventSource.normalizeEvent({ payload: { hook_event_name: 'Stop' } })).toBeNull();
    expect(
      antigravityAgentEventSource.normalizeEvent({ payload: fixture('gemini', 'session-start') })
    ).toBeNull();
  });
});

// ===========================================================================
// gemini
// ===========================================================================

describe('gemini: four of the seven are spelled differently', () => {
  const CASES: ReadonlyArray<[string, AgentEventType, string | null]> = [
    ['session-start', 'session_start', 'startup'],
    ['before-agent', 'user_prompt_submit', null],
    ['session-end', 'session_end', 'exit'],
  ];

  it.each(CASES)('maps %s onto %s', (name, event, detail) => {
    // Mutation 2 for gemini lives here: change one entry of
    // GEMINI_HOOK_EVENT_NAMES and the corresponding row goes red.
    const normalized = geminiAgentEventSource.normalizeEvent({ payload: fixture('gemini', name) });
    expect(normalized, `${name} did not map`).not.toBeNull();
    expect(normalized!.event).toBe(event);
    expect(normalized!.detail).toBe(detail);
  });

  it('maps the four renamed spellings, including the two with no captured payload', () => {
    // `AfterAgent` is the event `commandmate wait` returns on, and #1757 never
    // saw one — the spike's account could not reach a model call, so no turn
    // ever ended (§5.3.6). The spelling is not guessed: it is the CLI's own
    // `hooks migrate --from-claude` table, cross-checked against the
    // `HookEventName` enum in the shipped v0.55.1 bundle.
    const renamed: ReadonlyArray<[string, AgentEventType]> = [
      ['BeforeAgent', 'user_prompt_submit'],
      ['AfterAgent', 'stop'],
      ['BeforeTool', 'pre_tool_use'],
      ['AfterTool', 'post_tool_use'],
    ];
    for (const [native, event] of renamed) {
      expect(
        geminiAgentEventSource.normalizeEvent({ payload: { hook_event_name: native } })?.event,
        native
      ).toBe(event);
    }
  });

  it('reads the session id gemini actually sends', () => {
    expect(
      geminiAgentEventSource.normalizeEvent({ payload: fixture('gemini', 'session-start') })!
        .conversationId
    ).toBe('00000000-0000-4000-8000-000000000000');
  });

  it('publishes no tool-call id, because gemini sends none', () => {
    // `BeforeTool` carries `tool_name` and `tool_input` and nothing resembling
    // Claude's `tool_use_id`; claiming one would be inventing a correlation key.
    expect(
      geminiAgentEventSource.normalizeEvent({
        payload: { hook_event_name: 'BeforeTool', tool_name: 'run_shell_command' },
      })!.toolCallId
    ).toBeNull();
    expect(
      geminiAgentEventSource.normalizeEvent({
        payload: { hook_event_name: 'BeforeTool', tool_name: 'run_shell_command' },
      })!.detail
    ).toBe('run_shell_command');
  });

  it('translates gemini’s notification subtype into the one consumers compare against', () => {
    // gemini's `NotificationType` has exactly one member, `ToolPermission`, and
    // it means what Claude's `permission_prompt` means. `status-mapping.ts`
    // compares `detail` against the literal `permission_prompt`, so publishing
    // the native spelling would leave gemini permanently unable to report
    // `waiting` — with the event arriving and being stored correctly the whole
    // time.
    expect(GEMINI_NOTIFICATION_SUBTYPES.ToolPermission).toBe('permission_prompt');
    expect(
      geminiAgentEventSource.normalizeEvent({
        payload: { hook_event_name: 'Notification', notification_type: 'ToolPermission' },
      })!.detail
    ).toBe('permission_prompt');
  });

  it('passes an unknown notification subtype through instead of dropping it', () => {
    expect(
      geminiAgentEventSource.normalizeEvent({
        payload: { hook_event_name: 'Notification', notification_type: 'SomethingNew' },
      })!.detail
    ).toBe('SomethingNew');
  });

  it('drops the gemini-only events instead of forcing them into a word', () => {
    // `BeforeModel` and `PreCompress` were both captured live and have no
    // counterpart. Filing them under something adjacent would publish a meaning
    // nothing agreed to; counting them is how an operator finds out.
    for (const name of ['before-model', 'pre-compress']) {
      expect(geminiAgentEventSource.normalizeEvent({ payload: fixture('gemini', name) })).toBeNull();
    }
    expect(getUnknownEventTally(GEMINI_CLI_TOOL_ID).names).toEqual(['BeforeModel', 'PreCompress']);
  });

  it('does not throw on an event it has never seen', () => {
    expect(() =>
      geminiAgentEventSource.normalizeEvent({ payload: { hook_event_name: 'BeforeToolSelection' } })
    ).not.toThrow();
  });

  it('states what a CommandMate-started gemini session emits', () => {
    expect([...geminiAgentEventSource.capabilities.supportedEvents].sort()).toEqual([
      'notification',
      'session_end',
      'session_start',
      'stop',
      'user_prompt_submit',
    ]);
    // Mapped but not registered: the hooks would cost two blocking round trips
    // per tool call and answer `running`, which `user_prompt_submit` has already
    // established. A caller waiting for one would wait for good, which is
    // exactly what `supportedEvents` exists to tell it.
    expect(geminiAgentEventSource.capabilities.supportedEvents).not.toContain('pre_tool_use');
    expect(geminiAgentEventSource.capabilities.supportedEvents).not.toContain('post_tool_use');
    expect(geminiAgentEventSource.capabilities.configScope).toBe('per-worktree');
  });

  it('treats abstention as free, and says why it may', () => {
    // Read out of gemini v0.55.1's own `DefaultHookOutput`: `isBlockingDecision`
    // tests `decision === "block" || "deny"`, `isAskDecision` tests
    // `decision === "ask"` and `shouldStopExecution` tests `continue === false`.
    // An empty reply has none of those fields, so silence cannot block.
    expect(geminiAgentEventSource.noDecision).toEqual({ kind: 'proceeds' });
    expect(isAbstainSafe(geminiAgentEventSource)).toBe(true);
  });

  it('never emits a verdict, because gemini hooks cannot approve anything', () => {
    // The scheduler runs the hook first, then `checkPolicy`, then
    // `if (hookDecision === "ask") decision = ASK_USER`. There is no branch in
    // which a hook turns a policy verdict into an approval — so approval on
    // gemini is the Policy Engine's job alone, and Auto-Yes keeps exactly one
    // meaning for this tool. Emitting `deny` from here would be a new power
    // Auto-Yes has never had on any tool.
    for (const verdict of [
      { kind: 'allowOnce' },
      { kind: 'allowAlways' },
      { kind: 'deny', message: 'no' },
      { kind: 'abstain' },
    ] as const) {
      expect(geminiAgentEventSource.encodeVerdict(verdict)).toEqual({
        kind: 'responseBody',
        body: {},
      });
    }
    expect(geminiAgentEventSource.capabilities.decisionTimeoutSeconds).toBe(0);
  });

  it('reads no structured permission or question payload, because gemini has neither', () => {
    expect(geminiAgentEventSource.parsePermissionRequest(fixture('gemini', 'before-agent'))).toBeNull();
    expect(geminiAgentEventSource.parseQuestion(fixture('gemini', 'before-agent'))).toBeNull();
  });
});

// ===========================================================================
// antigravity
// ===========================================================================

describe('antigravity: no event name, no cwd, camelCase, fail-closed', () => {
  it('is only mappable through the relay argument', () => {
    const payload = fixture('antigravity', 'pre-tool-use');
    // Nothing in the payload says what this is…
    expect(antigravityAgentEventSource.normalizeEvent({ payload })).toBeNull();
    // …so the receiver is told, by the `--event` the config file bakes in.
    const normalized = antigravityAgentEventSource.normalizeEvent({
      payload,
      event: 'pre_tool_use',
    });
    expect(normalized!.event).toBe('pre_tool_use');
    expect(normalized!.detail).toBe('run_command');
  });

  it('refuses to infer the event from field presence', () => {
    // `PreToolUse` and `PostToolUse` differ by an `error` key that is the empty
    // string on success, so a heuristic would file one as the other and do it
    // silently. An unmappable payload is counted, not guessed at.
    expect(
      antigravityAgentEventSource.normalizeEvent({ payload: fixture('antigravity', 'stop') })
    ).toBeNull();
    expect(getUnknownEventTally(ANTIGRAVITY_CLI_TOOL_ID).count).toBe(1);
    expect(getUnknownEventTally(ANTIGRAVITY_CLI_TOOL_ID).names).toEqual(['(unnamed)']);
  });

  it('reads the camelCase conversation id on every captured payload', () => {
    const CASES: ReadonlyArray<[string, AgentEventType]> = [
      ['session-start', 'session_start'],
      ['pre-tool-use', 'pre_tool_use'],
      ['post-tool-use', 'post_tool_use'],
      ['stop', 'stop'],
    ];
    for (const [name, event] of CASES) {
      const normalized = antigravityAgentEventSource.normalizeEvent({
        payload: fixture('antigravity', name),
        event,
      });
      expect(normalized!.conversationId, name).toBe('22222222-2222-4222-8222-222222222222');
    }
  });

  it('finds the tool name under toolCall on both tool events', () => {
    for (const name of ['pre-tool-use', 'post-tool-use'] as const) {
      const event: AgentEventType = name === 'pre-tool-use' ? 'pre_tool_use' : 'post_tool_use';
      expect(
        antigravityAgentEventSource.normalizeEvent({ payload: fixture('antigravity', name), event })!
          .detail,
        name
      ).toBe('run_command');
    }
  });

  it('cannot locate a worktree from the payload, and does not pretend to', () => {
    const stop = fixture('antigravity', 'stop');
    expect(stop.cwd).toBeUndefined();
    expect(stop.workspacePaths).toEqual([]);
  });

  // ---- mutation 3: the most important assertion in this Issue ----
  it('declares that abstaining is safe only because of how it is spelled', () => {
    // Until Issue #1779 this read `expect(…noDecision).toEqual({ kind: 'blocks' })`
    // and `isAbstainSafe(…)).toBe(false)`, and it was right: #1762 registered no
    // `PreToolUse` hook, and a hook that answered `{}` would have had every tool
    // call denied (#1757 P10). #1779 registered one and measured the case
    // neither Issue had: `{"decision":"ask"}` — agy's own word for *"prompt the
    // user for permission"* — draws exactly the dialog a hooks-free control run
    // draws, on agy 1.1.12, interactively, in an isolated HOME.
    //
    // The mutation this still catches is the one that matters, and it is now
    // spelled in `encodeVerdict` rather than here: encode abstention as `{}` and
    // the assertion below goes red while this one stays green, which is why the
    // two are asserted together.
    expect(antigravityAgentEventSource.noDecision).toEqual({ kind: 'proceeds' });
    expect(isAbstainSafe(antigravityAgentEventSource)).toBe(true);
    expect(describeAbstain(antigravityAgentEventSource).safe).toBe(true);
    expect(antigravityAgentEventSource.encodeVerdict({ kind: 'abstain' })).not.toEqual({
      kind: 'responseBody',
      body: {},
    });
  });

  it('never encodes abstention as an empty object', () => {
    // The whole failure mode: `{}` is a denial here, so the "safe" reply that
    // works on Claude stops every tool call on antigravity. Abstention has to be
    // spelled positively.
    //
    // #1779 changed *which* positive word. #1762 wrote `allow` for abstention on
    // the reasoning that it was the only other thing agy would accept; agy's
    // vocabulary in fact has four values, and `ask` is the one that means "no
    // opinion". `allow` would have meant that turning Auto-Yes **off** silently
    // auto-approved every tool call — and, since the config file is
    // machine-global, that stopping CommandMate did the same thing to agy
    // sessions it never started.
    expect(antigravityAgentEventSource.encodeVerdict({ kind: 'abstain' })).toEqual({
      kind: 'responseBody',
      body: { decision: 'ask' },
    });
    expect(antigravityAgentEventSource.encodeVerdict({ kind: 'allowOnce' })).toEqual({
      kind: 'responseBody',
      body: { decision: 'allow' },
    });
    expect(
      antigravityAgentEventSource.encodeVerdict({ kind: 'deny', message: 'blocked by policy' })
    ).toEqual({
      kind: 'responseBody',
      body: { decision: 'deny', reason: 'blocked by policy' },
    });
  });

  it('agrees with gemini that abstaining is safe, for opposite reasons', () => {
    // Until #1779 this asserted the two were *opposites*. They now agree, and
    // the contrast worth stating is why: gemini is safe because CommandMate
    // never adjudicates for it at all (its approvals belong to the Policy
    // Engine), and agy is safe only because its abstention is spelled `ask`.
    // Remove that spelling and this pair diverges again — silently.
    expect(isAbstainSafe(geminiAgentEventSource)).toBe(true);
    expect(isAbstainSafe(antigravityAgentEventSource)).toBe(true);
    expect(geminiAgentEventSource.encodeVerdict({ kind: 'abstain' })).toEqual({
      kind: 'responseBody',
      body: {},
    });
    expect(antigravityAgentEventSource.encodeVerdict({ kind: 'abstain' })).toEqual({
      kind: 'responseBody',
      body: { decision: 'ask' },
    });
  });

  it('states what a CommandMate-started agy session emits', () => {
    expect([...antigravityAgentEventSource.capabilities.supportedEvents].sort()).toEqual([
      'post_tool_use',
      'session_start',
      'stop',
    ]);
    // Absent because agy never fires them, however they are configured.
    expect(antigravityAgentEventSource.capabilities.supportedEvents).not.toContain('session_end');
    expect(antigravityAgentEventSource.capabilities.supportedEvents).not.toContain(
      'user_prompt_submit'
    );
    expect(antigravityAgentEventSource.capabilities.supportedEvents).not.toContain('notification');
    // Absent for a different reason again, and the same one copilot omits it
    // for: since #1779 `PreToolUse` *is* registered, but against
    // `/api/hooks/permission-request`, which adjudicates and does not record.
    // Nothing ever files a `pre_tool_use` event for agy, and this list is a
    // promise about what does.
    expect(antigravityAgentEventSource.capabilities.supportedEvents).not.toContain('pre_tool_use');
    expect(antigravityAgentEventSource.capabilities.configScope).toBe('global-singleton');
  });
});

describe('both tools are push sources with no liveness and nothing to re-read', () => {
  it.each([
    ['gemini', geminiAgentEventSource],
    ['antigravity', antigravityAgentEventSource],
  ] as const)('%s', async (_name, source) => {
    expect(source.transport).toBe('push');
    expect(source.liveness({ worktreeId: 'wt', cliToolId: source.cliToolId })).toEqual({
      state: 'unknown',
    });
    expect(await source.probeActivity({ worktreeId: 'wt', cliToolId: source.cliToolId })).toBeNull();
  });
});
