/**
 * codex's `AgentEventSource` (Issue #1760, Phase 4-2 of Epic #1720).
 *
 * Driven by the payloads captured from a live codex-cli 0.147.0 session in
 * Issue #1757 (`tests/fixtures/hooks/codex/`), never by a hand-written body:
 * the whole reason this Issue had a spike in front of it is that codex's
 * documentation and codex's wire format disagree, and a test written against
 * the documentation would pass while the feature was dead.
 *
 * The assertions to keep honest are the ones that would otherwise pass
 * vacuously:
 *
 *  - every fixture maps to a *specific* word and detail, not merely to
 *    "something non-null";
 *  - `noDecision` is pinned to the value driven live (`{}` produced codex's
 *    ordinary approval dialog), and to `describeAbstain().safe`, because the
 *    whole point of the field is that abstaining is not free on every tool;
 *  - `encodeVerdict` is pinned to the bytes measured in #1757 §5.1.6, since a
 *    body codex does not recognise is ignored in silence;
 *  - the registry entry is asserted by name — `hasAgentEventSource('codex')` —
 *    and never by counting registrations, which would go red the moment
 *    #1761…#1763 land next to this.
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
  type Verdict,
} from '@/lib/hooks/sources';
import { codexAgentEventSource, encodeCodexVerdict } from '@/lib/hooks/sources/codex/source';
import { CODEX_CLI_TOOL_ID } from '@/lib/hooks/sources/codex/tool-id';
import { parsePermissionRequestPayload } from '@/lib/hooks/permission-request-payload';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/codex');

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

beforeEach(() => resetUnknownEventTallies());

describe('codex source: the captured payloads', () => {
  const CASES: ReadonlyArray<[string, string, string | null]> = [
    ['session-start', 'session_start', 'startup'],
    ['user-prompt-submit', 'user_prompt_submit', null],
    ['stop', 'stop', null],
    ['session-end', 'session_end', 'other'],
    // Registered by nobody, but codex sends them when the operator's own
    // hooks.json asks for them, and the mappers must still read them.
    ['pre-tool-use', 'pre_tool_use', 'Bash'],
    ['post-tool-use', 'post_tool_use', 'Bash'],
  ];

  it.each(CASES)('maps %s to %s with detail %s', (name, event, detail) => {
    const normalized = codexAgentEventSource.normalizeEvent({ payload: fixture(name) });
    expect(normalized, `${name} did not map`).not.toBeNull();
    expect(normalized!.event).toBe(event);
    expect(normalized!.detail).toBe(detail);
  });

  it('reads session_id as the conversation id on every captured payload', () => {
    for (const [name] of CASES) {
      expect(codexAgentEventSource.normalizeEvent({ payload: fixture(name) })!.conversationId).toBe(
        '00000000-0000-4000-8000-000000000000'
      );
    }
  });

  it('correlates a tool call by tool_use_id where codex sends one', () => {
    expect(
      codexAgentEventSource.normalizeEvent({ payload: fixture('pre-tool-use') })!.toolCallId
    ).toBe('exec-00000000-0000-4000-8000-000000000000');
    // …and `PermissionRequest` carries none, exactly as on Claude (D2). Nothing
    // may key off it.
    expect(fixture('permission-request').tool_use_id).toBeUndefined();
  });

  it('keeps the payload verbatim, because the shape moves between releases', () => {
    const payload = fixture('stop');
    expect(codexAgentEventSource.normalizeEvent({ payload })!.raw).toBe(payload);
  });

  it('returns null and counts an event it has no word for, instead of throwing', () => {
    // `PreCompact` is a real codex event (its review screen lists it) with no
    // counterpart among the seven. Filing it under something adjacent would
    // publish a meaning nothing agreed to.
    const payload = { ...fixture('stop'), hook_event_name: 'PreCompact' };
    expect(codexAgentEventSource.normalizeEvent({ payload })).toBeNull();
    expect(getUnknownEventTally(CODEX_CLI_TOOL_ID).names).toEqual(['PreCompact']);
  });

  it('takes the word from the relay argument when the caller already resolved it', () => {
    // How `scripts/hooks/cmate-agent-event.sh --event stop` reaches the source.
    const normalized = codexAgentEventSource.normalizeEvent({
      payload: fixture('stop'),
      event: 'stop',
    });
    expect(normalized!.event).toBe('stop');
  });
});

describe('codex source: what it promises', () => {
  it('is registered under its own id', () => {
    // Named, never counted: `listAgentEventSources().length` would be green on
    // this branch alone and red the moment copilot/gemini/opencode land.
    expect(hasAgentEventSource(CODEX_CLI_TOOL_ID)).toBe(true);
    expect(getAgentEventSource(CODEX_CLI_TOOL_ID)).toBe(codexAgentEventSource);
    expect(getAgentEventSource(CODEX_CLI_TOOL_ID).cliToolId).toBe('codex');
  });

  it('does not claim notification, which codex has no event for at all', () => {
    // #1757 §5.1.1: codex's own hooks review screen enumerates eleven events
    // and `Notification` is not among them. A caller waiting for one waits for
    // good, which is what `supportedEvents` exists to prevent.
    expect(codexAgentEventSource.capabilities.supportedEvents).not.toContain('notification');
  });

  it('claims exactly the four words the generated config can produce', () => {
    expect([...codexAgentEventSource.capabilities.supportedEvents].sort()).toEqual([
      'session_end',
      'session_start',
      'stop',
      'user_prompt_submit',
    ]);
  });

  it('is a push source scoped to one file for the machine', () => {
    expect(codexAgentEventSource.transport).toBe('push');
    // codex has no `--settings`: `$CODEX_HOME/hooks.json` is shared by every
    // session, which is why the correlation keys travel in the environment.
    expect(codexAgentEventSource.capabilities.configScope).toBe('global-singleton');
  });

  it('abstains safely — measured, not assumed', () => {
    // #1757 §5.1.6, re-driven for this Issue: a `{}` reply produced codex's
    // ordinary "Would you like to run the following command?" dialog, and so
    // did a receiver that was not listening.
    expect(codexAgentEventSource.noDecision).toEqual({ kind: 'proceeds' });
    expect(describeAbstain(codexAgentEventSource).safe).toBe(true);
  });

  it('answers unknown liveness and no activity probe, like every push source', () => {
    const target = { worktreeId: 'wt-1', cliToolId: CODEX_CLI_TOOL_ID } as const;
    expect(codexAgentEventSource.liveness(target)).toEqual({ state: 'unknown' });
    return expect(codexAgentEventSource.probeActivity(target)).resolves.toBeNull();
  });
});

describe('codex source: the verdict wire format (#1757 §5.1.6)', () => {
  it('spells allow the way the live session obeyed', () => {
    expect(encodeCodexVerdict({ kind: 'allowOnce' })).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
    expect(codexAgentEventSource.encodeVerdict({ kind: 'allowOnce' })).toEqual({
      kind: 'responseBody',
      body: {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' },
        },
      },
    });
  });

  it('spells deny with the feedback message codex shows the agent', () => {
    expect(encodeCodexVerdict({ kind: 'deny', message: 'blocked by CommandMate' })).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'blocked by CommandMate' },
      },
    });
  });

  it('answers the empty body for every verdict it cannot spell', () => {
    // Empty is not a swallowed error: it is the documented way to say "no
    // opinion", and codex responds by drawing the dialog it would have drawn
    // with no hook installed.
    const collapsing: Verdict[] = [
      { kind: 'abstain' },
      { kind: 'allowAlways' },
      { kind: 'answer', answers: [['yes']] },
    ];
    for (const verdict of collapsing) {
      expect(encodeCodexVerdict(verdict)).toEqual({});
    }
  });
});

describe('codex source: reading the permission request', () => {
  it('parses the captured PermissionRequest payload', () => {
    // The reuse of Claude's strict parser rests on this fixture, not on the two
    // formats looking alike.
    const parsed = codexAgentEventSource.parsePermissionRequest(fixture('permission-request'));
    expect(parsed).not.toBeNull();
    expect(parsed!.toolName).toBe('Bash');
    expect(parsed!.toolInput.command).toBe('touch ./cx-approval-marker.txt');
    expect(parsed!.sessionId).toBe('00000000-0000-4000-8000-000000000000');
    expect(parsed!.permissionMode).toBe('default');
    expect(parsed).toEqual(parsePermissionRequestPayload(fixture('permission-request')));
  });

  it('leaves promptId null, because codex sends a turn id and not a request id', () => {
    // `turn_id` is shared by every approval inside one turn, so mapping it onto
    // `promptId` would give two approvals the same decision slot id.
    const payload = fixture('permission-request');
    expect(payload.turn_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(payload.prompt_id).toBeUndefined();
    expect(codexAgentEventSource.parsePermissionRequest(payload)!.promptId).toBeNull();
  });

  it('refuses a payload that is not a PermissionRequest', () => {
    expect(codexAgentEventSource.parsePermissionRequest(fixture('pre-tool-use'))).toBeNull();
  });

  it('reads no structured question, because codex has no AskUserQuestion tool', () => {
    for (const name of ['permission-request', 'user-prompt-submit', 'stop']) {
      expect(codexAgentEventSource.parseQuestion(fixture(name))).toBeNull();
    }
  });
});
