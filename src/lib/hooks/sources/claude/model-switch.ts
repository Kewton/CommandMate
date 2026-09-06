/**
 * Claude Code's `PostModelSwitch` hook, as CommandMate reads it (Issue #2363).
 *
 * #2361 detected a `/model` switch off the pane, because the seven events
 * CommandMate registered never mentioned it: Claude names its model on
 * `SessionStart` and on nothing else. The same probe found the build emitting
 * a pair of dedicated hooks, and this module is the structured half of the
 * answer — the frame reader stays as the fallback (see
 * `lib/session/agent-event-state`'s `FRAME_OVERTAKES_HOOK_MODEL_TOOLS`).
 *
 * ## Measured on claude 2.1.263 (2026-09-06, isolated `CLAUDE_CONFIG_DIR`)
 *
 * Re-taken for this Issue rather than inherited from #2361, whose numbers were
 * a by-product. Payload, delivered verbatim by a `type: "http"` hook injected
 * through `--settings` — the same channel every other event here uses:
 *
 * ```json
 * {
 *   "session_id": "…", "transcript_path": "…", "cwd": "…", "prompt_id": "…",
 *   "hook_event_name": "PostModelSwitch",
 *   "from_model": "claude-haiku-4-5-20251001",
 *   "to_model": "claude-sonnet-5",
 *   "requested_model": "sonnet",
 *   "source": "command",
 *   "context_tokens": 0, "prompt_cache_warm": false, "cache_ttl": "5m",
 *   "estimated_cache_write_usd": 0, "pricing": "catalog"
 * }
 * ```
 *
 *  - **`to_model` is the model id in the `SessionStart` spelling** —
 *    `claude-sonnet-5`, `claude-haiku-4-5-20251001`, `claude-opus-5`,
 *    `claude-opus-5[1m]` — so the latch in `agent-event-state` compares like
 *    with like, and the `[1m]` suffix travels with it.
 *  - **`/fast` is a switch**: ON from Haiku reported `to_model:
 *    "claude-opus-5[1m]"`, `requested_model: null`, `source: "command"`. That
 *    is the fix for the spelling drift #2361 refused to read (the confirmation
 *    line says `Opus 5`, the banner `Opus 5 (1M context)`): the hook spells it
 *    the one way. `/fast` OFF fires nothing and the model stays on Opus.
 *  - **`requested_model` is null** for `/model default` (→ `claude-opus-5[1m]`)
 *    and for `/fast`, and is the user's alias (`sonnet`) otherwise. Never read.
 *  - **`source`** is `command` for `/model <arg>` and `/fast`, `picker` for the
 *    interactive list (measured with `s`). The schema also names `sdk`, `auto`
 *    and `resume`; none were reproducible. Not read.
 *  - **Nothing fires when the model does not change**: `/model haiku` while on
 *    Haiku, `/fast` while already on Opus 1M, the picker's `Esc` (`Kept model
 *    as`), and `/effort` all stay silent. `/clear` emits its usual
 *    `SessionEnd` + `SessionStart` (no `model` key) and no switch.
 *  - **There is no `model` key on this event.** The generic `modelFields:
 *    ['model']` lookup answers null for it, which is why the extraction below
 *    exists rather than a second entry in that list.
 *
 * ## Why `from_model` is never read
 *
 * It is the model the session was on BEFORE the switch. Reading it as "the
 * model" would move the latch backwards on the very event that reports a
 * forward move. It is also the field the paired `PreModelSwitch` got wrong:
 * in the probe's second session that hook fired **twice per switch**, and on
 * `/fast` the second of the two named `from_model: "claude-sonnet-5"` for a
 * session that was on Haiku (`PostModelSwitch` fired once, and agreed with
 * the screen, every time).
 *
 * ## Why `PreModelSwitch` is not registered
 *
 * Three measured reasons. It is a decision hook — its response body can block
 * or redirect the switch — and the event receiver answers a fixed 202 that
 * decides nothing, so registering it would put a blocking round-trip (5 s at
 * worst, on a wedged server) in front of every `/model` for no information.
 * It fired twice per switch with inconsistent values (above). And its
 * `to_model` is the request, not the outcome — the second of that pair on
 * `/model haiku` said `to_model: "claude-sonnet-5"`; `PostModelSwitch` alone
 * is the event that says what happened. The Issue leaves this to
 * implementation judgement, and this is it.
 *
 * ## Which of the seven words
 *
 * `notification`, with a subtype of its own ({@link modelSwitchDetail}). A
 * model switch is the agent telling the human something and is neither a turn
 * boundary nor a tool call; `agent-event-state` treats a `notification` whose
 * subtype it does not recognise as evidence of nothing (no status, no dialog,
 * no turn), and `status-mapping` answers null for it — measured behaviour, not
 * a hope. The one thing every event does is run the model latch, and that is
 * the whole point of delivering this one.
 *
 * @module lib/hooks/sources/claude/model-switch
 */

import type { EventMapper } from '../event-mapper';
import { readStringField } from '../event-mapper';

/** Claude's own name for the event; the key written into `--settings`. */
export const CLAUDE_POST_MODEL_SWITCH_EVENT_NAME = 'PostModelSwitch';

/**
 * The paired decision hook, which is deliberately NOT registered — see the
 * module comment. Named here so the test that pins its absence from the
 * injected settings spells it the way this module does.
 */
export const CLAUDE_PRE_MODEL_SWITCH_EVENT_NAME = 'PreModelSwitch';

/**
 * The subtype a switch is filed under (Issue #2363).
 *
 * A word of CommandMate's own, beside Claude's `permission_prompt` /
 * `idle_prompt` on the same event. Nothing branches on it — the model rides on
 * the normalised event's `model`, not on the subtype — but two things read it:
 * `structuredEvents.lastEventDetail` shows it, and the receiver's
 * de-duplication key carries it. See {@link modelSwitchDetail} for why the
 * target model is appended.
 */
export const MODEL_SWITCH_DETAIL = 'model_switch';

/** The payload key that names the model the session is now on. */
const TO_MODEL_FIELD = 'to_model';

/**
 * `model_switch:<to_model>`, or the bare word when the switch names no target.
 *
 * The target is part of the subtype because the subtype is part of the
 * receiver's de-duplication key: `(instance, event, detail, session_id)` within
 * a 3 s window (`isDuplicateAgentEvent`). With a fixed word, two switches to
 * DIFFERENT models inside that window — the picker's `s` followed by `/fast`,
 * a `/model` typed twice to correct itself — would collapse into one and the
 * second target would be lost until the frame caught up. With the target in
 * the key, only a second delivery of the SAME switch collapses, which is the
 * case the window exists for (a user's own `PostModelSwitch` hook is
 * concatenated with the injected one, and both name the same `to_model`).
 */
export function modelSwitchDetail(toModel: string | null): string {
  return toModel === null ? MODEL_SWITCH_DETAIL : `${MODEL_SWITCH_DETAIL}:${toModel}`;
}

/** Whether a recorded `detail` is one this module wrote, target or no target. */
export function isModelSwitchDetail(detail: string | null | undefined): boolean {
  return detail === MODEL_SWITCH_DETAIL || (detail?.startsWith(`${MODEL_SWITCH_DETAIL}:`) ?? false);
}

/** True for the one native event this module speaks for. */
export function isClaudeModelSwitchPayload(payload: Record<string, unknown>): boolean {
  return readStringField(payload, 'hook_event_name') === CLAUDE_POST_MODEL_SWITCH_EVENT_NAME;
}

/**
 * The rule that maps `PostModelSwitch` onto `notification(model_switch:<to_model>)`.
 *
 * Appended after the shared CamelCase table in `./source`, so every spelling
 * that table already claims keeps its word.
 */
export const claudeModelSwitchMapper: EventMapper = (nativeEventName, payload) =>
  nativeEventName === CLAUDE_POST_MODEL_SWITCH_EVENT_NAME
    ? {
        event: 'notification',
        detail: modelSwitchDetail(readStringField(payload, TO_MODEL_FIELD)),
      }
    : null;

/**
 * The model a `PostModelSwitch` reports, or null for any other payload.
 *
 * `to_model` and only `to_model`: `from_model` is the value being left behind
 * and `requested_model` is an alias that is null for `/model default` and
 * `/fast`. Answers null for a switch that somehow carries no `to_model`, which
 * the caller (`buildNormalizedEvent`) turns into "this event names no model"
 * — the latch is left where it was rather than blanked or reversed.
 *
 * Declared as the source's `extractModel`, which runs before the flat
 * `modelFields` lookup; for every other event it answers null and the lookup
 * proceeds exactly as it did before this Issue.
 */
export function extractClaudeSwitchedModel(payload: Record<string, unknown>): string | null {
  if (!isClaudeModelSwitchPayload(payload)) return null;
  return readStringField(payload, TO_MODEL_FIELD);
}
