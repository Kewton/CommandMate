/**
 * GitHub Copilot CLI as an `AgentEventSource` (Issue #1761, Epic #1720 Phase
 * 4-3).
 *
 * Every input below is a payload copilot actually sent, read out of
 * `tests/fixtures/hooks/copilot/`. That is not a stylistic preference: the tool
 * updated itself from 1.0.77 to 1.0.79 *during* the capture that produced those
 * files (#1757 P12), so a payload written from documentation is a payload
 * nothing has ever emitted, and a suite built on one would be green against a
 * shape that does not exist.
 *
 * The suite is aimed at the four ways this could be inert rather than wrong —
 * the mutations Issue #1761 asks to be proved lethal:
 *
 *  1. copilot missing from the registry
 *  2. one event-name mapping broken
 *  3. the config written to `config.json` instead of `settings.json`
 *  4. `beginAgentSession()` not called from `startSession`
 *
 * 1 and 2 are killed here; 3 lives in `copilot-hook-settings.test.ts` and 4 in
 * `tests/unit/cli-tools/copilot-agent-hooks.test.ts`.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  describeAbstain,
  getAgentEventSource,
  getUnknownEventTally,
  hasAgentEventSource,
  resetUnknownEventTallies,
  COPILOT_CLI_TOOL_ID,
  type Verdict,
} from '@/lib/hooks/sources';
import {
  copilotAgentEventSource,
  encodeCopilotVerdict,
  parseCopilotPermissionRequest,
} from '@/lib/hooks/sources/copilot/source';
import { COPILOT_HOOK_TIMEOUT_SECONDS } from '@/lib/hooks/sources/copilot/hook-settings';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks');

/** One captured payload, as it was actually received. */
function fixture(tool: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, tool, `${name}.json`), 'utf8'));
}

beforeEach(() => {
  resetUnknownEventTallies();
});

describe('registry', () => {
  it('answers for copilot with the real implementation, not the fallback', () => {
    // Mutation 1. Removing the `registerAgentEventSource(copilotAgentEventSource)`
    // line leaves `getAgentEventSource('copilot')` answering with the legacy
    // relay — which maps most of these payloads correctly, which is exactly why
    // the check is on identity and on `hasAgentEventSource` rather than on
    // behaviour.
    expect(hasAgentEventSource(COPILOT_CLI_TOOL_ID)).toBe(true);
    expect(getAgentEventSource(COPILOT_CLI_TOOL_ID)).toBe(copilotAgentEventSource);
  });

  it('is registered statically, so a bundler cannot drop it', () => {
    expect(globalThis.__agentEventSources?.get('copilot')).toBe(copilotAgentEventSource);
  });

  it('still falls back for a tool nobody has implemented', () => {
    // `vibe-local` on purpose: the other four tools of Phase 4 are landing in
    // parallel, and naming one of them here would be a test that passes on this
    // branch and fails the moment its sibling merges.
    expect(hasAgentEventSource('vibe-local')).toBe(false);
  });
});

describe('event mapping, driven by the captured payloads', () => {
  const CASES: ReadonlyArray<[string, string, string | null]> = [
    ['session-start', 'session_start', 'new'],
    ['user-prompt-submit', 'user_prompt_submit', null],
    ['pre-tool-use', 'pre_tool_use', 'Bash'],
    ['post-tool-use', 'post_tool_use', 'Bash'],
    ['stop', 'stop', null],
    ['session-end', 'session_end', 'complete'],
  ];

  it.each(CASES)('maps %s to %s with detail %s', (name, event, detail) => {
    // Mutation 2. Breaking one entry of the CamelCase table takes exactly one
    // of these rows red, and the row names which spelling stopped working.
    const normalized = copilotAgentEventSource.normalizeEvent({ payload: fixture('copilot', name) });
    expect(normalized, `${name} did not map`).not.toBeNull();
    expect(normalized!.event).toBe(event);
    expect(normalized!.detail).toBe(detail);
  });

  it('reads session_id as the conversation id on every captured payload', () => {
    for (const [name] of CASES) {
      const normalized = copilotAgentEventSource.normalizeEvent({
        payload: fixture('copilot', name),
      });
      expect(normalized!.conversationId).toBe('00000000-0000-4000-8000-000000000000');
    }
  });

  it('correlates no tool call, because copilot sends no tool_use_id', () => {
    // #1757 R5. Stated as an assertion so that a future release which starts
    // sending one is noticed here rather than assumed away.
    for (const name of ['pre-tool-use', 'post-tool-use']) {
      expect(fixture('copilot', name).tool_use_id).toBeUndefined();
      expect(
        copilotAgentEventSource.normalizeEvent({ payload: fixture('copilot', name) })!.toolCallId
      ).toBeNull();
    }
  });

  it('does not depend on the order the events arrive in', () => {
    // Copilot fires `UserPromptSubmit` **before** `SessionStart` (20.813Z vs
    // 20.915Z, measured). Feeding them in that order has to produce the same
    // two words as feeding them the other way round; a source that carried
    // per-conversation state would not.
    const ups = copilotAgentEventSource.normalizeEvent({
      payload: fixture('copilot', 'user-prompt-submit'),
    });
    const start = copilotAgentEventSource.normalizeEvent({
      payload: fixture('copilot', 'session-start'),
    });
    expect([ups!.event, start!.event]).toEqual(['user_prompt_submit', 'session_start']);
  });

  it('returns null and counts an unrecognised event instead of throwing', () => {
    // C8. Copilot's own vocabulary is larger than the seven words and grows
    // between releases; a receiver that threw would fail on a healthy session.
    expect(
      copilotAgentEventSource.normalizeEvent({
        payload: { hook_event_name: 'PreCompact', session_id: 'x' },
      })
    ).toBeNull();
    expect(getUnknownEventTally('copilot').names).toEqual(['PreCompact']);
  });
});

describe('capabilities are promises, so they are asserted one by one', () => {
  it('states the ten-second decision budget, two orders below Claude', () => {
    // #1757 §5.2.3. The single number a Claude-shaped decision path gets wrong:
    // budgeting 600s here means the verdict is discarded and the call proceeds.
    expect(copilotAgentEventSource.capabilities.decisionTimeoutSeconds).toBe(10);
    expect(COPILOT_HOOK_TIMEOUT_SECONDS).toBe(10);
  });

  it('says its configuration is one file for the whole machine', () => {
    expect(copilotAgentEventSource.capabilities.configScope).toBe('global-singleton');
  });

  it('promises the five events CommandMate routes to the event store', () => {
    expect([...copilotAgentEventSource.capabilities.supportedEvents].sort()).toEqual([
      'post_tool_use',
      'session_end',
      'session_start',
      'stop',
      'user_prompt_submit',
    ]);
  });

  it('does not promise notification, which has never been observed to fire', () => {
    // Registered during the spike and delivered zero times. A caller waiting on
    // it would wait forever, so the promise is withheld — while the mapper
    // still knows the spelling, for a hand-configured hook that does get one.
    expect(copilotAgentEventSource.capabilities.supportedEvents).not.toContain('notification');
    expect(
      copilotAgentEventSource.normalizeEvent({
        payload: { hook_event_name: 'Notification', notification_type: 'permission_prompt' },
      })!.event
    ).toBe('notification');
  });

  it('does not promise pre_tool_use, which is adjudicated rather than recorded', () => {
    // Copilot has no `PermissionRequest`; `PreToolUse` is the approval gate, so
    // CommandMate points it at `/api/hooks/permission-request`, which decides
    // and does not record. Promising the word would strand a caller waiting for
    // an event that is being answered somewhere else.
    expect(copilotAgentEventSource.capabilities.supportedEvents).not.toContain('pre_tool_use');
  });

  it('abstaining is safe here, and says so through the shared helper', () => {
    // #1757 §5.2.4: `{}` lands in copilot's ordinary approval flow. True for
    // Claude, codex and copilot; false for antigravity, where the same reply is
    // a denial (C3).
    expect(copilotAgentEventSource.noDecision).toEqual({ kind: 'proceeds' });
    expect(describeAbstain(copilotAgentEventSource).safe).toBe(true);
  });

  it('is a push source with the inert lifecycle every hook tool shares', async () => {
    expect(copilotAgentEventSource.transport).toBe('push');
    const ref = { worktreeId: 'wt-1', cliToolId: COPILOT_CLI_TOOL_ID, instanceId: 'copilot' };
    await expect(copilotAgentEventSource.probeActivity(ref)).resolves.toBeNull();
    expect(copilotAgentEventSource.liveness(ref)).toEqual({ state: 'unknown' });
  });
});

describe('permission payloads (S7)', () => {
  it('reads copilot’s PreToolUse as the permission request it is', () => {
    const parsed = parseCopilotPermissionRequest(fixture('copilot', 'pre-tool-use'));
    expect(parsed?.toolName).toBe('Bash');
    expect(parsed?.toolInput.command).toBe('echo CP-TOOL-MARKER > ./cp-marker.txt');
    expect(parsed?.sessionId).toBe('00000000-0000-4000-8000-000000000000');
    // Copilot sends no correlation id on this payload, so the route mints one.
    expect(parsed?.promptId).toBeNull();
  });

  it('is reached through the registry, not only by direct import', () => {
    // What the permission route actually does. Had the source reused Claude's
    // strict parser — which insists on `hook_event_name === 'PermissionRequest'`,
    // an event copilot does not have — this would be null for every request
    // copilot ever makes and Auto-Yes would abstain on all of them in silence.
    const source = getAgentEventSource(COPILOT_CLI_TOOL_ID);
    expect(source.parsePermissionRequest(fixture('copilot', 'pre-tool-use'))?.toolName).toBe(
      'Bash'
    );
  });

  it('refuses payloads it cannot vouch for', () => {
    // Strict on purpose: null becomes no-decision, and the fallback to a dialog
    // is the safe side. The alternative is executing a command.
    expect(parseCopilotPermissionRequest(fixture('copilot', 'stop'))).toBeNull();
    // `PostToolUse` carries the same `tool_name` and `tool_input` as the
    // `PreToolUse` that preceded it and is not a request for anything — the
    // call already ran. Judging one would be adjudicating the past.
    expect(parseCopilotPermissionRequest(fixture('copilot', 'post-tool-use'))).toBeNull();
    expect(parseCopilotPermissionRequest(fixture('claude', 'permission-request'))).toBeNull();
    expect(parseCopilotPermissionRequest({ hook_event_name: 'PreToolUse' })).toBeNull();
    expect(
      parseCopilotPermissionRequest({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })
    ).toBeNull();
    expect(parseCopilotPermissionRequest(null)).toBeNull();
  });

  it('has no question payload, and does not invent one', () => {
    for (const name of ['pre-tool-use', 'post-tool-use', 'stop', 'session-start']) {
      expect(copilotAgentEventSource.parseQuestion(fixture('copilot', name))).toBeNull();
    }
  });
});

describe('verdict encoding (S6)', () => {
  it('approves with permissionDecision, the shape measured live', () => {
    // Verified end to end against copilot 1.0.79 for this Issue: with this body
    // a shell command that would otherwise have prompted ran unattended.
    expect(copilotAgentEventSource.encodeVerdict({ kind: 'allowOnce' })).toEqual({
      kind: 'responseBody',
      body: {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
      },
    });
  });

  it('is not Claude’s spelling', () => {
    // Claude wants `decision.behavior`. Sending that to copilot is accepted,
    // ignored, and indistinguishable from having no hook — which is why the
    // difference is asserted rather than left to the resemblance.
    const body = encodeCopilotVerdict({ kind: 'allowOnce' }) as {
      hookSpecificOutput: Record<string, unknown>;
    };
    expect(body.hookSpecificOutput.decision).toBeUndefined();
    expect(body.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('can express a denial, which Claude’s source cannot', () => {
    // Measured: the reason string is printed to the operator as
    // `Denied by preToolUse hook: …` and the command does not run. Nothing
    // produces a `deny` verdict today — `permission-decision-service` answers
    // allow or no-decision — so this states a capability, not a behaviour.
    expect(encodeCopilotVerdict({ kind: 'deny', message: 'blocked by contract' })).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'blocked by contract',
      },
    });
  });

  it('spells abstention as the empty object copilot reads as “carry on”', () => {
    const verdicts: Verdict[] = [
      { kind: 'abstain' },
      { kind: 'allowAlways' },
      { kind: 'answer', answers: [['yes']] },
    ];
    for (const verdict of verdicts) {
      expect(encodeCopilotVerdict(verdict)).toEqual({});
    }
  });
});
