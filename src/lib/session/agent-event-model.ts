/**
 * Which model and effort an agent instance is on: the hook latch, the frame
 * latch, the reported effort, their precedence, and the model-change edge.
 *
 * Split out of `agent-event-state` (Issue #3375), which re-exports the public
 * names.
 *
 * @module lib/session/agent-event-model
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { MAX_EVENT_DETAIL_LENGTH } from '@/lib/hooks/agent-event-types';
// Issue #1784: the terminal-frame half of "which model / effort is this on".
import { mergeModelInfo, type ModelInfo } from '@/lib/detection/model-info-extractor';
import type { AgentEventRecord } from '@/lib/session/agent-event-record';
import { MAX_RECENT_EVENT_KEYS, trimOldestEntries } from '@/lib/session/agent-event-dedup';
import { getOrInitGlobal } from '../global-state';

// The maps below live on `globalThis`; see the note above `declare global` in
// `agent-event-state` for why (Issue #1736).
declare global {
  // eslint-disable-next-line no-var
  var __agentEventLastModel: Map<string, string> | undefined;
  // eslint-disable-next-line no-var
  var __agentEventLastModelAt: Map<string, number> | undefined;
  // eslint-disable-next-line no-var
  var __agentCapturedModelInfo: Map<string, CapturedModelRecord> | undefined;
  // eslint-disable-next-line no-var
  var __agentEventLastEffort: Map<string, string> | undefined;
  // eslint-disable-next-line no-var
  var __agentModelBaseline: Map<string, AgentModelBaseline> | undefined;
  // eslint-disable-next-line no-var
  var __agentModelChangeListeners: Set<AgentModelChangeListener> | undefined;
}

/**
 * compositeKey -> the last non-null model this instance reported (Issue #1783).
 *
 * A *separate* map, not a field read off {@link lastAgentEvent}, and that is the
 * whole point of it. `lastAgentEvent` is replaced wholesale on every delivery,
 * and Claude puts the model on `SessionStart` and on a `PostModelSwitch`
 * (Issue #2363) and on nothing else — so the very next `UserPromptSubmit` would
 * overwrite the only record that ever knew it, and
 * the UI would show the model for the fraction of a second between session start
 * and the first prompt. Keeping the last *non-null* sighting separately is what
 * makes "which model is this session on" answerable at all for that tool.
 *
 * Never written with null: absent means "nothing has ever said", which is the
 * honest state for gemini, copilot, and any session that predates this server
 * process. See {@link getLastKnownAgentModel}.
 */
export const lastAgentModel = getOrInitGlobal('__agentEventLastModel', () => new Map<string, string>());

/**
 * compositeKey -> epoch ms of the report that last wrote {@link lastAgentModel}
 * (Issue #2361).
 *
 * Kept so the frame can be judged NEWER than the hook. When #2361 was measured
 * on 2.1.263, Claude named its model on `SessionStart` and on nothing
 * CommandMate registered — `/model` fired none of the seven events, and the
 * `SessionStart` a `/clear` emits carries no `model` key — so after a switch
 * the hook latch was a true statement about a process that had since changed
 * its mind, and the screen was the only channel that heard it. Issue #2363
 * registers `PostModelSwitch`, which re-stamps this on every switch; the stamp
 * now matters for the sessions where that hook does not arrive. See
 * {@link resolveAgentModel}.
 */
export const lastAgentModelAt = getOrInitGlobal('__agentEventLastModelAt', () => new Map<string, number>());

/**
 * What {@link capturedModelInfo} holds per instance (Issue #2361).
 *
 * `ModelInfo` plus when the model half last CHANGED — not when it was last
 * seen. The poll re-reads a banner that is still on screen every two seconds,
 * so "last seen" would make every frame newer than every hook; "last changed"
 * moves only when the pane starts saying something different, which is the
 * one event that can mean a switch.
 */
interface CapturedModelRecord extends ModelInfo {
  /** Epoch ms the `model` half last took a different value, or null while it has none. */
  modelChangedAt: number | null;
}

/**
 * compositeKey -> what the terminal frame last showed for this instance (#1784).
 *
 * The second source, and a strictly different kind of fact from
 * {@link lastAgentModel}: that one is the agent naming itself over the hook
 * channel, this one is the TUI's own chrome read back off the screen. It is
 * kept apart rather than folded into the first map because the two have a
 * precedence between them ({@link getResolvedAgentModelInfo}) — merging on write
 * would let a scraped display name ("Gemini 3.7 Flash") overwrite the exact id
 * the agent reported, with nothing left to recover it from.
 *
 * Latched the same way and for a sharper reason: Claude prints its model in the
 * startup banner and nowhere else, and tmux keeps 2000 lines of history, so on
 * any session that has been talking for a while the banner is simply gone. The
 * screen going quiet is not the model changing, so the last non-null sighting
 * stands until the process it described does not (see
 * {@link beginAgentEventGeneration} / {@link discardAgentEventState}).
 */
export const capturedModelInfo = getOrInitGlobal('__agentCapturedModelInfo', () => new Map<string, CapturedModelRecord>());

/**
 * compositeKey -> the effort the *agent itself* last reported (Issue #2048).
 *
 * The third source, and until #2048 there was no such thing: #1784's whole
 * premise was that "no hook payload of any tool carries an effort field", which
 * was true of the five push tools and stayed true of opencode's own screen —
 * `model-info-extractor` still records that opencode prints no effort anywhere
 * in its pane, across 17 live frames.
 *
 * What changed is the *channel*, not the screen. opencode calls it a **variant**
 * and publishes it on the frames CommandMate is subscribed to —
 * `Session.model.variant` on `session.updated` and `info.variant` on
 * `message.updated`, measured on 1.18.22 in an isolated `HOME`
 * (`docs/design/opencode-server-live-verification.md` §20.4). The names in that
 * catalogue are `low` / `medium` / `high` / `max` / `minimal` / `none` /
 * `xhigh`, and each one's entry carries an `effort` (or `reasoningEffort`) equal
 * to itself — so the value is an effort in opencode's own vocabulary as well as
 * in this map's.
 *
 * Kept apart from {@link capturedModelInfo} for the reason that map is kept
 * apart from {@link lastAgentModel}: there is a precedence between them
 * ({@link getResolvedAgentModelInfo}), and merging on write would lose it.
 * Latched the same way, and never written with null — a turn that reports no
 * variant is opencode running the model's default, not the previous choice
 * being withdrawn.
 */
export const reportedEffort = getOrInitGlobal('__agentEventLastEffort', () => new Map<string, string>());

// =============================================================================
// Model change detection (Issue #2357)
// =============================================================================

/** Which channel a model value arrived on. See {@link AgentModelChange.source}. */
export type AgentModelSource = 'hook' | 'frame';

/**
 * The resolved model this instance was last seen on, and which channel put it
 * there (Issue #2357).
 *
 * "Resolved" is {@link getResolvedAgentModelInfo}'s answer — the hook value when
 * one has arrived, the scraped frame otherwise — so this is the value the UI and
 * `capture --json` publish, not either raw latch. The source is kept beside it
 * because the two channels spell the same model differently (agy reports
 * `gemini-3.7-flash-high` and prints `Gemini 3.7 Flash`), and a comparison that
 * did not know it was crossing channels would announce a change every time the
 * hook overtook the screen. See {@link isSameAgentModelName}.
 */
export interface AgentModelBaseline {
  model: string;
  source: AgentModelSource;
}

/** One model transition of one instance — the `model_changed` event's payload. */
export interface AgentModelChange {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Always resolved (`instanceId ?? cliToolId`), so a listener can key on it directly. */
  instanceId: string;
  /** The model the instance was on. Never null: `null → value` is not a change. */
  from: string;
  /** The model it is on now. Never null: `value → null` is not a change either. */
  to: string;
  /** Which channel reported the new value. */
  source: AgentModelSource;
  /** Epoch ms of the report that carried the new value. */
  at: number;
}

export type AgentModelChangeListener = (change: AgentModelChange) => void;

/**
 * compositeKey -> the model this instance was last observed on (Issue #2357).
 *
 * A *fourth* map beside the three latches rather than a comparison against
 * them, because the latches are what they are for a reason: each remembers the
 * last non-null value its channel produced, and none of them can say "and the
 * value before that". This map holds exactly that — the previous answer of
 * {@link getResolvedAgentModelInfo} — so a write to either latch can be judged
 * as "same model", "first sighting" or "changed" without re-deriving history
 * from maps that never kept it.
 *
 * Cleared wherever the latches are cleared (generation, discard, test seam) and
 * on `session_start`, so the first model a new agent process reports is
 * recorded as its starting model and announced to nobody.
 */
export const modelBaseline = getOrInitGlobal('__agentModelBaseline', () => new Map<string, AgentModelBaseline>());

/**
 * Listeners for the model edge, on `globalThis` for the reason the maps above
 * are: under `next dev` each route bundle evaluates this module once, and the
 * hook route (which writes the hook latch) and the status poll (which writes
 * the frame latch) are different bundles. A module-scoped set would let each
 * bundle notify only the listeners registered in the same bundle — which is
 * none, for the one that receives the hook.
 */
const modelChangeListeners = getOrInitGlobal('__agentModelChangeListeners', () => new Set<AgentModelChangeListener>());

/**
 * A trailing reasoning-effort token in a model id (`gemini-3.7-flash-high`).
 *
 * The same five words `model-info-extractor` recognises, matched only at the
 * very end and only after a separator, so `gpt-5-mini` keeps its `mini` and a
 * model that merely ends in these letters is untouched. agy encodes the effort
 * in the id it reports on every event (`deriveEffortFromModelId`), and a user
 * moving the same model from `high` to `low` has not changed model.
 */
export const AGENT_MODEL_EFFORT_SUFFIX_PATTERN = /[-_ ](?:minimal|low|medium|high|xhigh)$/i;

/**
 * Tokens a display label carries that the id does not, dropped before comparing.
 *
 * Measured pairs only: claude's banner reads `Opus 5 (1M context)` for the id
 * `claude-opus-5[1m]` — the `1m` is part of the model, the word is not.
 */
const MODEL_LABEL_NOISE_PATTERN = /\bcontext\b/gi;

/** Lowercase alphanumerics, effort suffix and label-only words removed. */
function modelNameKey(value: string): string {
  return value
    .replace(AGENT_MODEL_EFFORT_SUFFIX_PATTERN, '')
    .replace(MODEL_LABEL_NOISE_PATTERN, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Do two model names name the same model? (Issue #2357)
 *
 * Within one channel the answer is exact on alphanumerics — `GPT-5 mini` and
 * `gpt-5-mini` are one model rendered two ways (copilot's bar and its notice,
 * both read off the frame), while `gpt-5` and `gpt-5-mini` are two models and
 * the second is precisely the downgrade this Issue exists to announce. The
 * effort suffix is stripped first, because agy's id carries it and an effort
 * change is not a model change.
 *
 * *Across* channels the rule is widened to containment: the hook reports an
 * id, the screen prints a label, and every measured pair is the label's key
 * inside the id's (`gemini37flash` ⊂ `gemini37flashhigh`, `opus51m` ⊂
 * `claudeopus51m`, `claudesonnet46` ⊂ `anthropicclaudesonnet46`). Containment
 * is NOT applied within a channel — it would fold `gpt-5` into `gpt-5-mini` —
 * and a caller has to say which case it is in.
 *
 * Exported for the tests and for anything that has to agree with this module
 * about identity; deliberately local rather than the extractor's `sameModel`,
 * which is a single-channel exact match and is shared with #2358's edit.
 */
export function isSameAgentModelName(
  a: string,
  b: string,
  options: { crossSource?: boolean } = {}
): boolean {
  const ka = modelNameKey(a);
  const kb = modelNameKey(b);
  if (ka === kb) return true;
  if (!options.crossSource) return false;
  if (ka.length === 0 || kb.length === 0) return false;
  return ka.includes(kb) || kb.includes(ka);
}

/**
 * Subscribe to the model edge (Issue #2357).
 *
 * The listener receives every transition {@link observeAgentModel} judged to be
 * a change — never a first sighting, never a value going quiet. `#2357`'s
 * realtime broadcaster and push notifier are the two subscribers; neither keeps
 * a "what was it last time?" of its own, which is the point of this being an
 * edge rather than a level.
 *
 * @returns The unsubscribe function
 */
export function onAgentModelChange(listener: AgentModelChangeListener): () => void {
  modelChangeListeners.add(listener);
  return () => {
    modelChangeListeners.delete(listener);
  };
}

/** Deliver one change; a listener that throws must not disturb the write that observed it. */
function emitAgentModelChange(change: AgentModelChange): void {
  for (const listener of modelChangeListeners) {
    try {
      listener(change);
    } catch {
      // Advisory. The hook route and the status poll are the callers, and a
      // notification failure is not a reason to fail either.
    }
  }
}

/**
 * The model this instance was last observed on, or null. Test seam.
 */
export function getAgentModelBaseline(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): AgentModelBaseline | null {
  return modelBaseline.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? null;
}

/**
 * Judge the resolved model after a latch wrote, and announce a change
 * (Issue #2357).
 *
 * Called after every write to {@link lastAgentModel} and
 * {@link capturedModelInfo}, with the channel that wrote. What it compares is
 * {@link getResolvedAgentModelInfo}'s *model* — the merged value the UI shows —
 * against the previous merged value this map remembers. The suppression rules,
 * each of which is a measured false positive:
 *
 *  - **`null → value`** (first report, server restart): recorded as the
 *    starting model, announced to nobody.
 *  - **`value → null`**: cannot reach here — the latches never write null, so
 *    a frame that stopped showing the banner leaves the merged value where it
 *    was. A generation reset clears this map along with the latches, so the
 *    next value is a first sighting again.
 *  - **same name, either channel**: `GPT-5 mini` after `gpt-5-mini` is not a
 *    change. Compared with {@link isSameAgentModelName}; the cross-channel
 *    widening applies only when the merged value's source actually moved.
 *  - **`session_start`**: {@link recordAgentEvent} drops the baseline first, so
 *    the model a relaunched process reports is that process's starting model.
 *
 * Everything else is a change and is emitted exactly once — the baseline is
 * advanced before the listeners run, so a listener that re-enters this module
 * cannot see the same edge twice.
 */
export function observeAgentModel(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  source: AgentModelSource,
  at: number
): void {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  // Where the merged value came from is decided in one place
  // (`resolveAgentModel`, Issue #2361): the hook's, unless the frame overtook
  // it — and that is independent of which channel just wrote.
  const { info, source: resolvedSource } = resolveAgentModel(key, cliToolId);
  const resolved = info.model;
  if (resolved === null || resolvedSource === null) return;

  const previous = modelBaseline.get(key);
  const next: AgentModelBaseline = { model: resolved, source: resolvedSource };
  if (previous === undefined) {
    modelBaseline.set(key, next);
    trimOldestEntries(modelBaseline, MAX_RECENT_EVENT_KEYS);
    return;
  }
  if (
    isSameAgentModelName(previous.model, resolved, {
      crossSource: previous.source !== resolvedSource,
    })
  ) {
    // Same model, possibly a new spelling or a new channel: follow it so the
    // next comparison is against the current representation.
    modelBaseline.set(key, next);
    return;
  }

  modelBaseline.set(key, next);
  emitAgentModelChange({
    worktreeId,
    cliToolId,
    instanceId: instanceId ?? cliToolId,
    from: previous.model,
    to: resolved,
    source,
    at,
  });
}

/**
 * Issue #1783: latch, never clear. An event without a model is the ordinary
 * case (Claude sends one on `SessionStart` and, since #2363, on a model
 * switch), and reading it as "the model is now unknown" would blank the display
 * on the very next event.
 */
export function latchAgentModel(key: string, record: AgentEventRecord): void {
  if (typeof record.model === 'string' && record.model !== '') {
    lastAgentModel.set(key, record.model.slice(0, MAX_EVENT_DETAIL_LENGTH));
    // Issue #2361: stamped on every model-bearing report, not only on a change
    // of value — a hook that names the same model again is the agent
    // re-affirming it, and a frame has to be newer than THAT to overtake.
    lastAgentModelAt.set(key, record.at);
  }
}

/**
 * The last model this instance reported running, or null (Issue #1783).
 *
 * "Last **non-null**", which is the only useful reading: three of the four tools
 * that publish a model publish it on some events and not others, and Claude
 * publishes it on two (`SessionStart`, and each switch since #2363). Reading
 * `getLastAgentEvent()?.model` would therefore answer null for almost every
 * moment of almost every session.
 *
 * Deliberately **not** bounded by {@link STRUCTURED_STATE_MAX_AGE_MS}, unlike
 * every other reader in this module. That bound exists because a *status* that
 * nothing has refreshed is a claim about right now that may have expired — a
 * lost `Stop` leaving the layer asserting `running` forever. A model is not that
 * kind of claim: an eight-hour turn is on the same model at the end as at the
 * start, and expiring it would blank the display on precisely the long-running
 * sessions this is most useful for. What *is* honoured is identity: a new
 * generation or a discarded session drops the value, because the process that
 * reported it is gone. See {@link beginAgentEventGeneration} /
 * {@link discardAgentEventState}.
 *
 * In-memory only — nothing is written to `session_states`. After a server
 * restart codex and antigravity repopulate on their next event; Claude stays
 * null until its next `SessionStart`, a gap Phase 2 (#1784) closes from the
 * terminal frame.
 */
export function getLastKnownAgentModel(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): string | null {
  return lastAgentModel.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? null;
}

/**
 * Latch the model the agent named for itself outside an agent event
 * (Issue #2964).
 *
 * The hook channel's latch — the one {@link recordAgentEvent} writes from
 * `record.model` — for a source whose model arrives on something that is not
 * one of the seven event words. OpenCode V2 is that source: its `session.*`
 * frames carry no model, and the model it actually answered with is read off
 * the assistant messages of `GET /api/session/{id}/message` after the turn.
 *
 * Latch, never clear ({@link latchAgentModel}'s rule), and judged for a change
 * exactly as a hook-borne model is, so #2357's broadcast and push fire for it.
 *
 * @param model - The model name, or null/empty to leave the latch alone
 */
export function recordAgentReportedModel(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  model: string | null | undefined,
  at: number = Date.now()
): void {
  if (typeof model !== 'string' || model === '') return;
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  lastAgentModel.set(key, model.slice(0, MAX_EVENT_DETAIL_LENGTH));
  lastAgentModelAt.set(key, at);
  observeAgentModel(worktreeId, cliToolId, instanceId, 'hook', at);
}

/**
 * Latch what a terminal capture showed for this instance (Issue #1784).
 *
 * Called from the status-detection poll with the text that poll already
 * captured — no `capture-pane` is issued for this, so the feature costs nothing
 * in tmux round-trips.
 *
 * **Each half latches independently.** A Codex footer carries a model on every
 * frame but an effort only on some formats; a Claude banner carries both and
 * then scrolls away entirely. Writing `{model, effort}` wholesale would let the
 * frame that stopped showing one of them blank a value the other frame proved.
 * Nothing is ever written as null: absent means "no frame has ever shown this",
 * which is the honest state for gemini/copilot and for any session whose chrome
 * this module has no rule for.
 *
 * **The one exception is an effort the frame shows but cannot name** (Issue
 * #2835, `info.effortUnreadable`). A codex bar that draws `default` or a
 * model-defined value where `xhigh` used to be is not "not showing" the effort
 * — it is showing a different one. Keeping `xhigh` would publish a value the
 * session is no longer running at, so the effort half is dropped to null and
 * the model half latches as usual.
 *
 * @param info - {@link import('@/lib/detection/model-info-extractor').extractModelInfo}'s answer
 */
export function recordCapturedModelInfo(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  info: ModelInfo,
  at: number = Date.now()
): void {
  if (!info.model && !info.effort) return;
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const previous = capturedModelInfo.get(key);
  const model = info.model ? info.model.slice(0, MAX_EVENT_DETAIL_LENGTH) : (previous?.model ?? null);
  capturedModelInfo.set(key, {
    model,
    effort: info.effortUnreadable ? null : (info.effort ?? previous?.effort ?? null),
    // Issue #2361: the change stamp moves only when the model half takes a
    // different value. A banner re-read on every poll keeps the stamp where the
    // first sighting put it, so it never out-dates a hook by mere repetition.
    modelChangedAt:
      model === null
        ? null
        : model === (previous?.model ?? null)
          ? (previous?.modelChangedAt ?? at)
          : at,
  });
  // Issue #2357: an effort-only frame leaves the model half where it was, so
  // there is nothing to judge; a frame that named a model is the screen's
  // report and is compared against what this instance was last seen on.
  if (info.model) observeAgentModel(worktreeId, cliToolId, instanceId, 'frame', at);
}

/**
 * The last model/effort a terminal capture showed, both halves possibly null.
 *
 * The raw scraped value, before precedence is applied — {@link
 * getResolvedAgentModelInfo} is what callers publishing to the UI or the API
 * want. Exported for the tests and for anything that needs to tell "the screen
 * said" apart from "the agent said".
 */
export function getLastCapturedModelInfo(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): ModelInfo {
  const record = capturedModelInfo.get(buildCompositeKey(worktreeId, cliToolId, instanceId));
  return { model: record?.model ?? null, effort: record?.effort ?? null };
}

/**
 * The model and reasoning effort to publish for this instance (Issue #1784).
 *
 * The single answer both surfaces should read: it folds the hook channel
 * (#1783) together with the screen under the precedence documented on
 * {@link mergeModelInfo} — hooks win for the model, the screen is the only
 * source of effort for codex/claude, and antigravity's effort is derived from
 * the id it reports rather than from its (renderer-truncated) status bar —
 * with the one exception {@link resolveAgentModel} documents (Issue #2361): a
 * claude frame that started naming a different model after the hook last
 * spoke is the newer statement, and wins.
 *
 * Both halves may be null, and routinely are: no tool publishes an effort over
 * hooks, and most tools publish neither. Callers omit the key rather than
 * emitting null — see `CliToolSessionStatus`.
 */
export function getResolvedAgentModelInfo(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): ModelInfo {
  return resolveAgentModel(buildCompositeKey(worktreeId, cliToolId, instanceId), cliToolId).info;
}

/**
 * Tools whose hook channel may name the model at session start and never again
 * (Issue #2361).
 *
 * For these, a frame that starts naming a DIFFERENT model after the hook last
 * spoke may be the only report of a mid-session switch there is, and it
 * overtakes the hook in {@link resolveAgentModel}. For every other tool the
 * rule stays #1784's — hooks win — because their hook channel re-reports the
 * model on later events (codex and antigravity on every one, opencode on every
 * `message.updated`), so a switch reaches the hook latch by itself and a frame
 * that disagrees with a hook that is still re-affirming its value is a
 * misread, not news.
 *
 * Measured on claude 2.1.263 for #2361: `SessionStart` alone carried `model`
 * among the events then registered; `/model`, `/fast` and `/effort` fired none
 * of them; the `SessionStart` that `/clear` emits carries no `model`.
 *
 * Issue #2363 registers `PostModelSwitch`, so on 2.1.263 and later the hook
 * DOES re-report every `/model` and `/fast` that changes the model, in the
 * `SessionStart` spelling (`claude-sonnet-5`, `claude-opus-5[1m]`). Claude
 * stays on this list all the same, as the **fallback** rather than the rule,
 * and the two cases the rule exists for were weighed against each other:
 *
 *  - *The hook re-reports.* The switch lands here as a hook write, stamping
 *    {@link lastAgentModelAt}; the pane re-reads the rewritten banner or the
 *    confirmation line moments later and names the same model in its label
 *    spelling, which {@link isSameAgentModelName} (cross-channel) folds into
 *    the hook's exact id. The frame does not overtake, the hook's id is what
 *    is published, and the edge fires once. Nothing in this rule had to change
 *    for that — it was written to defer to a hook that re-affirms.
 *  - *The hook does not arrive.* A claude older than the hook, a session
 *    launched without injection (`CM_AGENT_HOOKS_INJECT=0`, a hand-written
 *    `--settings`), a delivery lost to a wedged server or the 3 s
 *    de-duplication window: the latch is stale, the frame is the only channel
 *    that heard the switch, and this rule is what publishes it. Removing the
 *    tool from this set would take that back to the #2361 symptom — a stale
 *    id shown with no edge — on precisely the sessions that have no other way
 *    of reporting.
 *
 * The price of keeping it is the case #2361 already carried: a frame that
 * starts showing a stale confirmation line AFTER the hook spoke (the banner
 * scrolls away, an older `Set model to …` row becomes the fallback the
 * extractor reads) overtakes a hook that was right. That was possible before
 * #2363 — with a staler hook value underneath — and is no wider now; a switch
 * whose confirmation line the extractor does read leaves the newer row on the
 * pane, so the stale row is reachable only after a `/fast` or an automatic
 * fallback, and only until the next `/model` line or hook.
 */
const FRAME_OVERTAKES_HOOK_MODEL_TOOLS: ReadonlySet<CLIToolType> = new Set<CLIToolType>(['claude']);

/**
 * The merged model/effort for one instance, and which channel the model half
 * came from (Issue #2361).
 *
 * {@link mergeModelInfo}'s precedence — hooks win the model — with one
 * exception layered on top for {@link FRAME_OVERTAKES_HOOK_MODEL_TOOLS}: when
 * the frame's model half CHANGED after the hook last named a model
 * ({@link CapturedModelRecord.modelChangedAt} > {@link lastAgentModelAt}) and
 * the two do not name the same model ({@link isSameAgentModelName}, cross
 * channel), the frame's value is the newer statement and is published in the
 * hook's place. Every other case is unchanged:
 *
 *  - the frame names the same model as the hook (the startup banner after
 *    `SessionStart`, or `/model` back to the model the hook named): the hook's
 *    exact id is published, as before;
 *  - the frame's value predates the hook (a switch line still on screen when a
 *    relaunched process reports its starting model): the hook wins;
 *  - no hook has spoken: the frame is the only source, as before.
 *
 * `source` is null when neither channel has a model.
 */
function resolveAgentModel(
  key: string,
  cliToolId: CLIToolType
): { info: ModelInfo; source: AgentModelSource | null } {
  const hooksModel = lastAgentModel.get(key) ?? null;
  const captured = capturedModelInfo.get(key);
  const capturedInfo: ModelInfo = { model: captured?.model ?? null, effort: captured?.effort ?? null };
  // Issue #2048: the third source. Null for every tool but opencode and for
  // every opencode session running on a model's default, so every other
  // surface's string is byte-identical to pre-#2048.
  const hooksEffort = reportedEffort.get(key) ?? null;

  const frameChangedAt = captured?.modelChangedAt ?? null;
  const frameOvertakes =
    hooksModel !== null &&
    capturedInfo.model !== null &&
    frameChangedAt !== null &&
    FRAME_OVERTAKES_HOOK_MODEL_TOOLS.has(cliToolId) &&
    frameChangedAt > (lastAgentModelAt.get(key) ?? 0) &&
    !isSameAgentModelName(hooksModel, capturedInfo.model, { crossSource: true });

  const info = mergeModelInfo(cliToolId, frameOvertakes ? null : hooksModel, capturedInfo, hooksEffort);
  if (info.model === null) return { info, source: null };
  return { info, source: hooksModel !== null && !frameOvertakes ? 'hook' : 'frame' };
}

/**
 * Latch the effort (opencode's *variant*) the agent named for itself (#2048).
 *
 * Latch, never clear — {@link latchAgentModel}'s rule, and for the same reason:
 * `session.updated` omits `Session.model.variant` entirely when the session is
 * on a model's default, and `message.updated` omits `info.variant` on the
 * assistant message a turn opens with. Reading either absence as "the variant
 * is now unknown" would blank the display between frames of the same turn.
 *
 * Called by the tool's own reader — `lib/hooks/sources/opencode/subscription` —
 * rather than from the generic event path, because the value lives on frames
 * that map to none of the seven event words.
 *
 * @param effort - The variant name, or null/empty to leave the latch alone
 */
export function recordAgentReportedEffort(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  effort: string | null | undefined
): void {
  if (typeof effort !== 'string' || effort === '') return;
  reportedEffort.set(
    buildCompositeKey(worktreeId, cliToolId, instanceId),
    effort.slice(0, MAX_EVENT_DETAIL_LENGTH)
  );
}

/**
 * The effort the agent last reported for this instance, or null (#2048).
 *
 * The raw latched value, before precedence — {@link getResolvedAgentModelInfo}
 * is what callers publishing to the UI or the API want. Exported so a test can
 * tell "the agent said" apart from "the screen said", the same way
 * {@link getLastCapturedModelInfo} lets it.
 */
export function getLastReportedAgentEffort(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): string | null {
  return reportedEffort.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? null;
}

/**
 * The reasoning effort this instance is running at, or null (Issue #1784).
 *
 * Convenience reader over {@link getResolvedAgentModelInfo} for callers that
 * want only the effort — `capture --json` and `instances` (#1785) among them.
 */
export function getLastKnownAgentEffort(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): string | null {
  return getResolvedAgentModelInfo(worktreeId, cliToolId, instanceId).effort;
}
