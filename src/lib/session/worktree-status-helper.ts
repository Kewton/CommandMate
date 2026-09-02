/**
 * Worktree session status detection helper
 *
 * Issue #405: Extracted from worktrees/route.ts and worktrees/[id]/route.ts
 * to eliminate code duplication (DRY principle).
 *
 * Provides batch session status detection for all CLI tools of a given worktree,
 * including:
 * - Session existence check via pre-queried tmux session name Set
 * - Per-tool liveness probe: "the session is there, but is the TOOL?"
 *   (Issue #2070; claude-only before that, hence the bug it fixes)
 * - Terminal output capture and status detection
 * - Stale pending prompt cleanup
 */

import { CLIToolManager } from '@/lib/cli-tools/manager';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import { captureSessionOutput } from './cli-session';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import { sessionStatusToActivityFlags } from './status-mapping';
import { resolveCaptureSpec } from '@/lib/cli-tools/capture-spec';
import { probeToolSessionLiveness } from '@/lib/cli-tools/session-liveness';
import { getLastServerResponseTimestamp, buildCompositeKey } from '@/lib/polling/auto-yes-manager';
import { GLOBAL_SESSION_WORKTREE_ID } from '@/lib/session/global-session-constants';
import { peekPromptWaiting } from '@/lib/session/prompt-waiting-composition';
import { deriveWaitingKind, type WaitingKind } from '@/lib/session/waiting-kind';
import {
  forgetLastKnownStatus,
  getLastKnownStatus,
  observeStatusEvidence,
  type StatusEvidence,
} from '@/lib/session/status-evidence';
import { observeWaitingEdge } from '@/lib/session/waiting-episode-state';
// Issue #1783 adds the model readers alongside #1786's `isAwaitingInstruction`;
// Issue #1784 promotes them to `getResolvedAgentModelInfo`, which folds in what
// the capture below showed.
import {
  getResolvedAgentModelInfo,
  isAwaitingInstruction,
  recordCapturedModelInfo,
} from '@/lib/session/agent-event-state';
import { extractModelInfo } from '@/lib/detection/model-info-extractor';
// Issue #2054: the event source is asked through the registry, exactly as
// `current-output-builder` asks it. `describeAgentEventSource` is the single
// fold both of them call, so the header chip's tooltip (driven by this object)
// and the terminal payload cannot describe one pane two ways.
import { getAgentEventSource } from '@/lib/hooks/sources/registry';
import { describeAgentEventSource } from '@/lib/hooks/sources/define-source';
import type { AgentEventSourceStatus } from '@/lib/hooks/sources/types';
import type { getMessages as GetMessagesFn, markPendingPromptsAsAnswered as MarkPendingFn, getAgentInstances as GetAgentInstancesFn } from '@/lib/db';
import type { ChatMessage } from '@/types/models';
import { createLogger } from '@/lib/logger';

const logger = createLogger('lib/session/worktree-status-helper');

/**
 * What one status pass actually cost, in tmux round-trips (Issue #2060).
 *
 * Counters, not timings: the wall clock is the caller's to measure, and what
 * the caller cannot see from outside is how many `capture-pane` calls the pass
 * decided to issue. That number is the one that matters, because it is NOT
 * `worktreeCount × CLI_TOOL_IDS.length`. `detectInstanceSessionStatus` captures
 * only for a probe whose session name is in the pre-queried `sessionNameSet`
 * (and, for claude, only after `isSessionHealthy` agrees), so a worktree with
 * nothing running costs zero captures however many tools exist.
 *
 * Passed in and mutated rather than returned, so that adding instrumentation
 * does not change `WorktreeSessionStatus` — which is published verbatim to
 * every client of `GET /api/worktrees`.
 */
export interface StatusDetectionMetrics {
  /** Probes constructed: one per CLI tool primary, plus one per alias instance. */
  probeCount: number;
  /** `capture-pane` calls actually issued (throwing ones included). */
  captureCount: number;
  /**
   * Liveness probes actually issued — one `capture-pane` each.
   *
   * Issue #2070 widened this from "claude primaries/aliases only": the check it
   * counts is no longer claude's alone, so a worktree with a running codex now
   * costs the same two round trips a running claude has always cost. It is
   * still one probe per RUNNING session and zero for a worktree with nothing
   * running, which is the property this counter exists to make visible.
   */
  healthCheckCount: number;
}

/** A zeroed {@link StatusDetectionMetrics} accumulator (Issue #2060). */
export function createStatusDetectionMetrics(): StatusDetectionMetrics {
  return { probeCount: 0, captureCount: 0, healthCheckCount: 0 };
}

/** Per-CLI-tool session status */
export interface CliToolSessionStatus {
  isRunning: boolean;
  isWaitingForResponse: boolean;
  isProcessing: boolean;
  /**
   * What kind of wait this is, or null when it is not waiting (Issue #1786).
   *
   * `isWaitingForResponse` alone renders one orange dot for a y/n prompt the app
   * can answer, a selection list only the terminal can drive, and a dialog only
   * the agent's own events reported. See `deriveWaitingKind`.
   */
  waitingKind: WaitingKind | null;
  /**
   * Epoch ms the current wait began, or null (Issue #1786).
   *
   * Fixed for the whole wait — polling does not move it — so "waiting for 12
   * minutes" is a number a surface can render. Owned by `waiting-episode-state`,
   * which is also where #1788 / #1790 subscribe to the edge.
   */
  waitingSince: number | null;
  /**
   * Whether the agent has said it is waiting for its next instruction
   * (Issue #1786).
   *
   * Independent of `isWaitingForResponse`: this one is the `idle_prompt`
   * notification — the turn is over and nothing is blocking — held until the
   * next `user_prompt_submit` / `session_start` / `session_end`.
   */
  awaitingInstruction: boolean;
  /**
   * The model this instance last reported running, or absent (Issue #1783).
   *
   * Comes from the structured hook events, not from the terminal frame, so it is
   * present only for tools that publish one (claude / codex / antigravity /
   * opencode) and only once one has arrived. **The key is omitted rather than
   * set to null when nothing is known** — this object is compared with `toEqual`
   * in existing suites, and an always-present `model: null` would fail them
   * while saying nothing the absence does not.
   *
   * **Read it from `sessionStatusByInstance` only.** A model belongs to one
   * instance, and `sessionStatusByCli` is an aggregate over all instances of a
   * tool: {@link mergeSessionStatus} drops the field when there are two or more,
   * so the per-CLI entry carries a model exactly when the fold had nothing to
   * fold. The client type in `src/types/models.ts` declares it on the
   * per-instance map alone for that reason.
   */
  model?: string | null;
  /**
   * The reasoning effort this instance is running at, or absent (Issue #1784).
   *
   * Scraped from the TUI's own chrome, because **no hook payload of any tool
   * carries an effort field** — the Codex footer, the Claude startup banner and
   * the Antigravity status bar are the only places the value exists at all. For
   * Antigravity it is derived from the model id instead, which encodes it.
   *
   * Same key-omission rule as {@link model}, and for the same reason: the
   * absence is what existing `toEqual` suites assert, and it says everything a
   * `null` would. Same per-instance rule too — {@link mergeSessionStatus} drops
   * it, so read it from `sessionStatusByInstance`.
   *
   * Absent is the ordinary state, not a defect: a long-lived Claude session has
   * scrolled its banner out of tmux's 2000-line history, and reporting a guess
   * would be worse than reporting nothing.
   */
  reasoningEffort?: string | null;
  /**
   * Whether this instance's status rests on something positive (Issue #1926,
   * 方針書 §4 D1 / §7 / DR3-005).
   *
   * The second of the two contract changes Phase 1 makes, and the reason it is
   * needed: `CurrentOutputResponse` drives `PromptPanel` / `ActivityPane` /
   * `TerminalEscapeHatch`, but the header status chip, `BranchStatusIndicator`
   * and `commandmate ls` are driven by THIS object, which until now carried
   * three booleans and no reason at all. §7's rows "スクレイパが肯定的証拠を
   * 得られない" and "直前の確定状態" cannot be built on the other contract.
   *
   * `'none'` means the verdict rests on no positive proof: nothing on the frame
   * could be read either way, OR the frame was read but the tool's §4 D1 idle
   * rule declined to vouch for it. Issue #2011: NOT the same fact
   * `CurrentOutputResponse.isUnclassifiedActive` carries — that one is
   * `isUnclassifiedFrame` in `status-evidence.ts`, and the two sets stopped
   * coinciding the moment the rollout gave a tool an idle rule that can decline.
   *
   * **The key is omitted rather than set to null when nothing is known**, for
   * the reason {@link model} gives: these objects are compared with `toEqual` in
   * existing suites, and a session that is not running (or whose capture threw)
   * has no frame to have read. Same per-instance rule too — see
   * {@link mergeSessionStatus}.
   */
  statusEvidence?: StatusEvidence;
  /**
   * The scraper's reason token for this instance's status (Issue #1926).
   *
   * `input_prompt` / `no_recent_output` / `thinking_indicator` / `default` … —
   * `STATUS_REASON` in `src/lib/detection/status-detector.ts`. It is what turns
   * an orange dot into a sentence, and what `commandmate ls` prints in its
   * REASON column.
   *
   * Deliberately the SCRAPER's reason, not a `hook_` one: this object is built
   * from `detectSessionStatus` alone (the list API does not run
   * `mergeStructuredStatus`), and labelling a scraper verdict with a structured
   * reason would misreport which layer decided. The merged reason is on
   * `CurrentOutputResponse.sessionStatusReason`.
   */
  sessionStatusReason?: string;
  /**
   * The last status anything could positively confirm for this instance, or
   * absent (Issue #1926, §7 「直前の確定状態（証拠なしの間の表示）」).
   *
   * Held server-side with a TTL of `LAST_KNOWN_STATUS_TTL_MS` and cleared by a
   * restart. What a surface renders while {@link statusEvidence} is `'none'` and
   * the three booleans are a fallback rather than a reading.
   */
  lastKnownStatus?: string;
  /** Epoch ms of {@link lastKnownStatus}, absent when that is absent. */
  lastKnownStatusAt?: number;
  /**
   * Which machinery is speaking for this instance right now (Issue #2054).
   *
   * The half of the picture this object was missing: every field above is
   * something the **screen** said, and this one says whether anything other than
   * the screen is reading the pane at all. It is what turns "opencode looks idle"
   * into "opencode looks idle *and its event stream has been gone for a minute*",
   * which are different facts and were indistinguishable here before.
   *
   * **Present only for a source that can be degraded, and only while the session
   * is running.** Concretely that is opencode and nothing else today: every push
   * tool answers `{ state: 'unknown' }` from `definePushHookSource`, so
   * {@link describeAgentEventSource} publishes no `liveness` / `degradedReason`
   * for them and this key is omitted rather than set — which is the same
   * key-omission rule {@link model} follows, for the same reason (`toEqual` in
   * existing suites) and with the same consequence: claude / codex status objects
   * are byte-identical to their pre-#2054 selves.
   *
   * A stopped session carries none either. The subscription is closed when the
   * pane is killed, so "no stream" would be the answer for every stopped
   * opencode instance in the app — true, and useless.
   *
   * Same per-instance rule as {@link model}: {@link mergeSessionStatus} drops it,
   * because two instances of one tool can be on different sides of a
   * disconnection and an aggregate would name one of them.
   */
  eventSource?: AgentEventSourceStatus;
}

/** Aggregated session status result for a worktree */
export interface WorktreeSessionStatus {
  /**
   * Per-CLI-tool session status map.
   *
   * Issue #875: when a worktree has alias instances (instanceId !== cliToolId),
   * each tool's entry is the aggregate (logical-OR of the flags) across all of
   * its instances, so worktree-level consumers (sidebar #867, header dot) reflect
   * activity in alias instances as well as the primary one.
   */
  sessionStatusByCli: Partial<Record<CLIToolType, CliToolSessionStatus>>;
  /**
   * Per-agent-instance session status map keyed by instanceId (Issue #875).
   *
   * Primary instances are keyed by their CLI tool id (instanceId === cliToolId);
   * alias instances are keyed by their own instanceId. Each entry is that single
   * instance's own status (NOT aggregated), so the per-instance UI (status
   * dot/spinner, "End" button) can resolve each instance independently.
   */
  sessionStatusByInstance: Partial<Record<string, CliToolSessionStatus>>;
  /** Whether any CLI tool session is running */
  isSessionRunning: boolean;
  /** Whether any CLI tool is waiting for a user response */
  isWaitingForResponse: boolean;
  /** Whether any CLI tool is actively processing */
  isProcessing: boolean;
}

/**
 * Precedence when several instances of one CLI tool are waiting (Issue #1786).
 *
 * Same ordering `deriveWaitingKind` applies within one instance, for the same
 * reason: an aggregate that reports `menu` while one of its instances has an
 * answerable prompt would hide the action the user can actually take.
 */
const WAITING_KIND_PRIORITY: Record<WaitingKind, number> = {
  prompt: 3,
  menu: 2,
  unclassified: 1,
};

/** The more actionable of two kinds; null only when both are null. */
function mergeWaitingKind(a: WaitingKind | null, b: WaitingKind | null): WaitingKind | null {
  if (a === null) return b;
  if (b === null) return a;
  return WAITING_KIND_PRIORITY[a] >= WAITING_KIND_PRIORITY[b] ? a : b;
}

/** The earlier of two starts — the aggregate reports the longest-running wait. */
function mergeWaitingSince(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * Merge two per-instance statuses into an aggregate (logical-OR of each flag).
 *
 * `model` (#1783) and `reasoningEffort` (#1784) are deliberately NOT carried
 * over: they describe one instance, and two instances of a tool can be on
 * different models. The aggregate therefore keeps them only when there was
 * nothing to fold — i.e. the tool has a single instance and this function was
 * never called for it.
 *
 * The four fields Issue #1926 adds (`statusEvidence` / `sessionStatusReason` /
 * `lastKnownStatus` / `lastKnownStatusAt`) follow the same rule, and it is not a
 * shortcut: there is no logical-OR of two reasons. Two instances of one tool can
 * be at `input_prompt` and `thinking_indicator` at the same moment, and an
 * aggregate that picked one would tell the header chip a reason that is true of
 * an instance the user is not looking at. Read them from
 * `sessionStatusByInstance`, which is never folded.
 */
function mergeSessionStatus(
  a: CliToolSessionStatus,
  b: CliToolSessionStatus,
): CliToolSessionStatus {
  return {
    isRunning: a.isRunning || b.isRunning,
    isWaitingForResponse: a.isWaitingForResponse || b.isWaitingForResponse,
    isProcessing: a.isProcessing || b.isProcessing,
    waitingKind: mergeWaitingKind(a.waitingKind, b.waitingKind),
    waitingSince: mergeWaitingSince(a.waitingSince, b.waitingSince),
    awaitingInstruction: a.awaitingInstruction || b.awaitingInstruction,
  };
}

/**
 * The `onUpdated` hook for `markPendingPromptsAsAnswered` (Issue #2214,
 * completing #2195).
 *
 * The sweep below stamps every still-pending prompt row of an instance the
 * moment the agent is seen to have moved on. #2195 gave the DB function this
 * callback and wired the poller's two sweeps to it, but not this one — so the
 * `ChatMessage` cache in every open pane kept the row as `pending` until its
 * next `/messages` poll, which #2195 itself demoted to a 15 s fallback.
 *
 * `'message_updated'`, never `'message'`: the row already existed and was
 * already delivered when it was created, so a client that appended instead of
 * replacing would show the same question twice. This is the same call
 * `response-checker` makes for the same DB function.
 *
 * **The push is detached, and that is load-bearing here rather than merely
 * tidy.** The sweep runs inside `detectInstanceSessionStatus`'s `try`, whose
 * `catch` means "the capture failed, assume the session is processing". A
 * callback that threw into it would therefore not just lose a frame — it would
 * publish a wrong status to the worktree list and detail APIs, i.e. to the
 * sidebar, Home, Sessions, Review and the command palette. Resolving the import
 * and the send on a promise keeps every failure, including a throwing
 * `broadcastMessage`, inside the `.catch` below.
 *
 * `broadcastMessage` reaches the `rooms` map of *its own* `ws-server` module
 * instance, and only the instance that called `setupWebSocket` owns live
 * sockets. #2214 claimed "production serves both callers of this helper from
 * that one bundle" and scoped the gap to `next dev`. **That was wrong.** Both
 * callers of this helper are route handlers (`/worktrees` and `/worktrees/:id`),
 * and a production build gives route handlers a second copy of `ws-server` in
 * `.next/server/chunks/` whose `setupWebSocket` is never called — so this sweep
 * published into an empty map on every production request, and the pane waited
 * for its next history poll exactly as it did under `next dev`.
 *
 * #2220 closed it with a process-local publisher registry
 * (`lib/realtime/publisher-registry`): `setupWebSocket` registers the owner's
 * publish/subscriber-count/room-lifecycle closures on `globalThis`, and
 * `broadcastMessage` routes there. The maps themselves stay inside `ws-server`.
 * The call below is unchanged — that is the point of bridging inside
 * `ws-server` rather than at each producer.
 */
function broadcastPromptSweptToAnswered(worktreeId: string): (message: ChatMessage) => void {
  return (message: ChatMessage) => {
    void import('@/lib/ws-server')
      .then(({ broadcastMessage }) => {
        broadcastMessage('message_updated', { worktreeId, message });
      })
      .catch((error: unknown) => {
        // The rows are already stamped; a socket write must not colour the
        // status this pass is about to publish.
        logger.warn('prompt-sweep-broadcast-failed', {
          worktreeId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };
}

/**
 * Detect the session status of a single (cliTool, instance) session.
 *
 * Issue #875: extracted from the per-CLI loop so both primary instances
 * (instanceId === cliToolId) and alias instances can be detected through one
 * code path. The capture / messages / pending-prompt cleanup are all scoped to
 * the given instanceId, so each instance's status is independent.
 */
async function detectInstanceSessionStatus(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string,
  sessionName: string,
  sessionNameSet: Set<string>,
  db: ReturnType<typeof import('@/lib/db/db-instance').getDbInstance>,
  getMessages: typeof GetMessagesFn,
  markPendingPromptsAsAnswered: typeof MarkPendingFn,
  metrics?: StatusDetectionMetrics,
): Promise<CliToolSessionStatus> {
  // Issue #405: Use Set.has() instead of individual hasSession() calls
  let isRunning = sessionNameSet.has(sessionName);

  // Issue #2070: the liveness probe, for EVERY tool.
  //
  // This branch used to read `if (isRunning && cliToolId === 'claude')`, and
  // that condition was the whole bug: a tmux session outlives its agent
  // whenever the agent quits, updates itself or crashes, and `has-session`
  // cannot tell the difference. So a codex pane that had fallen back to the
  // login shell kept a green dot here, `isRunning` stayed true for the send
  // route, and every subsequent `send` died in `waitForPrompt` with no recovery
  // short of killing the session by hand.
  //
  // The rule is unchanged and so is claude's answer — `resolveLivenessSpec`
  // hands claude exactly the patterns, thresholds and orderings
  // `isSessionHealthy` has always applied (which is still the function the two
  // claude-only call sites use, and it now delegates here). What is new is that
  // six other specs exist to ask it with.
  let exitedReason: string | null = null;
  if (isRunning) {
    if (metrics) metrics.healthCheckCount++;
    const liveness = await probeToolSessionLiveness(sessionName, cliToolId);
    if (!liveness.alive) {
      isRunning = false;
      exitedReason = liveness.reason;
    }
  }

  // Check status based on terminal state
  let isWaitingForResponse = false;
  let isProcessing = false;
  // Issue #1786: the waiting metadata the list API now publishes. Declared out
  // here so the edge below is observed exactly once per probe, whatever happened
  // inside the try — a session that is not running, and a capture that threw,
  // are both "not waiting" and must end an episode that was open.
  let waitingKind: WaitingKind | null = null;
  let structuredWaitingSince: number | null = null;
  // Issue #1926: what the frame said and whether it said it positively. Both
  // stay null when there was no frame to read — the session is not running, or
  // the capture threw — and the keys are then omitted from the result, which is
  // the same rule `model` follows and for the same reason.
  let statusEvidence: StatusEvidence | null = null;
  let sessionStatusReason: string | null = null;
  if (isRunning) {
    try {
      // Issue #1933: the per-tool ladder that used to live here — and that made
      // this module import two CLI-tool implementations for two pane heights —
      // is `ICLITool.captureSpec()`, resolved from `lib/cli-tools/capture-spec`.
      // Read through the resolver rather than through `CLIToolManager` so the
      // status poll does not instantiate all seven tools for one number.
      const captureLines = resolveCaptureSpec(cliToolId).statusLines;
      // Issue #2060: counted BEFORE the await, so a capture that throws is still
      // counted as a tmux round-trip that was paid for.
      if (metrics) metrics.captureCount++;
      const output = await captureSessionOutput(worktreeId, cliToolId, captureLines, instanceId);
      // Issue #501, #525, #896: Pass last server response timestamp using the
      // per-instance compositeKey. Auto-yes / last-response tracking is now
      // per-instance, so alias instances read their own poller timestamp.
      const compositeKey = buildCompositeKey(worktreeId, cliToolId, instanceId);
      const lastServerResponseTs = getLastServerResponseTimestamp(compositeKey);
      const lastOutputTimestamp = lastServerResponseTs ? new Date(lastServerResponseTs) : undefined;
      const statusResult = detectSessionStatus(output, cliToolId, lastOutputTimestamp);

      // Issue #1784: read the model / reasoning effort off the same frame the
      // detector just judged. Riding on this capture is the entire point — the
      // reasoning effort exists nowhere except the TUI's own chrome, and a
      // dedicated `capture-pane` for it would add a tmux round-trip per
      // instance per poll for a string that changes once a session. Pure and
      // non-throwing; a frame that shows nothing latches nothing.
      recordCapturedModelInfo(
        worktreeId,
        cliToolId,
        instanceId,
        extractModelInfo(cliToolId, output)
      );
      // Issue #1550: SessionStatus → activity flags lives in status-mapping.ts
      ({ isWaitingForResponse, isProcessing } = sessionStatusToActivityFlags(statusResult.status));

      // Issue #1926 read the same derivation `current-output-builder` used;
      // Issue #1927 replaced the derivation with the detector's own answer, for
      // both of them at once. §4 D1 決定 2's rule — one fact, one expression —
      // is unchanged and now stronger: there is no expression left to keep in
      // sync, because the layer that applied the rule is the layer that reports
      // it. Latched here as well as in the builder because this is the loop the
      // sidebar polls, so it is what keeps `lastKnownStatus` warm for the header
      // chip and `commandmate ls`.
      sessionStatusReason = statusResult.reason;
      statusEvidence = statusResult.evidence;
      observeStatusEvidence(compositeKey, {
        status: statusResult.status,
        reason: statusResult.reason,
        evidence: statusEvidence,
      });

      // Issue #1786: fold in what the agent's own events know. Until now the
      // list API — and therefore the sidebar, Home, Sessions, Review and the
      // command palette — published the scraper's verdict alone, so a dialog
      // only the structured layer could see (#1725's whole reason to exist) lit
      // no dot anywhere. Read-only on purpose: see `peekPromptWaiting`.
      //
      // ORed onto the scraper's flag rather than replacing it with the
      // resolution's `waiting`, which the Issue's text proposed. Measured
      // against the code: that field is `hasActivePrompt || structured`, while
      // this flag is `status === 'waiting'` — a strictly wider set, because a
      // selection list and a Codex pager report `waiting` with
      // `hasActivePrompt: false` (status-detector.ts, the SELECTION_LIST_REASONS
      // returns). Assigning it verbatim would have turned every selection list
      // in the sidebar from orange to green: a regression, in an Issue whose own
      // non-functional requirement is that the dots must not get worse. The OR
      // only ever widens `isWaitingForResponse`, never narrows it.
      const peek = peekPromptWaiting({
        worktreeId,
        cliToolId,
        instanceId,
        scraper: {
          status: statusResult.status,
          reason: statusResult.reason,
          hasActivePrompt: statusResult.hasActivePrompt,
        },
      });
      isWaitingForResponse = isWaitingForResponse || peek.waiting;
      structuredWaitingSince = peek.structured?.at ?? null;
      waitingKind = deriveWaitingKind({
        waiting: isWaitingForResponse,
        hasActivePrompt: statusResult.hasActivePrompt,
        scraperStatus: statusResult.status,
        scraperReason: statusResult.reason,
      });

      // Clean up stale pending prompts (scoped to this instance) if none is showing
      if (!statusResult.hasActivePrompt) {
        const messages = getMessages(db, worktreeId, { limit: 10, cliToolId, instanceId });
        const hasPendingPrompt = messages.some(
          msg => msg.messageType === 'prompt' && msg.promptData?.status !== 'answered'
        );
        if (hasPendingPrompt) {
          markPendingPromptsAsAnswered(
            db,
            worktreeId,
            cliToolId,
            instanceId,
            broadcastPromptSweptToAnswered(worktreeId),
          );
        }
      }
    } catch {
      // If capture fails, assume processing
      isProcessing = true;
    }
  }

  // Issue #1786: the single place the waiting edge is observed. #1788 (WS push)
  // and #1790 (push notifications) subscribe with `onWaitingTransition` rather
  // than adding a second detector of their own — see `waiting-episode-state`.
  const waitingSince = observeWaitingEdge({
    worktreeId,
    cliToolId,
    instanceId,
    waiting: isWaitingForResponse,
    kind: waitingKind,
    structuredSince: structuredWaitingSince,
  });

  // Issue #1783 / #1784: the model and reasoning effort, folded from the agent's
  // own hooks and from the frame captured above. Independent of the waiting
  // taxonomy, and attached regardless of `isRunning`: for Claude the flag is
  // gated on a health check that can fail transiently, and blanking a correct
  // model on that would flicker. Absent — not null — when nothing has ever
  // reported one, so a status object for a tool without hooks and without
  // recognisable chrome keeps exactly the shape #1786 left it with.
  const { model, effort } = getResolvedAgentModelInfo(worktreeId, cliToolId, instanceId);

  // Issue #1926: the latch, read after it was fed above so a positive poll
  // reports itself. Dropped outright for a session that is not running — its
  // last confirmed status describes a process that is gone, which is the same
  // call `current-output-builder` makes and the same one `model` makes.
  const evidenceKey = buildCompositeKey(worktreeId, cliToolId, instanceId);
  if (!isRunning) forgetLastKnownStatus(evidenceKey);
  const lastKnown = isRunning ? getLastKnownStatus(evidenceKey) : null;

  // Issue #2054: what is reading this pane besides the frame above. Cheap on
  // every tool — the registry is a map and a push source's `liveness()` is a
  // constant — and read only for a running session, so a stopped opencode
  // instance does not report a stream it is not supposed to have.
  const eventSource = isRunning
    ? describeEventSourceFor(worktreeId, cliToolId, instanceId)
    : null;

  return {
    isRunning,
    isWaitingForResponse,
    isProcessing,
    waitingKind,
    waitingSince,
    // A dead session is not awaiting anything; the flag describes the process
    // that reported it, and that process is gone.
    awaitingInstruction: isRunning && isAwaitingInstruction(worktreeId, cliToolId, instanceId),
    ...(model !== null ? { model } : {}),
    ...(effort !== null ? { reasoningEffort: effort } : {}),
    ...(statusEvidence !== null ? { statusEvidence } : {}),
    ...(sessionStatusReason !== null ? { sessionStatusReason } : {}),
    // Issue #2070: the one reason published for a session that is NOT running.
    // `statusEvidence: 'positive'` is not a formality — tmux was asked, the
    // pane was read, and a shell prompt was found where the agent's composer
    // should be. That is an observation, which is the distinction §4 D1 draws
    // (and the same call `current-output-builder` makes for `session_not_running`).
    ...(exitedReason !== null
      ? { sessionStatusReason: STATUS_REASON.EXITED, statusEvidence: 'positive' as const }
      : {}),
    ...(lastKnown !== null
      ? { lastKnownStatus: lastKnown.status, lastKnownStatusAt: lastKnown.at }
      : {}),
    ...(eventSource !== null ? { eventSource } : {}),
  };
}

/**
 * The published event-source status for one instance, or null when there is
 * nothing worth publishing (Issue #2054).
 *
 * Null — rather than `{ kind: 'hooks' }` — for every source that cannot be
 * degraded. The `kind` alone is a property of the tool, not of the pane: it is
 * the same on every poll of every worktree for the whole life of the build, and
 * putting it on this object would add a key to the six status entries of every
 * worktree in the sidebar to say something the tool id already says. What is
 * worth a key is the pair that can change under the operator — see
 * `AgentEventSourceStatus.degradedReason` / `.liveness` — so this publishes
 * exactly when one of them is there.
 *
 * Never throws: a status poll that failed because a source misbehaved would take
 * the sidebar down with it.
 */
function describeEventSourceFor(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string,
): AgentEventSourceStatus | null {
  try {
    const source = getAgentEventSource(cliToolId);
    const status = describeAgentEventSource(
      source,
      source.liveness({ worktreeId, cliToolId, instanceId }),
      Date.now(),
    );
    if (status.degradedReason === undefined && status.liveness === undefined) return null;
    return status;
  } catch {
    return null;
  }
}

/**
 * Detect session status for all CLI tools of a single worktree.
 *
 * Consolidates the duplicated logic previously in worktrees/route.ts (GET)
 * and worktrees/[id]/route.ts (GET). Both routes now delegate to this function.
 *
 * @param worktreeId - Worktree ID
 * @param sessionNameSet - Pre-queried Set of active tmux session names (from listSessions())
 * @param db - Database instance
 * @param getMessages - DB function to get messages for a worktree
 * @param markPendingPromptsAsAnswered - DB function to mark stale prompts as answered
 * @param getAgentInstances - DB function returning the worktree's agent-instance roster (Issue #875)
 * @param metrics - Optional accumulator for the tmux round-trips this pass issues
 *   (Issue #2060). Mutated in place; safe to share across concurrent calls, which
 *   is how the list route sums one number over every worktree.
 * @returns Aggregated session status for the worktree
 */
export async function detectWorktreeSessionStatus(
  worktreeId: string,
  sessionNameSet: Set<string>,
  db: ReturnType<typeof import('@/lib/db/db-instance').getDbInstance>,
  getMessages: typeof GetMessagesFn,
  markPendingPromptsAsAnswered: typeof MarkPendingFn,
  getAgentInstances: typeof GetAgentInstancesFn,
  metrics?: StatusDetectionMetrics,
): Promise<WorktreeSessionStatus> {
  // Issue #649: Skip status detection for global assistant sessions.
  // Global sessions are not real worktrees and should not appear in the sidebar.
  if (worktreeId === GLOBAL_SESSION_WORKTREE_ID) {
    return {
      sessionStatusByCli: {},
      sessionStatusByInstance: {},
      isSessionRunning: false,
      isWaitingForResponse: false,
      isProcessing: false,
    };
  }

  const manager = CLIToolManager.getInstance();
  const allCliTools: readonly CLIToolType[] = CLI_TOOL_IDS;

  // Issue #875: detect each instance's session independently. The primary
  // instance of every CLI tool (instanceId === cliToolId) is always probed for
  // backward compatibility; alias instances (instanceId !== cliToolId) from the
  // roster are probed in addition. Each probe is independent, so Promise.all is
  // safe. de-dup primaries already covered by the per-tool list.
  const aliasInstances = getAgentInstances(db, worktreeId).filter(
    (inst) => inst.id !== inst.cliTool
  );

  type Probe = { cliToolId: CLIToolType; instanceId: string; sessionName: string };
  const probes: Probe[] = allCliTools.map((cliToolId) => ({
    cliToolId,
    instanceId: cliToolId,
    sessionName: manager.getTool(cliToolId).getSessionName(worktreeId, cliToolId),
  }));
  for (const inst of aliasInstances) {
    probes.push({
      cliToolId: inst.cliTool,
      instanceId: inst.id,
      sessionName: manager.getTool(inst.cliTool).getSessionName(worktreeId, inst.id),
    });
  }

  if (metrics) metrics.probeCount += probes.length;

  const results = await Promise.all(
    probes.map(async (probe): Promise<Probe & { status: CliToolSessionStatus }> => {
      const status = await detectInstanceSessionStatus(
        worktreeId,
        probe.cliToolId,
        probe.instanceId,
        probe.sessionName,
        sessionNameSet,
        db,
        getMessages,
        markPendingPromptsAsAnswered,
        metrics,
      );
      return { ...probe, status };
    })
  );

  const sessionStatusByCli: Partial<Record<CLIToolType, CliToolSessionStatus>> = {};
  const sessionStatusByInstance: Partial<Record<string, CliToolSessionStatus>> = {};

  for (const { cliToolId, instanceId, status } of results) {
    // Per-instance: each instance keeps its own (un-aggregated) status.
    sessionStatusByInstance[instanceId] = status;
    // Per-CLI: aggregate (logical-OR) across every instance of the tool so the
    // sidebar / header dot reflect alias-instance activity too.
    const existing = sessionStatusByCli[cliToolId];
    sessionStatusByCli[cliToolId] = existing ? mergeSessionStatus(existing, status) : status;
  }

  let anyRunning = false;
  let anyWaiting = false;
  let anyProcessing = false;
  for (const status of Object.values(sessionStatusByCli)) {
    if (!status) continue;
    if (status.isRunning) anyRunning = true;
    if (status.isWaitingForResponse) anyWaiting = true;
    if (status.isProcessing) anyProcessing = true;
  }

  return {
    sessionStatusByCli,
    sessionStatusByInstance,
    isSessionRunning: anyRunning,
    isWaitingForResponse: anyWaiting,
    isProcessing: anyProcessing,
  };
}
