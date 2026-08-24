/**
 * The #1708 hatch, pinned on the MERGED verdict (Issue #1927, DR2-003 / §11;
 * corrected by Issue #2011).
 *
 * ## Why this file exists at all
 *
 * §4 D1 決定 3 abolishes the `ready` the five-second staleness heuristic used to
 * publish: `no_recent_output` now says `running` with no evidence. That single
 * change reaches into `mergeStructuredStatus`, whose override branch was keyed
 * on `scraper.status === 'running'` — a shape `no_recent_output` did not have
 * before and does now. The branch would therefore begin firing on a frame
 * NOBODY COULD READ, and if the hatch is derived from the evidence it publishes,
 * take the escape away at exactly the moment it is worth having: the pane is
 * unreadable and the agent's hooks say the turn is done.
 *
 * §11 spells out the consequence for testing, and it is the whole point of this
 * file: **a scraper-level fixture cannot see this**. `detectSessionStatus` never
 * runs `mergeStructuredStatus`, so a suite that pins the detector's verdict
 * stays green while the merged flag flips underneath it. The pin has to be on
 * the payload `buildCurrentOutput` publishes.
 *
 * ## What #2011 changed
 *
 * #1927 protected the hatch by refusing to raise `evidence`, because the flag
 * was `evidence === 'none'`. That guard was a no-op — its own conjunct required
 * the evidence to already be `'positive'` — and the coupling it was compensating
 * for is what stalled every idle Claude pane. So the two are separate facts now:
 *
 *  - **table A — the unreadable routes.** `no_recent_output` and `default` keep
 *    the hatch open, INCLUDING under a structured `ready`. Unchanged, and this
 *    is the table that goes red if the flag is re-derived from the evidence.
 *  - **table B — the idle route.** `input_prompt` keeps the hatch SHUT whatever
 *    the evidence says. This is the regression #2011 fixes.
 *  - **table C — the agent's own word.** A `Stop` that closed a turn this server
 *    watched open publishes `evidence: 'positive'`, so a payload can no longer
 *    say `hook_stop` in one field and deny it in another.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null), createMessage: vi.fn() }));

const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ isRunning: (...args: unknown[]) => isRunning(...args) }) }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));

const getLastServerResponseTimestamp = vi.fn<() => number | null>(() => null);
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: (...args: unknown[]) =>
    (getLastServerResponseTimestamp as (...a: unknown[]) => number | null)(...args),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-1:claude'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import {
  clearAgentStopEvents,
  recordAgentEvent,
} from '@/lib/session/agent-event-state';
import { IDLE_EVIDENCE_ENV_VAR } from '@/config/detection-evidence-config';
import { STATUS_REASON } from '@/lib/detection/status-detector';
import { buildClaudeIdleComposerFrame } from '../../fixtures/claude-idle-composer';

const db = {} as Database.Database;

/** A frame with no marker, no indicator and no composer: `running` / `default`. */
const UNREADABLE_FRAME = 'a line of prose that matches nothing in particular';

/** A frame whose spinner is on screen: `running` / `thinking_indicator`. */
const BUSY_FRAME = 'writing files\n\n────────────────────\n❯ \n────────────────────\n  ⏸ manual mode on · esc to interrupt · ⇥ for agents';

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  isRunning.mockResolvedValue(true);
  getLastServerResponseTimestamp.mockReturnValue(null);
  // The §4 D1 rule is asked for by name rather than inherited: #2011 put claude
  // back to `observe`, under which every idle row publishes `'positive'` and
  // table B could not tell a fixed build from a broken one.
  process.env[IDLE_EVIDENCE_ENV_VAR] = 'claude=enforce';
});

afterEach(() => {
  delete process.env[IDLE_EVIDENCE_ENV_VAR];
});

/**
 * Record a turn the agent opened and then closed with its own `Stop`.
 *
 * Both events matter since #2011: a `Stop` with no opening behind it publishes
 * `openedAt: null`, which is not a completion anybody watched — see
 * `hookClosedTurn`.
 */
function recordStop(): void {
  const now = Date.now();
  recordAgentEvent('wt-1', 'claude', 'claude', {
    event: 'user_prompt_submit',
    at: now - 5_000,
    detail: null,
    sessionId: 'sess-1',
  });
  recordAgentEvent('wt-1', 'claude', 'claude', {
    event: 'stop',
    at: now - 1_000,
    detail: null,
    sessionId: 'sess-1',
  });
}

/** A bare `Stop` with no turn under it — the shape `openedAt: null` describes. */
function recordOrphanStop(): void {
  recordAgentEvent('wt-1', 'claude', 'claude', {
    event: 'stop',
    at: Date.now() - 1_000,
    detail: null,
    sessionId: 'sess-1',
  });
}

async function payloadFor(
  frame: string,
  opts: { stop?: boolean; orphanStop?: boolean; stale?: boolean } = {},
) {
  vi.mocked(captureSessionOutput).mockResolvedValue(frame);
  if (opts.stale) getLastServerResponseTimestamp.mockReturnValue(Date.now() - 60_000);
  if (opts.stop) recordStop();
  if (opts.orphanStop) recordOrphanStop();
  return buildCurrentOutput(db, 'wt-1', 'claude', 'claude');
}

describe('[#1927] table A — the no-evidence routes keep the hatch open after the merge', () => {
  it('default (4), with no structured verdict', async () => {
    const payload = await payloadFor(UNREADABLE_FRAME);

    expect(payload.sessionStatus).toBe('running');
    expect(payload.sessionStatusReason).toBe(STATUS_REASON.DEFAULT);
    expect(payload.isUnclassifiedActive).toBe(true);
  });

  it('no_recent_output (3), with no structured verdict', async () => {
    const payload = await payloadFor(UNREADABLE_FRAME, { stale: true });

    // §4 D1 決定 3: `running`, not `ready`. The reason code is kept.
    expect(payload.sessionStatus).toBe('running');
    expect(payload.sessionStatusReason).toBe(STATUS_REASON.NO_RECENT_OUTPUT);
    expect(payload.isUnclassifiedActive).toBe(true);
  });

  it('default (4) UNDER a structured ready — the combination DR2-003 is about', async () => {
    // THE guard. Derive `isUnclassifiedActive` from the merged `evidence` again
    // and this assertion goes red: the structured `Stop` clears the hatch on a
    // frame nobody could read, which is #1708's stall with the escape nailed
    // shut. The evidence beside it is `'positive'` since #2011 — the agent
    // really did report the end of this turn — and that is precisely why the
    // hatch must not be reading it.
    const payload = await payloadFor(UNREADABLE_FRAME, { stop: true });

    expect(payload.sessionStatus).toBe('ready');
    expect(payload.sessionStatusReason).toBe('hook_stop');
    expect(payload.statusEvidence).toBe('positive');
    expect(payload.isUnclassifiedActive).toBe(true);
  });

  it('no_recent_output (3) UNDER a structured ready — the route the flip created', async () => {
    // The same guard on the route that did not exist before #1927. Before
    // §4 D1 決定 3 this frame published `ready`, so `scraper.status === 'running'`
    // was false and the override could not fire; the flip makes it fire, which
    // is why the two changes had to land in this order.
    const payload = await payloadFor(UNREADABLE_FRAME, { stale: true, stop: true });

    expect(payload.sessionStatus).toBe('ready');
    expect(payload.statusEvidence).toBe('positive');
    expect(payload.isUnclassifiedActive).toBe(true);
  });

  it('still clears the hatch when the frame the structured ready landed on WAS readable', async () => {
    // #1723's reported case — the agent's `Stop` arrives while the spinner is
    // still painted — reads `running`/`thinking_indicator`, which is a
    // classified frame, so the hatch was never up and `wait` completes on it
    // exactly as it did before.
    const payload = await payloadFor(BUSY_FRAME, { stop: true });

    expect(payload.sessionStatus).toBe('ready');
    expect(payload.sessionStatusReason).toBe('hook_stop');
    expect(payload.statusEvidence).toBe('positive');
    expect(payload.isUnclassifiedActive).toBe(false);
  });
});

describe('[#2011] table B — the input_prompt route moves evidence, never the flag', () => {
  it('an idle-looking claude frame with a completion marker reports false', async () => {
    const payload = await payloadFor(buildClaudeIdleComposerFrame());

    expect(payload.sessionStatus).toBe('ready');
    expect(payload.sessionStatusReason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(payload.statusEvidence).toBe('positive');
    expect(payload.isUnclassifiedActive).toBe(false);
  });

  it('the same frame without one loses the evidence and keeps the classification', async () => {
    const payload = await payloadFor(buildClaudeIdleComposerFrame('  it stopped mid-sentence'));

    // DR3-002: the wire status does NOT move to `running`. `isProcessing` drives
    // `ls`, the sidebar aggregate, the "queued (session busy)" toast and
    // demo-video's `wait_until_busy` probe, none of which are asking about
    // evidence.
    expect(payload.sessionStatus).toBe('ready');
    expect(payload.sessionStatusReason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(payload.statusEvidence).toBe('none');
    // The regression #2011 fixes. #1927 published `true` here, which opened
    // `TerminalEscapeHatch` on every idle Claude pane and stopped `wait`
    // completing on one — the frame was read perfectly well, and the composer
    // row it was read from is one a human can type into.
    expect(payload.isUnclassifiedActive).toBe(false);
  });

  it('a structured ready over the same frame vouches for it rather than being ignored', async () => {
    // The shape a hooks-driven claude session takes when its idle rule declines:
    // the frame says "composer", the agent says "I stopped". #1927 published
    // `statusEvidence: 'none'` next to `sessionStatusReason: 'hook_stop'` — a
    // payload denying, in one field, the strongest signal it had in another.
    const payload = await payloadFor(buildClaudeIdleComposerFrame('  it stopped mid-sentence'), {
      stop: true,
    });

    expect(payload.sessionStatusReason).toBe('hook_stop');
    expect(payload.statusEvidence).toBe('positive');
    expect(payload.isUnclassifiedActive).toBe(false);
  });
});

describe('[#2011] table C — which structured closes count as evidence', () => {
  it('a Stop that closed a watched turn is positive', async () => {
    const payload = await payloadFor(UNREADABLE_FRAME, { stop: true });

    expect(payload.structuredEvents.closedBy).toBe('stop');
    expect(payload.structuredEvents.openedAt).not.toBeNull();
    expect(payload.statusEvidence).toBe('positive');
  });

  it('a Stop with no turn under it is not', async () => {
    // `recordAgentEvent` publishes `openedAt: null` for a `Stop` that arrived
    // with nothing open. There is no turn boundary to vouch for, so the frame's
    // own reading stands — which for this frame is no evidence at all.
    const payload = await payloadFor(UNREADABLE_FRAME, { orphanStop: true });

    expect(payload.structuredEvents.closedBy).toBe('stop');
    expect(payload.structuredEvents.openedAt).toBeNull();
    expect(payload.statusEvidence).toBe('none');
    expect(payload.isUnclassifiedActive).toBe(true);
  });

  it('an open turn vouches for nothing — `running` is not a completion', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(UNREADABLE_FRAME);
    recordAgentEvent('wt-1', 'claude', 'claude', {
      event: 'user_prompt_submit',
      at: Date.now() - 1_000,
      detail: null,
      sessionId: 'sess-1',
    });

    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload.sessionStatus).toBe('running');
    expect(payload.structuredEvents.closedBy).toBeNull();
    expect(payload.statusEvidence).toBe('none');
  });
});
