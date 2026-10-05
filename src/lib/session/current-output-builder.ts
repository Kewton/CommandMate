/**
 * Shared builder for the "current terminal output" payload (Issue #1120).
 *
 * Extracted from the GET /api/worktrees/[id]/current-output route so the exact
 * same payload can be produced by the server-side response poller and pushed
 * over WebSocket (terminal streaming), keeping the pull (HTTP) and push (WS)
 * paths byte-for-byte consistent (DRY).
 */

import type Database from 'better-sqlite3';
import { getSessionState } from '@/lib/db';
import { observeUnclassifiedFrame } from '@/lib/detection/unclassified-frame-tracker';
import {
  getSessionStartingSince,
  observeSessionStartingFrame,
  startingStatusResult,
} from '@/lib/session/session-starting-state';
import { extractComposerText } from '@/lib/detection/composer-text';
import { matchUpstreamFault } from '@/lib/detection/upstream-faults';
import {
  detectOpenCodePaneObstruction,
  type OpenCodePaneObstruction,
} from '@/lib/detection/opencode-pane-obstruction';
import { createLogger } from '@/lib/logger';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import {
  capturedLineCountIsCursor,
  getCliToolDisplayName,
  type CLIToolType,
} from '@/lib/cli-tools/types';
import { getAgentEventSource } from '@/lib/hooks/sources/registry';
import { describeAgentEventSource } from '@/lib/hooks/sources/define-source';
import type { AgentEventSource } from '@/lib/hooks/sources/types';
import { getOpencodeProbedActivity } from '@/lib/hooks/sources/opencode/subscription';
import { getLastPermissionDecision } from '@/lib/hooks/permission-decision-state';
import { getLastToolInputNormalization } from '@/lib/hooks/tool-input-normalization-state';
import {
  ensureAgentSessionContextUsage,
  getAgentSessionTelemetry,
} from '@/lib/hooks/agent-session-telemetry';
import { pendingDecisionKind } from '@/lib/hooks/pending-decision-kind';
import { ensureOpencodeSessionDiff } from '@/lib/hooks/sources/opencode/diff';
import { questionDecisionOptions } from '@/lib/hooks/structured-decision-response';
import { captureSessionOutput } from '@/lib/session/cli-session';
import {
  detectSessionStatus,
  STATUS_REASON,
  SELECTION_LIST_REASONS,
  isGeneratingStatus,
  type StatusDetectionResult,
} from '@/lib/detection/status-detector';
import {
  getAutoYesState,
  getLastServerResponseTimestamp,
  isPollerActive,
  buildCompositeKey,
} from '@/lib/polling/auto-yes-manager';
import { getLastPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import { getPromptDedupSkips } from '@/lib/polling/prompt-dedup-state';
import { STATUS_CAPTURE_LINES } from '@/config/status-capture-config';
import { CACHE_MAX_CAPTURE_LINES, isCaptureWindowSaturated } from '@/lib/tmux/tmux-capture-cache';
import { selectRealtimeSnippetRows } from '@/lib/realtime-snippet';
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
  type AskUserQuestionEpisode,
  type StructuredPromptWaitingState,
} from '@/lib/session/agent-event-state';
import {
  isApiAnswerableStructuredWait,
  resolvePromptWaiting,
} from '@/lib/session/prompt-waiting-composition';
import { DIALOG_PENDING_MAX_MS, isDeliveryExpired } from '@/lib/session/provisional-turn';
import {
  forgetLastKnownStatus,
  getLastKnownStatus,
  isUnclassifiedFrame,
  observeStatusEvidence,
  type StatusEvidence,
} from '@/lib/session/status-evidence';
import { applyAskUserQuestion } from '@/lib/session/ask-user-question-prompt';
import { derivePromptView } from '@/lib/session/prompt-view';
import { assessPromptAnswerability } from '@/lib/polling/auto-yes-dialog-gate';
import { classifyLayerDisagreement, reportLayerDisagreement } from '@/lib/session/layer-disagreement';
import {
  buildStructuredPromptData,
  hasApiAnswerableDecision,
  structuredDecisionOptionsFor,
  type StructuredPromptFacts,
  type StructuredPromptWaitingData,
} from '@/lib/session/structured-prompt';
import type { PromptData } from '@/types/models';
import type {
  StructuredEventsPayload,
  CurrentOutputPayload,
  SessionTargetResolution,
} from './current-output-types';
import { publishChatTurnProgress } from './chat-turn-progress';
import {
  mergeStructuredStatus,
  readNewestPromptAt,
  staleReadyCandidate,
  summarizeAskUserQuestion,
  type ScraperVerdict,
} from './structured-status-merge';
import { recordStructuredPrompt, recordUnclassifiedFrame } from './current-output-history-writers';

// Issue #3215: the response types live in `current-output-types`. Re-exported
// under the same names so every existing import of this module keeps resolving.
export type {
  StructuredEventsPayload,
  PendingQuestionOptionPayload,
  PendingDecisionPayload,
  StructuredSourcePayload,
  CurrentOutputPayload,
  SessionTargetResolution,
} from './current-output-types';

// Issue #3215: chat turn progress lives in `chat-turn-progress`. Re-exported
// under the same names so every existing import of this module keeps resolving.
export {
  buildChatTurnProgress,
  emitChatTurnProgress,
  resetChatTurnProgressState,
} from './chat-turn-progress';
export type {
  ChatTurnProgressTarget,
  ChatTurnProgressDraft,
  ChatTurnProgressSource,
} from './chat-turn-progress';

// Issue #3215: the status merge lives in `structured-status-merge`. Re-exported
// under the same names so every existing import of this module keeps resolving.
export { mergeStructuredStatus } from './structured-status-merge';
export type { ScraperVerdict, MergedStatusVerdict } from './structured-status-merge';

const logger = createLogger('current-output-builder');

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
  // Issue #2199. Fire-and-forget, and placed HERE rather than in the poller for
  // one reason: this is the function both live paths run through. The WebSocket
  // push calls it from `broadcastTerminalSnapshot` on every generating poller
  // tick, and the HTTP `/current-output` poll calls it at the same cadence when
  // the push is down — so the progress frames appear at whatever rate the
  // surface is actually being watched at, which is exactly the property the
  // terminal snapshot already has. Gated on the merged verdict (`'running'`, not
  // the tmux-session-exists `isRunning`) so an idle pane reads no transcript.
  // Issue #3179: not during a launch — there is no turn to publish yet.
  if (payload.isRunning && payload.sessionStatus === 'running' && payload.startingSince == null) {
    // Issue #2248 made this an `await`, and it buys less than it looks like: the
    // expensive half — the transcript read and the broadcast — is detached
    // inside, so what is waited for is a worktree row and a Map lookup. What it
    // buys is that the frame's outcome is logged against the tick that produced
    // it rather than whenever the event loop got round to the detached tail.
    await publishChatTurnProgress(db, worktreeId, cliToolId, instanceId);
  }
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

/** What {@link readAgentEvents} read, for the rest of {@link buildPayload}. */
interface AgentEventsRead {
  stopEventAt: number | null;
  eventSource: AgentEventSource;
  askUserQuestion: AskUserQuestionEpisode | null;
  structuredEvents: StructuredEventsPayload;
}

/**
 * The agent's own events for this session, read before the pane is looked at
 * (Issue #3215). Split out of {@link buildPayload} in the order it ran there:
 * nothing here awaits, and `structuredEvents` is the object both of its return
 * paths publish.
 */
function readAgentEvents(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  resolvedInstanceId: string,
): AgentEventsRead {
  const stopEventAt = getLastStopEventAt(worktreeId, cliToolId, instanceId);
  const lastEvent = getLastAgentEvent(worktreeId, cliToolId, instanceId);
  // Issue #1924: the registry answers for every tool — a real implementation
  // when there is one, the compatibility source otherwise — so this needs no
  // null branch and never names a tool.
  const eventSource = getAgentEventSource(cliToolId);
  const now = Date.now();
  const pendingDecisions = getPendingDecisions(worktreeId, cliToolId, instanceId, now);
  // Issue #1726's episode, read once at the same `now` the decisions were read
  // at. Issue #2040 needs it up here — a question's choices are published on the
  // decision entry — and the degraded prompt below re-uses this read rather than
  // taking a second one, so the two cannot describe different instants.
  const askUserQuestion = getAskUserQuestion(worktreeId, cliToolId, instanceId, now);
  // Issue #2040, read once: #2042's context measurement is keyed on this
  // record's `at`, so reading it twice would risk keying the derived block to a
  // different instant than the one it is published beside.
  const agentSession = getAgentSessionTelemetry(worktreeId, cliToolId, instanceId);
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
    pendingDecisions: pendingDecisions.map((decision) => {
      // Issue #2040. Recovered rather than stored — see `pending-decision-kind`.
      const kind = pendingDecisionKind(decision.toolName);
      return {
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
        kind,
        // Issue #2040: the agent's own list, numbered the way `respond` numbers
        // it — the same `questionDecisionOptions` the reply path resolves an
        // answer against (#2039), so what is printed here and what a number
        // means cannot come apart. Null for an approval and for a question whose
        // payload is no longer held; never a screen's numbering.
        questionOptions:
          kind === 'question' && askUserQuestion
            ? questionDecisionOptions(askUserQuestion.spec).map((option) => ({
                number: option.number,
                label: option.label,
              }))
            : null,
      };
    }),
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
      // Issue #2054. Read through the source interface — `liveness(target)` —
      // rather than through opencode's subscription map, so this layer keeps
      // naming no tool: every push source answers `{ state: 'unknown' }` from
      // `definePushHookSource` at no cost, and the fold that turns that into a
      // published `kind` is the same one `worktree-status-helper` calls.
      ...describeAgentEventSource(
        eventSource,
        eventSource.liveness({ worktreeId, cliToolId, instanceId: resolvedInstanceId }),
        now
      ),
      // Issue #2054: opencode-only by construction, and read from the module
      // that owns the attach. `./opencode/diff` is imported here for the same
      // reason (#2043) — the alternative is a field that exists on the wire and
      // is filled in by nothing.
      probedActivity: getOpencodeProbedActivity({
        worktreeId,
        cliToolId,
        instanceId: resolvedInstanceId,
      }),
    },
    // Issue #2040. Read here, before the `isRunning` branch, so both return
    // paths carry the key — but the record itself is dropped when the
    // subscription closes, so a pane that is not running answers null without
    // this layer needing a rule of its own.
    session: agentSession,
    // Issue #2042. `ensure…` never awaits: it answers from the cache and starts
    // a refresh only when the session record has moved since the last one, so
    // the two HTTP round trips it needs happen once per *turn* rather than once
    // per poll and never in front of this payload. See
    // `ensureAgentSessionContextUsage` for why that trade is the right way
    // round here.
    sessionContext: ensureAgentSessionContextUsage(
      { worktreeId, cliToolId, instanceId },
      agentSession
    ),
    // Issue #2043, on exactly #2042's terms: `ensure...` answers from the store
    // and starts at most one `GET /session/:id/diff` per *turn*, never in front
    // of this payload. It answers null for every tool but opencode, so no other
    // tool's status poll grows a field or a request.
    sessionDiff: ensureOpencodeSessionDiff({ worktreeId, cliToolId, instanceId }),
  };

  return { stopEventAt, eventSource, askUserQuestion, structuredEvents };
}

/** What {@link composePromptData} reads: the frame's verdict and both layers' records. */
interface PromptCompositionInput {
  worktreeId: string;
  cliToolId: CLIToolType;
  output: string;
  statusResult: StatusDetectionResult;
  startingSince: number | null;
  promptWaiting: StructuredPromptWaitingState | null;
  askUserQuestion: AskUserQuestionEpisode | null;
  eventSource: AgentEventSource;
}

/** What {@link composePromptData} composed, for the rest of {@link buildPayload}. */
interface PromptComposition {
  structuredFacts: StructuredPromptFacts | null;
  promptData: PromptData | StructuredPromptWaitingData | null;
  promptAnswerable: boolean | undefined;
}

/**
 * The prompt this payload publishes and the replies an approval accepts
 * (Issue #3215). Split out of {@link buildPayload} in the order it ran there;
 * every value below is derived from the arguments, and nothing is assigned
 * outside this function.
 */
function composePromptData({
  worktreeId,
  cliToolId,
  output,
  statusResult,
  startingSince,
  promptWaiting,
  askUserQuestion,
  eventSource,
}: PromptCompositionInput): PromptComposition {
  const scraperPromptWaiting = statusResult.hasActivePrompt;
  // Issue #1726: the agent's own account of what it asked. It contributes only
  // where some other layer has already established that a dialog is on screen —
  // this record decides no status of its own, because Claude emits nothing at
  // all while an AskUserQuestion picker is up (§5.6) and a record that asserted
  // `waiting` from the invocation would go on asserting it long after a human
  // answered in the terminal.
  // Issue #2040 moved the read to the top of `buildPayload` — `readAgentEvents`
  // takes it there today (the decision entries publish the same episode's
  // choices) — and this line now re-uses it, so the two surfaces cannot describe
  // different instants.
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
  //
  // Issue #2031 adds the fourth conjunct and folds the whole gate into ONE
  // value — today `promptWaiting !== null` here and the other three inside
  // `isApiAnswerableStructuredWait` (Issue #3215).
  // The three verdicts and the id they are delivered to are now derived
  // from the same expression, so they cannot be published apart — and "apart"
  // is not hypothetical, it is the state #1932 shipped: options were published
  // on the capability alone while `decisionId` was published nowhere at all, so
  // the panel drew no buttons and the only way out of an opencode approval in a
  // browser was the arrow-key safety net. Options WITHOUT an id is the worse
  // half of that pair — the numbers would reach the keystroke path, where a
  // bare "1" selects whatever the picker happens to be highlighting (#1681).
  const addressableDecisionId =
    promptWaiting !== null &&
    isApiAnswerableStructuredWait(promptWaiting, eventSource.capabilities.eventIdentity)
      ? promptWaiting.decisionId
      : null;
  // Issue #2100 splits the two halves of #2031's single expression, because an
  // addressable decision is now of two KINDS. The id is published for both — it
  // is what `POST /respond` names, and a question needs it exactly as much as an
  // approval does — but the three verdicts belong to an approval alone.
  //
  // Publishing both for a question is not a cosmetic error: it is precisely what
  // #2039's third gate refuses. `readPromptQuestionChoices` returns null the
  // moment `decisionOptions` is non-empty, so a question carrying them would
  // draw `Allow once / Allow always / Reject` over the agent's own choices, and
  // a verdict sent to a question is refused at the source
  // (`question-needs-answer-verdict`). The kind is recovered from the record the
  // same way `structuredEvents.pendingDecisions[].kind` is, through the one
  // reader in `pending-decision-kind`.
  const addressesQuestion =
    promptWaiting !== null && pendingDecisionKind(promptWaiting.toolName) === 'question';
  const decisionOptions =
    addressableDecisionId !== null && !addressesQuestion
      ? // Issue #2951: in the tool's own words (OpenCode V2: `Always allow`).
        structuredDecisionOptionsFor(cliToolId)
      : null;

  const structuredFacts: StructuredPromptFacts | null =
    promptWaiting === null
      ? null
      : {
          ...promptWaiting,
          askUserQuestion: summarizeAskUserQuestion(askUserQuestion),
          decisionOptions,
          // Explicit, though the spread above already carries a `decisionId`
          // off the record: the spread's copy is the raw one, and what may be
          // published is the GATED one. Letting the record's value through
          // would put an id on a payload whose verdicts were withheld, which is
          // the biconditional this Issue exists to hold.
          decisionId: addressableDecisionId,
          // Gated on the same value, for a reason of its own: `patterns` is
          // what the `Allow always` BUTTON grants, so publishing it where no
          // button is drawn adds a rule list to a panel that is telling the
          // user to go and answer in the terminal. Every source but opencode
          // therefore keeps the exact payload it had before this Issue, plus
          // the one `decisionId: null`.
          //
          // Issue #2100 moves the gate onto `decisionOptions` rather than the
          // id, which is the same value for every approval and the honest one
          // for a question: a question draws no `Allow always`, so it may not
          // carry the rules one would have saved. (`reportQuestionPending`
          // records `patterns: null` anyway; the two agree by construction now
          // instead of by coincidence.)
          patterns: decisionOptions !== null ? promptWaiting.patterns : null,
        };

  const promptData: PromptData | StructuredPromptWaitingData | null = startingSince !== null
    ? null
    : scraperPromptWaiting
    ? correctedPromptData ??
      scraperPromptData ??
      (structuredFacts ? buildStructuredPromptData(worktreeId, structuredFacts) : null)
    : structuredFacts
      ? buildStructuredPromptData(worktreeId, structuredFacts)
      : null;

  // Issue #2870: whether `/prompt-response` would answer the prompt published
  // above, read by the SAME function it re-verifies with. In #2868 `promptData`
  // came off the generic parser alone, the route refused it, and the UI's Send
  // did nothing. Only for a parser-read prompt: the structured form (hook
  // `decisionId`, degraded) is answered by id or not by number at all, so the
  // key is left out there, as it is when no prompt is up. `isPromptWaiting` /
  // `promptData` / `sessionStatus` are untouched — `wait`'s exit 10, Auto-Yes
  // and push notifications keep reading exactly what they read before.
  const promptAnswerable: boolean | undefined =
    scraperPromptWaiting && (correctedPromptData ?? scraperPromptData)
      ? assessPromptAnswerability(cliToolId, output).refusal === null
      : undefined;

  return { structuredFacts, promptData, promptAnswerable };
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
  // Issue #2886: read once, independent of `isRunning`, so both return paths
  // below publish the same value the pane is (or would be) reached at.
  const sessionName = cliTool.getSessionName(worktreeId, instanceId);

  const { stopEventAt, eventSource, askUserQuestion, structuredEvents } = readAgentEvents(
    worktreeId,
    cliToolId,
    instanceId,
    resolvedInstanceId,
  );

  const running = await cliTool.isRunning(worktreeId, instanceId);
  if (!running) {
    // Issue #1926: the latch describes a process, and this one is gone. Dropped
    // rather than aged out so the next session on this key starts with no
    // history instead of inheriting the last one's verdict.
    forgetLastKnownStatus(buildCompositeKey(worktreeId, cliToolId, instanceId));
    return {
      isRunning: false,
      // Issue #3179: `beginAgentSession` runs before the pane is created, so a
      // launch can be in progress with no tmux session yet. Read-only here —
      // there is no frame to judge a dialog on.
      startingSince: getSessionStartingSince(worktreeId, cliToolId, instanceId),
      sessionName,
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
      // Issue #2095: same reasoning — a session that is not running has no pane
      // to lay out in two columns.
      paneObstruction: null,
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

  // The sequence from here to `startingStatusResult` is the same as in
  // worktree-status-helper.ts; what follows differs on purpose and is not shared
  // (#3215 "not touched").
  const compositeKey = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const lastServerResponseTimestamp = getLastServerResponseTimestamp(compositeKey);
  const lastOutputTimestamp = lastServerResponseTimestamp ? new Date(lastServerResponseTimestamp) : undefined;

  const rawStatusResult = detectSessionStatus(output, cliToolId, lastOutputTimestamp);
  // Issue #3179: a launch in progress. The frame is a shell prompt and the
  // launch line, or a dialog the launch is about to answer, and none of the
  // flags below may be read off it: the floor verdict raised the Navigate pad,
  // the trust dialog raised the selection list / prompt sheet. A dialog that
  // outstays the launch's own answer releases the record (a login, an unknown
  // dialog), and from then on this is the ordinary verdict again.
  const startingSince = observeSessionStartingFrame(
    worktreeId,
    cliToolId,
    instanceId,
    rawStatusResult.status === 'waiting' || rawStatusResult.hasActivePrompt,
  );
  const statusResult = startingSince === null
    ? rawStatusResult
    : startingStatusResult(rawStatusResult);
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
  // Issue #2369: an overlay whose ONLY exit is the dismiss — Command Code's
  // `/usage` panel, whose last row is `Press Esc to close`.
  //
  // A THIRD flag rather than a member of `SELECTION_LIST_REASONS`, and the
  // separation is the fix rather than a nicety: `isSelectionListActive` is what
  // the arrow pad is drawn from, and this screen has no highlight to move. Nor
  // is it `isUnclassifiedActive` any more — the detector answers `waiting` for
  // it, and `isUnclassifiedFrame` only ever says yes to `running` — which is
  // exactly what stops the chat surface offering the eighteen-button
  // hatch + answer-key card to a panel that accepts one key.
  //
  // `status === 'waiting'` is checked as well as the reason, the same shape
  // `isSelectionListActive` above uses, so a future producer that publishes the
  // token with some other status cannot silently turn the card into an Esc
  // button.
  const isDismissablePanelActive =
    statusResult.status === 'waiting'
    && statusResult.reason === STATUS_REASON.COMMAND_CODE_DISMISSABLE_PANEL;
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

  const scraperVerdict: ScraperVerdict = {
    status: statusResult.status,
    reason: statusResult.reason,
    thinking,
    evidence,
    isUnclassifiedActive,
  };

  // Issue #2429: the send ledger, read ONLY when it could change the verdict.
  // `staleReadyCandidate` is the merge's own first three conjuncts, so the two
  // cannot disagree about when this read is needed — and every other poll (an
  // idle pane, a turn the agent has opened, a tool that reports its own start)
  // costs exactly what it did before this Issue, which is nothing.
  const lastPromptAt = staleReadyCandidate(scraperVerdict, structured, structuredEvents)
    ? readNewestPromptAt(db, worktreeId, cliToolId, resolvedInstanceId)
    : null;

  const merged = mergeStructuredStatus(
    scraperVerdict,
    structured,
    promptWaiting,
    // Issue #2011: the same record `structuredEvents` publishes, read once. The
    // merge needs `closedBy` / `closedAt` / `openedAt`, which
    // `StructuredSessionState` folds away into `hook_stop` — and the folded form
    // cannot tell a `Stop` that closed a watched turn from one that arrived with
    // no turn open.
    structuredEvents,
    lastPromptAt,
  );

  // The OR rule, computed once for the whole server (Issue #1737): this is the
  // same `resolvePromptWaiting` call the `send` guard makes, so the payload and
  // the guard cannot disagree about whether a prompt is open. What they are
  // still allowed to differ on is what to DO about it — see `blocksSend`, which
  // bounds the structured layer's veto over sends and leaves this flag alone.
  // Issue #3179: not while a launch is in progress. The scraper half is already
  // neutralised above; this also drops a structured wait the launch inherited.
  const isPromptWaiting = startingSince === null && promptResolution.waiting;

  const { structuredFacts, promptData, promptAnswerable } = composePromptData({
    worktreeId,
    cliToolId,
    output,
    statusResult,
    startingSince,
    promptWaiting,
    askUserQuestion,
    eventSource,
  });

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

  // Issue #1839 defined this window and Issue #2095 reuses it, so it is computed
  // once, here, above the first reader. The 100 rows are also what the payload
  // publishes, which is the property both fields rest on: what they claim can be
  // checked against the rows printed next to them in `capture --json`.
  // Issue #2768: still "the 100 rows this payload publishes" — but anchored to
  // the last content row when the plain tail is entirely blank (top-anchored panes).
  const realtimeSnippet = selectRealtimeSnippetRows(lines).join('\n');

  // Issue #2095: gated on the tool because the anchors are opencode's own box
  // drawing. Every other CLI's detection is untouched by construction — nothing
  // here even looks at its frame. Computed before the unclassified-frame writer
  // below because that row is where a user first meets this: the sidebar is
  // exactly the reason the frame could not be classified, and a "detection
  // failed" row that does not say so sends the reader to the raw pane to work it
  // out again.
  const paneObstruction: OpenCodePaneObstruction | null =
    cliToolId === 'opencode' ? detectOpenCodePaneObstruction(realtimeSnippet) : null;

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
  //
  // Issue #2965: not while the agent holds a decision this server can answer by
  // id (OpenCode V2 / opencode approvals and questions). The frame may still be
  // one the scraper cannot read, but "nothing could answer it" is false then,
  // and the row landed in the chat as a meaningless assistant line. Fed to the
  // tracker as "not unclassified" rather than merely not written, so the run —
  // and the 60 seconds — start afresh if the frame is still unreadable once the
  // decision is gone (answered, expired, or the source dropped).
  const answerableOverAgentApi = hasApiAnswerableDecision(
    eventSource.capabilities.eventIdentity,
    structuredEvents.pendingDecisions ?? [],
  );
  // Issue #3179: a launch in progress is not a detection failure — its frame is
  // the shell and the launch line — so no row, and the run starts afresh after.
  const unclassifiedVerdict = observeUnclassifiedFrame(
    compositeKey,
    merged.isUnclassifiedActive && !answerableOverAgentApi && startingSince === null,
  );
  if (unclassifiedVerdict.shouldRecord) {
    recordUnclassifiedFrame(db, {
      worktreeId,
      cliToolId,
      instanceId: resolvedInstanceId,
      dwellMs: unclassifiedVerdict.dwellMs,
      sessionStatus: merged.status,
      sessionStatusReason: merged.reason,
      // Issue #2095: the cause, when the frame carries one. Null leaves the row
      // exactly as #1708 wrote it.
      obstruction: paneObstruction,
    });
  }

  // Issue #2843: the opposite gap — the scraper reads a dialog on a turn the
  // agent's own `Stop` closed. Logged only (see `layer-disagreement.ts`); fed the
  // SCRAPER's verdict, because the merge lets a scraper `waiting` win and would
  // hide the very disagreement this records.
  const disagreement = classifyLayerDisagreement({
    supportedEvents: eventSource.capabilities.supportedEvents,
    scraperStatus: statusResult.status,
    scraperReason: statusResult.reason,
    hasActivePrompt: scraperPromptWaiting,
    lastEventType: structuredEvents.lastEventType,
    lastEventDetail: structuredEvents.lastEventDetail,
  });
  if (disagreement !== null) {
    reportLayerDisagreement({
      compositeKey,
      worktreeId,
      cliToolId,
      instanceId: resolvedInstanceId,
      turnId: structuredEvents.turnId,
      kind: disagreement,
      scraperReason: statusResult.reason,
      frame: output,
    });
  }

  // Issue #1725: the structured layer saw a dialog the scraper did not. That
  // gap is the fact worth keeping — see recordStructuredPrompt.
  //
  // Issue #2965: except while that dialog can be answered over the agent's API
  // — the live payload already carries its id and replies, so the row says
  // nothing true. Not marked recorded either: should the decision expire with
  // the dialog still open, the row is written then (the safe side).
  if (
    promptWaiting !== null &&
    structuredFacts !== null &&
    !scraperPromptWaiting &&
    !promptWaiting.recorded &&
    !answerableOverAgentApi
  ) {
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
  // Issue #3179: the structured layer cannot override a launch in progress
  // either — a `waiting` it inherited would put the answer sheet back.
  const published = startingSince === null
    ? merged
    : { ...merged, status: 'running' as const, reason: STATUS_REASON.STARTING, thinking: false };

  observeStatusEvidence(compositeKey, {
    status: published.status,
    reason: published.reason,
    evidence: published.evidence,
  });
  const lastKnown = getLastKnownStatus(compositeKey);

  return {
    isRunning: true,
    sessionName,
    cliToolId,
    sessionStatus: published.status,
    sessionStatusReason: published.reason,
    content: newContent,
    fullOutput: output,
    realtimeSnippet,
    lineCount: totalLines,
    lastCapturedLine,
    isComplete: isPromptWaiting,
    isGenerating: published.thinking,
    thinking: published.thinking,
    // Issue #2607: named after the tool actually running. A fixed "Claude" was
    // published for every agent, and `capture --json` readers took it at its word.
    thinkingMessage: published.thinking ? `${getCliToolDisplayName(cliToolId)} is thinking...` : null,
    isPromptWaiting,
    promptData,
    ...(promptAnswerable !== undefined ? { promptAnswerable } : {}),
    // Issue #3184: appended next to the value it is derived from, not at the end
    // — it is a reading of `promptData`, and only of it.
    promptView: derivePromptView(promptData),
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
    isDismissablePanelActive,
    isUnclassifiedActive: startingSince === null && merged.isUnclassifiedActive,
    startingSince,
    // Issue #1926: evidence strength, named the way §4 D1 names it. Not the same
    // fact as `isUnclassifiedActive` (Issue #2011); published from the merged
    // verdict so it agrees with the status it accompanies.
    statusEvidence: published.evidence,
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
    // Issue #2095: the same three keys as `upstreamFault`, read from the same
    // rows, so an operator comparing the two is comparing like with like. The
    // detector's `boxRight` / `rows` stay off the wire — they are how the rule
    // decided, not what a caller acts on, and the payload is already a published
    // contract wide enough to be hard to change.
    paneObstruction: paneObstruction
      ? {
          id: paneObstruction.id,
          matchedText: paneObstruction.matchedText,
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
