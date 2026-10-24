/**
 * API Route: GET/POST /api/worktrees/:id/auto-yes
 * Manages auto-yes mode state for a worktree
 *
 * Issue #138: Extended to trigger server-side polling
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import {
  resolveSessionTarget,
  resolveSessionTargetStrict,
  type SessionTarget,
} from '@/lib/session/resolve-session-target';
import { sessionTargetConflictResponse } from '@/lib/session/session-target-conflict-response';
import {
  getAutoYesState,
  setAutoYesEnabled,
  startAutoYesPolling,
  stopAutoYesPolling,
  stopAutoYesPollingByWorktree,
  buildCompositeKey,
  getCompositeKeysByWorktree,
  extractCliToolId,
  extractInstanceId,
  type AutoYesState,
} from '@/lib/polling/auto-yes-manager';
import { AUTO_YES_ANSWER_MODES, isAutoYesAnswerMode, type AutoYesAnswerMode } from '@/types/auto-yes-answer-mode';
import { autoYesAnswerModeOf, isAutoYesShutdownStarted } from '@/lib/auto-yes-state';
import { recheckPendingDecisions } from '@/lib/hooks/pending-decision-recheck';
import {
  getSessionContractPolicySummary,
  isSessionAutoYesBlockedByContract,
  type ContractPolicySummary,
} from '@/lib/polling/auto-yes-policy';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { CLI_TOOL_IDS, isValidInstanceId, type CLIToolType } from '@/lib/cli-tools/types';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import { checkSessionOwnership, foreignSessionErrorBody } from '@/lib/cli-tools/session-ownership';
import {
  isAllowedDuration,
  DEFAULT_AUTO_YES_DURATION,
  validateStopPattern,
  type AutoYesDuration,
  type AutoYesStopReason,
} from '@/config/auto-yes-config';
import { createLogger } from '@/lib/logger';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import type { Worktree } from '@/types/models';

const logger = createLogger('api/auto-yes');

/**
 * Allowed CLI tool IDs for interactive auto-yes (session-based).
 * Derived from CLI_TOOL_IDS (Issue #368: DRY).
 * Note: This differs from claude-executor.ts ALLOWED_CLI_TOOLS which is for
 * non-interactive (-p flag) schedule execution. See R3-006.
 */
const ALLOWED_CLI_TOOLS: readonly CLIToolType[] = CLI_TOOL_IDS;

/** Response shape for auto-yes state */
interface AutoYesResponse {
  enabled: boolean;
  expiresAt: number | null;
  /**
   * Issue #3863: how the enabled grant answers questions (`recommended` /
   * `careful`) — on a POST, what an omitted `answerMode` resolved to. Omitted
   * when not enabled, so a disabled state answers exactly what it did. On the
   * single-target shapes (the `?cliToolId` GET, every POST and the top level of
   * the whole-worktree GET); the `agents` / `instances` entries keep their
   * shape and the whole-worktree GET carries `answerModeByInstance` beside
   * them, as the worktree list carries `autoYesStopReasonByInstance` (#3730).
   */
  answerMode?: AutoYesAnswerMode;
  pollingStarted?: boolean;
  /**
   * Issue #1909: which agent this state (or this arming) actually belongs to.
   *
   * Added because the answer used to be unknowable from outside: the route
   * coalesced an unresolved tool to a hard-coded claude and said nothing, so a
   * worktree whose default is copilot got a claude poller and an `enabled: true`
   * that named no agent — only the server log said which one. Carried on the
   * single-target responses (the `?cliToolId` GET and every POST), not on the
   * map entries, whose key already is the agent.
   *
   * This is also the agent `pendingDecisions` below was re-judged for: the two
   * fields describe one target, resolved once (#1898 / #1909).
   */
  cliToolId?: CLIToolType;
  instanceId?: string;
  resolvedBy?: SessionTarget['resolvedBy'];
  /** Read path only: the explicit request the roster contradicts, or null (DR3-015). */
  conflict?: SessionTarget['conflict'] | null;
  /**
   * Approvals that were already pending and got re-judged by this call
   * (Issue #1898-2), or absent when nothing was re-read.
   *
   * Enabling Auto-Yes under a dialog that is already up used to do nothing at
   * all: the request had been abstained on when it arrived, and the only
   * re-read ran on re-connect. This field is how the operator sees the
   * difference — `commandmate auto-yes --enable` says how many approvals it
   * answered on the way in.
   */
  pendingDecisions?: {
    examined: number;
    delivered: number;
    skipped: number;
  };
  /**
   * Issue #3723: what the contract governing this instance says about Auto-Yes,
   * or null when none does. Carried on the single-target responses that can
   * leave an operator believing Auto-Yes will answer — the arming POST and the
   * `?cliToolId` GET. Read through the poller's own policy lookup, so a
   * `mode: 'off'` here is the reason the poller answers nothing.
   */
  contractPolicy?: ContractPolicySummary | null;
  /**
   * Issue #3723, map entries only (`agents` / `instances`): true when the
   * instance is armed and its contract says `mode: 'off'`. Omitted otherwise,
   * so a worktree with no contract answers exactly what it did.
   */
  blockedByContract?: boolean;
  /**
   * Issue #3730: why a DISABLED state is off, when that is worth saying —
   * today only `server-restart` (the grant was live when the previous process
   * shut down). Omitted otherwise, so every other answer is the shape it was;
   * `capture --json`'s `autoYes.stopReason` keeps carrying the full reason.
   */
  stopReason?: AutoYesStopReason;
}

/**
 * The reason a disabled state publishes on this route (Issue #3730), or
 * undefined. Only `server-restart`: the other reasons stay where they always
 * were (`capture --json`), and a disabled state with no reason must not start
 * reading as one.
 */
function publishedStopReason(state: AutoYesState | null): AutoYesStopReason | undefined {
  return state && !state.enabled && state.stopReason === 'server-restart' ? state.stopReason : undefined;
}

/**
 * Build the JSON response shape from an AutoYesState.
 *
 * @param state - The stored state, or null when nothing is armed
 * @param pollingStarted - Whether this request started a poller (POST only)
 * @param target - The resolved (agent, instance) this state belongs to (Issue #1909)
 * @param pendingDecisions - What the arming re-judged on the way in (Issue #1898-2)
 */
function buildAutoYesResponse(
  state: AutoYesState | null,
  pollingStarted?: boolean,
  target?: SessionTarget,
  pendingDecisions?: AutoYesResponse['pendingDecisions']
): AutoYesResponse {
  const response: AutoYesResponse = {
    enabled: state?.enabled ?? false,
    expiresAt: state?.enabled ? state.expiresAt : null,
  };
  const stopReason = publishedStopReason(state);
  if (stopReason !== undefined) {
    response.stopReason = stopReason;
  }
  if (pollingStarted !== undefined) {
    response.pollingStarted = pollingStarted;
  }
  if (target) {
    response.cliToolId = target.cliToolId;
    response.instanceId = target.instanceId;
    response.resolvedBy = target.resolvedBy;
    response.conflict = target.conflict ?? null;
  }
  if (pendingDecisions !== undefined) {
    response.pendingDecisions = pendingDecisions;
  }
  return response;
}

/**
 * Issue #3863: a single-target response with the grant's answer mode, when it
 * is enabled (see {@link AutoYesResponse.answerMode}).
 */
function withAnswerMode(response: AutoYesResponse, state: AutoYesState | null): AutoYesResponse {
  return state?.enabled ? { ...response, answerMode: autoYesAnswerModeOf(state) } : response;
}

/** The worktree row, or the 404 response to answer with when there is none */
function findWorktreeOr404(worktreeId: string): Worktree | NextResponse {
  const db = getDbInstance();
  const worktree = getWorktreeById(db, worktreeId);
  if (!worktree) {
    return NextResponse.json(
      { error: `Worktree '${worktreeId}' not found` },
      { status: 404 }
    );
  }
  return worktree;
}

/** Validate CLI tool ID */
function isValidCliTool(cliToolId: string | undefined): cliToolId is CLIToolType {
  if (!cliToolId) return false;
  return (ALLOWED_CLI_TOOLS as readonly string[]).includes(cliToolId);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // [SEC4-SF-003] Validate worktree ID format
    const { id: requestedWorktreeId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    if (!isValidWorktreeId(id)) {
      return NextResponse.json(
        { error: 'Invalid worktree ID format' },
        { status: 400 }
      );
    }

    const found = findWorktreeOr404(id);
    if (found instanceof NextResponse) return found;

    // Issue #525: cliToolId query parameter support
    // Issue #896: optional instanceId query parameter for per-instance state
    const url = new URL(request.url);
    const cliToolIdParam = url.searchParams.get('cliToolId');
    const instanceIdParam = url.searchParams.get('instanceId') ?? undefined;

    if (instanceIdParam !== undefined && !isValidInstanceId(instanceIdParam)) {
      return NextResponse.json(
        { error: 'Invalid instanceId' },
        { status: 400 }
      );
    }

    if (cliToolIdParam) {
      // Single agent query
      if (!isValidCliTool(cliToolIdParam)) {
        return NextResponse.json(
          { error: 'Invalid cliToolId' },
          { status: 400 }
        );
      }
      // Issue #1909 / #1925 (design §4 D5 決定 3): the pair is resolved by the
      // one shared resolver instead of taken as given, so `?cliToolId=claude
      // &instanceId=oc-2` reads the state of the agent the roster says `oc-2`
      // is — the same agent the POST below arms — rather than a claude key
      // that nothing ever wrote. Reading is not a side effect, so the
      // contradiction resolves (roster wins) and ships in the payload rather
      // than answering 400 (DR3-015).
      const target = resolveSessionTarget(getDbInstance(), id, {
        instanceId: instanceIdParam,
        requestedCliTool: cliToolIdParam,
      });
      if (target.conflict) {
        logger.warn('instance-tool-conflict:', {
          worktreeId: id,
          instanceId: target.conflict.instanceId,
          rosterCliTool: target.conflict.rosterCliTool,
          requestedCliTool: target.conflict.requestedCliTool,
        });
      }
      const state = getAutoYesState(id, target.cliToolId, target.instanceId);
      return NextResponse.json({
        ...withAnswerMode(buildAutoYesResponse(state, undefined, target), state),
        contractPolicy: getSessionContractPolicySummary(id, target.cliToolId, target.instanceId),
      });
    }

    // No cliToolId: return maps keyed by agent (cliToolId) and by instance (Issue #896).
    const compositeKeys = getCompositeKeysByWorktree(id);
    const agentStates: Record<string, ReturnType<typeof buildAutoYesResponse>> = {};
    const instanceStates: Record<string, ReturnType<typeof buildAutoYesResponse>> = {};
    // Issue #3863: each enabled instance's answer mode, keyed like `instances`
    // (a primary's instance id is its agent id, so it covers `agents` too).
    const answerModeByInstance: Record<string, AutoYesAnswerMode> = {};
    // Issue #3753: two keys can share an instanceId under different tools (the
    // roster's tool changed between them). The map is keyed by instanceId, so
    // the roster's tool decides which key speaks for it; without a roster
    // entry, an enabled one wins over a disabled one.
    const claimed = new Map<string, { agentId: CLIToolType; enabled: boolean }>();
    const rosterToolOf = (instanceId: string): CLIToolType | undefined => {
      const target = resolveSessionTarget(getDbInstance(), id, { instanceId });
      return target.resolvedBy === 'roster' ? target.cliToolId : undefined;
    };
    for (const key of compositeKeys) {
      const agentId = extractCliToolId(key);
      if (!agentId) continue;
      const instanceId = extractInstanceId(key) ?? agentId;
      const state = getAutoYesState(id, agentId, instanceId);
      const previous = claimed.get(instanceId);
      if (previous) {
        const rosterTool = rosterToolOf(instanceId);
        const keepPrevious = rosterTool
          ? previous.agentId === rosterTool
          : previous.enabled || !state?.enabled;
        if (keepPrevious) continue;
      }
      claimed.set(instanceId, { agentId, enabled: !!state?.enabled });
      const entry = buildAutoYesResponse(state);
      // Issue #3723: `commandmate instances` reads this map; an armed instance
      // its contract keeps silent is flagged here, beside the arming it undoes.
      if (entry.enabled && isSessionAutoYesBlockedByContract(id, agentId, instanceId)) {
        entry.blockedByContract = true;
      }
      instanceStates[instanceId] = entry;
      if (state?.enabled) answerModeByInstance[instanceId] = autoYesAnswerModeOf(state);
      else delete answerModeByInstance[instanceId];
      // Keep the cliTool-level map populated from the primary instance for backward compat.
      if (instanceId === agentId) {
        agentStates[agentId] = { ...entry };
      }
    }

    // For backward compatibility, also include top-level fields from default agent.
    //
    // Issue #1909 / DR3-010: "default agent" is the worktree's, not a hard-coded
    // one. This is the GET-side twin of the POST bug — with `--enable`
    // fixed but this left alone, a copilot worktree would arm a copilot poller
    // and then report the (never-written, always-disabled) claude state to the
    // UI and to every reader of the top-level fields.
    const defaultTarget = resolveSessionTarget(getDbInstance(), id);
    const defaultState = getAutoYesState(id, defaultTarget.cliToolId, defaultTarget.instanceId);
    return NextResponse.json({
      ...withAnswerMode(buildAutoYesResponse(defaultState, undefined, defaultTarget), defaultState),
      agents: agentStates,
      instances: instanceStates,
      answerModeByInstance,
    });
  } catch (error: unknown) {
    logger.error('error-getting-auto-yes-state:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to get auto-yes state' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // [SEC-MF-001] Validate worktree ID format before DB query
    const { id: requestedWorktreeId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    if (!isValidWorktreeId(id)) {
      return NextResponse.json(
        { error: 'Invalid worktree ID format' },
        { status: 400 }
      );
    }

    const worktree = findWorktreeOr404(id);
    if (worktree instanceof NextResponse) return worktree;

    // [SEC-SF-001] JSON parse error handling
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 }
      );
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 }
      );
    }

    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json(
        { error: 'enabled must be a boolean' },
        { status: 400 }
      );
    }

    // [SEC-SF-002] Validate duration if provided (whitelist check with type guard)
    let duration: AutoYesDuration = DEFAULT_AUTO_YES_DURATION;
    if (body.enabled && body.duration !== undefined) {
      if (!isAllowedDuration(body.duration)) {
        return NextResponse.json(
          { error: 'Invalid duration value. Allowed values: 3600000, 10800000, 28800000' },
          { status: 400 }
        );
      }
      duration = body.duration;
    }

    // [SEC-SF-003] Validate stopPattern if provided (Issue #314)
    let stopPattern: string | undefined;
    if (body.enabled && body.stopPattern !== undefined) {
      const trimmed = typeof body.stopPattern === 'string' ? body.stopPattern.trim() : '';
      if (trimmed) {
        const validation = validateStopPattern(trimmed);
        if (!validation.valid) {
          return NextResponse.json(
            { error: validation.error },
            { status: 400 }
          );
        }
        stopPattern = trimmed;
      }
    }

    // Issue #3863: how questions are answered. Omitted keeps a live grant's
    // mode and starts a new grant at `recommended` (`setAutoYesEnabled`).
    if (body.answerMode !== undefined && !isAutoYesAnswerMode(body.answerMode)) {
      return NextResponse.json(
        { error: `Invalid answerMode. Allowed values: ${AUTO_YES_ANSWER_MODES.join(', ')}` },
        { status: 400 }
      );
    }
    const answerMode: AutoYesAnswerMode | undefined = body.answerMode;

    // [SEC4-SF-002] Validate cliToolId: reject invalid values (no fallback)
    if (body.cliToolId !== undefined && !isValidCliTool(body.cliToolId)) {
      return NextResponse.json(
        { error: 'Invalid cliToolId' },
        { status: 400 }
      );
    }

    // Issue #896: Validate optional instanceId (per-instance auto-yes).
    if (body.instanceId !== undefined && !isValidInstanceId(body.instanceId)) {
      return NextResponse.json(
        { error: 'Invalid instanceId' },
        { status: 400 }
      );
    }

    // Issue #1629: the poller keys on (worktree, cliTool, instance) and derives
    // the tmux session name from cliTool, so an instance must be paired with the
    // CLI tool its roster entry declares. Without this, `--instance codex` armed
    // auto-yes against a Claude session that was never started.
    //
    // Issue #1909 / #1925: resolution moved to the one shared resolver, which
    // is what removes the hard-coded claude this line used to coalesce to. That
    // literal was the bug: `resolveInstanceCliTool` answers null for "the
    // request named no agent" and left the worktree default to the caller, so
    // `commandmate auto-yes <id> --enable` on a copilot worktree armed a claude
    // poller, which then logged `Claude Code session ... does not exist` every
    // 2s while copilot's dialogs went unanswered. `send` / `wait` / `capture`
    // all took the worktree default; only this route did not.
    //
    // Strict, unlike the GET above: arming a poller types into a session, and
    // design §4 D5 決定 3 (DR3-015) puts `auto-yes` POST on the side-effect side
    // of that table — with two contradicting declarations of which agent is
    // meant, refusing is the only answer that cannot auto-answer a dialog in
    // the wrong pane.
    const resolution = resolveSessionTargetStrict(getDbInstance(), id, {
      instanceId: body.instanceId as string | undefined,
      requestedCliTool: body.cliToolId as CLIToolType | undefined,
    });
    if (!resolution.ok) {
      return sessionTargetConflictResponse(resolution.conflict);
    }
    const target = resolution.target;
    const cliToolId: CLIToolType = target.cliToolId;

    // Effective instance: provided instanceId, else the primary (=== cliToolId).
    const instanceId: string = target.instanceId;

    // Issue #138, #525, #896: Start or stop server-side polling (per-instance)
    let pollingStarted = false;
    let pendingDecisions: AutoYesResponse['pendingDecisions'];
    let state;
    if (body.enabled) {
      // Issue #3290: a same-named session another CommandMate server created is
      // not this worktree's to auto-answer. The poller already declines to act
      // on one (#2865), so arming used to answer 200 and show ON over a session
      // nothing would ever answer. Refused here, before any state is written,
      // with the 409 the routes that type into a session give.
      //
      // Only `foreign` is refused. `absent` goes on: `commandmate send
      // --auto-yes` arms ahead of the session it is about to start. And only
      // arming is checked — turning Auto-Yes off below writes this server's own
      // state and touches no pane, and refusing it would leave a grant nobody
      // could withdraw.
      const sessionName = resolveSessionName(cliToolId, id, instanceId);
      const ownership = await checkSessionOwnership(sessionName, worktree.path);
      if (ownership.verdict === 'foreign') {
        return NextResponse.json(foreignSessionErrorBody(sessionName, ownership.sessionPath), { status: 409 });
      }

      // Issue #3730: the ownership check above awaits, and a shutdown can
      // begin meanwhile. The shutdown has already written down which grants it
      // released, so a grant added now would be one the next process never
      // explains — and a poller started now would run into the teardown.
      // Checked here, after the last await and before the synchronous write.
      if (isAutoYesShutdownStarted()) {
        return NextResponse.json({ error: 'Server is shutting down' }, { status: 503 });
      }

      // Issue #3863: the mode is passed only when the request named one, so an
      // enable without it reaches the setter exactly as before (which keeps a
      // live grant's mode and starts a new one at `recommended`).
      state = answerMode === undefined
        ? setAutoYesEnabled(id, cliToolId, true, duration, stopPattern, instanceId)
        : setAutoYesEnabled(id, cliToolId, true, duration, stopPattern, instanceId, answerMode);
      const result = startAutoYesPolling(id, cliToolId, instanceId);
      pollingStarted = result.started;
      if (!result.started) {
        logger.warn('polling-not-started:');
      }

      // Issue #1898-2: the policy just changed, so re-judge what the agent is
      // already blocked on. The poller cannot: it reads the SCREEN, and the
      // approval this is about is an object on the agent's own server that was
      // abstained on before Auto-Yes existed for this session. Measured before
      // this call: 30+ seconds of `waiting` with no adjudication log.
      //
      // Awaited rather than fired and forgotten, so `commandmate auto-yes
      // --enable` returns only once the pending approval has been answered —
      // an operator who runs it on a stuck worker should not have to poll to
      // find out whether it worked. Bounded: it answers immediately for every
      // source that declares `resync: 'none'`, which is all five hook tools.
      //
      // Issue #1909: `cliToolId` and `instanceId` here are the pair
      // `resolveSessionTargetStrict` produced above — the same pair
      // `startAutoYesPolling` was just armed with. Passing the raw
      // `body.instanceId` instead would be equivalent today (every consumer
      // keys through `buildCompositeKey`, which collapses `undefined` into the
      // primary instance) but would read as a second, unresolved notion of the
      // target sitting next to a resolved `cliToolId`. One resolution, one pair.
      const recheck = await recheckPendingDecisions({
        worktreeId: id,
        cliToolId,
        instanceId,
      });
      if (recheck.reason === null) {
        pendingDecisions = {
          examined: recheck.examined,
          delivered: recheck.delivered,
          skipped: recheck.skipped,
        };
      }
    } else {
      // Issue #525, #896: instanceId/cliToolId specified -> stop that instance;
      // neither specified -> stop all instances for this worktree.
      if (body.instanceId) {
        state = setAutoYesEnabled(id, cliToolId, false, undefined, undefined, instanceId);
        const compositeKey = buildCompositeKey(id, cliToolId, instanceId);
        stopAutoYesPolling(compositeKey, 'manual');
      } else if (body.cliToolId) {
        state = setAutoYesEnabled(id, cliToolId, false);
        const compositeKey = buildCompositeKey(id, cliToolId);
        stopAutoYesPolling(compositeKey, 'manual');
      } else {
        // Disable all agents/instances for this worktree
        const keys = getCompositeKeysByWorktree(id);
        for (const key of keys) {
          const toolId = extractCliToolId(key);
          if (toolId) {
            setAutoYesEnabled(id, toolId, false, undefined, undefined, extractInstanceId(key) ?? undefined);
          }
        }
        // Issue #3713: a disable, not a delete — the memory of an answer stopped
        // part-way (and a send still in flight) is kept, as for one agent.
        stopAutoYesPollingByWorktree(id, { keepPartialAnswers: true, reason: 'manual' });
        state = { enabled: false, enabledAt: 0, expiresAt: 0 };
      }
    }

    // Issue #1909: the resolved target rides back on the response so the caller
    // can name the agent it just armed. The CLI prints it; before this the only
    // record of the choice was `poller:started` in the server log.
    //
    // Withheld from the untargeted `{enabled: false}` request, which disables
    // every instance of the worktree: naming one agent there would describe a
    // request that deliberately named none. `pendingDecisions` (#1898-2) is
    // undefined on that path anyway — nothing is re-judged when nothing is armed.
    const targetedRequest = body.enabled || !!body.instanceId || !!body.cliToolId;
    const response = withAnswerMode(
      buildAutoYesResponse(state, pollingStarted, targetedRequest ? target : undefined, pendingDecisions),
      state ?? null
    );
    // Issue #3723: arming answered `enabled: true` even when the contract on
    // this instance says `autoYes.mode: 'off'`, so the poller would answer
    // nothing — the reason surfaced only in `capture --json`'s lastSuppression,
    // after a prompt had already sat unanswered. Read after
    // `startAutoYesPolling`, which drops the cached policy when it starts a
    // poller; otherwise the policy is at most AUTO_YES_POLICY_CACHE_TTL_MS old,
    // the same staleness the poller itself judges with.
    if (body.enabled) {
      response.contractPolicy = getSessionContractPolicySummary(id, cliToolId, instanceId);
    }
    return NextResponse.json(response);
  } catch (error: unknown) {
    logger.error('error-setting-auto-yes-state:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to set auto-yes state' },
      { status: 500 }
    );
  }
}
