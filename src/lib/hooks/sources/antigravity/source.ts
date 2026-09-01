/**
 * Antigravity's {@link AgentEventSource} (Issue #1762, Phase 4-4 of Epic #1720;
 * adjudication added by Issue #1779).
 *
 * The tool that does not fit. Four things about agy are different in kind from
 * the other push sources rather than different in spelling, and every one of
 * them is a thing that fails without an error message:
 *
 *  1. **An empty object is a denial.** Everywhere else `{}` means "CommandMate
 *     has no opinion". On agy's `PreToolUse` it means *deny*, and the agent
 *     loses every tool it has (#1757 P10; re-measured on 1.1.12 for #1779, where
 *     it prints `⚠ Tool call denied by pre-tool hook:`). A *timeout* is
 *     fail-open, and so — #1779's correction to #1762 — is a hook that exits 0
 *     having **printed nothing at all**: measured on 1.1.12, that is
 *     indistinguishable from having no hook. "No reply" and "an empty reply" are
 *     opposites here, which is not true of any other tool.
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
 * ## How abstention is spelled, and why `noDecision` says `proceeds` (#1779)
 *
 * #1762 shipped this source with `noDecision: { kind: 'blocks' }` and no
 * `PreToolUse` hook, on the reasoning that abstaining *would* stop the agent if
 * a hook existed, and that `blocks` was the closest member of
 * {@link NoDecisionBehavior} to "it refuses". Both halves of that are now
 * obsolete, because #1779 registered the hook and measured the missing case.
 *
 * agy's own `decision` vocabulary has four words — `allow`, `deny`, `ask`,
 * `force_ask` — and `ask` means *"prompt the user for permission (respects the
 * Always Allow cache)"*, i.e. precisely what abstaining means. Measured live for
 * #1779 against agy 1.1.12 in an isolated `HOME`: a `PreToolUse` hook answering
 * `{"decision":"ask"}` draws agy's ordinary `Do you want to proceed? / 1. Yes …`
 * dialog, the same dialog a hooks-free control run drew.
 *
 * So abstaining on agy costs a dialog and nothing else — `proceeds`, the same
 * value Claude, codex and copilot carry — **provided abstention is spelled
 * `{"decision":"ask"}` and never `{}`.** The declaration and
 * {@link AgentEventSource.encodeVerdict} have to be read together: this field is
 * true *because* of how the verdict below is encoded, and flipping the encoding
 * back to `{}` would make it a lie without changing a character of it.
 *
 * ## What `allow` does and does not buy on this tool
 *
 * Measured for #1779 on agy 1.1.12, interactively: a `PreToolUse` hook
 * answering `{"decision":"allow"}` **does not suppress the approval dialog** —
 * neither on its own nor with `permissionOverrides: ["command(*)"]`. The
 * verdict is encoded honestly all the same, because it is agy's documented
 * spelling of the thing CommandMate means and because `--print` (headless) does
 * honour it (#1757 §5.4.4). Auto-Yes over an interactive agy therefore still
 * lands on the TUI responder, which has answered that dialog since #988. What
 * this source adds is that abstaining is finally *safe*, and that a verdict can
 * be expressed at all.
 *
 * @module lib/hooks/sources/antigravity/source
 */

import {
  MAX_TOOL_NAME_LENGTH,
  type PermissionRequestPayload,
} from '@/lib/hooks/permission-request-payload';
import { definePushHookSource } from '../define-source';
import { boundDetail, isPlainObject, readNestedString, readStringField } from '../event-mapper';
import type {
  AgentEventSource,
  AgentLaunchContext,
  AgentLaunchPlan,
  Verdict,
} from '../types';
import {
  ANTIGRAVITY_PERMISSION_TIMEOUT_SECONDS,
  buildAntigravityLaunchCommand,
  writeAntigravityHooksConfig,
} from './hooks-config';
import { ANTIGRAVITY_CLI_TOOL_ID } from './tool-id';

/**
 * agy's spelling of "no opinion" (Issue #1779).
 *
 * `ask` is documented as *"Prompt the user for permission (respects the Always
 * Allow cache)"*, and measured on 1.1.12 to draw exactly the dialog a hooks-free
 * run draws. **Never `{}`** — see {@link ANTIGRAVITY_ABSTAIN_BODY} in
 * `./hooks-config`, whose string form is this object and must stay in step with
 * it; `encodesTheSameAbstention` in the tests pins the two together.
 */
const ABSTAIN_BODY: Record<string, unknown> = { decision: 'ask' };

/**
 * Read agy's `PreToolUse` payload as a permission request (S7).
 *
 * Was `() => null` until #1779, which was correct while no `PreToolUse` hook
 * existed and is a silent Auto-Yes-is-off switch now that one does: a null
 * payload makes `decidePermissionRequest` answer `unknown-payload`, which is
 * indistinguishable from a working feature with nothing to approve.
 *
 * Nothing here is Claude-shaped. agy's payload is protojson camelCase with the
 * call nested under `toolCall`, has no `hook_event_name` to key off (#1757 R2)
 * and no `prompt_id` of any spelling (R5) — `stepIdx` identifies a step within a
 * conversation and is deliberately not passed off as a prompt id, since the
 * route uses that field to correlate and mints its own when it is absent.
 *
 * Strict for the same reason Claude's and copilot's parsers are: anything
 * unvouchable becomes null, null becomes no-decision, and no-decision on this
 * tool is now a dialog rather than a denial.
 *
 * @param body - Whatever was posted to `/api/hooks/permission-request`
 */
export function parseAntigravityPermissionRequest(
  body: unknown
): PermissionRequestPayload | null {
  if (!isPlainObject(body)) return null;

  const toolCall = body.toolCall;
  if (!isPlainObject(toolCall)) return null;

  const toolName = readStringField(toolCall, 'name');
  if (!toolName || toolName.length > MAX_TOOL_NAME_LENGTH) return null;

  // No arguments means nothing for the deny patterns to be judged against,
  // which makes the request unadjudicatable rather than harmless.
  if (!isPlainObject(toolCall.args)) return null;

  return {
    toolName,
    toolInput: toolCall.args,
    promptId: null,
    sessionId: readStringField(body, 'conversationId'),
    permissionMode: null,
    permissionSuggestions: null,
  };
}

/**
 * Encode a verdict in agy's wire form (S6, #1757 R15).
 *
 * A top-level `decision`, not Claude's `hookSpecificOutput.decision.behavior`
 * and not copilot's `hookSpecificOutput.permissionDecision`. The three
 * measurements this rests on, all taken against 1.1.12 in an isolated `HOME`:
 *
 *  - `{}` → `⚠ Tool call denied by pre-tool hook:`, the tool does not run.
 *    **This is why abstention may never be the empty object.**
 *  - `{"decision":"ask"}` → the ordinary `Do you want to proceed?` dialog.
 *  - `{"decision":"allow"}` → *also* the ordinary dialog, interactively. agy
 *    honours it in `--print` (#1757 §5.4.4) and treats it as "the hook does not
 *    object" in the TUI, where the user is still asked. It is encoded anyway:
 *    it is agy's documented word for what CommandMate means, and a source that
 *    lied about its intent to match one version's behaviour would be wrong the
 *    moment that behaviour changed.
 *
 * `allowAlways` and `answer` collapse to abstention, as they do on copilot:
 * agy's `permissionOverrides` is the only standing-grant form it has, and
 * approving one call is not the same promise as writing a standing rule.
 */
export function encodeAntigravityVerdict(verdict: Verdict): Record<string, unknown> {
  if (verdict.kind === 'allowOnce') return { decision: 'allow' };
  // `reason` is shown to the agent, which is how a refusal becomes something an
  // operator can act on rather than a mystery.
  if (verdict.kind === 'deny') return { decision: 'deny', reason: verdict.message ?? '' };
  return { ...ABSTAIN_BODY };
}

/**
 * Antigravity as an event source.
 *
 * Registered in `../registry`. Nothing outside this directory imports it by
 * name; callers ask the registry for the tool they are holding.
 */
export const antigravityAgentEventSource: AgentEventSource = definePushHookSource({
  cliToolId: ANTIGRAVITY_CLI_TOOL_ID,

  // #1779, measured. Read this together with `encodeVerdict`: abstaining is
  // safe here *because* it is spelled `{"decision":"ask"}`, and would stop every
  // tool call on the machine if it were spelled `{}` (#1757 P10). See the module
  // comment for the measurement that replaced #1762's `{ kind: 'blocks' }`.
  noDecision: { kind: 'proceeds' },

  capabilities: {
    // agy has no `SessionEnd`, no `Notification` and no `UserPromptSubmit` — not
    // "undocumented", *absent*: configuring all three produced zero events
    // across the whole spike.
    //
    // `pre_tool_use` is missing for a different reason again, and it is the same
    // reason copilot omits it (`copilot/source.ts`): the event fires and is
    // registered, but it is pointed at `/api/hooks/permission-request`, which
    // adjudicates and does not record. Nothing ever files a `pre_tool_use`
    // NormalizedAgentEvent for agy, and this list is a promise about what does —
    // a caller waiting for a word it names waits for good.
    supportedEvents: ['session_start', 'post_tool_use', 'stop'],
    configScope: 'global-singleton',
    // What the adjudication hook actually gets: agy's own default is 30s, the
    // handler is written with a 5s `timeout`, and the `curl` inside it gives up
    // at 4s so that CommandMate rather than agy decides what a slow server
    // means. The number a caller budgeting a verdict needs is the outer one.
    decisionTimeoutSeconds: ANTIGRAVITY_PERMISSION_TIMEOUT_SECONDS,
    // Issue #1924, §4 D3. agy registers a permission hook, but CommandMate is
    // the adjudicator on it rather than a forecaster: the reply IS the decision
    // (see the module comment on encodeVerdict), so a non-allow answer is not a
    // prediction that agy will now ask a human.
    permissionHookPredictsDialog: false,
    // Not audited. Default = Claude's current behaviour.
    sessionStartMayArriveLate: false,
    permissionReplyReleasesPrompt: false,
    eventIdentity: null,
    resync: 'none',
    // Issue #2197. Nobody but the screen scraper records antigravity replies.
    transcriptHistory: null,
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

  // Issue #1783. protojson camelCase again: `modelName`, not `model`. Present on
  // all six captured fixtures, so agy is the one tool whose model survives every
  // kind of event — including the ones that carry no session id at all.
  modelFields: ['modelName'],

  // The tool name is nested under `toolCall`, and it is present on both
  // `PreToolUse` and `PostToolUse` payloads (checked against both fixtures).
  extractDetail: (event, payload) =>
    event === 'pre_tool_use' || event === 'post_tool_use'
      ? boundDetail(readNestedString(payload, ['toolCall', 'name']))
      : null,

  // agy has no `PermissionRequest` event; its approvals ride on `PreToolUse`,
  // which #1779 registers against its own receiver.
  parsePermissionRequest: parseAntigravityPermissionRequest,
  // No `AskUserQuestion` tool and nothing shaped like one.
  parseQuestion: () => null,

  encodeVerdict: encodeAntigravityVerdict,

  // Unlike gemini, the whole config is reachable from here: the file is global,
  // so no worktree path is needed and `prepareLaunch` really does write it.
  prepareLaunch: ({ target, executablePath }: AgentLaunchContext): AgentLaunchPlan => {
    const settingsPath = writeAntigravityHooksConfig();
    // #1846: the two correlation URLs are the plan's `env`. `worktreePath` is
    // in the context now and deliberately unused here — agy's config is one
    // file for the machine, so there is nothing per-worktree to write.
    const { command, env } = buildAntigravityLaunchCommand(executablePath, {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId,
      cliToolId: ANTIGRAVITY_CLI_TOOL_ID,
    });
    return { command, settingsPath, env };
  },
});
