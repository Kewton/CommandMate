/**
 * The five open items #1759 left behind, and what #1846 decided about each.
 *
 * The Issue's premise is that a report is not a decision. Two of the five
 * items had been *reached independently by two implementations each* — a
 * worktree path `prepareLaunch` could not carry, and an environment
 * `AgentLaunchPlan` could not declare — which is the signal that the seventh
 * tool would write the same workaround a third time. Those two are adopted, and
 * this file is what makes the adoption non-inert: the interface can be widened
 * and still be routed around, so the assertions here are aimed at the routes.
 *
 * The other three are declined, for reasons the design doc carries in full. Two
 * of the three are decisions *about* a type, so they are pinned here too — a
 * verdict that lives only in prose comes back as the same 申し送り next year.
 *
 * | # | Item | Verdict |
 * |---|---|---|
 * | 1 | `worktreePath` on the launch input | adopted, required |
 * | 2 | `env` on `AgentLaunchPlan` | adopted, required |
 * | 3 | a `denies` member on `NoDecisionBehavior` | declined — premise obsolete since #1779 |
 * | 4 | splitting `supportedEvents` | declined — it means *delivered*, documented |
 * | 5 | a shared turn-gate in `definePullEventSource` | declined — documented as a rule |
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import {
  getAgentEventSource,
  listAgentEventSources,
  renderAgentLaunchCommand,
  type AgentEventSource,
  type AgentLaunchContext,
} from '@/lib/hooks/sources';
import { getGeminiSettingsPath } from '@/lib/hooks/sources/gemini/settings-generator';
import { ANTIGRAVITY_ABSTAIN_BODY } from '@/lib/hooks/sources/antigravity/hooks-config';
import { antigravityAgentEventSource } from '@/lib/hooks/sources/antigravity/source';
import { copilotAgentEventSource } from '@/lib/hooks/sources/copilot/source';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import { rememberOpencodePort } from '@/lib/hooks/sources/opencode/ports';

/**
 * The tools that have a real source, in registration order.
 *
 * Seven since Issue #2251: Command Code is the seventh, and it is the case the
 * declined item 2 was written against — a per-worktree config file that cannot
 * hold the instance id, so the correlation URL has to be `env` rather than a
 * prefix on `command`.
 */
const TOOLS = [
  'claude',
  'codex',
  'copilot',
  'gemini',
  'antigravity',
  'opencode',
  'command-code',
] as const;

const dirs: string[] = [];
let home: string;
let worktree: string;

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** A launch context for one tool, pointed at this test's private worktree. */
function context(cliToolId: (typeof TOOLS)[number]): AgentLaunchContext {
  return {
    target: { worktreeId: 'wt-1846', cliToolId, instanceId: cliToolId },
    executablePath: `/usr/local/bin/${cliToolId}`,
    worktreePath: worktree,
  };
}

beforeEach(() => {
  // Private HOME and CODEX_HOME: three of the six sources write a config file
  // under the user's home, and this suite calls all six.
  home = makeTempDir('cmate-1846-home-');
  worktree = makeTempDir('cmate-1846-wt-');
  vi.stubEnv('HOME', home);
  vi.stubEnv('CODEX_HOME', join(home, '.codex'));
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
// 1. worktreePath — adopted, and required
// ===========================================================================

describe('1. the launch context carries the worktree path (adopted)', () => {
  it('lets the one per-worktree source write its own config, from prepareLaunch', () => {
    // The workaround this replaces: #1762 exported
    // `injectGeminiHookSettings(worktreePath, target)` beside the source
    // because `prepareLaunch(target, executablePath)` had no path, and
    // `cli-tools/gemini.ts` called both. The mutation that must turn this red
    // is dropping `worktreePath` from the context — the write then has nowhere
    // to go and `settingsPath` goes back to null.
    const settingsPath = getGeminiSettingsPath(worktree);
    expect(existsSync(settingsPath)).toBe(false);

    const plan = getAgentEventSource('gemini').prepareLaunch(context('gemini'));

    expect(plan.settingsPath).toBe(settingsPath);
    expect(existsSync(settingsPath)).toBe(true);
    // …and it is this worktree's file, not a global one.
    expect(settingsPath.startsWith(worktree)).toBe(true);
    expect(readFileSync(settingsPath, 'utf8')).toContain('SessionStart');
  });

  it('reports the file it actually wrote, for every source that writes one', () => {
    // `settingsPath` used to be inferred by codex from "is the command
    // different from the bare executable?", which is the same fact derived
    // twice and stops being true the moment the command stops carrying the
    // environment. Each source now answers from the write.
    for (const tool of TOOLS) {
      const plan = getAgentEventSource(tool).prepareLaunch(context(tool));
      if (plan.settingsPath === null) continue;
      expect(existsSync(plan.settingsPath), `${tool} named a file it did not write`).toBe(true);
    }
  });

  it('keeps the path out of AgentInstanceRef, which is a key', () => {
    // The declined half of item 1. Widening the key would have changed a type
    // `agent-event-state`, `pending-decisions` and both receiver routes compare
    // for equality — and a key carrying a path stops equalling itself when a
    // worktree moves.
    const ref = context('claude').target;
    expect(Object.keys(ref).sort()).toEqual(['cliToolId', 'instanceId', 'worktreeId']);
  });
});

// ===========================================================================
// 2. env — adopted, and the only place it is applied
// ===========================================================================

describe('2. the plan declares its environment (adopted)', () => {
  it('never leaves a NAME=value prefix inside command, on any of the six', () => {
    // The workaround this replaces, written independently four times: codex
    // (#1760), copilot (#1761), gemini and antigravity (#1762) each prefixed
    // their own assignments onto `command` and trusted the caller to be a
    // shell. A prefix here is invisible to a launcher that spawns argv.
    for (const tool of TOOLS) {
      const plan = getAgentEventSource(tool).prepareLaunch(context(tool));
      expect(plan.command, `${tool} put an assignment in command`).not.toMatch(
        /^\s*[A-Za-z_][A-Za-z0-9_]*=/
      );
      expect(plan.env, `${tool} did not declare an env`).toBeTypeOf('object');
    }
  });

  it('puts the correlation keys somewhere for every source whose config cannot hold them', () => {
    // The five tools with a machine-global or per-worktree config file. If any
    // of these ever declares an empty environment, its hooks fire and cannot be
    // attributed — events land on the primary instance of the wrong pane, with
    // no error anywhere. Command Code (#2251) is the fifth, for gemini's reason:
    // one `.commandcode/settings.local.json` serves `command-code` and
    // `command-code-2`, so the instance cannot live in the file.
    for (const tool of ['codex', 'copilot', 'gemini', 'antigravity', 'command-code'] as const) {
      const plan = getAgentEventSource(tool).prepareLaunch(context(tool));
      expect(Object.keys(plan.env).length, `${tool} declared no correlation env`).toBeGreaterThan(0);
    }
  });

  it('renders assignments in declaration order, in front of the command', () => {
    const plan = getAgentEventSource('codex').prepareLaunch(context('codex'));
    const line = renderAgentLaunchCommand(plan);

    const rendered = Object.entries(plan.env).map(([k, v]) => `${k}='${v}'`);
    expect(line).toBe(`${rendered.join(' ')} ${plan.command}`);
    // codex pins `CODEX_HOME` first on purpose: the file it wrote and the file
    // codex reads have to be the same file.
    expect(line.startsWith('CODEX_HOME=')).toBe(true);
  });

  it('leaves a command alone when there is nothing to apply', () => {
    // An empty env must not grow a leading space, or claude's launch line stops
    // being byte-identical to the pre-#1846 one.
    const plan = getAgentEventSource('claude').prepareLaunch(context('claude'));
    expect(plan.env).toEqual({});
    expect(renderAgentLaunchCommand(plan)).toBe(plan.command);
  });

  it('quotes values so a worktree path with a space survives', () => {
    expect(
      renderAgentLaunchCommand({
        command: 'agent',
        settingsPath: null,
        env: { CM_HOOK_URL: `http://x/?a=1&b='2'`, OTHER: 'a b' },
      })
    ).toBe(`CM_HOOK_URL='http://x/?a=1&b='\\''2'\\''' OTHER='a b' agent`);
  });
});

// ===========================================================================
// 3. NoDecisionBehavior — `denies` declined, because the premise expired
// ===========================================================================

describe('3. no `denies` member (declined)', () => {
  it('has agy on proceeds, which is what #1779 measured', () => {
    // The 申し送り said agy was approximated as `blocks`. It was, in #1762 —
    // and #1779 then registered the `PreToolUse` hook and measured agy 1.1.12:
    // `{"decision":"ask"}` draws the ordinary dialog, and a hook that prints
    // nothing is indistinguishable from no hook. Adding `denies` and moving agy
    // to it would contradict a live run.
    expect(antigravityAgentEventSource.noDecision).toEqual({ kind: 'proceeds' });
  });

  it('holds only because abstention is spelled positively', () => {
    // The two declarations are one statement. `{}` on agy's `PreToolUse` is a
    // denial (#1757 P10), so an `encodeVerdict` that returned it would make the
    // line above a lie without changing a character of it.
    const encoded = antigravityAgentEventSource.encodeVerdict({ kind: 'abstain' });
    expect(encoded.kind).toBe('responseBody');
    expect(encoded.kind === 'responseBody' && encoded.body).toEqual({ decision: 'ask' });
    expect(JSON.parse(ANTIGRAVITY_ABSTAIN_BODY)).toEqual({ decision: 'ask' });
  });

  it('leaves `blocks` meaning what it was measured to mean, on the one source that blocks', () => {
    // opencode, 10m19s pending with no timeout (#1758 §5.5.3). If a future
    // change moves agy back to `blocks` to approximate "it refuses", this is
    // the assertion that says the word is already taken by a measurement.
    const blocking = listAgentEventSources().filter(
      (source: AgentEventSource) => source.noDecision.kind === 'blocks'
    );
    expect(blocking.map((source) => source.cliToolId)).toEqual(['opencode']);
  });
});

// ===========================================================================
// 4. supportedEvents means *delivered* — declined, documented
// ===========================================================================

describe('4. supportedEvents is the delivered list, not the emittable one (declined)', () => {
  it('omits an event copilot emits and CommandMate answers somewhere else', () => {
    // copilot's `PreToolUse` *is* its approval gate: it goes to
    // `/api/hooks/permission-request`, which adjudicates and never records. The
    // spelling is still mapped, because a hand-configured hook from #1549
    // points at the event route — so "can emit" and "will be delivered" are two
    // different lists, and this field is the second one.
    expect(copilotAgentEventSource.capabilities.supportedEvents).not.toContain('pre_tool_use');
    expect(
      copilotAgentEventSource.normalizeEvent({
        payload: { hook_event_name: 'PreToolUse', tool_name: 'bash' },
      })?.event
    ).toBe('pre_tool_use');
  });

  it('is the same relationship for gemini, whose config never registers the hook', () => {
    const gemini = getAgentEventSource('gemini');
    expect(gemini.capabilities.supportedEvents).not.toContain('pre_tool_use');
    expect(
      gemini.normalizeEvent({ payload: { hook_event_name: 'BeforeTool', tool_name: 'bash' } })
        ?.event
    ).toBe('pre_tool_use');
  });
});

// ===========================================================================
// 5. the turn gate stays opencode's — declined, documented as a rule
// ===========================================================================

describe('5. pull sources fold their own repeats (declined)', () => {
  it('does not fold them in normalizeEvent, which is why the rule exists', () => {
    // opencode re-emits `message.updated` for the *same* message after
    // `session.idle`, byte-identical (#1763). `normalizeEvent` is a pure
    // function of one frame and cannot tell the second copy from the first —
    // both map to `user_prompt_submit`, which `status-mapping` reads as
    // `running`. Nothing in the interface can fix that, because the fix needs
    // memory of the connection: it belongs to the subscription, which is why
    // `docs/design/agent-event-source-interface.md` §4 makes a turn-gate a step
    // in the checklist rather than a field on the spec.
    rememberOpencodePort({ worktreeId: 'wt-1846', cliToolId: 'opencode' }, 4242, worktree);
    const frame = {
      type: 'message.updated',
      properties: { sessionID: 'ses_1', info: { role: 'user', id: 'msg_1' } },
    };
    const first = opencodeAgentEventSource.normalizeEvent({ payload: frame });
    const second = opencodeAgentEventSource.normalizeEvent({ payload: frame });
    expect(first?.event).toBe('user_prompt_submit');
    expect(second?.event).toBe('user_prompt_submit');
  });

  it('is the only transport for which that is true', () => {
    // Stated so the rule has a scope: push sources are answered request by
    // request and have no stream to replay, so there is nothing to fold.
    const pull = listAgentEventSources().filter((source) => source.transport === 'pull');
    expect(pull.map((source) => source.cliToolId)).toEqual(['opencode']);
  });
});
