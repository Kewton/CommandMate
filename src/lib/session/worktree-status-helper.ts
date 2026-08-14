/**
 * Worktree session status detection helper
 *
 * Issue #405: Extracted from worktrees/route.ts and worktrees/[id]/route.ts
 * to eliminate code duplication (DRY principle).
 *
 * Provides batch session status detection for all CLI tools of a given worktree,
 * including:
 * - Session existence check via pre-queried tmux session name Set
 * - Claude-only health check (other tools use simple session existence)
 * - Terminal output capture and status detection
 * - Stale pending prompt cleanup
 */

import { CLIToolManager } from '@/lib/cli-tools/manager';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import { captureSessionOutput } from './cli-session';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { sessionStatusToActivityFlags } from './status-mapping';
import { OPENCODE_PANE_HEIGHT } from '@/lib/cli-tools/opencode';
import { GEMINI_PANE_HEIGHT } from '@/lib/cli-tools/gemini';
import { STATUS_DETECTION_CAPTURE_LINES } from '@/config/status-capture-config';
import { isSessionHealthy } from './claude-session';
import { getLastServerResponseTimestamp, buildCompositeKey } from '@/lib/polling/auto-yes-manager';
import { GLOBAL_SESSION_WORKTREE_ID } from '@/lib/session/global-session-constants';
import { peekPromptWaiting } from '@/lib/session/prompt-waiting-composition';
import { deriveWaitingKind, type WaitingKind } from '@/lib/session/waiting-kind';
import { observeWaitingEdge } from '@/lib/session/waiting-episode-state';
import { isAwaitingInstruction } from '@/lib/session/agent-event-state';
import type { getMessages as GetMessagesFn, markPendingPromptsAsAnswered as MarkPendingFn, getAgentInstances as GetAgentInstancesFn } from '@/lib/db';

function getStatusCaptureLines(cliToolId: CLIToolType): number {
  if (cliToolId === 'opencode') {
    return OPENCODE_PANE_HEIGHT;
  }

  if (cliToolId === 'gemini') {
    return GEMINI_PANE_HEIGHT;
  }

  // Issue #965: detection uses a smaller capture than the display path. The
  // status detector trims trailing blank padding before windowing, so this is
  // enough to find the prompt/status while keeping capture-pane fast.
  return STATUS_DETECTION_CAPTURE_LINES;
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

/** Merge two per-instance statuses into an aggregate (logical-OR of each flag). */
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
): Promise<CliToolSessionStatus> {
  // Issue #405: Use Set.has() instead of individual hasSession() calls
  let isRunning = sessionNameSet.has(sessionName);

  // [DR1-005] Claude-only health check (other tools use simple session existence)
  if (isRunning && cliToolId === 'claude') {
    const healthResult = await isSessionHealthy(sessionName);
    if (!healthResult.healthy) {
      isRunning = false;
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
  if (isRunning) {
    try {
      const captureLines = getStatusCaptureLines(cliToolId);
      const output = await captureSessionOutput(worktreeId, cliToolId, captureLines, instanceId);
      // Issue #501, #525, #896: Pass last server response timestamp using the
      // per-instance compositeKey. Auto-yes / last-response tracking is now
      // per-instance, so alias instances read their own poller timestamp.
      const compositeKey = buildCompositeKey(worktreeId, cliToolId, instanceId);
      const lastServerResponseTs = getLastServerResponseTimestamp(compositeKey);
      const lastOutputTimestamp = lastServerResponseTs ? new Date(lastServerResponseTs) : undefined;
      const statusResult = detectSessionStatus(output, cliToolId, lastOutputTimestamp);
      // Issue #1550: SessionStatus → activity flags lives in status-mapping.ts
      ({ isWaitingForResponse, isProcessing } = sessionStatusToActivityFlags(statusResult.status));

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
          markPendingPromptsAsAnswered(db, worktreeId, cliToolId, instanceId);
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

  return {
    isRunning,
    isWaitingForResponse,
    isProcessing,
    waitingKind,
    waitingSince,
    // A dead session is not awaiting anything; the flag describes the process
    // that reported it, and that process is gone.
    awaitingInstruction: isRunning && isAwaitingInstruction(worktreeId, cliToolId, instanceId),
  };
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
 * @returns Aggregated session status for the worktree
 */
export async function detectWorktreeSessionStatus(
  worktreeId: string,
  sessionNameSet: Set<string>,
  db: ReturnType<typeof import('@/lib/db/db-instance').getDbInstance>,
  getMessages: typeof GetMessagesFn,
  markPendingPromptsAsAnswered: typeof MarkPendingFn,
  getAgentInstances: typeof GetAgentInstancesFn,
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
