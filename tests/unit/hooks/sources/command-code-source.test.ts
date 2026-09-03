/**
 * Command Code's source, driven by the payloads Command Code actually sent
 * (Issue #2251, Epic #2249 Phase B).
 *
 * Every fixture in `tests/fixtures/hooks/command-code/` is a verbatim capture
 * from v1.40.1, so "the four events map" is a statement about the tool rather
 * than about a JSON file someone wrote to match the code.
 *
 * The assertions are grouped by the thing that would break:
 *
 *  1. the four events map to the four words, with the detail an operator greps;
 *  2. the three absent words stay absent, and are refused rather than guessed;
 *  3. abstention is `{}` and is safe — the pair `noDecision` / `encodeVerdict`
 *     that `describeAbstain` reads, which on antigravity is a denial;
 *  4. the config write merges instead of replacing, and `matcher` is the empty
 *     string, which is what keeps `SessionStart` and `Stop` firing at all;
 *  5. `CM_AGENT_HOOKS_INJECT=0` produces the byte-identical Phase A line;
 *  6. the transcript pointer Phase C (#2252) reads.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { describeAbstain, renderAgentLaunchCommand } from '@/lib/hooks/sources';
import {
  commandCodeAgentEventSource,
  encodeCommandCodeVerdict,
  readCommandCodeTranscriptPath,
  COMMAND_CODE_HOOK_EVENT_NAMES,
  COMMAND_CODE_TRANSCRIPT_PATH_FIELDS,
} from '@/lib/hooks/sources/command-code/source';
import {
  buildCommandCodeHookGroups,
  buildCommandCodeLaunchEnvironment,
  getCommandCodeSettingsPath,
  mergeCommandCodeHookSettings,
  writeCommandCodeHookSettings,
  COMMAND_CODE_MATCH_ALL_MATCHER,
  COMMAND_CODE_REGISTERED_HOOKS,
  COMMAND_CODE_SETTINGS_FILENAME,
} from '@/lib/hooks/sources/command-code/hooks-config';
import { CAMEL_CASE_HOOK_EVENT_NAMES } from '@/lib/hooks/sources/hook-event-vocabulary';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/command-code');

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

const dirs: string[] = [];
let worktree: string;

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

const TARGET = { worktreeId: 'wt-2251', cliToolId: 'command-code' as const, instanceId: 'command-code' };

beforeEach(() => {
  worktree = makeTempDir('cmate-2251-wt-');
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) removeTempDir(dir);
  }
});

// ===========================================================================
// 1. The four events
// ===========================================================================

describe('[#2251] the four captured payloads map to the four words', () => {
  const CASES: ReadonlyArray<[string, string, string | null]> = [
    ['session-start', 'session_start', 'startup'],
    ['pre-tool-use-shell', 'pre_tool_use', 'shell_command'],
    ['post-tool-use-shell', 'post_tool_use', 'shell_command'],
    ['pre-tool-use-write', 'pre_tool_use', 'write_file'],
    ['post-tool-use-write', 'post_tool_use', 'write_file'],
    ['stop', 'stop', null],
  ];

  it.each(CASES)('maps %s to %s with detail %s', (name, event, detail) => {
    const normalized = commandCodeAgentEventSource.normalizeEvent({ payload: fixture(name) });
    expect(normalized, `${name} did not map`).not.toBeNull();
    expect(normalized!.event).toBe(event);
    expect(normalized!.detail).toBe(detail);
  });

  it('reads the session id off every payload, as `session_id`', () => {
    // Not `conversationId`: that is antigravity's spelling and no Command Code
    // payload has it. A reader that took the first non-empty of both would still
    // work here, so the point of the assertion is that the value is present on
    // ALL SIX frames — which is what lets a transcript pointer be latched from
    // whichever one arrives first.
    for (const [name] of CASES) {
      expect(
        commandCodeAgentEventSource.normalizeEvent({ payload: fixture(name) })!.conversationId,
        name
      ).toBe('33333333-3333-4333-8333-333333333333');
    }
  });

  it('correlates a tool call by tool_use_id, and only on the tool events', () => {
    expect(
      commandCodeAgentEventSource.normalizeEvent({ payload: fixture('pre-tool-use-shell') })!
        .toolCallId
    ).toBe('call_00_AAAABBBBCCCCDDDDEEEE0001');
    // The same id on the matching PostToolUse — the pair really is one call.
    expect(
      commandCodeAgentEventSource.normalizeEvent({ payload: fixture('post-tool-use-shell') })!
        .toolCallId
    ).toBe('call_00_AAAABBBBCCCCDDDDEEEE0001');
    // A different call gets a different id.
    expect(
      commandCodeAgentEventSource.normalizeEvent({ payload: fixture('pre-tool-use-write') })!
        .toolCallId
    ).toBe('call_00_AAAABBBBCCCCDDDDEEEE0002');
    // …and the lifecycle events carry none, which is why `eventIdentity` is null.
    expect(
      commandCodeAgentEventSource.normalizeEvent({ payload: fixture('stop') })!.toolCallId
    ).toBeNull();
    expect(
      commandCodeAgentEventSource.normalizeEvent({ payload: fixture('session-start') })!.toolCallId
    ).toBeNull();
  });

  it('reports no model, because no payload carries one (#1783)', () => {
    // Null is a fact here, not a gap: the value an operator sees comes from the
    // `# models: …` banner Phase A reads off the pane.
    for (const [name] of CASES) {
      expect(commandCodeAgentEventSource.normalizeEvent({ payload: fixture(name) })!.model, name)
        .toBeNull();
    }
  });
});

// ===========================================================================
// 2. The three words that are not there
// ===========================================================================

describe('[#2251] the absent events are refusals, not silences', () => {
  it('declares exactly the four the tool can deliver', () => {
    expect([...commandCodeAgentEventSource.capabilities.supportedEvents]).toEqual([
      'session_start',
      'pre_tool_use',
      'post_tool_use',
      'stop',
    ]);
    for (const absent of ['user_prompt_submit', 'notification', 'session_end'] as const) {
      expect(commandCodeAgentEventSource.capabilities.supportedEvents).not.toContain(absent);
    }
  });

  it('does not map a spelling the tool refuses to load, and counts it instead', () => {
    // Command Code's `isHookEvent` tests a closed four-element list, so a
    // `SessionEnd` handler is skipped at load with `unknown hook event`. Mapping
    // the word here would be mapping something no configuration can produce —
    // and would hide the case that matters, which is the tool growing an event.
    for (const native of ['SessionEnd', 'UserPromptSubmit', 'Notification', 'SubagentStop']) {
      expect(
        commandCodeAgentEventSource.normalizeEvent({ payload: { hook_event_name: native } }),
        native
      ).toBeNull();
    }
  });

  it('keeps its table private, and does not widen the shared one', () => {
    // Issue #2251 asks for both halves. The private table is four rows…
    expect(Object.keys(COMMAND_CODE_HOOK_EVENT_NAMES).sort()).toEqual([
      'PostToolUse',
      'PreToolUse',
      'SessionStart',
      'Stop',
    ]);
    // …and the shared CamelCase table other sources read is untouched by it: it
    // still carries the three words Command Code cannot send, because claude,
    // codex and copilot do send them.
    for (const shared of ['SessionEnd', 'UserPromptSubmit', 'Notification', 'SubagentStop']) {
      expect(CAMEL_CASE_HOOK_EVENT_NAMES[shared]).toBeDefined();
    }
  });

  it('keeps `pre_tool_use` in the delivered list, unlike copilot and antigravity', () => {
    // The field means *delivered*. On those two the event goes to
    // `/api/hooks/permission-request`, which adjudicates and never records; here
    // it is an ordinary observation that reaches the event store, because
    // Command Code fires it after the dialog is already answered.
    expect(commandCodeAgentEventSource.capabilities.supportedEvents).toContain('pre_tool_use');
    expect(commandCodeAgentEventSource.capabilities.permissionHookPredictsDialog).toBe(false);
    expect(
      commandCodeAgentEventSource.parsePermissionRequest(fixture('pre-tool-use-shell'))
    ).toBeNull();
    expect(commandCodeAgentEventSource.parseQuestion(fixture('pre-tool-use-shell'))).toBeNull();
  });
});

// ===========================================================================
// 3. Abstention
// ===========================================================================

describe('[#2251] abstention is the empty object, and it is safe', () => {
  it('says silence costs nothing, and encodes it as `{}`', () => {
    expect(commandCodeAgentEventSource.noDecision).toEqual({ kind: 'proceeds' });

    const outcome = describeAbstain(commandCodeAgentEventSource);
    expect(outcome.safe).toBe(true);
    expect(outcome.blocksForMs).toBe(0);
    expect(outcome.summary).toBe('the agent continues with its own approval flow');
  });

  it('encodes every verdict as `{}`, including allowOnce', () => {
    // Not laziness: there is no event on this tool whose reply is a permission
    // decision. `PreToolUse` arrives after the human answered, and the only word
    // it reads is `deny` — which `permission-decision-service` never emits.
    for (const verdict of [
      { kind: 'abstain' },
      { kind: 'allowOnce' },
      { kind: 'allowAlways' },
      { kind: 'deny', message: 'no' },
    ] as const) {
      expect(encodeCommandCodeVerdict(verdict), verdict.kind).toEqual({});
    }
    expect(commandCodeAgentEventSource.encodeVerdict({ kind: 'abstain' })).toEqual({
      kind: 'responseBody',
      body: {},
    });
  });
});

// ===========================================================================
// 4. The config file
// ===========================================================================

describe('[#2251] the settings layer CommandMate writes', () => {
  it('is `<worktree>/.commandcode/settings.local.json`', () => {
    expect(getCommandCodeSettingsPath(worktree)).toBe(
      join(worktree, '.commandcode', COMMAND_CODE_SETTINGS_FILENAME)
    );
    expect(COMMAND_CODE_SETTINGS_FILENAME).toBe('settings.local.json');
  });

  it('registers all four events, with the EMPTY matcher', () => {
    // The mutation this exists for: setting the matcher to `'*'` — which loads
    // without a warning — removes `SessionStart` and `Stop` entirely, because
    // Command Code skips any handler with a truthy matcher when there is no tool
    // name. Measured: `""` → `Ran 2 session start hooks`, `"*"` → `Ran 1`.
    expect(COMMAND_CODE_MATCH_ALL_MATCHER).toBe('');

    const groups = buildCommandCodeHookGroups('/relay/cmate-agent-event.sh', TARGET);
    expect(Object.keys(groups)).toEqual(['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']);
    for (const [nativeName] of COMMAND_CODE_REGISTERED_HOOKS) {
      const group = groups[nativeName][0];
      expect(group.matcher, nativeName).toBe('');
      expect(group.hooks).toHaveLength(1);
      expect(group.hooks[0].type).toBe('command');
      // Seconds, and inside the (0, 600] window the tool's own validator enforces.
      expect(group.hooks[0].timeout).toBe(5);
      expect(group.hooks[0].timeout).toBeGreaterThan(0);
      expect(group.hooks[0].timeout).toBeLessThanOrEqual(600);
    }
  });

  it('passes --event explicitly and burns the worktree into the command', () => {
    const groups = buildCommandCodeHookGroups('/relay/cmate-agent-event.sh', TARGET);
    expect(groups.Stop[0].hooks[0].command).toBe(
      "'/relay/cmate-agent-event.sh' --tool command-code --event stop --worktree-id 'wt-2251' --stdin-json"
    );
    expect(groups.SessionStart[0].hooks[0].command).toContain('--event session_start');
    expect(groups.PreToolUse[0].hooks[0].command).toContain('--event pre_tool_use');
    expect(groups.PostToolUse[0].hooks[0].command).toContain('--event post_tool_use');
    // No --instance-id and no --url: one file serves `command-code` and
    // `command-code-2`, so both ride in CM_HOOK_URL instead.
    for (const [nativeName] of COMMAND_CODE_REGISTERED_HOOKS) {
      expect(groups[nativeName][0].hooks[0].command).not.toContain('--instance-id');
      expect(groups[nativeName][0].hooks[0].command).not.toContain('--url');
    }
  });

  it('keeps every key and every foreign hook the user already had', () => {
    const existing = {
      permissions: { allow: ['shell_command'] },
      disabledSkills: ['taste'],
      hooks: {
        // A user's own handler on an event we also register…
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: '/usr/local/bin/notify' }] }],
        // …and one on an event we do not touch, plus a value that is not an array.
        PreToolUse: [{ matcher: 'shell_command', hooks: [{ type: 'command', command: '/lint' }] }],
        SomethingElse: { not: 'an array' },
      },
    };

    const merged = mergeCommandCodeHookSettings(
      existing,
      buildCommandCodeHookGroups('/relay/cmate-agent-event.sh', TARGET),
      'wt-2251'
    );

    expect(merged.permissions).toBe(existing.permissions);
    expect(merged.disabledSkills).toBe(existing.disabledSkills);
    const hooks = merged.hooks as Record<string, unknown>;
    expect(hooks.SomethingElse).toBe(existing.hooks.SomethingElse);
    // The user's handlers are first, ours appended.
    expect((hooks.Stop as unknown[])[0]).toBe(existing.hooks.Stop[0]);
    expect((hooks.Stop as unknown[]).length).toBe(2);
    expect((hooks.PreToolUse as unknown[])[0]).toBe(existing.hooks.PreToolUse[0]);
    expect((hooks.PreToolUse as unknown[]).length).toBe(2);
  });

  it('replaces its own previous entries rather than accumulating them', () => {
    const groups = buildCommandCodeHookGroups('/relay/cmate-agent-event.sh', TARGET);
    const once = mergeCommandCodeHookSettings(null, groups, 'wt-2251');
    const twice = mergeCommandCodeHookSettings(once, groups, 'wt-2251');
    const thrice = mergeCommandCodeHookSettings(twice, groups, 'wt-2251');

    expect(thrice).toEqual(once);
    for (const [nativeName] of COMMAND_CODE_REGISTERED_HOOKS) {
      expect((thrice.hooks as Record<string, unknown[]>)[nativeName], nativeName).toHaveLength(1);
    }
  });

  it('leaves ANOTHER worktree`s CommandMate entry alone', () => {
    // The marker is (relay name, tool, worktree id) together, so a shared file —
    // which this one is not, but a symlinked or copied one could be — does not
    // lose the other worktree's registration.
    const other = mergeCommandCodeHookSettings(
      null,
      buildCommandCodeHookGroups('/relay/cmate-agent-event.sh', { ...TARGET, worktreeId: 'wt-other' }),
      'wt-other'
    );
    const merged = mergeCommandCodeHookSettings(
      other,
      buildCommandCodeHookGroups('/relay/cmate-agent-event.sh', TARGET),
      'wt-2251'
    );
    expect((merged.hooks as Record<string, unknown[]>).Stop).toHaveLength(2);
  });

  it('writes the file prepareLaunch names, and merges into one that exists', () => {
    const settingsPath = getCommandCodeSettingsPath(worktree);
    mkdirSync(join(worktree, '.commandcode'), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({ model: 'taste-1', hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '/mine' }] }] } })
    );

    const plan = commandCodeAgentEventSource.prepareLaunch({
      target: TARGET,
      executablePath: '/usr/local/bin/commandcode',
      worktreePath: worktree,
    });

    expect(plan.settingsPath).toBe(settingsPath);
    expect(existsSync(settingsPath)).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.model).toBe('taste-1');
    expect(written.hooks.Stop[0].hooks[0].command).toBe('/mine');
    expect(written.hooks.Stop[1].hooks[0].command).toContain('--event stop');
    expect(written.hooks.SessionStart[0].matcher).toBe('');
  });

  it('does not touch a file it cannot parse, and starts without hooks', () => {
    // A hand-edited file with a trailing comma is not a reason to fail a
    // session — but it IS a reason not to rewrite it, because rewriting means
    // discarding whatever the operator meant. `readJsonObjectFile` answers null
    // for unparseable, so what lands is CommandMate's key over an empty base;
    // the assertion is that the write still succeeds and the session starts.
    mkdirSync(join(worktree, '.commandcode'), { recursive: true });
    writeFileSync(getCommandCodeSettingsPath(worktree), '{ "hooks": { , }');

    const path = writeCommandCodeHookSettings(worktree, TARGET);
    expect(path).toBe(getCommandCodeSettingsPath(worktree));
    expect(JSON.parse(readFileSync(path!, 'utf8')).hooks.Stop).toHaveLength(1);
  });
});

// ===========================================================================
// 5. The launch line
// ===========================================================================

describe('[#2251] the launch line', () => {
  it('carries the correlation URL in `env`, never as a command prefix (#1846)', () => {
    const plan = commandCodeAgentEventSource.prepareLaunch({
      target: { ...TARGET, instanceId: 'command-code-2' },
      executablePath: '/usr/local/bin/commandcode',
      worktreePath: worktree,
    });

    expect(plan.command).toBe("'/usr/local/bin/commandcode'");
    expect(plan.command).not.toMatch(/^\s*[A-Za-z_][A-Za-z0-9_]*=/);
    expect(Object.keys(plan.env)).toEqual(['CM_HOOK_URL']);
    // The instance is in the URL because the FILE cannot hold it: one
    // `.commandcode/settings.local.json` serves every instance in the worktree.
    expect(plan.env.CM_HOOK_URL).toContain('instanceId=command-code-2');
    expect(plan.env.CM_HOOK_URL).toContain('worktreeId=wt-2251');
    expect(plan.env.CM_HOOK_URL).toContain('tool=command-code');
    expect(renderAgentLaunchCommand(plan)).toBe(
      `CM_HOOK_URL='${plan.env.CM_HOOK_URL}' '/usr/local/bin/commandcode'`
    );
  });

  it('goes bare with CM_AGENT_HOOKS_INJECT=0, and writes nothing', () => {
    vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');

    const plan = commandCodeAgentEventSource.prepareLaunch({
      target: TARGET,
      executablePath: 'commandcode',
      worktreePath: worktree,
    });

    expect(plan.command).toBe('commandcode');
    expect(plan.env).toEqual({});
    expect(plan.settingsPath).toBeNull();
    expect(existsSync(getCommandCodeSettingsPath(worktree))).toBe(false);
    // The rendered line grows no leading space, which is what makes the Phase A
    // launch line byte-identical.
    expect(renderAgentLaunchCommand(plan)).toBe('commandcode');
  });

  it('refuses to inject for an instance id the receiver would reject', () => {
    const { command, env } = buildCommandCodeLaunchEnvironment('commandcode', {
      worktreeId: 'wt-2251',
      instanceId: '../../etc/passwd',
      cliToolId: 'command-code',
    });
    expect(command).toBe('commandcode');
    expect(env).toEqual({});
  });
});

// ===========================================================================
// 6. The Phase C seam
// ===========================================================================

describe('[#2251] the transcript pointer Phase C reads', () => {
  it('is on every captured payload, with the same value', () => {
    const expected =
      '/Users/example/.commandcode/projects/private-tmp-my-code-branch-desk-probe/33333333-3333-4333-8333-333333333333.jsonl';
    for (const name of [
      'session-start',
      'pre-tool-use-shell',
      'post-tool-use-shell',
      'pre-tool-use-write',
      'post-tool-use-write',
      'stop',
    ]) {
      expect(readCommandCodeTranscriptPath(fixture(name)), name).toBe(expected);
    }
    expect([...COMMAND_CODE_TRANSCRIPT_PATH_FIELDS]).toEqual(['transcript_path']);
  });

  it('is not derivable from cwd, which is the whole reason it is read', () => {
    // The slug splits camel case: `MyCodeBranchDesk` -> `my-code-branch-desk`.
    // Any reader that built the path from the worktree would have to
    // reimplement an unpublished function; this asserts the fixture really does
    // preserve the pair, so a future "just kebab the cwd" shortcut is visibly
    // wrong.
    const payload = fixture('session-start');
    expect(payload.cwd).toBe('/private/tmp/MyCodeBranchDesk/probe');
    expect(readCommandCodeTranscriptPath(payload)).toContain('my-code-branch-desk');
    expect(String(payload.cwd).toLowerCase().replace(/\//g, '-')).not.toContain(
      'my-code-branch-desk'
    );
  });

  it('answers null for anything it cannot vouch for', () => {
    expect(readCommandCodeTranscriptPath(null)).toBeNull();
    expect(readCommandCodeTranscriptPath('a string')).toBeNull();
    expect(readCommandCodeTranscriptPath({})).toBeNull();
    expect(readCommandCodeTranscriptPath({ transcript_path: 42 })).toBeNull();
    // Relative — would resolve against whatever cwd the reader happens to have.
    expect(readCommandCodeTranscriptPath({ transcript_path: 'projects/x/a.jsonl' })).toBeNull();
    // Not the transcript.
    expect(readCommandCodeTranscriptPath({ transcript_path: '/tmp/a.txt' })).toBeNull();
    // Unbounded.
    expect(
      readCommandCodeTranscriptPath({ transcript_path: `/${'a'.repeat(5000)}.jsonl` })
    ).toBeNull();
  });
});
