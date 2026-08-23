/**
 * The per-instance turn model (Issue #1930, 方針書 §4 D3 決定 2・3 / §5.2 / §6.2).
 *
 * The state this replaces was "the newest structured event is the verdict", and
 * the reason it had to go is that an event carrying no verdict — a
 * `session_start`, a `session_end`, an unrecognised `Notification`, a
 * `permission.replied` — erased the one that did. #1903 fixed the single
 * measured instance of that (copilot's late `SessionStart`) by holding the
 * delivery; this Issue makes the rule general and gives a turn an identity.
 *
 * ## What these tests are written against
 *
 * Every case below is either a **measured sequence** or a **mutation**, and the
 * two do different jobs:
 *
 *  - a measured sequence pins behaviour against something a real agent did. The
 *    opencode approval flow and copilot's 12-second `SessionStart` are both in
 *    the live-verification reports, and both were bugs under the old model.
 *  - a mutation flips a **declared capability** and asserts the outcome flips
 *    with it. That is what separates "the fix works" from "the fix is
 *    `if (cliToolId === 'copilot')`" — §4 D3 決定 1 requires the branch to be a
 *    declared value, and a suite that never flips one cannot tell.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginAgentEventGeneration,
  classifyAgentEventDelivery,
  clearAgentStopEvents,
  clearStructuredPromptWaiting,
  corroborateStructuredPromptWaiting,
  discardAgentEventState,
  getAgentEventDropCounts,
  getAgentTurn,
  getPendingDecisions,
  getPublishedAgentTurn,
  getStructuredPromptWaiting,
  getStructuredSessionState,
  observeScraperCompletionEvidence,
  closeAgentTurn,
  recordAgentEvent,
  reportPermissionRequestPending,
  STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS,
  STRUCTURED_STATE_MAX_AGE_MS,
  type AgentEventRecord,
} from '@/lib/session/agent-event-state';
import {
  acceptExternalId,
  MAX_EXTERNAL_ID_LENGTH,
  MAX_PENDING_DECISIONS_PER_TURN,
  SCRAPER_COMPLETION_POLLS,
  isDeliveryExpired,
} from '@/lib/session/provisional-turn';
import { HOOK_STATUS_REASON } from '@/lib/session/status-mapping';
import { PERMISSION_REPLIED_DETAIL } from '@/lib/hooks/agent-event-types';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WT = 'wt-1930';
const T0 = 1_800_000_000_000;
const SESSION_A = 'ses_aaaaaaaa';
const SESSION_B = 'ses_bbbbbbbb';

beforeEach(() => {
  clearAgentStopEvents();
});

/** Record one event against wt-1930 / `tool` / `tool`. */
function post(
  tool: CLIToolType,
  record: Partial<AgentEventRecord> & Pick<AgentEventRecord, 'event' | 'at'>,
  options: Parameters<typeof recordAgentEvent>[4] = {},
): ReturnType<typeof recordAgentEvent> {
  return recordAgentEvent(
    WT,
    tool,
    tool,
    { detail: null, sessionId: SESSION_A, ...record },
    options,
  );
}

const status = (tool: CLIToolType, now: number) =>
  getStructuredSessionState(WT, tool, tool, now);
const turn = (tool: CLIToolType, now: number) => getAgentTurn(WT, tool, tool, now);
const drops = (tool: CLIToolType) => getAgentEventDropCounts(WT, tool, tool);

// =============================================================================
// Turn identity
// =============================================================================

describe('[#1930] a turn has an identity', () => {
  it('keeps turnId and openedAt across every tool call inside one turn', () => {
    post('claude', { event: 'user_prompt_submit', at: T0 });
    const opened = getPublishedAgentTurn(WT, 'claude', 'claude', T0 + 1);

    post('claude', { event: 'pre_tool_use', at: T0 + 1_000, detail: 'Bash' });
    post('claude', { event: 'post_tool_use', at: T0 + 2_000, detail: 'Bash' });
    post('claude', { event: 'pre_tool_use', at: T0 + 3_000, detail: 'Read' });

    const mid = getPublishedAgentTurn(WT, 'claude', 'claude', T0 + 3_001);
    expect(mid.turnId).toBe(opened.turnId);
    expect(mid.openedAt).toBe(T0);
    expect(mid.closedAt).toBeNull();
    // The whole turn still reads `running`, and the reason names the event that
    // actually last spoke rather than the one that opened it.
    expect(status('claude', T0 + 3_001)).toMatchObject({
      status: 'running',
      reason: HOOK_STATUS_REASON.PRE_TOOL_USE,
    });
  });

  it('gives the next prompt a different turn', () => {
    post('claude', { event: 'user_prompt_submit', at: T0 });
    const first = getPublishedAgentTurn(WT, 'claude', 'claude', T0 + 1).turnId;

    post('claude', { event: 'stop', at: T0 + 1_000 });
    post('claude', { event: 'user_prompt_submit', at: T0 + 2_000 });

    const second = getPublishedAgentTurn(WT, 'claude', 'claude', T0 + 2_001);
    expect(second.turnId).not.toBe(first);
    expect(second.openedAt).toBe(T0 + 2_000);
    expect(second.closedAt).toBeNull();
  });

  it('publishes a null openedAt for a stop whose turn was never seen open', () => {
    // #1926 made this call and it survives the rewrite: `closedAt - openedAt` is
    // an elapsed time a header chip renders, so a guess is worse than a null.
    post('claude', { event: 'stop', at: T0 });

    expect(getPublishedAgentTurn(WT, 'claude', 'claude', T0 + 1)).toMatchObject({
      openedAt: null,
      closedAt: T0,
      closedBy: 'stop',
    });
    expect(status('claude', T0 + 1)).toMatchObject({
      status: 'ready',
      reason: HOOK_STATUS_REASON.STOP,
    });
  });
});

// =============================================================================
// An event with no verdict does not close a turn, and does not erase one
// =============================================================================

describe('[#1930] a verdict-less event is inert (§4 D3 決定 2)', () => {
  it('does not let an unrecognised notification become the event the verdict is read from', () => {
    post('claude', { event: 'user_prompt_submit', at: T0 });
    post('claude', { event: 'notification', at: T0 + 1_000, detail: 'some_future_type' });

    // The status AND the event it was read from. Asserting only the status
    // would pass either way — an open turn falls back to `running` whatever the
    // display says — and the difference that matters is the staleness clock: a
    // stream of unrecognised notifications must not keep a turn nobody is
    // progressing alive for ever.
    expect(status('claude', T0 + 1_001)).toEqual({
      status: 'running',
      reason: HOOK_STATUS_REASON.PROMPT_SUBMIT,
      event: 'user_prompt_submit',
      at: T0,
      detail: null,
    });
    expect(status('claude', T0 + STRUCTURED_STATE_MAX_AGE_MS)).toBeNull();
  });

  it('leaves a closed turn ready after an unrecognised notification', () => {
    // The mirror image, and the one the old model got wrong in the other
    // direction: a `Stop` followed by a notification nobody recognises used to
    // publish "nothing is known", handing a finished session back to the
    // scraper for no reason.
    post('claude', { event: 'stop', at: T0 });
    post('claude', { event: 'notification', at: T0 + 1_000, detail: 'some_future_type' });

    expect(status('claude', T0 + 1_001)).toEqual({
      status: 'ready',
      reason: HOOK_STATUS_REASON.STOP,
      event: 'stop',
      at: T0,
      detail: null,
    });
  });

  it('retires a finished turn when the agent session ends under it', () => {
    // The one place a later event rewrites an earlier close reason, and #1723's
    // contract is why: `/clear` emits `SessionEnd(reason=clear)` on a session
    // that is alive and about to keep going, and the turn before it may have
    // ended with a perfectly good `Stop`. Leaving that `Stop` standing would
    // keep publishing "the agent finished" about a conversation that is gone.
    post('claude', { event: 'user_prompt_submit', at: T0 });
    post('claude', { event: 'stop', at: T0 + 1_000 });
    expect(status('claude', T0 + 1_001)?.status).toBe('ready');

    post('claude', { event: 'session_end', at: T0 + 2_000, detail: 'clear' });

    expect(turn('claude', T0 + 2_001)).toMatchObject({ closedBy: 'session_end' });
    expect(status('claude', T0 + 2_001)).toBeNull();
  });

  it('publishes `ready` for an idle_prompt that is the first thing ever heard', () => {
    // #1723 publishes `hook_idle_prompt` for this, and it arrives on instances
    // that have opened no turn at all — a session that was already sitting at
    // its composer when the server started. The record it opens is display-only
    // (`openedAt` stays null), because an agent at its composer is not in a turn
    // and a record that claimed otherwise would gate `wait` on nothing.
    post('claude', { event: 'notification', at: T0, detail: 'idle_prompt' });

    expect(status('claude', T0 + 1)).toMatchObject({
      status: 'ready',
      reason: HOOK_STATUS_REASON.IDLE_PROMPT,
    });
    expect(getPublishedAgentTurn(WT, 'claude', 'claude', T0 + 1).openedAt).toBeNull();
  });

  it('ends the turn on session_end without calling it a completion', () => {
    // `/clear` emits SessionEnd on a session that is alive and about to keep
    // going. The turn is over — the work was abandoned — but nothing says the
    // pane is free, so the scraper takes it back.
    post('claude', { event: 'user_prompt_submit', at: T0 });
    post('claude', { event: 'session_end', at: T0 + 1_000, detail: 'clear' });

    expect(turn('claude', T0 + 1_001)).toMatchObject({
      closedAt: T0 + 1_000,
      closedBy: 'session_end',
    });
    expect(status('claude', T0 + 1_001)).toBeNull();
  });
});

// =============================================================================
// copilot: UserPromptSubmit -> 12 s -> SessionStart
// =============================================================================

describe('[#1930] copilot reports SessionStart 12 s into the turn (#1903, measured)', () => {
  const LATE = { sessionStartMayArriveLate: true } as const;

  it('keeps the turn open and does not let the frame become the display', () => {
    post('copilot', { event: 'user_prompt_submit', at: T0 }, LATE);
    const opened = getPublishedAgentTurn(WT, 'copilot', 'copilot', T0 + 1);

    expect(post('copilot', { event: 'session_start', at: T0 + 12_000 }, LATE)).toEqual({
      recorded: false,
      skipped: 'late-session-start',
    });

    const after = getPublishedAgentTurn(WT, 'copilot', 'copilot', T0 + 12_001);
    expect(after.turnId).toBe(opened.turnId);
    expect(after.closedAt).toBeNull();
    expect(status('copilot', T0 + 12_001)).toMatchObject({
      status: 'running',
      reason: HOOK_STATUS_REASON.PROMPT_SUBMIT,
    });
  });

  it('MUTATION: declaring the ordinary ordering puts the overwrite back', () => {
    // The assertion the tool-id version of this fix would still pass. Flip the
    // declared capability and copilot behaves like the other five sources: the
    // frame is recorded, it opens a generation, and the turn it fenced off is
    // no longer this instance's.
    post('copilot', { event: 'user_prompt_submit', at: T0 }, { sessionStartMayArriveLate: false });
    expect(
      post('copilot', { event: 'session_start', at: T0 + 12_000 }, { sessionStartMayArriveLate: false }),
    ).toEqual({ recorded: true });

    expect(status('copilot', T0 + 12_001)).toBeNull();
    expect(turn('copilot', T0 + 12_001)).toMatchObject({ closedBy: 'generation' });
  });

  it('MUTATION: declaring the late ordering holds claude’s SessionStart too', () => {
    post('claude', { event: 'user_prompt_submit', at: T0 }, { sessionStartMayArriveLate: true });
    post('claude', { event: 'session_start', at: T0 + 12_000 }, { sessionStartMayArriveLate: true });

    expect(status('claude', T0 + 12_001)?.status).toBe('running');
  });

  it('records a SessionStart that names a different agent session', () => {
    // A genuine relaunch inside the pane. Holding THAT frame would keep
    // publishing a dead process's `running`.
    post('copilot', { event: 'user_prompt_submit', at: T0, sessionId: SESSION_A }, LATE);
    expect(
      post('copilot', { event: 'session_start', at: T0 + 12_000, sessionId: SESSION_B }, LATE),
    ).toEqual({ recorded: true });

    expect(status('copilot', T0 + 12_001)).toBeNull();
  });
});

// =============================================================================
// The measured opencode approval flow
// =============================================================================

describe('[#1930] the opencode SSE sequence, end to end', () => {
  /**
   * `permission.asked -> permission.replied -> message.updated(user) ->
   * session.idle -> message.updated(user)`, in this codebase's vocabulary.
   *
   * The last frame is the one the old model could not express: after an idle,
   * a further user message is a NEW turn, and a model whose only state was
   * "the newest event" had no way to say so — the id it published was the id of
   * whatever had last happened.
   */
  const OPENCODE: CLIToolType = 'opencode';
  const DECISION = 'per_abc123';

  it('opens waiting, releases on the reply, and gives the next prompt its own turn', () => {
    // permission.asked
    post(OPENCODE, {
      event: 'notification',
      at: T0,
      detail: 'permission_prompt',
      decisionId: DECISION,
      message: 'opencode wants to run rm -rf build',
    });
    expect(status(OPENCODE, T0 + 1)).toMatchObject({
      status: 'waiting',
      reason: HOOK_STATUS_REASON.PERMISSION_PROMPT,
    });
    expect(getPendingDecisions(WT, OPENCODE, OPENCODE, T0 + 1)).toHaveLength(1);

    // permission.replied — the source declares permissionReplyReleasesPrompt,
    // which is what the caller turns into `promptSettled`.
    post(OPENCODE, {
      event: 'notification',
      at: T0 + 3_000,
      detail: PERMISSION_REPLIED_DETAIL,
      decisionId: DECISION,
      promptSettled: true,
    });
    expect(getPendingDecisions(WT, OPENCODE, OPENCODE, T0 + 3_001)).toHaveLength(0);
    // No turn was ever seen to open, so the pane goes back to the scraper
    // rather than to a `running` nothing observed.
    expect(status(OPENCODE, T0 + 3_001)).toBeNull();

    // message.updated(user)
    post(OPENCODE, { event: 'user_prompt_submit', at: T0 + 4_000 });
    const first = getPublishedAgentTurn(WT, OPENCODE, OPENCODE, T0 + 4_001);
    expect(first.openedAt).toBe(T0 + 4_000);
    expect(status(OPENCODE, T0 + 4_001)?.status).toBe('running');

    // session.idle
    post(OPENCODE, { event: 'stop', at: T0 + 9_000 });
    expect(status(OPENCODE, T0 + 9_001)?.status).toBe('ready');

    // message.updated(user), again
    post(OPENCODE, { event: 'user_prompt_submit', at: T0 + 10_000 });
    const second = getPublishedAgentTurn(WT, OPENCODE, OPENCODE, T0 + 10_001);
    expect(second.turnId).not.toBe(first.turnId);
    expect(second.openedAt).toBe(T0 + 10_000);
    expect(second.closedAt).toBeNull();
  });

  it("does not let another session's idle close this turn", () => {
    // opencode's `GET /session` returns sessions belonging to other processes
    // entirely (#1758 §5.6), and its event stream publishes `session.idle` for
    // all of them. One of those completing must not complete this pane's work.
    post(OPENCODE, { event: 'user_prompt_submit', at: T0, sessionId: SESSION_A });
    post(OPENCODE, { event: 'stop', at: T0 + 1_000, sessionId: SESSION_B });

    expect(turn(OPENCODE, T0 + 1_001)).toMatchObject({ closedAt: null });
    expect(status(OPENCODE, T0 + 1_001)?.status).toBe('running');

    // ...and this session's own idle still does.
    post(OPENCODE, { event: 'stop', at: T0 + 2_000, sessionId: SESSION_A });
    expect(status(OPENCODE, T0 + 2_001)?.status).toBe('ready');
  });

  it('releases only the decision the reply names', () => {
    post(OPENCODE, { event: 'notification', at: T0, detail: 'permission_prompt', decisionId: 'per_one' });
    post(OPENCODE, {
      event: 'notification',
      at: T0 + 100,
      detail: 'permission_prompt',
      decisionId: 'per_two',
    });
    expect(getPendingDecisions(WT, OPENCODE, OPENCODE, T0 + 101)).toHaveLength(2);

    post(OPENCODE, {
      event: 'notification',
      at: T0 + 200,
      detail: PERMISSION_REPLIED_DETAIL,
      decisionId: 'per_one',
      promptSettled: true,
    });

    const left = getPendingDecisions(WT, OPENCODE, OPENCODE, T0 + 201);
    expect(left.map((decision) => decision.decisionId)).toEqual(['per_two']);
  });
});

// =============================================================================
// Session recreation
// =============================================================================

describe('[#1930] a turn is not inherited across a session recreation', () => {
  it('closes the open turn as `generation` and starts the next one clean', () => {
    post('claude', { event: 'user_prompt_submit', at: T0 });
    post('claude', {
      event: 'notification',
      at: T0 + 500,
      detail: 'permission_prompt',
      message: 'needs your permission to use Bash',
    });
    const before = getPublishedAgentTurn(WT, 'claude', 'claude', T0 + 501).turnId;
    expect(getPendingDecisions(WT, 'claude', 'claude', T0 + 501)).toHaveLength(1);

    beginAgentEventGeneration(WT, 'claude', 'claude', T0 + 1_000);

    // The turn is closed and says why; the approval the dead process was
    // holding is gone, and the count of it is published rather than swallowed.
    expect(turn('claude', T0 + 1_001)).toMatchObject({ closedBy: 'generation' });
    expect(status('claude', T0 + 1_001)).toBeNull();
    expect(getStructuredPromptWaiting(WT, 'claude', 'claude', T0 + 1_001)).toBeNull();
    expect(drops('claude').decisionEvicted).toBe(1);

    // An event from before the fence cannot resurrect it, whatever order it
    // arrives in.
    post('claude', { event: 'user_prompt_submit', at: T0 });
    expect(status('claude', T0 + 1_002)).toBeNull();

    post('claude', { event: 'user_prompt_submit', at: T0 + 2_000 });
    const after = getPublishedAgentTurn(WT, 'claude', 'claude', T0 + 2_001);
    expect(after.turnId).not.toBe(before);
    expect(after.openedAt).toBe(T0 + 2_000);
  });

  it('does not let the previous process’s Stop publish `ready` for a fresh session', () => {
    // The other half of the fence, and the one that is invisible if the only
    // case tested is an open turn: a session restarted moments after its agent
    // finished would otherwise publish "the agent finished" for a pane nobody
    // has typed into yet.
    post('claude', { event: 'user_prompt_submit', at: T0 });
    post('claude', { event: 'stop', at: T0 + 1_000 });
    expect(status('claude', T0 + 1_001)?.status).toBe('ready');

    beginAgentEventGeneration(WT, 'claude', 'claude', T0 + 2_000);

    expect(status('claude', T0 + 2_001)).toBeNull();
    expect(turn('claude', T0 + 2_001)).toBeNull();
  });

  it('drops everything for an instance whose session was stopped', () => {
    post('claude', { event: 'user_prompt_submit', at: T0 });
    discardAgentEventState(WT, 'claude', 'claude');

    expect(turn('claude', T0 + 1)).toBeNull();
    expect(status('claude', T0 + 1)).toBeNull();
  });

  it('keeps instances of the same tool apart', () => {
    recordAgentEvent(WT, 'claude', 'claude-2', {
      event: 'user_prompt_submit',
      at: T0,
      detail: null,
      sessionId: SESSION_A,
    });
    beginAgentEventGeneration(WT, 'claude', 'claude', T0 + 1_000);

    expect(getStructuredSessionState(WT, 'claude', 'claude-2', T0 + 1_001)?.status).toBe('running');
  });
});

// =============================================================================
// Expiry: the two bounds, kept apart
// =============================================================================

describe('[#1930] the bounds', () => {
  it('closes an unheard-from turn as `stale` at the staleness bound', () => {
    post('claude', { event: 'user_prompt_submit', at: T0 });

    expect(status('claude', T0 + STRUCTURED_STATE_MAX_AGE_MS - 1)?.status).toBe('running');
    expect(status('claude', T0 + STRUCTURED_STATE_MAX_AGE_MS)).toBeNull();
    expect(turn('claude', T0 + STRUCTURED_STATE_MAX_AGE_MS)).toMatchObject({
      closedBy: 'stale',
      closedAt: T0 + STRUCTURED_STATE_MAX_AGE_MS,
    });
  });

  it('expires a prediction far sooner than a proof', () => {
    reportPermissionRequestPending(WT, 'codex', 'codex', 'Bash', T0);

    const nearly = T0 + STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS - 1;
    expect(getStructuredPromptWaiting(WT, 'codex', 'codex', nearly)).not.toBeNull();
    expect(status('codex', nearly)).toMatchObject({
      status: 'waiting',
      reason: HOOK_STATUS_REASON.PERMISSION_REQUEST,
    });

    const past = T0 + STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS;
    expect(getStructuredPromptWaiting(WT, 'codex', 'codex', past)).toBeNull();
    expect(drops('codex').dialogTimedOut).toBe(1);
  });

  it('stops expiring a prediction early once something proves the dialog', () => {
    reportPermissionRequestPending(WT, 'codex', 'codex', 'Bash', T0);
    corroborateStructuredPromptWaiting(WT, 'codex', 'codex', T0 + 1_000);

    const past = T0 + STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS + 1;
    expect(getStructuredPromptWaiting(WT, 'codex', 'codex', past)).not.toBeNull();
  });

  it('keeps `waiting` after the DELIVERY window closes', () => {
    // The separation §4 D3 asks for. copilot stops listening for a verdict after
    // ~10 s; the dialog it drew is still on the pane, and reporting the pane
    // free at ten seconds would be the wrong half of the fact.
    post('claude', { event: 'notification', at: T0, detail: 'permission_prompt' });

    const decision = getPendingDecisions(WT, 'claude', 'claude', T0 + 11_000)[0];
    expect(decision).toBeDefined();
    expect(isDeliveryExpired(decision, 10, T0 + 11_000)).toBe(true);
    expect(isDeliveryExpired(decision, null, T0 + 11_000)).toBe(false);
    // ...and the state is unchanged by it.
    expect(status('claude', T0 + 11_000)?.status).toBe('waiting');
  });
});

// =============================================================================
// Closures nothing in the event stream can produce
// =============================================================================

describe('[#1930] the screen can close a turn the agent never closed', () => {
  it('needs consecutive positive readings, and resets on any other frame', () => {
    post('claude', { event: 'user_prompt_submit', at: T0 });

    for (let i = 1; i < SCRAPER_COMPLETION_POLLS; i++) {
      expect(observeScraperCompletionEvidence(WT, 'claude', 'claude', true, T0 + i)).toBe(false);
    }
    // One frame that is not a finished composer, and the count starts over.
    expect(observeScraperCompletionEvidence(WT, 'claude', 'claude', false, T0 + 10)).toBe(false);
    expect(status('claude', T0 + 11)?.status).toBe('running');

    for (let i = 1; i < SCRAPER_COMPLETION_POLLS; i++) {
      observeScraperCompletionEvidence(WT, 'claude', 'claude', true, T0 + 10 + i);
    }
    expect(
      observeScraperCompletionEvidence(WT, 'claude', 'claude', true, T0 + 20),
    ).toBe(true);

    expect(turn('claude', T0 + 21)).toMatchObject({ closedBy: 'scraper_evidence' });
    // Closed by the SCREEN, so no `ready` is published over the hook channel —
    // the pane goes back to the layer that made the observation.
    expect(status('claude', T0 + 21)).toBeNull();
  });

  it('accepts a resync that answered "not busy", and refuses a closed turn', () => {
    post('claude', { event: 'user_prompt_submit', at: T0 });

    expect(closeAgentTurn(WT, 'claude', 'claude', 'resync_idle', T0 + 1_000)).toBe(true);
    expect(turn('claude', T0 + 1_001)).toMatchObject({ closedBy: 'resync_idle' });
    expect(closeAgentTurn(WT, 'claude', 'claude', 'resync_idle', T0 + 2_000)).toBe(false);
  });
});

// =============================================================================
// S1 / S3 / S14: what is kept, and what is refused
// =============================================================================

describe('[#1930] S1: an external id is discarded, never truncated', () => {
  const OVERLONG = `per_${'a'.repeat(MAX_EXTERNAL_ID_LENGTH)}`;

  it('refuses an id that is too long, empty, or carries control characters', () => {
    expect(acceptExternalId('per_abc')).toBe('per_abc');
    expect(acceptExternalId('a'.repeat(MAX_EXTERNAL_ID_LENGTH))).toHaveLength(
      MAX_EXTERNAL_ID_LENGTH,
    );
    expect(acceptExternalId(OVERLONG)).toBeNull();
    expect(acceptExternalId('')).toBeNull();
    expect(acceptExternalId(`per_${String.fromCharCode(10)}abc`)).toBeNull();
    expect(acceptExternalId(String.fromCharCode(127))).toBeNull();
    expect(acceptExternalId(42)).toBeNull();
  });

  it('does not store a prefix of a refused id', () => {
    // The failure a truncating implementation produces is silent: two ids that
    // share a prefix become one, and the reply to one approval retires the
    // record for the other.
    post('opencode', {
      event: 'notification',
      at: T0,
      detail: 'permission_prompt',
      decisionId: OVERLONG,
    });

    const decisions = getPendingDecisions(WT, 'opencode', 'opencode', T0 + 1);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decisionId).toBeNull();
    expect(drops('opencode').idsDiscarded).toBe(1);
  });

  it('refuses one on the dedup path too, and falls back to the time window', () => {
    const verdict = classifyAgentEventDelivery({
      worktreeId: WT,
      cliToolId: 'opencode',
      instanceId: 'opencode',
      event: 'post_tool_use',
      detail: 'Bash',
      sessionId: SESSION_A,
      at: T0,
      identity: OVERLONG,
      identityKind: 'tool-call-id',
    });

    expect(verdict).toEqual({ duplicate: false });
    expect(drops('opencode').idsDiscarded).toBe(1);
  });
});

describe('[#1930] S3: the received payload is not retained', () => {
  it('keeps only the bounded fields a later reader can act on', () => {
    post('claude', {
      event: 'notification',
      at: T0,
      detail: 'permission_prompt',
      message: 'x'.repeat(5_000),
      decisionId: 'per_kept',
    });

    const decision = getPendingDecisions(WT, 'claude', 'claude', T0 + 1)[0];
    expect(Object.keys(decision).sort()).toEqual([
      'at',
      'confirmedAt',
      'decisionId',
      'message',
      'recorded',
      'scraperCorroborated',
      'source',
      'toolName',
    ]);
    // Bounded, and bounded to the shared constant rather than to a literal of
    // its own.
    expect(decision.message!.length).toBeLessThanOrEqual(500);
  });
});

describe('[#1930] S14: every bound counts what it dropped', () => {
  it('refuses decisions past the per-turn cap and says how many', () => {
    for (let i = 0; i < MAX_PENDING_DECISIONS_PER_TURN + 5; i++) {
      post('opencode', {
        event: 'notification',
        at: T0 + i,
        detail: 'permission_prompt',
        decisionId: `per_${i}`,
      });
    }

    expect(getPendingDecisions(WT, 'opencode', 'opencode', T0 + 100)).toHaveLength(
      MAX_PENDING_DECISIONS_PER_TURN,
    );
    expect(drops('opencode').decisionOverflow).toBe(5);
  });

  it('counts a de-duplicated delivery under the rule that judged it', () => {
    const delivery = {
      worktreeId: WT,
      cliToolId: 'opencode' as CLIToolType,
      instanceId: 'opencode',
      event: 'post_tool_use' as const,
      detail: 'Bash',
      sessionId: SESSION_A,
      at: T0,
      identity: 'call_xyz',
      identityKind: 'tool-call-id' as const,
    };

    expect(classifyAgentEventDelivery(delivery)).toEqual({ duplicate: false });
    expect(classifyAgentEventDelivery(delivery)).toEqual({ duplicate: true, by: 'identity' });
    expect(drops('opencode').dedupDropped).toEqual({ identity: 1, timeWindow: 0 });

    // MUTATION: the same two frames from a source that declares no identity
    // fall to the time window, and are counted there instead.
    const noIdentity = { ...delivery, cliToolId: 'claude' as CLIToolType, instanceId: 'claude', identityKind: null };
    expect(classifyAgentEventDelivery(noIdentity)).toEqual({ duplicate: false });
    expect(classifyAgentEventDelivery(noIdentity)).toEqual({ duplicate: true, by: 'time-window' });
    expect(drops('claude').dedupDropped).toEqual({ identity: 0, timeWindow: 1 });
  });
});

// =============================================================================
// The dialog release rules the scraper is entitled to
// =============================================================================

describe('[#1930] the dialog surface #1725 published is unchanged', () => {
  it('still hands `prompt-waiting-composition` a live, writable record', () => {
    post('claude', { event: 'notification', at: T0, detail: 'permission_prompt' });

    const state = getStructuredPromptWaiting(WT, 'claude', 'claude', T0 + 1)!;
    expect(state.scraperCorroborated).toBe(false);
    corroborateStructuredPromptWaiting(WT, 'claude', 'claude', T0 + 1_000);
    expect(getStructuredPromptWaiting(WT, 'claude', 'claude', T0 + 1_001)!.scraperCorroborated).toBe(
      true,
    );

    clearStructuredPromptWaiting(WT, 'claude', 'claude');
    expect(getStructuredPromptWaiting(WT, 'claude', 'claude', T0 + 1_002)).toBeNull();
  });

  it('releases every dialog when the scraper says the pane is clear', () => {
    post('opencode', { event: 'notification', at: T0, detail: 'permission_prompt', decisionId: 'per_1' });
    post('opencode', { event: 'notification', at: T0 + 1, detail: 'permission_prompt', decisionId: 'per_2' });

    clearStructuredPromptWaiting(WT, 'opencode', 'opencode');

    expect(getPendingDecisions(WT, 'opencode', 'opencode', T0 + 2)).toHaveLength(0);
  });

  it('leaves the dialog alone on pre_tool_use and retires it on post_tool_use', () => {
    post('claude', { event: 'user_prompt_submit', at: T0 });
    post('claude', { event: 'notification', at: T0 + 100, detail: 'permission_prompt' });

    post('claude', { event: 'pre_tool_use', at: T0 + 200, detail: 'AskUserQuestion' });
    expect(status('claude', T0 + 201)?.status).toBe('waiting');

    post('claude', { event: 'post_tool_use', at: T0 + 300, detail: 'Bash' });
    expect(status('claude', T0 + 301)).toMatchObject({
      status: 'running',
      reason: HOOK_STATUS_REASON.POST_TOOL_USE,
    });
  });

  it('publishes ready on idle_prompt without calling the turn over', () => {
    // #1839 measured Claude emitting `Notification(idle_prompt)` 62 s into a
    // turn that ran nothing at all. It cannot be a turn boundary, so the turn
    // stays open and `wait`'s gate stays armed — only the display moves.
    post('claude', { event: 'user_prompt_submit', at: T0 });
    post('claude', { event: 'notification', at: T0 + 62_000, detail: 'idle_prompt' });

    expect(status('claude', T0 + 62_001)).toMatchObject({
      status: 'ready',
      reason: HOOK_STATUS_REASON.IDLE_PROMPT,
    });
    expect(turn('claude', T0 + 62_001)).toMatchObject({ closedAt: null, openedAt: T0 });
  });
});
