/**
 * Gemini CLI's hook vocabulary — its event spellings and its subtype values
 * (Issue #1762).
 *
 * Kept here rather than added to `../hook-event-vocabulary`, which is
 * deliberate and is spelled out in `docs/design/agent-event-source-interface.md`
 * §5: that table is *the CamelCase dialect Claude, codex and copilot share*, and
 * putting `BeforeTool` in it would make every one of those tools accept a
 * spelling none of them ever sends. The fact that no gemini session has ever
 * emitted `Stop` is information, and merging the tables destroys it.
 *
 * ## Where the table comes from
 *
 * The CLI's own migration command. `gemini hooks migrate --from-claude` exists
 * to port a Claude `settings.json` across, so the map it carries is gemini's
 * authoritative statement of "this Claude event is that gemini event" (#1757
 * §5.3.1). Confirmed against the shipped bundle's `HookEventName` enum in
 * v0.55.1, which lists eleven events:
 *
 * ```
 * BeforeTool  AfterTool  BeforeAgent  Notification  AfterAgent  SessionStart
 * SessionEnd  PreCompress  BeforeModel  AfterModel  BeforeToolSelection
 * ```
 *
 * Four of them have no word in `AGENT_EVENT_TYPES` and are deliberately absent
 * below: `PreCompress`, `BeforeModel`, `AfterModel` and `BeforeToolSelection`
 * are real gemini events (`PreCompress` and `BeforeModel` were captured live in
 * #1757) that mean nothing CommandMate models. They map to null, get counted by
 * `recordUnknownEvent`, and are not filed under something adjacent.
 *
 * @module lib/hooks/sources/gemini/event-vocabulary
 */

import type { AgentEventType } from '@/lib/hooks/agent-event-types';
import { boundDetail, readStringField } from '../event-mapper';
import { extractSnakeCaseEventDetail } from '../hook-event-vocabulary';

/**
 * `hook_event_name` values gemini sends, mapped onto the seven words.
 *
 * Four of the seven are spelled differently from Claude's — `BeforeAgent`,
 * `AfterAgent`, `BeforeTool`, `AfterTool` — which is the whole reason a source
 * carries its own mappers. `SubagentStop` has no gemini counterpart (the CLI
 * has no subagents; `migrate` folds it onto `AfterAgent`), so it is absent.
 */
export const GEMINI_HOOK_EVENT_NAMES: Readonly<Record<string, AgentEventType>> = {
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  BeforeAgent: 'user_prompt_submit',
  AfterAgent: 'stop',
  BeforeTool: 'pre_tool_use',
  AfterTool: 'post_tool_use',
  Notification: 'notification',
};

/**
 * gemini's only notification subtype, and the word CommandMate spells it with.
 *
 * The value is read out of the shipped bundle: `NotificationType` has exactly
 * one member, `ToolPermission`, and `fireNotificationEvent` puts it on the wire
 * verbatim as `notification_type` (v0.55.1). It means precisely what Claude's
 * `permission_prompt` means — a tool is asking for approval and a dialog is on
 * screen.
 *
 * **The translation is not cosmetic.** `status-mapping.ts` and
 * `agent-event-state.ts` compare `detail` against the literal string
 * `permission_prompt`; #1759 abstracted the event *names* but left the subtype
 * vocabulary shared and Claude-shaped. Publishing `ToolPermission` would
 * therefore be publishing a subtype nothing downstream recognises, and gemini
 * would never report `waiting` — silently, with the event arriving and being
 * recorded correctly the whole time. Translating here is the one place that can
 * fix it without either editing a tool-agnostic consumer to know a tool's
 * dialect, or teaching the shared table a gemini spelling.
 */
export const GEMINI_NOTIFICATION_SUBTYPES: Readonly<Record<string, string>> = {
  ToolPermission: 'permission_prompt',
};

/**
 * The subtype for a gemini payload, in CommandMate's vocabulary.
 *
 * gemini's payload is Claude-shaped snake_case — verified field by field
 * against the bundle's per-event input builders (`source` on `SessionStart`,
 * `reason` on `SessionEnd`, `tool_name` on `BeforeTool`/`AfterTool`,
 * `notification_type` on `Notification`) — so the shared extractor does the
 * reading. Only `notification` needs translating afterwards.
 *
 * An unrecognised notification type is passed through rather than dropped: a
 * type gemini adds later is worth recording under its own name, and nothing
 * downstream branches on a value it does not know.
 *
 * @param event - The word this payload mapped to
 * @param payload - The event, verbatim
 * @returns The subtype, or null when the event has none
 */
export function extractGeminiEventDetail(
  event: AgentEventType,
  payload: Record<string, unknown>
): string | null {
  if (event !== 'notification') return extractSnakeCaseEventDetail(event, payload);

  const native = readStringField(payload, 'notification_type');
  if (native === null) return null;
  return boundDetail(GEMINI_NOTIFICATION_SUBTYPES[native] ?? native);
}
