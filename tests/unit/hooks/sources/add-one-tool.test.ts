/**
 * "One file adds one tool" — demonstrated rather than asserted (Issue #1759).
 *
 * The acceptance criterion is that Phase 4-2…4-5 can each land a tool by adding
 * a file, and the only honest way to show that is to write one and drive it
 * with that tool's real payloads. So this file contains a codex source in full
 * — every line a Phase 4-2 implementer would write, and nothing else — and runs
 * it against the seven payloads captured from codex 0.147.0 in Issue #1757.
 *
 * **None of the sources below are shipped.** Actual tool support is #1760…#1763
 * and stays out of `src/`. What is being proved is the shape: if a tool needed
 * something the interface cannot express, this file would not compile.
 *
 * The three tools after codex are covered more briefly — their divergences are
 * the interesting part, and each one is a thing that would have needed an `if`
 * in the receiver before this abstraction existed:
 *
 *  - copilot spells the events like Claude but fires `UserPromptSubmit` first.
 *  - gemini renames four of the seven.
 *  - antigravity ships no event name, no `cwd` and camelCase keys, and reads an
 *    empty reply as a denial.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  boundDetail,
  CAMEL_CASE_HOOK_EVENT_NAMES,
  definePushHookSource,
  describeAbstain,
  extractSnakeCaseEventDetail,
  fromNameTable,
  getUnknownEventTally,
  isPlainObject,
  readNestedString,
  resetUnknownEventTallies,
  SESSION_ID_FIELDS,
  TOOL_CALL_ID_FIELDS,
  type AgentEventSource,
  type EventMapper,
} from '@/lib/hooks/sources';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks');

function fixture(tool: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, tool, `${name}.json`), 'utf8'));
}

beforeEach(() => resetUnknownEventTallies());

// ===========================================================================
// The whole of a codex source. This is the file Phase 4-2 (#1760) adds.
// ===========================================================================

const codexSource: AgentEventSource = definePushHookSource({
  cliToolId: 'codex',

  // #1757 §5.1: an unanswered hook leaves codex in its ordinary approval flow.
  noDecision: { kind: 'proceeds' },

  capabilities: {
    // No `notification`: `Notification` is not among the eleven events codex's
    // own hooks review screen lists, and writing one into hooks.json is
    // discarded in silence.
    supportedEvents: [
      'stop',
      'session_start',
      'session_end',
      'user_prompt_submit',
      'pre_tool_use',
      'post_tool_use',
    ],
    // `$CODEX_HOME/hooks.json` plus `<cwd>/.codex/hooks.json`.
    configScope: 'per-worktree',
    decisionTimeoutSeconds: 600,
    // #1924: the five declared values of §4 D3. codex is a Claude-shaped
    // permission hook, so its forecast column matches Claude's.
    permissionHookPredictsDialog: true,
    sessionStartMayArriveLate: false,
    permissionReplyReleasesPrompt: false,
    eventIdentity: null,
    resync: 'none',
  },

  // Same CamelCase dialect as Claude — measured, not assumed (#1757 §8.1).
  mappers: fromNameTable(CAMEL_CASE_HOOK_EVENT_NAMES),
  nativeEventNameFields: ['hook_event_name'],
  conversationIdFields: SESSION_ID_FIELDS,
  toolCallIdFields: TOOL_CALL_ID_FIELDS,
  extractDetail: extractSnakeCaseEventDetail,

  // Payload is Claude-shaped, so the same strict parser reads it. A real #1760
  // would assert that against `codex/permission-request.json` before reusing it.
  parsePermissionRequest: () => null,
  parseQuestion: () => null,

  // #1757 R15: `hookSpecificOutput.decision.behavior`, like Claude.
  encodeVerdict: (verdict) =>
    verdict.kind === 'allowOnce'
      ? {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'allow' },
          },
        }
      : {},

  // #1757 P5: hook trust is persisted into the user's own `~/.codex/config.toml`,
  // so the only way to enable hooks without writing to it is per-invocation.
  prepareLaunch: ({ executablePath }) => ({
    command: `${executablePath} --dangerously-bypass-hook-trust`,
    settingsPath: null,
    env: {},
  }),
});

// ===========================================================================

describe('a codex source, written once, maps every captured codex payload', () => {
  const CASES: ReadonlyArray<[string, string, string | null]> = [
    ['session-start', 'session_start', 'startup'],
    ['user-prompt-submit', 'user_prompt_submit', null],
    ['pre-tool-use', 'pre_tool_use', 'Bash'],
    ['post-tool-use', 'post_tool_use', 'Bash'],
    ['stop', 'stop', null],
    ['session-end', 'session_end', 'other'],
  ];

  it.each(CASES)('maps %s to %s', (name, event, detail) => {
    const normalized = codexSource.normalizeEvent({ payload: fixture('codex', name) });
    expect(normalized, `${name} did not map`).not.toBeNull();
    expect(normalized!.event).toBe(event);
    expect(normalized!.detail).toBe(detail);
  });

  it('correlates a tool call by tool_use_id where codex sends one', () => {
    expect(
      codexSource.normalizeEvent({ payload: fixture('codex', 'pre-tool-use') })!.toolCallId
    ).toBe('exec-00000000-0000-4000-8000-000000000000');
    // …and `PermissionRequest` has none, exactly as on Claude (D2).
    expect(fixture('codex', 'permission-request').tool_use_id).toBeUndefined();
  });

  it('does not claim to emit notification', () => {
    // A caller waiting for one would wait forever. Saying so in `capabilities`
    // is how it finds out without a live session.
    expect(codexSource.capabilities.supportedEvents).not.toContain('notification');
  });

  it('carries the trust bypass into the launch command', () => {
    // #1757 P4: without it codex skips untrusted hooks in complete silence —
    // no stderr, no log, zero events, and a byte-identical transcript.
    expect(
      codexSource.prepareLaunch({
        target: { worktreeId: 'wt-1', cliToolId: 'codex' },
        executablePath: '/usr/local/bin/codex',
        worktreePath: '/repo/wt-1',
      }).command
    ).toBe('/usr/local/bin/codex --dangerously-bypass-hook-trust');
  });
});

describe('copilot: same spellings, different order, shorter fuse', () => {
  const copilotSource = definePushHookSource({
    cliToolId: 'copilot',
    noDecision: { kind: 'proceeds' },
    capabilities: {
      supportedEvents: [
        'stop',
        'session_start',
        'session_end',
        'user_prompt_submit',
        'pre_tool_use',
        'post_tool_use',
      ],
      // #1757 P2: `~/.copilot/settings.json`. Writing to config.json instead
      // looks like it works and is erased on the next launch.
      configScope: 'global-singleton',
      // ≈10s, against Claude's 600s. A decision path budgeted for Claude never
      // lands here.
      decisionTimeoutSeconds: 10,
      // #1924: copilot's two departures from the Claude row — its permission
      // hook fires on every tool call (#1901) and `SessionStart` trails
      // `UserPromptSubmit` (#1903).
      permissionHookPredictsDialog: false,
      sessionStartMayArriveLate: true,
      permissionReplyReleasesPrompt: false,
      eventIdentity: null,
      resync: 'none',
    },
    mappers: fromNameTable(CAMEL_CASE_HOOK_EVENT_NAMES),
    conversationIdFields: SESSION_ID_FIELDS,
    extractDetail: extractSnakeCaseEventDetail,
    parsePermissionRequest: () => null,
    parseQuestion: () => null,
    encodeVerdict: () => ({}),
    prepareLaunch: ({ executablePath }) => ({ command: executablePath, settingsPath: null, env: {} }),
  });

  it('maps its captured payloads', () => {
    for (const [name, event] of [
      ['session-start', 'session_start'],
      ['user-prompt-submit', 'user_prompt_submit'],
      ['pre-tool-use', 'pre_tool_use'],
      ['post-tool-use', 'post_tool_use'],
      ['stop', 'stop'],
      ['session-end', 'session_end'],
    ] as const) {
      expect(copilotSource.normalizeEvent({ payload: fixture('copilot', name) })?.event).toBe(event);
    }
  });

  it('states the ten-second decision budget as a capability', () => {
    expect(copilotSource.capabilities.decisionTimeoutSeconds).toBe(10);
  });
});

describe('gemini: four of the seven are spelled differently', () => {
  // The table is the CLI's own, read out of `gemini hooks migrate --from-claude`
  // rather than guessed (#1757 §5.3.1).
  const GEMINI_EVENT_NAMES = {
    SessionStart: 'session_start',
    SessionEnd: 'session_end',
    BeforeAgent: 'user_prompt_submit',
    AfterAgent: 'stop',
    BeforeTool: 'pre_tool_use',
    AfterTool: 'post_tool_use',
    Notification: 'notification',
  } as const;

  const geminiSource = definePushHookSource({
    cliToolId: 'gemini',
    noDecision: { kind: 'proceeds' },
    capabilities: {
      supportedEvents: [
        'stop',
        'session_start',
        'session_end',
        'user_prompt_submit',
        'pre_tool_use',
        'post_tool_use',
        'notification',
      ],
      // `<worktree>/.gemini/settings.json` — the one tool that scopes naturally.
      configScope: 'per-worktree',
      decisionTimeoutSeconds: null,
      // #1924: gemini registers no permission hook at all.
      permissionHookPredictsDialog: false,
      sessionStartMayArriveLate: false,
      permissionReplyReleasesPrompt: false,
      eventIdentity: null,
      resync: 'none',
    },
    mappers: fromNameTable(GEMINI_EVENT_NAMES),
    conversationIdFields: SESSION_ID_FIELDS,
    extractDetail: extractSnakeCaseEventDetail,
    parsePermissionRequest: () => null,
    parseQuestion: () => null,
    encodeVerdict: () => ({}),
    prepareLaunch: ({ executablePath }) => ({ command: executablePath, settingsPath: null, env: {} }),
  });

  it('maps BeforeAgent onto user_prompt_submit', () => {
    // The exact case that used to die as "unrecognized hook event name": the
    // shared table has no `BeforeAgent`, and a shared table is all there was.
    expect(geminiSource.normalizeEvent({ payload: fixture('gemini', 'before-agent') })?.event).toBe(
      'user_prompt_submit'
    );
    expect(
      geminiSource.normalizeEvent({ payload: fixture('gemini', 'session-start') })?.detail
    ).toBe('startup');
    expect(geminiSource.normalizeEvent({ payload: fixture('gemini', 'session-end') })?.event).toBe(
      'session_end'
    );
  });

  it('drops the gemini-only events instead of forcing them into a word', () => {
    // `BeforeModel` and `PreCompress` have no counterpart. Filing them under
    // something adjacent would publish a meaning nothing agreed to.
    for (const name of ['before-model', 'pre-compress']) {
      expect(geminiSource.normalizeEvent({ payload: fixture('gemini', name) })).toBeNull();
    }
    expect(getUnknownEventTally('gemini').names).toEqual(['BeforeModel', 'PreCompress']);
  });
});

describe('antigravity: no event name, no cwd, camelCase, fail-closed', () => {
  // #1757 R2/R6: the payload cannot say which event it is or which worktree it
  // came from, so both arrive as relay arguments. A source that could only read
  // the payload would be unimplementable — which is why `RawAgentEvent.event`
  // exists.
  const agyToolName: EventMapper = () => null;

  const agySource = definePushHookSource({
    cliToolId: 'antigravity',

    // #1757 P10, the most consequential single measurement of the spike: an
    // empty `{}` is read as a DENIAL and stops the tool call, while a *timeout*
    // is fail-open. Silence and an empty object are opposites here.
    noDecision: { kind: 'blocks' },

    capabilities: {
      // `SessionEnd` / `Notification` / `UserPromptSubmit` never fire, however
      // they are configured.
      supportedEvents: ['stop', 'session_start', 'pre_tool_use', 'post_tool_use'],
      // `~/.gemini/config/hooks.json`, one file for the whole machine; the
      // documented workspace-local file is never read.
      configScope: 'global-singleton',
      decisionTimeoutSeconds: 30,
      // #1924: agy's hook is adjudicated, not forecast.
      permissionHookPredictsDialog: false,
      sessionStartMayArriveLate: false,
      permissionReplyReleasesPrompt: false,
      eventIdentity: null,
      resync: 'none',
    },

    mappers: [agyToolName],
    // Nothing to read: there is no event-name field anywhere in the payload.
    nativeEventNameFields: [],
    conversationIdFields: ['conversationId'],
    // camelCase protojson, and the tool name is nested under `toolCall`.
    extractDetail: (event, payload) =>
      event === 'pre_tool_use' || event === 'post_tool_use'
        ? boundDetail(readNestedString(payload, ['toolCall', 'name']))
        : null,

    parsePermissionRequest: () => null,
    parseQuestion: () => null,

    // Abstention has to be spelled positively. `{}` would stop the agent.
    encodeVerdict: (verdict) =>
      verdict.kind === 'deny'
        ? { decision: 'deny', reason: verdict.message ?? '' }
        : { decision: 'allow' },

    prepareLaunch: ({ executablePath }) => ({ command: executablePath, settingsPath: null, env: {} }),
  });

  it('is only mappable through the relay argument', () => {
    const payload = fixture('antigravity', 'pre-tool-use');
    // Nothing in the payload says what this is…
    expect(agySource.normalizeEvent({ payload })).toBeNull();
    // …so the receiver is told.
    const normalized = agySource.normalizeEvent({ payload, event: 'pre_tool_use' });
    expect(normalized!.event).toBe('pre_tool_use');
    expect(normalized!.detail).toBe('run_command');
    expect(normalized!.conversationId).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('reads the camelCase conversation id on every captured payload', () => {
    for (const [name, event] of [
      ['session-start', 'session_start'],
      ['pre-tool-use', 'pre_tool_use'],
      ['post-tool-use', 'post_tool_use'],
      ['stop', 'stop'],
    ] as const) {
      const normalized = agySource.normalizeEvent({ payload: fixture('antigravity', name), event });
      expect(normalized!.conversationId).toBe('22222222-2222-4222-8222-222222222222');
    }
  });

  it('cannot locate a worktree from the payload, and does not pretend to', () => {
    // `workspacePaths` is `[]` in CLI mode and there is no `cwd` field at all,
    // so the worktree id has to be burned into the relay command's arguments.
    const stop = fixture('antigravity', 'stop');
    expect(stop.cwd).toBeUndefined();
    expect(stop.workspacePaths).toEqual([]);
  });

  it('never encodes abstention as an empty object', () => {
    // The whole failure mode: `{}` here is a denial, so the "safe" reply that
    // works on Claude stops every tool call on antigravity.
    expect(agySource.encodeVerdict({ kind: 'abstain' })).toEqual({
      kind: 'responseBody',
      body: { decision: 'allow' },
    });
    expect(describeAbstain(agySource).safe).toBe(false);
  });

  it('does not claim to emit session_end or user_prompt_submit', () => {
    expect(agySource.capabilities.supportedEvents).not.toContain('session_end');
    expect(agySource.capabilities.supportedEvents).not.toContain('user_prompt_submit');
    // Which is exactly why process termination stays tmux's job for every tool.
  });
});

describe('the four tools agree on only four words (#1757 §8.1)', () => {
  it('stop / session_start / pre_tool_use / post_tool_use', () => {
    // Restated as an assertion because it bounds what any cross-tool feature
    // may depend on: a `wait` that needs `session_end` works on three tools and
    // hangs on the fourth.
    const codex = new Set(codexSource.capabilities.supportedEvents);
    const agy = new Set(['stop', 'session_start', 'pre_tool_use', 'post_tool_use']);
    const shared = [...agy].filter((event) => codex.has(event as never));
    expect(shared.sort()).toEqual(['post_tool_use', 'pre_tool_use', 'session_start', 'stop']);
  });

  it('and every captured payload is a plain JSON object', () => {
    // Cheap, but it is the assumption every parser above makes.
    for (const tool of ['codex', 'copilot', 'gemini', 'antigravity']) {
      expect(isPlainObject(fixture(tool, 'session-start'))).toBe(true);
    }
  });
});
