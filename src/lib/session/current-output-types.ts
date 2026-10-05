/**
 * The shapes `buildCurrentOutput` publishes (Issue #3215).
 *
 * Types only: no function, no constant, nothing that exists at runtime. Moved
 * verbatim out of `current-output-builder`, which re-exports every name here,
 * so an import from either module reads the same declaration.
 */

import type { ComposerTextState } from '@/lib/detection/composer-text';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type {
  SessionTargetConflict,
  SessionTargetResolvedBy,
} from '@/lib/session/resolve-session-target';
import type { PermissionDecisionRecord } from '@/lib/hooks/permission-decision-state';
import type { ToolInputNormalizationRecord } from '@/lib/hooks/tool-input-normalization-state';
import type {
  AgentSessionContextUsage,
  AgentSessionRecord,
} from '@/lib/hooks/agent-session-telemetry';
import type { PendingDecisionKind } from '@/lib/hooks/pending-decision-kind';
import type { OpencodeSessionDiffRecord } from '@/lib/hooks/sources/opencode/diff';
import type {
  AgentEventSourceStatus,
  AgentSourceCapabilities,
} from '@/lib/hooks/sources/types';
import type { AutoYesPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import type { PromptDedupSkips } from '@/lib/polling/prompt-dedup-state';
import type { AgentEventDropCounts } from '@/lib/session/agent-event-state';
import type { PublishedTurn } from '@/lib/session/provisional-turn';
import type { StatusEvidence } from '@/lib/session/status-evidence';
import type { PromptView } from '@/lib/session/prompt-view';
import type {
  StructuredPromptSource,
  StructuredPromptWaitingData,
} from '@/lib/session/structured-prompt';
import type { PromptData } from '@/types/models';
import type { AgentMode } from '@/types/cli-tool-contracts';
import type { DetectorStaleness } from '@/lib/detection/version-probes';

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
   * What the agent says about the conversation this instance is in, or null
   * (Issue #2040).
   *
   * The half of a worker's state a terminal frame cannot show: which session,
   * which persona, which model, what it has cost and how many tokens it has
   * spent. Read off opencode's `session.updated` frames, which were already
   * arriving and mapped to none of the seven event words — so this costs no
   * request and no poll. OpenCode V2 (`opencode-v2`, Issue #2981) fills the
   * same record from `GET /api/session/{id}` whenever `session.usage.updated`
   * or the end of a turn arrives.
   *
   * **Sent on every payload this build produces, null when nothing knows** —
   * which is every tool but opencode / opencode-v2, every such pane whose stream has not
   * reported a session yet, and every pane that has been killed since it did.
   * See {@link AgentSessionRecord} for the field-by-field contract and for why
   * the values are verbatim.
   *
   * Optional on the type for the reason `pendingDecisions` below is, stated
   * once there: this shape is also *constructed* — by suites that stand in for
   * the builder, and by the CLI's mirror in `api-responses.ts`, which has to
   * describe a server older than the field as well as one newer. A reader takes
   * `?? null`.
   */
  session?: AgentSessionRecord | null;
  /**
   * How full this instance's context window is, or null (Issue #2042).
   *
   * The one number {@link session} cannot answer. `Session.tokens` is the
   * session's *cumulative* spend — the figure `opencode stats` prints — while
   * "how much of the window is in use" is the last finished assistant turn's
   * footprint, which is a different quantity and a smaller one. Summing the
   * record would have published `2%` where opencode's own footer says `1%`, so
   * this block is measured separately rather than derived from a field that
   * looks like it should work.
   *
   * **Derived, and separated for that reason.** Everything on {@link session} is
   * a value the agent published on a frame; everything here is this server
   * asking the agent's own server two further questions
   * (`GET /session/:id/message?limit=4` and `GET /config/providers`) and doing
   * arithmetic on the answers. Folding the two together would make one object a
   * mixture of quoted and computed values.
   *
   * **Always present, null while nothing has been measured.** The measurement
   * is refreshed off the hot path — the poll that notices the session moved
   * publishes the previous turn's numbers (or null on the first one) and the
   * next poll publishes the new ones. OpenCode V2 measures it in the refresh
   * that writes {@link session} (Issue #2981). Null forever for every other tool.
   *
   * Optional on the type for the reason `pendingDecisions` below is.
   */
  sessionContext?: AgentSessionContextUsage | null;

  /**
   * What the last opencode turn changed on disk, and what a revert is holding
   * back (Issue #2043). Omitted-as-null for every other tool.
   *
   * A third key beside {@link session} and {@link sessionContext} rather than a
   * field on either, because it answers a different kind of question: those two
   * describe the *conversation*, this one describes the **working tree**. It is
   * also the only one of the three the operator can act on — the panel it feeds
   * offers revert / unrevert.
   *
   * Mirrors: src/lib/hooks/sources/opencode/diff.ts OpencodeSessionDiffRecord.
   */
  sessionDiff?: OpencodeSessionDiffRecord | null;
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

/** One choice a pending question offers, as it is published (Issue #2040). */
export interface PendingQuestionOptionPayload {
  /** 1-based, in the order the agent's own payload listed the choices. */
  number: number;
  /** The choice's label, verbatim. This is also what answering it sends. */
  label: string;
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
  /**
   * Whether a human is being asked to approve or to choose (Issue #2040).
   *
   * The two block a worker identically and are answered completely differently,
   * so an orchestrator reading `capture --json` has to be able to tell them
   * apart before it decides whether a verdict is even meaningful. Recovered from
   * what the writers already record rather than stored — see
   * `lib/hooks/pending-decision-kind` for why, and for the one place that says
   * how.
   *
   * **Always present.** Unlike the optional fields on
   * {@link StructuredEventsPayload}, this one is per-entry: an entry that exists
   * at all comes from this build, so there is no older-server case for a reader
   * to interpret an absence as.
   */
  kind: PendingDecisionKind;
  /**
   * The choices this question offers, or null (Issue #2040).
   *
   * Null on every approval — an approval's three verdicts are the source's, not
   * this dialog's, and they are published as `promptData.decisionOptions` where
   * they belong. Null on a question too whenever the agent's own payload is no
   * longer held: the numbers here are the payload's order, so publishing them
   * from anything else would number a list the agent never sent.
   *
   * **One in-flight question per instance is all this can describe.** The
   * payload is `getAskUserQuestion`'s single episode, so two concurrent
   * questions on one instance would both quote it. Not observed — every
   * captured `question.asked` carries one call, and an agent asks one thing at a
   * time — and stated here rather than guarded, because the guard would have to
   * invent which episode belongs to which record.
   */
  questionOptions: PendingQuestionOptionPayload[] | null;
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
  /**
   * Which machinery is speaking for THIS pane right now (Issue #2054).
   *
   * Additive, and the two fields above are untouched: #1924's readers keep
   * reading exactly what they read. The difference between this and
   * {@link capabilities} is instant versus declaration — capabilities say what
   * opencode's source can do, `kind` says whether it is currently doing it, and
   * on a pane whose port was taken over by another process the answer is
   * `scraper` while every capability above still describes the SSE source.
   *
   * `degradedReason` and `liveness` are absent for every push tool, by
   * construction rather than by omission — see {@link describeAgentEventSource}.
   */
  kind: AgentEventSourceStatus['kind'];
  /** Issue #2054. Absent unless something is degraded. */
  degradedReason?: string;
  /** Issue #2054. Absent for a source with no heartbeat to miss. */
  liveness?: AgentEventSourceStatus['liveness'];
  /**
   * What `AgentEventSource.probeActivity` answered when this instance's stream
   * was last attached, or null (Issue #2054).
   *
   * **A record of one instant, not a live reading**, which is why it carries its
   * own `at` and why nothing derives a status from it: a stream that opens in
   * the middle of a turn delivers nothing until that turn ends, so this is the
   * only answer to "was the pane already working when CommandMate connected?"
   * that exists — and it stops being current the moment the next frame lands.
   *
   * Null for every tool but opencode (`probeActivity` answers null for a push
   * source by construction: an event cannot be re-read) and for an opencode
   * instance whose stream has never been attached in this process.
   */
  probedActivity: { activity: 'busy' | 'idle' | null; at: number } | null;
}

export interface CurrentOutputPayload {
  isRunning: boolean;
  cliToolId: CLIToolType;
  /**
   * The tmux session name this instance actually runs (or would run) under
   * (Issue #2886).
   *
   * `CLIToolManager.getTool(cliToolId).getSessionName(worktreeId, instanceId)`
   * verbatim — the same call every route already makes to reach the pane, so
   * this is the name a namespaced server (#2866) actually bound, adopted
   * legacy name included, never the `mcbd-${cliToolId}-${worktreeId}` a reader
   * would have to reconstruct. `orchestrate-monitor`'s `monitor.sh` reads this
   * field first and falls back to rebuilding the legacy shape only when it is
   * absent (an older server).
   *
   * Always present, computed independently of {@link isRunning}: the name is a
   * pure function of (tool, worktree, instance, namespace), not a fact about
   * the tmux session's existence.
   */
  sessionName: string;
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
  /**
   * Whether `/prompt-response` would answer the published prompt right now
   * (Issue #2870): `assessPromptAnswerability(...).refusal === null` on the same
   * capture. Present only when `promptData` is the screen-parsed prompt; absent
   * with no prompt and for the structured (hook / degraded) forms. `false` means
   * the UI must not offer Send — the route would refuse it.
   */
  promptAnswerable?: boolean;
  /**
   * How {@link promptData} is shown and answered, decided once (Issue #3184):
   * `derivePromptView(promptData)`, null when there is no prompt. Optional so the
   * early payloads (session not running) may omit it; absent reads as null. Readers
   * take this instead of combining `type` / `decisionOptions` / `decisionId`
   * themselves; a CLI talking to a server older than #3184 derives the same
   * value from `promptData` (`readPromptView`).
   */
  promptView?: PromptView | null;
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
  /**
   * Issue #2369: a dismiss-only overlay is on the pane — the frame's footer
   * offers `Esc to close` and nothing else.
   *
   * NOT a subset of {@link isSelectionListActive} (which `isPagerActive` is):
   * this screen has no highlight, so the two are disjoint by construction and a
   * consumer must not read one for the other. The chat surface answers it with
   * a single Esc button; a consumer that does not know the field sees the same
   * `waiting` it would have seen anyway.
   */
  isDismissablePanelActive?: boolean;
  isUnclassifiedActive?: boolean;
  /**
   * Epoch ms this instance's launch began, or null when it is not starting
   * (Issue #3179).
   *
   * Non-null from `beginAgentSession` until `startSession` returns or throws,
   * bounded by the tool's readiness wait and released early by a dialog the
   * launch does not answer — see `lib/session/session-starting-state`. While it
   * is non-null the status is `running` / `starting` and `isPromptWaiting`,
   * `isSelectionListActive`, `isPagerActive`, `isDismissablePanelActive` and
   * `isUnclassifiedActive` are all false: the frame under a launch is a shell
   * prompt and the launch line, or a trust dialog the launch answers itself,
   * and nobody has to drive it. The screen shows "<agent> を起動中…" instead.
   *
   * Optional on the type for a server that predates the field; this builder
   * always sets it.
   */
  startingSince?: number | null;
  /**
   * Whether {@link sessionStatus} rests on something positive (Issue #1926,
   * §4 D1 / §7).
   *
   * **Always present.** `capture --json | jq -r '.statusEvidence'` has to answer
   * for every session, including one that is not running, because the question
   * it settles — "did anything actually confirm this?" — is exactly the question
   * an operator asks of a verdict they distrust.
   *
   * It is NOT the inverse of {@link isUnclassifiedActive} (Issue #2011): this
   * asks whether a rule positively vouched for the verdict, while the flag asks
   * whether any rule could read the frame at all, so an idle composer can be
   * `'none'` and still classified. This one is the reading Phase 3 widens per
   * tool; the flag is the older CLI contract (`wait`'s completion rule).
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
   * A second column sharing rows with the agent's transcript, or null
   * (Issue #2095).
   *
   * **Always present, null when nothing matched.** Read
   * `src/lib/detection/opencode-pane-obstruction.ts` before reading this field:
   * null is "the frame's layout could not be read as two columns", NEVER "the
   * screen is clean". A permission dialog removes the border row the geometry is
   * measured from, and a tool other than opencode is not looked at at all.
   *
   * Deliberately shaped like {@link upstreamFault} — `{id, matchedText, at}`,
   * judged on `realtimeSnippet`, published on every poll and read by nobody by
   * default. The two answer the same kind of question ("something the detector
   * cannot fix is on the screen, and here is the evidence"), and one shape means
   * `capture --json | jq` reads them the same way.
   *
   * Where it deliberately parts company with `upstreamFault` is `wait`: there is
   * no `--fail-on-pane-obstruction`. #1839 needed a verdict of its own because
   * the faulted frame read `ready` and `wait` was about to exit 0 on a turn that
   * never ran — the exit code was WRONG. Here the frame reads
   * `running` / `unknown_frame`, so `isUnclassifiedActive` is already true and
   * `wait` already stops on it (exit 10, `type: unclassified`) after its 60 s
   * dwell. The verdict was never wrong; what was missing was the CAUSE, so this
   * Issue adds the cause to that message and to the history row and leaves
   * every exit code exactly where it was.
   *
   * opencode only. Every other tool publishes null here without being examined.
   */
  paneObstruction: {
    /** {@link OpenCodePaneObstruction.id} — `opencode_sidebar`. */
    id: string;
    /** The second column's own text on the first row that carried it. */
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

/**
 * What `GET /api/worktrees/:id/current-output` returns (Issue #3229): the
 * builder's {@link CurrentOutputPayload} plus the two fields the route attaches
 * itself. `detector` is absent until the staleness cache is warm.
 */
export interface CurrentOutputResponseBody extends CurrentOutputPayload {
  agentMode: AgentMode;
  detector?: { staleness: DetectorStaleness };
}
