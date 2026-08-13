/**
 * Antigravity's {@link AgentEventSource} (Issue #1762, Phase 4-4 of Epic #1720).
 *
 * The tool that does not fit. Four things about agy are different in kind from
 * the other push sources rather than different in spelling, and every one of
 * them is a thing that fails without an error message:
 *
 *  1. **Silence is a denial.** Everywhere else `{}` means "CommandMate has no
 *     opinion". On agy's `PreToolUse` it means *deny*, and the agent loses every
 *     tool it has (#1757 P10, checked against a hooks-free control run). A
 *     *timeout* on the same hook is fail-open — so "no reply" and "an empty
 *     reply" are opposites here, which is not true of any other tool.
 *  2. **The payload cannot say what it is.** No event-name field, no `cwd`, and
 *     `workspacePaths` is `[]` in CLI mode (#1757 R2/R6). The event word arrives
 *     as a relay argument and the correlation keys as an environment variable;
 *     see `./hooks-config`.
 *  3. **One config file for the machine.** `~/.gemini/config/hooks.json`, and
 *     the documented workspace-local file is never read.
 *  4. **`Stop` is not an observation.** Answering `{"decision":"continue"}`
 *     restarts the agent's loop, so the event CommandMate uses for "the turn is
 *     over" is one whose reply can prevent the turn from being over.
 *
 * ## What `noDecision: 'blocks'` is saying, and what it cannot say
 *
 * {@link NoDecisionBehavior} has three members: the agent proceeds, it waits
 * forever, or it waits with a timeout. **agy does none of the three — it
 * refuses.** `blocks` is chosen because it is the only member that makes
 * `describeAbstain(source).safe === false`, which is the decision every caller
 * actually reads, and because refusing is strictly worse than waiting: a wait
 * ends when a human notices, a refusal ends with the agent concluding it has no
 * tools and working around the absence.
 *
 * The gap is real and is reported rather than papered over — `AbstainOutcome`
 * cannot express "abstaining is an active denial", so the summary an operator
 * sees ("the agent waits indefinitely; nothing else will unblock it") is
 * pessimistic in the right direction but wrong about the mechanism. Widening the
 * union belongs to the interface's owner, not to a tool implementation, and no
 * caller does anything different for the fourth case today.
 *
 * ## Why there is no adjudication here yet
 *
 * `encodeVerdict` below is correct and unused. CommandMate registers no
 * `PreToolUse` hook for agy (`./hooks-config` explains at length), because the
 * only delivery mechanism agy has is a relay that writes nothing to stdout, and
 * nothing on stdout is the denial in (1). Auto-Yes over agy therefore stays on
 * the TUI path in this Issue; giving it a hook needs the relay to be able to
 * emit a verdict, which is a change to `scripts/hooks/cmate-agent-event.sh` and
 * out of this Issue's scope.
 *
 * @module lib/hooks/sources/antigravity/source
 */

import { definePushHookSource } from '../define-source';
import { boundDetail, readNestedString } from '../event-mapper';
import type { AgentEventSource, AgentInstanceRef, AgentLaunchPlan } from '../types';
import {
  buildAntigravityLaunchCommand,
  writeAntigravityHooksConfig,
} from './hooks-config';
import { ANTIGRAVITY_CLI_TOOL_ID } from './tool-id';

/**
 * Antigravity as an event source.
 *
 * Registered in `../registry`. Nothing outside this directory imports it by
 * name; callers ask the registry for the tool they are holding.
 */
export const antigravityAgentEventSource: AgentEventSource = definePushHookSource({
  cliToolId: ANTIGRAVITY_CLI_TOOL_ID,

  // #1757 P10. See the module comment for why this member of the union and not
  // another one.
  noDecision: { kind: 'blocks' },

  capabilities: {
    // agy has no `SessionEnd`, no `Notification` and no `UserPromptSubmit` — not
    // "undocumented", *absent*: configuring all three produced zero events
    // across the whole spike. `pre_tool_use` is missing for a different reason
    // again: the event exists and fires, and CommandMate does not register it
    // because it cannot answer it safely.
    supportedEvents: ['session_start', 'post_tool_use', 'stop'],
    configScope: 'global-singleton',
    // The `timeout` written into the handlers. agy's own default is 30s; this is
    // what a decision-bearing hook would actually get if one were ever
    // registered, which is the number a caller budgeting a verdict needs.
    decisionTimeoutSeconds: 5,
  },

  // Empty on purpose, and the only empty mapper list in the codebase. There is
  // nothing in an agy payload to map *from*: no `hook_event_name`, no `type`,
  // no discriminator that is not a guess. `PreToolUse` and `PostToolUse` differ
  // only by a `error` key that is an empty string on success, so inferring the
  // event from field presence would file one as the other and do it silently.
  // The word comes from the relay's `--event`, which reaches `normalizeEvent`
  // as `RawAgentEvent.event` and bypasses this list entirely.
  mappers: [],

  // Nothing to read. An empty list is what makes `definePushHookSource` skip the
  // payload lookup rather than search for a field that is never there.
  nativeEventNameFields: [],

  // protojson camelCase, one tool out of six. `session_id` does not exist here.
  conversationIdFields: ['conversationId'],
  toolCallIdFields: [],

  // The tool name is nested under `toolCall`, and it is present on both
  // `PreToolUse` and `PostToolUse` payloads (checked against both fixtures).
  extractDetail: (event, payload) =>
    event === 'pre_tool_use' || event === 'post_tool_use'
      ? boundDetail(readNestedString(payload, ['toolCall', 'name']))
      : null,

  // agy has no `PermissionRequest` event and no `AskUserQuestion` tool; its
  // approvals ride on `PreToolUse`, which CommandMate does not register.
  parsePermissionRequest: () => null,
  parseQuestion: () => null,

  // **Never `{}`.** Abstention has to be spelled positively here, because the
  // empty object is the denial that stops the agent. `deny` carries its reason
  // because agy shows it to the agent, which is how a refusal becomes something
  // the operator can act on rather than a mystery.
  encodeVerdict: (verdict) =>
    verdict.kind === 'deny'
      ? { decision: 'deny', reason: verdict.message ?? '' }
      : { decision: 'allow' },

  // Unlike gemini, the whole config is reachable from here: the file is global,
  // so no worktree path is needed and `prepareLaunch` really does write it.
  prepareLaunch: (target: AgentInstanceRef, executablePath: string): AgentLaunchPlan => {
    const settingsPath = writeAntigravityHooksConfig();
    return {
      command: buildAntigravityLaunchCommand(executablePath, {
        worktreeId: target.worktreeId,
        instanceId: target.instanceId,
        cliToolId: ANTIGRAVITY_CLI_TOOL_ID,
      }),
      settingsPath,
    };
  },
});
