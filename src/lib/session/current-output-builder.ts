/**
 * Shared builder for the "current terminal output" payload (Issue #1120).
 *
 * Extracted from the GET /api/worktrees/[id]/current-output route so the exact
 * same payload can be produced by the server-side response poller and pushed
 * over WebSocket (terminal streaming), keeping the pull (HTTP) and push (WS)
 * paths byte-for-byte consistent (DRY).
 */

import type Database from 'better-sqlite3';
import { getSessionState, createMessage } from '@/lib/db';
import { observeUnclassifiedFrame } from '@/lib/detection/unclassified-frame-tracker';
import { extractComposerText, type ComposerTextState } from '@/lib/detection/composer-text';
import { matchUpstreamFault } from '@/lib/detection/upstream-faults';
import { UNCLASSIFIED_PROMPT_TYPE, type UnclassifiedFrameRecord } from '@/types/models';
import { createLogger } from '@/lib/logger';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { capturedLineCountIsCursor, type CLIToolType } from '@/lib/cli-tools/types';
import type {
  SessionTargetConflict,
  SessionTargetResolvedBy,
} from '@/lib/session/resolve-session-target';
import { getAgentEventSource } from '@/lib/hooks/sources/registry';
import {
  getLastPermissionDecision,
  type PermissionDecisionRecord,
} from '@/lib/hooks/permission-decision-state';
import {
  getLastToolInputNormalization,
  type ToolInputNormalizationRecord,
} from '@/lib/hooks/tool-input-normalization-state';
import type { AgentSourceCapabilities } from '@/lib/hooks/sources/types';
import { captureSessionOutput } from '@/lib/session/cli-session';
import {
  detectSessionStatus,
  STATUS_REASON,
  SELECTION_LIST_REASONS,
  isGeneratingStatus,
  type SessionStatus,
} from '@/lib/detection/status-detector';
import {
  getAutoYesState,
  getLastServerResponseTimestamp,
  isPollerActive,
  buildCompositeKey,
} from '@/lib/polling/auto-yes-manager';
import {
  getLastPolicySuppression,
  type AutoYesPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';
import {
  getPromptDedupSkips,
  type PromptDedupSkips,
} from '@/lib/polling/prompt-dedup-state';
import { STATUS_CAPTURE_LINES } from '@/config/status-capture-config';
import { CACHE_MAX_CAPTURE_LINES, isCaptureWindowSaturated } from '@/lib/tmux/tmux-capture-cache';
import {
  getAgentEventDropCounts,
  getAskUserQuestion,
  getLastAgentEvent,
  getLastStopEventAt,
  getPendingDecisions,
  getPublishedAgentTurn,
  getResolvedAgentModelInfo,
  getStructuredSessionState,
  markStructuredPromptRecorded,
  observeScraperCompletionEvidence,
  type AgentEventDropCounts,
  type AskUserQuestionEpisode,
  type StructuredPromptWaitingState,
  type StructuredSessionState,
} from '@/lib/session/agent-event-state';
import {
  resolvePromptWaiting,
  structuredWaitingReason,
} from '@/lib/session/prompt-waiting-composition';
import {
  DIALOG_PENDING_MAX_MS,
  isDeliveryExpired,
  type PublishedTurn,
} from '@/lib/session/provisional-turn';
import {
  forgetLastKnownStatus,
  getLastKnownStatus,
  isUnclassifiedFrame,
  observeStatusEvidence,
  type StatusEvidence,
} from '@/lib/session/status-evidence';
import { applyAskUserQuestion } from '@/lib/session/ask-user-question-prompt';
import {
  buildStructuredPromptData,
  buildStructuredPromptHistoryRecord,
  STRUCTURED_DECISION_OPTIONS,
  type StructuredAskUserQuestionSummary,
  type StructuredPromptFacts,
  type StructuredPromptSource,
  type StructuredPromptWaitingData,
} from '@/lib/session/structured-prompt';
import type { PromptData } from '@/types/models';

/**
 * The last structured lifecycle event this instance reported (Issue #1722).
 *
 * Diagnostic, and the shape says so: one event, not a log. It exists so an
 * operator can answer "are the injected hooks reaching this server at all, and
 * for the right instance?" without reading server logs.
 *
 * It is the raw event, NOT the verdict. Since Issue #1723 the same event may
 * also have decided `sessionStatus` — `sessionStatusReason` starting with
 * `hook_` is how you tell that it did — but the two are reported separately on
 * purpose: an event arrives here even when the merge declined to act on it, and
 * that gap is the measurement the Epic is collecting.
 *
 * Since Issue #1926 it also carries the {@link PublishedTurn} fields
 * (`turnId` / `openedAt` / `closedAt` / `closedBy`). Issue #1930 made them a
 * real turn record rather than a derivation from the newest event, so `turnId`
 * IS a turn identity now — stable across the tool calls inside a turn, and not
 * inherited by a session recreated in the same pane. `wait`'s `adoptTurnStart`
 * reads `openedAt` since that Issue.
 *
 * `lastEventType` / `lastEventAt` stay, and are deliberately allowed to
 * disagree with the turn fields: they answer "did anything reach this server,
 * and for the right instance?", which is the diagnostic question this block was
 * added for, and an event carrying no verdict answers it while changing no
 * state at all.
 */
export interface StructuredEventsPayload extends PublishedTurn {
  /** e.g. `stop`, `user_prompt_submit`, `notification`. */
  lastEventType: string | null;
  /** Epoch ms. */
  lastEventAt: number | null;
  /** Subtype where the event has one: `permission_prompt`, `clear`, … */
  lastEventDetail: string | null;
  /**
   * Epoch ms the structured layer first learned a dialog was open, or null when
   * it knows of none (Issue #1725).
   *
   * Diagnostic, and the one field that answers "is `isPromptWaiting` true
   * because of the screen or because of the agent?" without guessing from
   * `sessionStatusReason`. Null on a session that is not running.
   */
  promptWaitingSince: number | null;
  /** `notification` / `permission-request`, or null. See above. */
  promptWaitingSource: StructuredPromptSource | null;
  /**
   * The last `tool_input` this server had to rewrite before it could adjudicate
   * it, or null (Issue #1902).
   *
   * Copilot 1.0.80's `Edit` sends its apply-patch envelope as a bare string, so
   * the adjudicated object is `{ patch: … }` rather than what arrived on the
   * wire. §7's discoverability rule is that an automatic action visible only in
   * the server log does not exist, and this is that action's reason code: it
   * says the input was a string and was read as a patch, which is also what
   * says why the deny patterns saw the envelope's action headers instead of its
   * body.
   *
   * Always present, null on every session that has never been normalised —
   * which is every tool but copilot. Reported on a stopped session too, for the
   * reason `promptDedup` is: it is a record of something that already happened,
   * and zeroing it would erase the evidence at the moment an operator comes
   * looking for it.
   *
   * Exposure only: nothing reads it back.
   */
  toolInputNormalization: ToolInputNormalizationRecord | null;
  /**
   * The last approval this server adjudicated on the agent's behalf, or null
   * (Issue #1898).
   *
   * The same shape of field as {@link toolInputNormalization} and for the same
   * reason. Five of the six tools are adjudicated inside the request they are
   * blocked on, so the agent learns the verdict by being answered; opencode is
   * adjudicated over a connection nobody is holding, which means Auto-Yes can
   * approve a `rm`, dismiss the dialog and leave nothing on any surface an
   * operator reads. This field is that surface: what was asked, what was
   * answered, whether it landed, and whether it retired the prompt.
   *
   * Always present, null on every session nothing has been adjudicated for.
   * Reported on a stopped session too, for the reason `promptDedup` is.
   *
   * Exposure only: nothing reads it back.
   */
  permissionDecision: PermissionDecisionRecord | null;
  /**
   * Which {@link AgentEventSource} speaks for this tool, and what it declares it
   * can do (Issue #1924, §7).
   *
   * The declared values verbatim — `capture --json` is where an operator finds
   * out why the structured layer did or did not record something, and a
   * capability that only existed in the source file could not answer that.
   * Nothing here is computed: §4 D3 decision 1 requires every capability to be a
   * JSON-serialisable declared value precisely so this field can be a copy.
   *
   * Always present. A tool with no source of its own gets the compatibility
   * source from `lib/hooks/sources/legacy-relay`, whose capabilities say
   * "nothing has been measured" rather than guessing Claude's.
   */
  source: StructuredSourcePayload;
  /**
   * The approvals this instance is blocked on, oldest first (Issue #1930).
   *
   * Set on every payload this build produces, and empty on every session with
   * no dialog open — which is almost every session almost all of the time. The
   * `id` is what `#1932` teaches `commandmate respond` to name; until then it is
   * what lets an operator tell two concurrent approvals apart in
   * `capture --json`.
   *
   * **The agent's `tool_input` is not here and never will be.** What a
   * permission request carries is a command line, a patch or a file's contents,
   * and this payload is served over HTTP to anyone who can reach the server.
   * What is published is what a reader has to be able to act on: which dialog,
   * how old, whether anything corroborated it, and whether a verdict from this
   * server can still reach the agent.
   *
   * Optional on the type for the reason the three fields below it are, stated
   * once here: this shape is also *constructed* — by suites that stand in for
   * the builder, and by the CLI's mirror in `api-responses.ts`, which has to
   * describe a server older than the field as well as one newer. A reader takes
   * `?? []`.
   */
  pendingDecisions?: PendingDecisionPayload[];
  /**
   * What this instance has had dropped, and on whose authority (Issue #1930).
   *
   * §7's discoverability rule applied to every bound in the structured layer: a
   * de-duplicated delivery, a discarded id, an evicted dialog and an overflowed
   * decision list are all *automatic actions*, and an automatic action visible
   * only in the server log does not exist. "My `stop` never arrived" and "my
   * `stop` arrived and something had already claimed its id" are the same
   * symptom with different fixes, and this is what separates them.
   *
   * Zeroed on an instance nothing has been dropped for. Optional on the type;
   * see `pendingDecisions` above.
   */
  dedupDropped?: AgentEventDropCounts;
  /**
   * The retention bounds a dialog record is held under, in ms (Issue #1930).
   *
   * Published so `capture --json` can explain a dialog that went away on its
   * own. Two values because a prediction and a proof are different statements —
   * see `provisional-turn`'s `DIALOG_PENDING_MAX_MS`. Optional on the type; see
   * `pendingDecisions` above.
   */
  dialogPendingMaxMs?: { predicted: number; confirmed: number };
}

/** One approval, as it is published (Issue #1930). */
export interface PendingDecisionPayload {
  /** The agent's own id for it, or null for a source that publishes none. */
  id: string | null;
  /** Epoch ms it was first reported. */
  at: number;
  /** `notification` (a dialog was proved) / `permission-request` (predicted). */
  source: StructuredPromptSource;
  /** The tool it named, or null. Bounded. */
  toolName: string | null;
  /** Epoch ms something independent confirmed it, or null while predicted. */
  confirmedAt: number | null;
  /** Whether the scraper has itself seen a blocking frame this episode. */
  scraperCorroborated: boolean;
  /**
   * Whether a verdict from this server can still reach the agent (Issue #1930).
   *
   * `capabilities.decisionTimeoutSeconds` (#1924) applied to this record's age.
   * Deliberately does NOT retire it: the dialog is on the pane whether or not
   * this server can still answer it, and reporting the pane free at ten seconds
   * because copilot stopped listening would be the wrong half of the fact.
   */
  deliveryExpired: boolean;
}

/**
 * The event source's identity and declared capabilities, as published.
 *
 * ## Why the whole block is on the hot path
 *
 * §7 (DR2-022) asks for the name on `current-output` and the capabilities only
 * on "the detailed fetch". There is no detailed fetch: `commandmate capture
 * --json` prints the `GET /api/worktrees/:id/current-output` response verbatim
 * (`src/cli/commands/capture.ts`), so a field that is not here is not in
 * `capture --json` either. Inventing a second endpoint or a query flag to
 * separate them is a wider change than Issue #1924 is scoped for, and the thing
 * being separated is ~250 bytes of static JSON next to a payload that carries
 * the whole terminal frame. So it ships unconditionally, and DR2-022's split can
 * be revisited if `instances` ever wants a different shape.
 */
export interface StructuredSourcePayload {
  /** The tool this source speaks for — its own id, not the caller's. */
  cliToolId: CLIToolType;
  /** The declared block, copied. See {@link AgentSourceCapabilities}. */
  capabilities: AgentSourceCapabilities;
}

export interface CurrentOutputPayload {
  isRunning: boolean;
  cliToolId: CLIToolType;
  sessionStatus: string;
  sessionStatusReason: string;
  content: string;
  fullOutput?: string;
  realtimeSnippet?: string;
  lineCount: number;
  lastCapturedLine?: number;
  isComplete?: boolean;
  isGenerating?: boolean;
  thinking?: boolean;
  thinkingMessage?: string | null;
  isPromptWaiting?: boolean;
  /**
   * The prompt to answer, or null.
   *
   * Since Issue #1725 this is a union: either the scraper's parsed prompt, or
   * the degraded {@link StructuredPromptWaitingData} published for a dialog only
   * the structured layer can see. Readers that answer by option number must
   * check `type` — the degraded form carries none, by construction.
   */
  promptData?: PromptData | StructuredPromptWaitingData | null;
  autoYes?: {
    enabled: boolean;
    expiresAt: number | null;
    stopReason?: string;
    /**
     * Last answer the contract's autoYes policy withheld for this session, or
     * null when it never withheld one (Issue #1684). Refreshed every poll while
     * the suppressed prompt stays on screen, so `at` being current together
     * with `isPromptWaiting` means the suppression is the reason the session is
     * waiting right now.
     */
    lastSuppression: AutoYesPolicySuppression | null;
    /**
     * Short excerpt of what `--stop-pattern` matched, present only while
     * `stopReason === 'stop_pattern_matched'` (Issue #1694).
     *
     * Exposure only, and deliberately raw: the operator's question is whether
     * the pattern hit the agent's own output or a build log that happened to
     * contain it (#1678 A-5), and that is answered by seeing the text in
     * place. Bounded and marked when cut — see STOP_MATCH_EXCERPT_MAX_BYTES in
     * `src/lib/auto-yes-state.ts`.
     */
    stopMatchedText?: string;
  };
  isSelectionListActive?: boolean;
  isPagerActive?: boolean;
  isUnclassifiedActive?: boolean;
  /**
   * Whether {@link sessionStatus} rests on something positive (Issue #1926,
   * §4 D1 / §7).
   *
   * **Always present.** `capture --json | jq -r '.statusEvidence'` has to answer
   * for every session, including one that is not running, because the question
   * it settles — "did anything actually confirm this?" — is exactly the question
   * an operator asks of a verdict they distrust.
   *
   * Today it is the negation of {@link isUnclassifiedActive}, which is derived
   * from it. The two are published side by side rather than one replacing the
   * other because `isUnclassifiedActive` is an older CLI contract (`wait`'s
   * `ready && !isUnclassifiedActive` rule) and this one is the reading Phase 3
   * widens per tool.
   */
  statusEvidence: StatusEvidence;
  /**
   * The last status this server could positively confirm, or null (Issue #1926,
   * §7 「直前の確定状態（証拠なしの間の表示）」).
   *
   * **Always present, null when nothing knows.** Null means one of: nothing has
   * ever been confirmed for this session, the confirmation aged past
   * `LAST_KNOWN_STATUS_TTL_MS`, the server restarted (the latch is in-memory by
   * design), or the session is not running — a dead session's last status
   * describes a process that is gone, so it is dropped for the reason
   * {@link model} is.
   *
   * Equal to {@link sessionStatus} whenever `statusEvidence` is `'positive'`,
   * because this poll just confirmed it. It earns its keep on the polls where
   * the evidence is `'none'` and the wire status is a fallback.
   */
  lastKnownStatus: string | null;
  /** Epoch ms of {@link lastKnownStatus}, or null when that is null. */
  lastKnownStatusAt: number | null;
  lastServerResponseTimestamp?: number | null;
  serverPollerActive?: boolean;
  /**
   * Epoch ms of the last `POST /api/hooks/agent-event` stop event, or null when
   * the agent has no hook wired up (Issue #1549).
   *
   * Still exposed only — this timestamp itself decides nothing. Since Issue
   * #1723 the *event* behind it can drive `sessionStatus`, but through
   * `getStructuredSessionState`, which applies the generation and age bounds
   * this raw field has never had.
   */
  lastStopEventAt: number | null;
  /**
   * Last structured event of any kind, or nulls when none has arrived
   * (Issue #1722). See {@link StructuredEventsPayload}.
   */
  structuredEvents: StructuredEventsPayload;
  /**
   * The model this instance is running, or null when nothing knows (#1785).
   *
   * Exposure only: the value is whatever the retention layer resolved — the
   * agent's own hook events first (#1783), the terminal frame filling the hole
   * (#1784), under `mergeModelInfo`'s precedence. Nothing here parses,
   * normalises or prettifies it — `commandmate capture --json` and
   * `commandmate instances` have to be able to compare it against what the
   * agent reports about itself, and any cleanup on the way out would break
   * that comparison exactly when it matters.
   *
   * **Always present, null when unknown.** Unlike `CliToolSessionStatus.model`,
   * which omits the key so existing `toEqual` suites keep passing, this payload
   * is a CLI contract: `capture --json | jq '.model'` must answer `null` rather
   * than nothing at all for a session whose tool publishes no model (gemini,
   * copilot) or for a server that restarted mid-session.
   *
   * Null whenever the session is not running, regardless of what was latched
   * before: the retention layer deliberately does not expire (an eight-hour
   * turn is on the same model at the end as at the start), so a dead session
   * would otherwise keep reporting the model of the process that ran in it.
   */
  model: string | null;
  /**
   * The reasoning effort this instance is running at, or null (#1785).
   *
   * Phase 3 (#1785) shipped this key against a seam that returned a constant
   * null, because its holding layer (#1784) was landing in parallel; the two
   * Issues went green side by side and nobody joined them, so the field stayed
   * null on every session for both `capture --json` and `commandmate
   * instances`. It now reads the same retention layer `model` does, resolved by
   * the same call — see the note on the resolution site in
   * {@link buildCurrentOutput}.
   *
   * Not an optional field and not `undefined`: a consumer must be able to read
   * `.reasoningEffort` and get an explicit "nothing knows" for gemini, for
   * copilot, and for any session whose banner has scrolled out of the tmux
   * history.
   *
   * Null whenever the session is not running, for the same reason `model` is —
   * see above.
   */
  reasoningEffort: string | null;
  /**
   * How many prompts the content-hash dedup guard suppressed for this session,
   * and when it last did (Issue #1695). See {@link PromptDedupSkips}.
   *
   * **Always present, zeroed when nothing was skipped.** The whole point is to
   * separate "the guard dropped it" from "nothing classified the frame"
   * (Issue #1676), and an absent key would leave the caller guessing which of
   * the two it was looking at — the same ambiguity the field removes.
   *
   * Exposure only: no verdict reads it. `skippedCount` is cumulative across
   * polling cycles, so `lastSkippedAt` is what says whether the suppression is
   * current — read it next to `isPromptWaiting` the way `autoYes.lastSuppression`
   * is read.
   */
  promptDedup: PromptDedupSkips;
  /**
   * The upstream (model API) fault visible on the live frame, or null
   * (Issue #1839).
   *
   * **Always present, null when no signature matched.** Read
   * `src/lib/detection/upstream-faults.ts` before reading this field: null is
   * "no known signature was on the frame", NEVER "upstream is healthy". The
   * measurement behind the Issue found a 529 storm that left the pane blank, and
   * a consumer that treats null as an all-clear re-creates exactly the false
   * confidence the field exists to remove.
   *
   * Judged on `realtimeSnippet` (the last 100 rows), so it clears once the fault
   * has scrolled out of that window rather than latching for the life of the
   * session — the question a caller asks of it is "is this happening now".
   *
   * Exposure plus one verdict: `commandmate wait --fail-on-upstream-fault`
   * exits {@link WaitExitCode.UPSTREAM_FAULT} on it. Nothing reads it by
   * default.
   */
  upstreamFault: {
    /** {@link UpstreamFault.id} — `overloaded` / `retrying` / `limit-reached` / `api-error`. */
    id: string;
    /** The whole line that matched, trimmed and bounded. */
    matchedText: string;
    /** Epoch ms the frame this was read from was captured. */
    at: number;
  } | null;
  /**
   * Text the user has in the CLI's composer but has not sent, or null
   * (Issue #1879).
   *
   * **Always present, null when there is none.** Read
   * `src/lib/detection/composer-text.ts` before reading this field: null is
   * "nothing REAL is in the input box", which covers four different situations
   * that {@link composerState} tells apart — most importantly Claude Code's dim
   * suggestion text — and codex's `Ask Codex to do anything` — which after
   * `stripAnsi` is indistinguishable from typed input and which this field must
   * never carry (a bar offering to run a hint that no `C-u` can clear is a defect
   * the user sees, not a cosmetic one).
   *
   * Extracted structurally from the raw frame, NOT from any status verdict: it
   * does not consult `sessionStatus`, `isPromptWaiting`, `isUnclassifiedActive`
   * or `isSelectionListActive`, and none of them consult it. That independence
   * is the point — the existing Enter-capable surfaces are gated on detection
   * flags precisely so a stray Enter cannot reach a normal input prompt, and
   * #1879's bar is allowed at a normal input prompt only because the user reads
   * what is there before pressing it.
   *
   * claude and codex (Issue #1890); every other CLI reports `unsupported_tool`.
   */
  composerText: string | null;
  /**
   * Which of the composer states {@link composerText} came from (Issue #1879).
   *
   * Exposure only — nothing branches on it server-side. It exists so
   * `capture --json` can answer "the box looked occupied but it was a ghost"
   * instead of leaving a null indistinguishable from an empty prompt.
   */
  composerState: ComposerTextState;
  /**
   * Which stage of the shared precedence chain chose {@link cliToolId}
   * (Issue #1884, design §4 D5 / §7).
   *
   * Present only when the caller resolved through
   * {@link SessionTargetResolution} — the HTTP route does, the WS terminal
   * streamer is handed an already-resolved pair by the poller and passes none.
   *
   * Exposure only, and the field an operator reads when a session they can see
   * in tmux is reported as not running: `worktree-default` on a request that
   * named an instance means the instance is not in the roster and its id is not
   * a tool name, which is the shape #1884 produced silently. `fallback` means
   * the worktree row has no CLI tool of its own (design §4 D5 決定 5) and is a
   * warning, not information.
   */
  resolvedBy?: SessionTargetResolvedBy;
  /**
   * The explicit `?cliTool` the roster contradicts, or null (Issue #1884).
   *
   * Present alongside {@link resolvedBy}. This is a read path, so a
   * contradiction resolves (the roster wins) and answers 200 with the fact
   * attached rather than 400 — `capture` is the inner call of unbounded monitor
   * loops and a non-zero exit there is a poll skipped forever, not an error
   * anyone reads (design §4 D5 / DR3-015). Routes with a side effect refuse it
   * instead, through `resolveSessionTargetStrict`.
   */
  conflict?: SessionTargetConflict | null;
}

/**
 * How a caller's request was resolved to the (tool, instance) pair it passes in
 * (Issue #1884).
 *
 * Deliberately the *result* of {@link resolveSessionTarget} rather than its
 * inputs: this module does not resolve anything and must not grow a second
 * copy of the precedence chain (design §4 D5). The route resolves, then hands
 * the answer here to be published next to the payload it produced.
 */
export interface SessionTargetResolution {
  resolvedBy: SessionTargetResolvedBy;
  conflict?: SessionTargetConflict | null;
}

const logger = createLogger('current-output-builder');

/**
 * Write the "detection failed on this frame" row (Issue #1708).
 *
 * Stored as a `prompt` message so `capture --prompts` — the audit trail that
 * exists precisely to answer "why did this stall?" — lists it alongside the
 * prompts that WERE detected. It must never read as one of them, so the
 * promptData carries `type: 'unclassified'` and `status: 'unclassified'`; the
 * latter is also what keeps it out of `markPendingPromptsAsAnswered()`, whose
 * SQL selects `status = 'pending'`. A frame nobody could read must not end up
 * stamped "(answered via terminal)" the moment the flag clears.
 *
 * Not broadcast: this is a record for after the fact, and the prompt-answering
 * UI has nothing to render for a frame with no parsed options.
 *
 * REACH, stated plainly because it is a real limit: this is driven by
 * observation, not by the server's own loops. `buildCurrentOutput` has exactly
 * two callers — the current-output route and `broadcastTerminalSnapshot`, which
 * returns immediately when the room has no subscribers. So a row is written
 * while `commandmate wait` is polling (every POLL_INTERVAL_MS), while a browser
 * has the terminal open, or on a `capture --json`. A stall that nobody is
 * watching at all writes nothing, and `capture --prompts` afterwards will not
 * show it. That is tolerable because the stalls this exists to explain are the
 * ones something WAS waiting on — but it means the Auto-Yes poller running
 * alone is not enough. Feeding the tracker from that loop would need a second
 * producer of `isUnclassifiedActive`, i.e. either duplicating its definition or
 * adding a detectSessionStatus pass to a hot path; deliberately not done here.
 *
 * Best effort — a failed insert must never break the payload the caller is
 * waiting on. The tracker has already marked the run as recorded, so a failure
 * costs this one row, not a retry storm.
 */
function recordUnclassifiedFrame(
  db: Database.Database,
  params: {
    worktreeId: string;
    cliToolId: CLIToolType;
    instanceId: string;
    dwellMs: number;
    sessionStatus: string;
    sessionStatusReason: string;
  },
): void {
  const dwellSeconds = Math.round(params.dwellMs / 1000);
  const statusReason = `${params.sessionStatus}/${params.sessionStatusReason}`;
  const question =
    `Unclassified interactive frame (${statusReason}) held for ${dwellSeconds}s. ` +
    `The detection layer could not parse it, so no prompt was published and ` +
    `nothing could answer it. Inspect the raw pane with ` +
    `\`commandmate capture ${params.worktreeId} --pane\`.`;

  const record: UnclassifiedFrameRecord = {
    type: UNCLASSIFIED_PROMPT_TYPE,
    status: 'unclassified',
    question,
    options: [],
    dwellSeconds,
    sessionStatusReason: statusReason,
  };

  try {
    createMessage(db, {
      worktreeId: params.worktreeId,
      role: 'assistant',
      content: question,
      messageType: 'prompt',
      // Not a PromptData: nothing may answer this row, which is why the record
      // type is kept out of that union (see UnclassifiedFrameRecord). The column
      // is shared, so the cast is confined to this one write.
      promptData: record as unknown as PromptData,
      timestamp: new Date(),
      cliToolId: params.cliToolId,
      instanceId: params.instanceId,
    });
    logger.info('unclassified-frame-recorded', {
      worktreeId: params.worktreeId,
      cliToolId: params.cliToolId,
      dwellSeconds,
      statusReason,
    });
  } catch (error: unknown) {
    logger.warn('unclassified-frame-record-failed', {
      worktreeId: params.worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Write the "the agent said a dialog is open and we could not read it" row
 * (Issue #1725, continuing #1708's proposal 2).
 *
 * Written once per waiting episode, and ONLY while the scraper is publishing no
 * prompt of its own. Both halves matter:
 *
 *  - once, because `buildCurrentOutput` runs on every poll and a row per poll
 *    would turn one blocked dialog into a wall of identical history;
 *  - only when the scraper is blind, because when it is not, the existing
 *    prompt writers already record that prompt with its options and its answer.
 *    A second row would double-count the audit trail `capture --prompts` prints
 *    and put a "nobody could read this" line next to the parsed prompt that
 *    proves somebody could.
 *
 * So a row here means exactly one thing, which is the thing #1708 asked to be
 * recorded: a prompt existed and the detection layer did not see it.
 *
 * Best effort, for the same reason as {@link recordUnclassifiedFrame}: the
 * caller is waiting on a payload, and a failed insert must cost this row and
 * nothing else.
 */
function recordStructuredPrompt(
  db: Database.Database,
  params: {
    worktreeId: string;
    cliToolId: CLIToolType;
    instanceId: string;
    state: StructuredPromptWaitingState;
    facts: StructuredPromptFacts;
  },
): void {
  const record = buildStructuredPromptHistoryRecord(params.worktreeId, params.facts);

  try {
    createMessage(db, {
      worktreeId: params.worktreeId,
      role: 'assistant',
      content: record.question,
      summary: `structured prompt · source=${params.state.source}${
        params.state.toolName ? ` · tool=${params.state.toolName}` : ''
      }`,
      messageType: 'prompt',
      // Not a PromptData: it has no options and nothing may answer it by
      // number. The column is shared, so the cast is confined to this write —
      // the same arrangement UnclassifiedFrameRecord uses.
      promptData: record as unknown as PromptData,
      timestamp: new Date(),
      cliToolId: params.cliToolId,
      instanceId: params.instanceId,
    });
    logger.info('structured-prompt-recorded', {
      worktreeId: params.worktreeId,
      cliToolId: params.cliToolId,
      instanceId: params.instanceId,
      source: params.state.source,
      toolName: params.state.toolName,
    });
  } catch (error: unknown) {
    logger.warn('structured-prompt-record-failed', {
      worktreeId: params.worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Re-exported from `@/lib/session/status-evidence`, where Issue #1926 moved it
 * so `worktree-status-helper` — the second producer, and the one that drives the
 * header chip, `BranchStatusIndicator` and `commandmate ls` — could call the
 * same derivation instead of restating it.
 *
 * Kept exported here because #1924 published it from this module and the type is
 * imported by name elsewhere; the definition is one file away, not two.
 */
export type { StatusEvidence };

/** What `detectSessionStatus()` said about this frame, as this module uses it. */
export interface ScraperVerdict {
  status: SessionStatus;
  reason: string;
  /** The agent is producing output right now. */
  thinking: boolean;
  /**
   * Whether `status` was positively confirmed (Issue #1924).
   *
   * Produced by the detector since #1927 (§8 Phase 3): an `input_prompt` frame
   * that no tool-specific idle-composer rule vouches for is `'none'` here, with
   * the same status and reason on the wire as one that was vouched for.
   *
   * NOT the negation of {@link ScraperVerdict.isUnclassifiedActive}, though it
   * was when both were introduced. Issue #2011 separated them after the rollout
   * made the two sets diverge — see `status-evidence.ts` for the two questions
   * and which consumer asks which.
   */
  evidence: StatusEvidence;
  /**
   * The frame is interactive but could not be classified (#1497 / #1708).
   *
   * `isUnclassifiedFrame(status, reason)` — the reason vocabulary, not the
   * evidence. A published CLI contract (`capture --json`, and `wait`'s
   * `ready && !isUnclassifiedActive` completion rule), so it is derived from the
   * one expression in `status-evidence.ts` at the single site that produces a
   * verdict and carried through everywhere else — two expressions for one fact
   * is how §4 D1 decision 2 says this drifts, and #2011 is what it cost.
   */
  isUnclassifiedActive: boolean;
}

export interface MergedStatusVerdict extends ScraperVerdict {
  /** True when the structured layer, not the scraper, decided `status`. */
  structuredApplied: boolean;
}

/**
 * The `AskUserQuestion` call as the degraded prompt can describe it
 * (Issue #1726).
 *
 * Only the first question, and no option numbers — see
 * {@link StructuredAskUserQuestionSummary} for why a layer that cannot see the
 * screen must not publish numbers for it.
 */
function summarizeAskUserQuestion(
  episode: AskUserQuestionEpisode | null,
): StructuredAskUserQuestionSummary | null {
  const first = episode?.spec.questions[0];
  if (!first) return null;
  return {
    question: first.question,
    labels: first.choices.map((choice) => choice.label),
    questionCount: episode!.spec.questions.length,
  };
}

/**
 * Prefer the agent's own account of what it is doing over the screen scrape
 * (Issue #1723).
 *
 * Pure, and exported so the whole precedence table can be tested without a tmux
 * session behind it.
 *
 * ## Why the scraper still wins in two cases
 *
 * **`waiting` on the scraper's side always wins.** A frame the detector reads
 * as a prompt, a selection list or a pager is a frame a human has to act on,
 * and this Issue deliberately does not touch `isPromptWaiting` / `promptData` /
 * `isSelectionListActive` (they are #1725's). Letting a structured `running`
 * overwrite `sessionStatus` while those three still said "answer me" would
 * publish a self-contradicting payload. It is also the empirically necessary
 * rule: the live capture found that Claude emits **no event at all** while an
 * `AskUserQuestion` selection or "Ready to submit your answers?" screen is up
 * (`agent-hooks-live-verification.md` §5.6), so the newest structured fact
 * there is the `user_prompt_submit` that opened the turn — `running` — while
 * the truth on screen is "waiting for a human". That is precisely the #1708
 * stall, and the scraper is the only layer that can see it.
 *
 * **A structured `waiting` is applied only through the prompt-waiting state**
 * (Issue #1725). #1723 recorded `Notification(permission_prompt)` and stopped
 * there, for a reason that had to be answered before it could be promoted:
 * nothing marks a permission prompt as *answered*, so a verdict read off the
 * last event alone would stick until the next `Stop` and describe a session
 * that went back to work minutes ago. `getStructuredPromptWaiting` is that
 * answer — it is released by `Stop` / `user_prompt_submit` / a generation
 * change, by the scraper reporting the frame it corroborated has cleared, and
 * by expiry. So the `waiting` promoted here is the one that survives all of
 * those, passed in explicitly; the raw `structured.status === 'waiting'` still
 * decides nothing on its own.
 *
 * ## `isUnclassifiedActive` is not this function's to move (Issue #2011)
 *
 * The flag is carried through from the scraper on every path. It answers "could
 * the detection layer read this frame?", and no amount of knowledge about the
 * TURN changes the answer for the FRAME:
 *
 *  - a static overlay left on screen after a turn (`/help`, #1497) reads as
 *    `running`/`no_recent_output` while the structured layer says `ready` — the
 *    structured layer adds nothing about the screen, and clearing the flag would
 *    take away the navigation hatch the user needs to escape;
 *  - a frame nobody can classify while the structured layer says `running` is
 *    still a frame nobody can classify. `wait`'s unclassified dwell (exit 10)
 *    is the last hatch for a screen that produces no events at all, and #1708
 *    exists because it was missing. A structured `running` does not prove a
 *    human is not needed — see the AskUserQuestion case above.
 *
 * `#1723`'s reported case — `Stop` arrives while the spinner is still painted —
 * needs no help from here: that frame reads `running`/`thinking_indicator`, which
 * is classified, so the flag was already down and `wait` completes on the
 * structured `ready` alone.
 *
 * What this function DOES move is `evidence`, and only upwards: see
 * {@link hookClosedTurn}.
 *
 * @param turn - The published turn record for this instance, or null. Read only
 *   for {@link hookClosedTurn}; `structured` remains the status authority.
 */
export function mergeStructuredStatus(
  scraper: ScraperVerdict,
  structured: StructuredSessionState | null,
  promptWaiting: StructuredPromptWaitingState | null = null,
  turn: PublishedTurn | null = null,
): MergedStatusVerdict {
  if (scraper.status === 'waiting') {
    return { ...scraper, structuredApplied: false };
  }

  // Issue #1725, the OR rule at the status level: the scraper reads this frame
  // as running or ready, and the agent has told us a dialog is in front of it.
  // Publishing `running` next to `isPromptWaiting: true` would be a payload
  // that contradicts itself, and every consumer of `sessionStatus` — the
  // sidebar dot, `deriveSessionStatus`, the worktrees API — would show a worker
  // that needs a human as one that is busy.
  if (promptWaiting !== null) {
    return {
      status: 'waiting',
      reason: structuredWaitingReason(promptWaiting),
      thinking: false,
      // Untouched: what the scraper could read about this frame does not change
      // because the agent told us a dialog is open (Issue #1924).
      evidence: scraper.evidence,
      isUnclassifiedActive: scraper.isUnclassifiedActive,
      structuredApplied: true,
    };
  }

  if (structured === null || structured.status === 'waiting') {
    return { ...scraper, structuredApplied: false };
  }

  const thinking = structured.status === 'running';
  // Issue #2011 (対応 2): the agent's own turn close IS positive evidence.
  //
  // #1927 (DR2-003) guarded this override with `scraper.evidence === 'positive'`
  // to stop a structured `ready` clearing `isUnclassifiedActive` on a frame
  // nobody could read. It over-corrected twice over. First, the conjunct made
  // the whole expression a no-op: `evidence = cond ? 'positive' : scraper.evidence`
  // where `cond` requires `scraper.evidence === 'positive'` returns
  // `scraper.evidence` on both arms, so the branch could not change a value in
  // any direction. Second, the fix it was reaching for belonged one field over —
  // the hatch is held open by {@link ScraperVerdict.isUnclassifiedActive}, which
  // is carried through below rather than re-derived, so the evidence no longer
  // has to be understated to protect it.
  //
  // What that leaves is a payload that stopped contradicting itself. A pane
  // whose `reason` reads `hook_stop` while `statusEvidence` reads `'none'` is
  // denying, in one field, the strongest positive signal this server can get: a
  // `Stop` from the agent, for a turn this server watched open. `closedAt >
  // openedAt` is what narrows it to that case — a `Stop` that arrived with no
  // turn open publishes `openedAt: null` (see `recordAgentEvent`), and a close
  // the SCREEN inferred carries one of the other {@link TurnCloseReason} values.
  // Freshness needs no bound of its own: `getStructuredSessionState` answered
  // null above once the display event passed STRUCTURED_STATE_MAX_AGE_MS.
  //
  // `scraper.status === 'running'` is deliberately NOT required. The session this
  // Issue was reported from sat at `ready`/`input_prompt` with `closedBy: 'stop'`
  // — the agent had said it was done and the frame agreed — and the old conjunct
  // is what kept publishing `'none'` for it.
  const evidence: StatusEvidence =
    structured.status === 'ready' && hookClosedTurn(turn) ? 'positive' : scraper.evidence;
  return {
    status: structured.status,
    reason: structured.reason,
    thinking,
    evidence,
    // Issue #2011: what the structured layer knows about the TURN says nothing
    // about whether this FRAME could be read. #1708's dwell and the nav hatch
    // are the last way out of a pane nothing can drive, and a `Stop` does not
    // make an unreadable pane readable — see the `/help` overlay fixture in
    // `tests/unit/lib/detection/fixtures/claude-live-2011/`.
    isUnclassifiedActive: scraper.isUnclassifiedActive,
    structuredApplied: true,
  };
}

/**
 * Whether the agent's own `Stop` closed a turn this server watched open
 * (Issue #2011, 対応 2).
 *
 * Both halves are required. `closedBy: 'stop'` rules out the five close reasons
 * that are the server's inference rather than the agent's word (`stale`,
 * `generation`, `session_end`, `scraper_evidence`, `resync_idle`), and
 * `closedAt > openedAt` rules out a `Stop` whose turn was never observed
 * opening — `recordAgentEvent` publishes `openedAt: null` for that, and a close
 * with nothing behind it is not a completion anybody watched.
 */
function hookClosedTurn(turn: PublishedTurn | null): boolean {
  if (turn === null) return false;
  const { closedBy, closedAt, openedAt } = turn;
  return closedBy === 'stop' && closedAt !== null && openedAt !== null && closedAt > openedAt;
}

/**
 * Build the current-output payload for a worktree session.
 *
 * @param db - Database instance
 * @param worktreeId - Worktree ID (assumed already validated by the caller)
 * @param cliToolId - CLI tool ID, ALREADY resolved by the caller
 * @param instanceId - Optional agent instance ID (defaults to the primary instance)
 * @param resolution - How the caller resolved that pair, when it resolved one
 *   (Issue #1884). Appended to the payload; nothing here reads it.
 */
export async function buildCurrentOutput(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  resolution?: SessionTargetResolution,
): Promise<CurrentOutputPayload> {
  const payload = await buildPayload(db, worktreeId, cliToolId, instanceId);
  if (!resolution) return payload;
  return {
    ...payload,
    resolvedBy: resolution.resolvedBy,
    // Explicit null rather than an absent key: `capture --json | jq '.conflict'`
    // must answer "no contradiction" rather than nothing at all, exactly as
    // `model` does.
    conflict: resolution.conflict ?? null,
  };
}

/**
 * The payload itself, with no knowledge of how its (tool, instance) pair was
 * chosen. Split from {@link buildCurrentOutput} so the resolution fields are
 * appended in one place instead of at both of the two return sites below.
 */
async function buildPayload(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): Promise<CurrentOutputPayload> {
  const resolvedInstanceId = instanceId ?? cliToolId;
  const manager = CLIToolManager.getInstance();
  const cliTool = manager.getTool(cliToolId);

  const stopEventAt = getLastStopEventAt(worktreeId, cliToolId, instanceId);
  const lastEvent = getLastAgentEvent(worktreeId, cliToolId, instanceId);
  // Issue #1924: the registry answers for every tool — a real implementation
  // when there is one, the compatibility source otherwise — so this needs no
  // null branch and never names a tool.
  const eventSource = getAgentEventSource(cliToolId);
  const now = Date.now();
  const pendingDecisions = getPendingDecisions(worktreeId, cliToolId, instanceId, now);
  const structuredEvents: StructuredEventsPayload = {
    lastEventType: lastEvent?.event ?? null,
    lastEventAt: lastEvent?.at ?? null,
    lastEventDetail: lastEvent?.detail ?? null,
    // Issue #1926 published these; Issue #1930 made them a real record. Read
    // before the `isRunning` branch so both return paths carry the turn fields.
    ...getPublishedAgentTurn(worktreeId, cliToolId, instanceId, now),
    // Issue #1930. `deliveryExpired` is computed HERE and only here, because
    // this is the layer that holds both halves: the record's age, and the
    // source's declared `decisionTimeoutSeconds`. `agent-event-state` cannot
    // reach the registry — its module graph pulls in `better-sqlite3` — which
    // is why every capability arrives there as a value a caller hands over.
    pendingDecisions: pendingDecisions.map((decision) => ({
      id: decision.decisionId,
      at: decision.at,
      source: decision.source,
      toolName: decision.toolName,
      confirmedAt: decision.confirmedAt,
      scraperCorroborated: decision.scraperCorroborated,
      deliveryExpired: isDeliveryExpired(
        decision,
        eventSource.capabilities.decisionTimeoutSeconds,
        now
      ),
    })),
    dedupDropped: getAgentEventDropCounts(worktreeId, cliToolId, instanceId),
    dialogPendingMaxMs: { ...DIALOG_PENDING_MAX_MS },
    promptWaitingSince: null,
    promptWaitingSource: null,
    // Issue #1902. Read here, before the `isRunning` branch, so both return
    // paths carry it.
    toolInputNormalization: getLastToolInputNormalization(worktreeId, cliToolId, instanceId),
    // Issue #1898, the same shape and for the same reason: an automatic verdict
    // this server delivered on the agent's behalf is invisible to the operator
    // otherwise. Exposure only — the dialog state is `promptWaitingSince` /
    // `isPromptWaiting`, and nothing reads this back to decide anything.
    permissionDecision: getLastPermissionDecision(worktreeId, cliToolId, instanceId),
    source: {
      cliToolId: eventSource.cliToolId,
      capabilities: eventSource.capabilities,
    },
  };

  const running = await cliTool.isRunning(worktreeId, instanceId);
  if (!running) {
    // Issue #1926: the latch describes a process, and this one is gone. Dropped
    // rather than aged out so the next session on this key starts with no
    // history instead of inheriting the last one's verdict.
    forgetLastKnownStatus(buildCompositeKey(worktreeId, cliToolId, instanceId));
    return {
      isRunning: false,
      content: '',
      lineCount: 0,
      cliToolId,
      sessionStatus: 'idle',
      sessionStatusReason: 'session_not_running',
      // Issue #1926: `'positive'` is not a formality here. tmux was asked and
      // answered — the absence of the session is a fact this layer observed,
      // not a pattern that failed to match, which is the whole distinction §4 D1
      // is drawing.
      statusEvidence: 'positive',
      lastKnownStatus: null,
      lastKnownStatusAt: null,
      lastStopEventAt: stopEventAt,
      structuredEvents,
      // Issue #1785: null on a dead session, not the last model it ran. The
      // latch outlives the process that filled it (by design — see
      // getLastKnownAgentModel), so reporting it here would tell `commandmate
      // instances` that a `RUNNING no` row is on gpt-5.6. The same holds for
      // the effort, whose scraped half never expires either: dropping both is
      // the server's job, done here and in exactly one place.
      model: null,
      reasoningEffort: null,
      // Issue #1695: the real tally, not zeros — and deliberately unlike the two
      // fields above. A model latch describes a process, so on a dead session it
      // would assert something false; a skip count describes what already
      // happened, and `lastSkippedAt` dates it. Zeroing it here would erase the
      // evidence at exactly the moment an operator goes looking for it — the
      // session ended and the prompt they were waiting on was never saved.
      promptDedup: getPromptDedupSkips(worktreeId, cliToolId, instanceId),
      // Issue #1839: there is no frame to read, so there is nothing to report.
      // Unlike `promptDedup` this is not a tally of what already happened — it
      // is a claim about what is on screen right now, and a dead session has no
      // screen.
      upstreamFault: null,
      // Issue #1879: same reasoning as `upstreamFault` — there is no input box
      // on a session that is not running, so there is nothing to report and
      // nothing the UI could act on.
      composerText: null,
      composerState: 'no_composer',
    };
  }

  const sessionState = getSessionState(db, worktreeId, resolvedInstanceId);
  const lastCapturedLine = sessionState?.lastCapturedLine || 0;

  const output = await captureSessionOutput(worktreeId, cliToolId, STATUS_CAPTURE_LINES, instanceId);
  const lines = output.split('\n');
  const totalLines = lines.length;

  // Issue #1670: `content` is "everything the poller has not saved yet", which
  // only works while `lastCapturedLine` indexes into `lines`. Once the capture is
  // clipped by the window the cursor is stale by an unknown amount, and slicing at
  // it collapses `content` to the last row or two — which is what `commandmate
  // capture <id>` prints, so a long-lived codex session returned an empty capture.
  // The window can only have slid forward, so 0 is the sole safe clamp; the result
  // is a superset (it may repeat already-saved rows) and never drops new output.
  //
  // The effective window is the smaller of what this path asks for and what the
  // capture layer will ever fetch — captureSessionOutput() reads at most
  // CACHE_MAX_CAPTURE_LINES regardless of the request.
  const captureWindowSaturated = isCaptureWindowSaturated(
    totalLines,
    Math.min(STATUS_CAPTURE_LINES, CACHE_MAX_CAPTURE_LINES),
  );

  // Issue #1910: saturation of the capture WINDOW is only one of the two ways
  // the cursor dies, and it is the one that never fires for the alternate-screen
  // tools — their pane is 1000 rows (claude / copilot) or 200 (opencode), so a
  // 10000-line window is never reached and the branch above stayed false
  // forever. Meanwhile the poller stores `lastCapturedLine` for them too
  // (`updateSessionState` is called unconditionally; only the DEDUP comparison
  // is gated on the tool, response-checker.ts), so after one turn the stored
  // value is the pane height, `slice()` starts past the last row, and `content`
  // — the field `commandmate capture <id>` prints — was an empty string.
  // `capturedLineCountIsCursor` states both conditions in one place.
  const lineCountIsCursor = capturedLineCountIsCursor(cliToolId, captureWindowSaturated);
  const newLines = lineCountIsCursor ? lines.slice(Math.max(0, lastCapturedLine)) : lines;
  const newContent = newLines.join('\n');

  const compositeKey = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const lastServerResponseTimestamp = getLastServerResponseTimestamp(compositeKey);
  const lastOutputTimestamp = lastServerResponseTimestamp ? new Date(lastServerResponseTimestamp) : undefined;

  const statusResult = detectSessionStatus(output, cliToolId, lastOutputTimestamp);
  // Issue #1912: every `running` reason that means "the agent is producing
  // output", not just `thinking_indicator`. opencode answers
  // `opencode_processing_indicator` for its `esc interrupt` footer, which is
  // the only signal it gives between the submitted prompt and the first
  // transcript row — on a scraper-only session that stretch showed no
  // thinking indicator at all.
  const thinking = isGeneratingStatus(statusResult);
  const scraperPromptWaiting = statusResult.hasActivePrompt;
  const isSelectionListActive =
    statusResult.status === 'waiting' && SELECTION_LIST_REASONS.has(statusResult.reason);
  const isPagerActive = statusResult.reason === STATUS_REASON.CODEX_PAGER;
  // Issue #1497: the detection-independent nav hatch (#1017/#1494) is gated on
  // isUnclassifiedActive. A static, unrecognized TUI overlay (e.g. Claude `/help`)
  // whose frame stops changing degrades from `running`/`default` to
  // `no_recent_output` once the Auto-Yes poller has stamped lastOutputTimestamp
  // (its sole writer, auto-yes-poller.ts). That is still an interactive-but-
  // unclassified frame — a real idle prompt (`❯`) is classified earlier as
  // `input_prompt`, never as `no_recent_output` — so treat the timed-out fallback
  // as unclassified too and keep the hatch open instead of stranding the user.
  // Issue #1924, §4 D1 decision 2: stated as evidence. Issue #1927 moved that
  // PRODUCER into the detector, because only the detector knows which rule
  // answered — `input_prompt` is positive for a tool whose idle rule vouched for
  // the frame and `'none'` for one whose rule declined, with the same status and
  // the same reason on the wire.
  const evidence: StatusEvidence = statusResult.evidence;
  // Issue #2011: the flag is NOT that fact, and deriving it from `evidence` is
  // the regression this Issue fixes. `'none'` is "I could not prove this pane is
  // idle" — an ordinary Claude composer with no completion marker above it
  // qualifies, and 7 of 8 live idle panes did on 2026-08-24. The flag's three
  // consumers all ask the older, narrower question instead: `TerminalEscapeHatch`
  // opens on a frame a human has to drive by hand, `wait` suppresses its
  // completion check and eventually exits 10 on one, and `unclassified_frames`
  // records it as a detection failure worth capturing as a fixture. That is
  // `isUnclassifiedFrame` — the reason vocabulary, not the strength of the
  // evidence behind a readable verdict.
  const isUnclassifiedActive = isUnclassifiedFrame(statusResult.status, statusResult.reason);

  // Issue #1723: the two-layer merge. Everything above this line is the string
  // analysis, unchanged and still the only source on a machine where no hook
  // ever fires — `getStructuredSessionState` answers null there, and
  // `mergeStructuredStatus` then returns the scraper's verdict untouched.
  // Issue #1930: the screen's own half of "is this turn over". Fed BEFORE the
  // structured state is read so a poll that closes the turn is the poll that
  // reports it, and fed with the SCRAPER's verdict rather than the merged one —
  // reading the merge back would be circular, since the merge is where this
  // layer's `running` overrides the frame.
  //
  // What this buys is a bound on a lost `Stop` far shorter than the 30-minute
  // staleness rule: three consecutive frames that positively read as a finished
  // composer retire the structured `running`, and the pane goes back to being
  // the scraper's to describe. What it deliberately does NOT do is complete a
  // `commandmate wait` — see SCRAPER_COMPLETION_POLLS, and #1839's measurement
  // of a 529 storm returning Claude to exactly this frame having run nothing.
  observeScraperCompletionEvidence(
    worktreeId,
    cliToolId,
    instanceId,
    statusResult.status === 'ready' && evidence === 'positive'
  );

  const structured = getStructuredSessionState(worktreeId, cliToolId, instanceId);

  // Issue #1725: the open-dialog half of the same merge, resolved before the
  // status merge because it decides one of its inputs. The rule itself — the
  // asymmetric release and the OR below — lives in `prompt-waiting-composition`
  // since Issue #1737, because the `send` guard has to reach the same verdict
  // and a second copy here is exactly how the two answers diverged.
  const promptResolution = resolvePromptWaiting({
    worktreeId,
    cliToolId,
    instanceId,
    scraper: {
      status: statusResult.status,
      reason: statusResult.reason,
      hasActivePrompt: scraperPromptWaiting,
    },
  });
  const promptWaiting = promptResolution.structured;
  if (promptWaiting !== null) {
    structuredEvents.promptWaitingSince = promptWaiting.at;
    structuredEvents.promptWaitingSource = promptWaiting.source;
  }

  const merged = mergeStructuredStatus(
    {
      status: statusResult.status,
      reason: statusResult.reason,
      thinking,
      evidence,
      isUnclassifiedActive,
    },
    structured,
    promptWaiting,
    // Issue #2011: the same record `structuredEvents` publishes, read once. The
    // merge needs `closedBy` / `closedAt` / `openedAt`, which
    // `StructuredSessionState` folds away into `hook_stop` — and the folded form
    // cannot tell a `Stop` that closed a watched turn from one that arrived with
    // no turn open.
    structuredEvents,
  );

  // The OR rule, computed once for the whole server (Issue #1737): this is the
  // same `resolvePromptWaiting` call the `send` guard makes, so the payload and
  // the guard cannot disagree about whether a prompt is open. What they are
  // still allowed to differ on is what to DO about it — see `blocksSend`, which
  // bounds the structured layer's veto over sends and leaves this flag alone.
  const isPromptWaiting = promptResolution.waiting;

  // Issue #1726: the agent's own account of what it asked. It contributes only
  // where some other layer has already established that a dialog is on screen —
  // this record decides no status of its own, because Claude emits nothing at
  // all while an AskUserQuestion picker is up (§5.6) and a record that asserted
  // `waiting` from the invocation would go on asserting it long after a human
  // answered in the terminal.
  const askUserQuestion = getAskUserQuestion(worktreeId, cliToolId, instanceId);
  const scraperPromptData = statusResult.promptDetection.promptData;
  const correctedPromptData =
    scraperPromptData && askUserQuestion
      ? applyAskUserQuestion(scraperPromptData, askUserQuestion.spec)
      : null;

  // The degraded form, for a dialog only the structured layer can see. Enriched
  // with the question text when one is in flight — that turns "a dialog is open
  // and nobody could read it" into "a dialog is open and here is what it asks".
  //
  // Issue #1898 adds the replies the dialog accepts, for the sources that can be
  // answered without touching the pane. The gate is `eventIdentity`: a source
  // that publishes a per-decision id is a source whose approval can be answered
  // by that id, which is what makes an option NUMBER here mean something other
  // than a line on a screen nobody parsed. `source === 'notification'` narrows
  // it to a dialog the agent actually reported — a `permission-request` record
  // is a prediction, and a question is answered with a choice rather than with
  // one of these three verdicts.
  const decisionOptions =
    promptWaiting !== null &&
    promptWaiting.source === 'notification' &&
    eventSource.capabilities.eventIdentity === 'permission-id'
      ? STRUCTURED_DECISION_OPTIONS
      : null;

  const structuredFacts: StructuredPromptFacts | null =
    promptWaiting === null
      ? null
      : {
          ...promptWaiting,
          askUserQuestion: summarizeAskUserQuestion(askUserQuestion),
          decisionOptions,
        };

  const promptData: PromptData | StructuredPromptWaitingData | null = scraperPromptWaiting
    ? correctedPromptData ??
      scraperPromptData ??
      (structuredFacts ? buildStructuredPromptData(worktreeId, structuredFacts) : null)
    : structuredFacts
      ? buildStructuredPromptData(worktreeId, structuredFacts)
      : null;

  // Issue #1723 §3: the field data this Epic is being built on. Every line is
  // one poll where the screen and the agent disagreed about what the agent was
  // doing, which is the only way to answer "how wrong was the scraper?" with a
  // number instead of an anecdote. Emitted only on disagreement — a session
  // where the two layers agree is silent — and including the disagreements this
  // merge deliberately does NOT act on (`applied: false`), because those are
  // exactly the cases the next Issues in the Epic have to decide about.
  if (structured !== null && structured.status !== statusResult.status) {
    logger.info('detection-divergence', {
      worktreeId,
      cliToolId,
      instanceId: resolvedInstanceId,
      scraperStatus: statusResult.status,
      scraperReason: statusResult.reason,
      structuredStatus: structured.status,
      structuredReason: structured.reason,
      structuredEvent: structured.event,
      structuredEventAt: structured.at,
      applied: merged.structuredApplied,
    });
  }

  // Issue #1708: a frame nothing could classify left no trace anywhere. Both
  // prompt-history writers (response-checker's pending row and
  // recordAnsweredPrompt) are gated on `promptDetection.isPrompt === true`, so
  // the only evidence a worker had stalled was the live pane — and `capture
  // --prompts` answered "No prompt history." for a session that had been stuck
  // for 900s. Record the failure itself, once, after it has persisted.
  //
  // Recorded here because this is the one place the flag is computed, and both
  // the HTTP pull and the WebSocket push run through it, so the row appears at
  // whatever cadence the session is actually being watched at.
  //
  // Fed the MERGED flag (#1723): a frame the structured layer classified is not
  // an unclassified frame, and writing a "detection failed" row for a turn the
  // agent itself told us had ended would put a false stall into the audit trail
  // `capture --prompts` prints.
  const unclassifiedVerdict = observeUnclassifiedFrame(compositeKey, merged.isUnclassifiedActive);
  if (unclassifiedVerdict.shouldRecord) {
    recordUnclassifiedFrame(db, {
      worktreeId,
      cliToolId,
      instanceId: resolvedInstanceId,
      dwellMs: unclassifiedVerdict.dwellMs,
      sessionStatus: merged.status,
      sessionStatusReason: merged.reason,
    });
  }

  // Issue #1725: the structured layer saw a dialog the scraper did not. That
  // gap is the fact worth keeping — see recordStructuredPrompt.
  if (promptWaiting !== null && structuredFacts !== null && !scraperPromptWaiting && !promptWaiting.recorded) {
    markStructuredPromptRecorded(worktreeId, cliToolId, instanceId);
    recordStructuredPrompt(db, {
      worktreeId,
      cliToolId,
      instanceId: resolvedInstanceId,
      state: promptWaiting,
      facts: structuredFacts,
    });
  }

  // Issue #1879: structural, and computed here next to the other frame readers
  // rather than inside a status branch — the bar it feeds must appear on the
  // strength of what is in the box, never on the strength of a status verdict.
  const composer = extractComposerText(output, cliToolId);

  const realtimeSnippet = lines.slice(-100).join('\n');
  // Issue #1839: judged on exactly what is published as `realtimeSnippet`, not
  // on `output`. The wider capture keeps a banner from an hour ago in scope, and
  // a fault the operator cannot see in the payload next to it is unverifiable.
  const upstreamFaultMatch = matchUpstreamFault(realtimeSnippet);
  const autoYesState = getAutoYesState(worktreeId, cliToolId, instanceId);

  // Issue #1785 + #1784: ONE resolution for both halves, not two readers.
  //
  // `getResolvedAgentModelInfo` is the reader #1784 documents as "the single
  // answer both surfaces should read", and it is already what the list API
  // publishes (`worktree-status-helper`). Reading the model off the hook latch
  // here while taking the effort from the resolver would let this payload
  // publish an effort with no model — the exact shape `buildModelByInstance`
  // calls "unreachable through the API" — on a claude session whose banner the
  // poller scraped before its first `SessionStart` hook arrived. It also folds
  // in antigravity's rule that the effort comes from the model id, which a bare
  // read of the scraped half would drop.
  const { model, effort } = getResolvedAgentModelInfo(worktreeId, cliToolId, instanceId);

  // Issue #1926, §7: fed the MERGED verdict, for the reason the unclassified
  // tracker above is — this is the verdict that gets published, so latching the
  // scraper's raw reading would make `lastKnownStatus` disagree with the
  // `sessionStatus` it sat next to one poll earlier. Observed before it is read
  // so a positive poll reports itself, which is what keeps the field from
  // looking stale on a healthy session.
  observeStatusEvidence(compositeKey, {
    status: merged.status,
    reason: merged.reason,
    evidence: merged.evidence,
  });
  const lastKnown = getLastKnownStatus(compositeKey);

  return {
    isRunning: true,
    cliToolId,
    sessionStatus: merged.status,
    sessionStatusReason: merged.reason,
    content: newContent,
    fullOutput: output,
    realtimeSnippet,
    lineCount: totalLines,
    lastCapturedLine,
    isComplete: isPromptWaiting,
    isGenerating: merged.thinking,
    thinking: merged.thinking,
    thinkingMessage: merged.thinking ? 'Claude is thinking...' : null,
    isPromptWaiting,
    promptData,
    autoYes: {
      enabled: autoYesState?.enabled ?? false,
      expiresAt: autoYesState?.enabled ? autoYesState.expiresAt : null,
      stopReason: autoYesState?.stopReason,
      lastSuppression: getLastPolicySuppression(worktreeId, cliToolId, instanceId),
      // Issue #1694: undefined (so the key is absent from the JSON) unless a
      // stop pattern actually fired — the state clears it on every other path.
      stopMatchedText: autoYesState?.stopMatchedText,
    },
    isSelectionListActive,
    isPagerActive,
    isUnclassifiedActive: merged.isUnclassifiedActive,
    // Issue #1926: the same fact `isUnclassifiedActive` carries, named the way
    // §4 D1 names it. Published from the merged verdict so the two cannot
    // disagree on the wire.
    statusEvidence: merged.evidence,
    lastKnownStatus: lastKnown?.status ?? null,
    lastKnownStatusAt: lastKnown?.at ?? null,
    lastServerResponseTimestamp,
    serverPollerActive: isPollerActive(compositeKey),
    lastStopEventAt: stopEventAt,
    structuredEvents,
    // Issue #1785: straight from the retention layer, unparsed. See the field
    // docs on CurrentOutputPayload for why nothing is normalised on the way out.
    model,
    reasoningEffort: effort,
    // Issue #1695: appended last on purpose — every field above is a published
    // CLI contract and reordering them churns the diff for no reader's benefit.
    promptDedup: getPromptDedupSkips(worktreeId, cliToolId, instanceId),
    // Issue #1839: read from `realtimeSnippet`, the same rows an operator sees
    // in `capture --json`, so what the field claims can be checked against what
    // is printed next to it.
    upstreamFault: upstreamFaultMatch
      ? {
          id: upstreamFaultMatch.fault.id,
          matchedText: upstreamFaultMatch.matchedText,
          at: Date.now(),
        }
      : null,
    // Issue #1879: read from `output` — the RAW capture, still carrying the SGR
    // attributes `capture-pane -e` fetched. Everything else in this function
    // works on stripped text; this one deliberately does not, because dim is the
    // only thing that separates Claude's ghost suggestion from text a human
    // typed. Do not "tidy" this to read a stripped variable.
    composerText: composer.state === 'content' ? composer.text : null,
    composerState: composer.state,
  };
}
