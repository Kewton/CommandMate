/**
 * Command Code's {@link AgentEventSource} (Issue #2251, Epic #2249 Phase B).
 *
 * The seventh source, and the one that looks most like Claude while being
 * unable to do the one thing Claude's shape is usually reached for. Everything
 * below was measured against **v1.40.1**: the hook payloads in
 * `tests/fixtures/hooks/command-code/` are verbatim captures, and the claims
 * about what the tool *accepts* come from its bundled `dist/cli.mjs`, which is
 * the only complete statement of its own validators (`--help` lists three
 * permission modes where the bundle lists five — Phase A found the same thing).
 *
 * ## Four events, and the absences are refusals rather than silences
 *
 * `supportedEvents` is `session_start` / `pre_tool_use` / `post_tool_use` /
 * `stop`. `user_prompt_submit`, `notification` and `session_end` are not
 * "undocumented" or "unobserved" — Command Code's `isHookEvent` tests a literal
 * `["PreToolUse","PostToolUse","Stop","SessionStart"]`, and its loader prints
 * `unknown hook event "SessionEnd" — skipped` for anything else. That is a
 * stronger statement than antigravity's, where the three missing words were
 * merely never seen to fire, and it is why {@link COMMAND_CODE_HOOK_EVENT_NAMES}
 * is a four-row table of its own rather than the shared
 * `CAMEL_CASE_HOOK_EVENT_NAMES`: a hand-configured hook from #1549 *cannot* send
 * a fifth word here, so mapping one would be mapping a spelling the tool
 * refuses to load.
 *
 * ## `parsePermissionRequest` is `() => null`, and that is the measurement
 *
 * Command Code fires `PreToolUse` **after** the approval dialog has been
 * answered. Measured on the same tool call: dialog drawn at 00:11:37, answered
 * at 00:11:46, `PreToolUse` delivered at 00:11:46. So the reply cannot forecast
 * a dialog (there is nothing left to forecast), cannot dismiss one (it is
 * already gone), and `deriveBlockFromOutput` in the bundle reads only
 * `permissionDecision: "deny"` from it — `"allow"` is not a word this event
 * understands. Auto-Yes therefore stays on Phase A's TUI number responder
 * (`detection-evidence-config` has this tool on `legacy`), and `pre_tool_use` is
 * registered as an ordinary observation instead of being pointed at
 * `/api/hooks/permission-request` the way copilot's and antigravity's are.
 * Epic #2249 決定 3.
 *
 * That is also why this source's `pre_tool_use` **is** in `supportedEvents`
 * where copilot's and antigravity's are not: the field means *delivered*, and on
 * those two tools the event is answered by the adjudicating receiver and never
 * recorded. Here it reaches the event store like any other frame.
 *
 * ## `{}` continues, on all four
 *
 * Measured live with a hook that printed exactly `{}` for every event: both tool
 * calls ran and both turns ended. The bundle agrees — an empty object carries
 * none of the fields `deriveBlockFromOutput` looks for, and `resolveHookExit`
 * only blocks on `decision: "block"`, `block: true`, `permissionDecision:
 * "deny"`, or **exit code 2 on `PreToolUse`/`Stop`**. The relay writes nothing
 * to stdout and exits 0 on every delivery failure, so none of those is reachable
 * from a server that is down.
 *
 * ## Where Phase C picks this up
 *
 * Every payload carries `transcript_path` as an absolute path to
 * `~/.commandcode/projects/<slug>/<session_id>.jsonl`, and the slug is the cwd
 * kebab-cased — so it is *not* computable from the worktree path, which is what
 * makes the hint load-bearing rather than a convenience.
 * {@link readCommandCodeTranscriptPath} is the reader Phase C (#2252) consumes;
 * see its own comment for what this Issue could and could not wire.
 *
 * @module lib/hooks/sources/command-code/source
 */

import type { AgentEventType } from '@/lib/hooks/agent-event-types';
import { definePushHookSource } from '../define-source';
import { fromNameTable, isPlainObject, readFirstStringField } from '../event-mapper';
import { extractSnakeCaseEventDetail, TOOL_CALL_ID_FIELDS } from '../hook-event-vocabulary';
import type { AgentEventSource, AgentLaunchContext, AgentLaunchPlan, Verdict } from '../types';
import {
  buildCommandCodeLaunchEnvironment,
  writeCommandCodeHookSettings,
} from './hooks-config';
import { COMMAND_CODE_CLI_TOOL_ID } from './tool-id';

/**
 * `hook_event_name` values Command Code sends, mapped onto CommandMate's words.
 *
 * A private four-row table rather than `CAMEL_CASE_HOOK_EVENT_NAMES`, and the
 * reason is a refusal rather than a preference. The shared table has seven rows
 * because claude, codex and copilot each emit some superset of four; Command
 * Code's loader validates the event key against a closed list of exactly these
 * four and skips the rest with a warning, so `SessionEnd` / `Notification` /
 * `UserPromptSubmit` / `SubagentStop` are words no Command Code configuration
 * can produce. Mapping them would put four rows in this source that nothing can
 * ever exercise, and would hide the one case that matters: a payload arriving
 * with a fifth spelling means the tool grew an event, and `recordUnknownEvent`
 * is how that gets noticed.
 *
 * Issue #2251 also asked for the converse explicitly: **do not add these
 * spellings to `hook-event-vocabulary.ts`.** Three of the four are already
 * there for the tools that share the dialect; the point is that this source
 * must not widen a table other sources read.
 */
export const COMMAND_CODE_HOOK_EVENT_NAMES: Readonly<Record<string, AgentEventType>> = {
  SessionStart: 'session_start',
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  Stop: 'stop',
};

/**
 * Where Command Code's session id lives.
 *
 * `session_id`, the snake_case spelling claude / codex / copilot / gemini share.
 * Declared as a one-element list rather than reusing `SESSION_ID_FIELDS` because
 * the second entry there is antigravity's `conversationId`, which no Command
 * Code payload has: reading a field the tool never sends is not harmful, but it
 * is a claim about a shape nobody measured.
 */
export const COMMAND_CODE_SESSION_ID_FIELDS = ['session_id'] as const;

/**
 * Where the transcript pointer lives — the `transcriptPathFields` Issue #2251
 * asks for, in the only form the interface has today.
 *
 * `AgentEventSource` has no `transcriptPathFields` and no place to put one that
 * reaches Phase C: `NormalizedAgentEvent` would carry the value fine, but the
 * receiver that turns a normalised event into an `AgentEventRecord`
 * (`src/app/api/hooks/agent-event/route.ts`) is outside this Issue's scope, so a
 * field added to the spec would be extracted and then dropped on the floor —
 * the exact "wiring left hanging" shape a phased Epic invites. So the *reading*
 * half ships here, tested against the real payloads, and #2252 wires it.
 *
 * @see readCommandCodeTranscriptPath
 */
export const COMMAND_CODE_TRANSCRIPT_PATH_FIELDS = ['transcript_path'] as const;

/**
 * Longest transcript path this source will vouch for.
 *
 * The value is a filesystem path the agent chose, and Command Code's own slug is
 * the whole cwd kebab-cased — the captured one is 129 characters for a worktree
 * six levels deep — so the bound has to be generous. It exists to stop an
 * unbounded string being latched, not to judge plausibility.
 */
export const MAX_COMMAND_CODE_TRANSCRIPT_PATH_LENGTH = 4096;

/**
 * Read the transcript pointer out of a Command Code hook payload (Phase C seam).
 *
 * Every one of the seven captured payloads carries it — `SessionStart`, both
 * `PreToolUse`, both `PostToolUse` and both `Stop` — with the same value for the
 * life of the session, so a reader may latch it from whichever event it sees
 * first rather than requiring a particular one.
 *
 * **The path cannot be computed, which is why this exists.** Command Code writes
 * `~/.commandcode/projects/<slug>/<session_id>.jsonl`, where `<slug>` is the cwd
 * with every non-alphanumeric run replaced and camel-case split — the captured
 * pair is `…/MyCodeBranchDesk/…` → `…-my-code-branch-desk-…`. Deriving that from
 * a worktree path would be reimplementing an unpublished function; the hook
 * hands over the answer instead.
 *
 * Strict, in the way this codebase's other payload readers are: anything that is
 * not an absolute path to a `.jsonl` file is null, and null means "no pointer",
 * which is the fail-open that leaves the scraper as the record.
 *
 * @param payload - A Command Code hook payload
 * @returns The absolute transcript path, or null when the payload has none
 */
export function readCommandCodeTranscriptPath(payload: unknown): string | null {
  if (!isPlainObject(payload)) return null;
  const value = readFirstStringField(payload, COMMAND_CODE_TRANSCRIPT_PATH_FIELDS);
  if (value === null) return null;
  if (value.length > MAX_COMMAND_CODE_TRANSCRIPT_PATH_LENGTH) return null;
  // Absolute and `.jsonl`. A relative path would be resolved against whatever
  // cwd the reader happens to have, and a value that is not the transcript is
  // not something to hand a file reader.
  if (!value.startsWith('/') || !value.endsWith('.jsonl')) return null;
  return value;
}

/**
 * Encode a verdict for Command Code (S6).
 *
 * Always the empty object, and that is a measurement rather than a stub. There
 * is no event on this tool whose reply is a permission decision CommandMate
 * could make:
 *
 *  - `PreToolUse` arrives after the human has already answered, so `allowOnce`
 *    would be an approval of something that is already approved. The bundle
 *    reads only `hookSpecificOutput.permissionDecision: "deny"` from it, so the
 *    one thing this source *could* say there is the one thing
 *    `permission-decision-service` never emits (a denial takes the choice away
 *    from the human in the direction waiting cannot undo).
 *  - `PostToolUse` and `Stop` accept a top-level `decision: "block"`, which is
 *    "redo this" rather than a permission verdict, and answering it would make
 *    the turn not end.
 *
 * `{}` is the measured no-op on all four events — the live probe's hook printed
 * exactly that and both tool calls ran and both turns ended — so abstention is
 * free here, the same way it is on claude, codex and copilot, and unlike
 * antigravity where `{}` is a denial.
 */
export function encodeCommandCodeVerdict(_verdict: Verdict): Record<string, unknown> {
  return {};
}

/**
 * Command Code as an event source.
 *
 * Registered in `../registry`. Nothing outside this directory imports it by
 * name; callers ask the registry for the tool they are holding.
 */
export const commandCodeAgentEventSource: AgentEventSource = definePushHookSource({
  cliToolId: COMMAND_CODE_CLI_TOOL_ID,

  // Measured: a hook printing `{}` left both tool calls running and both turns
  // ending, indistinguishable from a session with no hooks configured.
  noDecision: { kind: 'proceeds' },

  capabilities: {
    // The four the tool's own `isHookEvent` accepts, and nothing else. See the
    // module comment for why the three absences are refusals rather than gaps,
    // and why `pre_tool_use` is present here when copilot's and antigravity's
    // are not.
    supportedEvents: ['session_start', 'pre_tool_use', 'post_tool_use', 'stop'],
    // `<worktree>/.commandcode/settings.local.json`. The second tool after
    // gemini whose hook configuration scopes naturally to a worktree — and the
    // first whose tool *also* reads two other layers and unions all three, so
    // occupying one layer cannot displace the operator's own.
    configScope: 'per-worktree',
    // No event on this tool waits for a verdict CommandMate could give: the one
    // approval-shaped event fires after the human has answered. `null` is the
    // honest value — not "waits forever" but "there is nothing to wait for".
    // gemini declares the same for the same reason.
    decisionTimeoutSeconds: null,
    // Issue #1924, §4 D3. No permission hook is registered, so there is nothing
    // to forecast from — gemini's row, not claude's.
    permissionHookPredictsDialog: false,
    // Measured: `SessionStart` is delivered at startup, before anything has been
    // typed (`source: "startup"`, 00:09:55 against a first prompt at 00:10:0x).
    // copilot is still the only tool where it trails the turn it belongs to.
    sessionStartMayArriveLate: false,
    // A hook response body releases nothing observable, as on every push source.
    permissionReplyReleasesPrompt: false,
    // `tool_use_id` is present on both tool events (`call_00_…`) and absent from
    // `SessionStart` and `Stop`, so there is no id covering the frames dedup has
    // to cover. The time window stays. Extraction is declared below regardless,
    // because `toolCallId` on a normalised event is worth having even when it
    // cannot be the dedup key.
    eventIdentity: null,
    // push. There is no connection to lose and nothing to re-read.
    resync: 'none',
    // Phase C (#2252) flips this to `'pull'` when the reader for
    // `~/.commandcode/projects/<slug>/<session_id>.jsonl` lands. Until then the
    // scraped pane is the only record, and `structured-history-gate` must not be
    // sent looking for a reader that does not exist.
    transcriptHistory: null,
  },

  // The four-row private table. See COMMAND_CODE_HOOK_EVENT_NAMES.
  mappers: fromNameTable(COMMAND_CODE_HOOK_EVENT_NAMES),

  nativeEventNameFields: ['hook_event_name'],
  conversationIdFields: COMMAND_CODE_SESSION_ID_FIELDS,
  toolCallIdFields: TOOL_CALL_ID_FIELDS,

  // Issue #1783: no `model` key on any captured payload. The field is omitted
  // rather than declared empty, so a normalised event carries `model: null` —
  // a fact, not a gap. What the pane shows (`# models: … · taste-1`) is Phase
  // A's banner extraction, which is a different channel.

  // `tool_name` on the two tool events (`shell_command` / `write_file` /
  // `read_file` / `edit_file`), `source` on `SessionStart` (`startup`). Both are
  // the snake_case spellings the shared extractor already reads; `Stop` has no
  // subtype and answers null. `tool_display_name` (`SHELL` / `WRITE`) is
  // deliberately not used — it is a label for the tool's own UI, and the detail
  // is what a matcher and an operator's grep are tested against.
  extractDetail: extractSnakeCaseEventDetail,

  // Epic #2249 決定 3. `PreToolUse` fires after the dialog is answered, so there
  // is no permission request here to parse — see the module comment. Returning
  // null makes `decidePermissionRequest` answer `unknown-payload`, which is the
  // correct outcome for an event that is not an approval gate.
  parsePermissionRequest: () => null,
  // No `AskUserQuestion` tool and nothing shaped like one: the captured
  // `tool_name` values are the four file/shell primitives.
  parseQuestion: () => null,

  encodeVerdict: encodeCommandCodeVerdict,

  // S3 / S4 / S5. The config is per-worktree, so the whole of it is reachable
  // from here — `worktreePath` is on the context since #1846, which is what
  // removed gemini's second entry point.
  prepareLaunch: ({ target, executablePath, worktreePath }: AgentLaunchContext): AgentLaunchPlan => {
    const settingsTarget = {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId,
      cliToolId: COMMAND_CODE_CLI_TOOL_ID,
    };
    const settingsPath = writeCommandCodeHookSettings(worktreePath, settingsTarget);
    // #1846: the correlation URL is the plan's `env`, never a `NAME=value `
    // prefix on `command`. The file is per-worktree and cannot tell
    // `command-code` from `command-code-2`, so the instance has to ride here.
    const { command, env } = buildCommandCodeLaunchEnvironment(executablePath, settingsTarget);
    return { command, settingsPath, env };
  },
});
