/**
 * The #1708 hatch, pinned on the MERGED verdict (Issue #1927, DR2-003 / §11).
 *
 * ## Why this file exists at all
 *
 * §4 D1 決定 3 abolishes the `ready` the five-second staleness heuristic used to
 * publish: `no_recent_output` now says `running` with no evidence. That single
 * change reaches into `mergeStructuredStatus`, because its override branch is
 * keyed on `scraper.status === 'running'` — a shape `no_recent_output` did not
 * have before and does now. The branch would therefore begin firing on a frame
 * NOBODY COULD READ, clear `isUnclassifiedActive`, and take away the hatch at
 * exactly the moment it is worth having: the pane is unreadable and the agent's
 * hooks say the turn is done. That is #1708's stall with the escape nailed shut.
 *
 * §11 spells out the consequence for testing, and it is the whole point of this
 * file: **a scraper-level fixture cannot see this**. `detectSessionStatus` never
 * runs `mergeStructuredStatus`, so a suite that pins the detector's verdict
 * stays green while the merged flag flips underneath it. The pin has to be on
 * the payload `buildCurrentOutput` publishes.
 *
 * ## The two tables §11 asks for
 *
 * **A — equivalence.** The `no_recent_output` (3) and `default` (4) routes must
 * carry the SAME merged `isUnclassifiedActive` as before, INCLUDING when a
 * structured `ready` is present. This is the table that goes red if the override
 * branch is reverted.
 *
 * **B — the deliberate widening.** The `input_prompt` (2) route gains new frames
 * that report `true`, tool by tool. Equivalence must NOT be pinned here (DR2-001
 * says a correct implementation always fails it); the new rows are listed
 * explicitly instead.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
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
});

/** Record the agent's own `Stop` for the session the payload is built for. */
function recordStop(): void {
  recordAgentEvent('wt-1', 'claude', 'claude', {
    event: 'stop',
    at: Date.now() - 1_000,
    detail: null,
    sessionId: 'sess-1',
  });
}

async function payloadFor(frame: string, opts: { stop?: boolean; stale?: boolean } = {}) {
  vi.mocked(captureSessionOutput).mockResolvedValue(frame);
  if (opts.stale) getLastServerResponseTimestamp.mockReturnValue(Date.now() - 60_000);
  if (opts.stop) recordStop();
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
    // THE guard. Revert `mergeStructuredStatus`'s override to its pre-#1927
    // form (drop the `scraper.evidence === 'positive'` conjunct) and this
    // assertion goes red: the structured `Stop` clears the hatch on a frame
    // nobody could read.
    const payload = await payloadFor(UNREADABLE_FRAME, { stop: true });

    expect(payload.sessionStatus).toBe('ready');
    expect(payload.sessionStatusReason).toBe('hook_stop');
    expect(payload.statusEvidence).toBe('none');
    expect(payload.isUnclassifiedActive).toBe(true);
  });

  it('no_recent_output (3) UNDER a structured ready — the route the flip created', async () => {
    // The same guard on the route that did not exist before this Issue. Before
    // §4 D1 決定 3 this frame published `ready`, so `scraper.status === 'running'`
    // was false and the override could not fire; the flip makes it fire, which
    // is why the two changes had to land in this order.
    const payload = await payloadFor(UNREADABLE_FRAME, { stale: true, stop: true });

    expect(payload.sessionStatus).toBe('ready');
    expect(payload.statusEvidence).toBe('none');
    expect(payload.isUnclassifiedActive).toBe(true);
  });

  it('still clears the hatch when the frame the structured ready landed on WAS readable', async () => {
    // The narrowing is a narrowing, not a removal. #1723's reported case — the
    // agent's `Stop` arrives while the spinner is still painted — reads
    // `running`/`thinking_indicator`, which is positive evidence, so `wait`
    // completes on it exactly as it did before.
    const payload = await payloadFor(BUSY_FRAME, { stop: true });

    expect(payload.sessionStatus).toBe('ready');
    expect(payload.sessionStatusReason).toBe('hook_stop');
    expect(payload.statusEvidence).toBe('positive');
    expect(payload.isUnclassifiedActive).toBe(false);
  });
});

describe('[#1927] table B — the input_prompt route widens, deliberately', () => {
  // DR2-001: equivalence must NOT be pinned here. These are the frames that
  // report `true` where the pre-#1927 detector reported `false`, listed one by
  // one so the widening is a readable diff rather than a silent change.
  it('an idle-looking claude frame with a completion marker still reports false', async () => {
    const payload = await payloadFor(buildClaudeIdleComposerFrame());

    expect(payload.sessionStatus).toBe('ready');
    expect(payload.sessionStatusReason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(payload.isUnclassifiedActive).toBe(false);
  });

  it('the same frame without one reports true — and stays `ready` on the wire', async () => {
    const payload = await payloadFor(buildClaudeIdleComposerFrame('  it stopped mid-sentence'));

    // DR3-002: the wire status does NOT move to `running`. `isProcessing` drives
    // `ls`, the sidebar aggregate, the "queued (session busy)" toast and
    // demo-video's `wait_until_busy` probe, none of which are asking about
    // evidence. What moves is `statusEvidence` / `isUnclassifiedActive`, which
    // is what `wait` branches on.
    expect(payload.sessionStatus).toBe('ready');
    expect(payload.sessionStatusReason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(payload.statusEvidence).toBe('none');
    expect(payload.isUnclassifiedActive).toBe(true);
  });

  it('a structured ready cannot vouch for the widened frame either', async () => {
    // The widening and the guard, together: this is the shape a hooks-driven
    // claude session takes when its pane stops being readable, and it is the
    // one DR2-003 is protecting.
    const payload = await payloadFor(buildClaudeIdleComposerFrame('  it stopped mid-sentence'), {
      stop: true,
    });

    expect(payload.statusEvidence).toBe('none');
    expect(payload.isUnclassifiedActive).toBe(true);
  });
});
