/**
 * `evidence` and the published source block (Issue #1924, §4 D1 decision 2 / §7).
 *
 * Phase 1 of the multi-agent state architecture lands three things and changes
 * no verdict: the `evidence` reading of a status, the `unclassified-frame`
 * suppression reason, and the source capabilities on the wire. This suite is
 * written against the way a type-only landing goes wrong — the field exists, the
 * suite is green, and the value is `'positive'` on every frame because nothing
 * ever computes it.
 *
 * So the assertions here are of two kinds:
 *
 *  1. **Behaviour is unchanged.** The frames that opened `isUnclassifiedActive`
 *     before #1924 are exactly the frames that report `evidence: 'none'` now,
 *     and no other frame moved. `SessionStatus` still has four members.
 *  2. **The two readings cannot come apart.** `isUnclassifiedActive` is derived
 *     from `evidence`, at every branch of `mergeStructuredStatus` — including
 *     the one that clears the hatch. Phase 3 changes the producer; if any branch
 *     computed the flag independently, Phase 3 would move one and not the other.
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
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-1:claude'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import {
  buildCurrentOutput,
  mergeStructuredStatus,
  type ScraperVerdict,
} from '@/lib/session/current-output-builder';
import {
  clearAgentStopEvents,
  type StructuredSessionState,
} from '@/lib/session/agent-event-state';
import { HOOK_STATUS_REASON, type HookStatusReason } from '@/lib/session/status-mapping';
import { getAgentEventSource } from '@/lib/hooks/sources/registry';
import { buildClaudeIdleComposerFrame } from '../../fixtures/claude-idle-composer';

const db = {} as Database.Database;

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  isRunning.mockResolvedValue(true);
});

/**
 * A frame the detector reads as a finished, idle Claude turn.
 *
 * `input_prompt` — and, since Issue #1927 landed Claude's rule, positively
 * classified for a measured reason rather than because a composer row was on
 * screen. This is the diff #1924 asked to be able to see: the frame that used
 * to be `'some agent output\n> '` now has to carry Claude's turn-completion
 * marker to count as evidence at all.
 */
const IDLE_COMPOSER_FRAME = buildClaudeIdleComposerFrame();

/**
 * A frame with nothing on it at all.
 *
 * The detector has no marker, no thinking indicator and no composer to read, so
 * it falls through to the `default` branch: `running` on the strength of nothing.
 * This is one of the two "absence of a negative" rows of §6.1.
 */
const UNREADABLE_FRAME = 'a line of prose that matches nothing in particular';

describe('[#1924] evidence — the scraper half', () => {
  it('reports positive evidence for a frame the detector classified', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(IDLE_COMPOSER_FRAME);

    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload.sessionStatusReason).toBe('input_prompt');
    expect(payload.isUnclassifiedActive).toBe(false);
  });

  it('leaves the unreadable frame exactly where #1708 left it', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(UNREADABLE_FRAME);

    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    // The wire value does not move in Phase 1 (DR3-002 keeps `input_prompt` at
    // `ready` in Phase 3 too). What #1924 adds is the second reading of it.
    expect(payload.sessionStatus).toBe('running');
    expect(payload.sessionStatusReason).toBe('default');
    expect(payload.isUnclassifiedActive).toBe(true);
  });
});

describe('[#1924] evidence — mergeStructuredStatus keeps one fact, not two', () => {
  const scraper = (over: Partial<ScraperVerdict> = {}): ScraperVerdict => {
    const base: ScraperVerdict = {
      status: 'ready',
      reason: 'input_prompt',
      thinking: false,
      evidence: 'positive',
      isUnclassifiedActive: false,
      ...over,
    };
    return { ...base, evidence: over.evidence ?? (base.isUnclassifiedActive ? 'none' : 'positive') };
  };

  const structured = (
    status: 'ready' | 'running' | 'waiting',
    reason: HookStatusReason,
  ): StructuredSessionState => ({
    status,
    reason,
    event: status === 'ready' ? 'stop' : 'user_prompt_submit',
    at: 1_700_000_000_000,
    detail: null,
  });

  /**
   * Every branch of the merge, named by which `return` it lands on.
   *
   * The invariant asserted over all of them is the one Phase 3 depends on: the
   * published flag is `evidence === 'none'` and nothing else. A branch that
   * wrote `isUnclassifiedActive` from its own expression would satisfy today's
   * expectations and diverge the moment the producer moves.
   */
  const BRANCHES: Array<[string, ScraperVerdict, StructuredSessionState | null]> = [
    ['scraper waiting wins outright', scraper({ status: 'waiting', reason: 'prompt_detected' }), null],
    ['no structured verdict at all', scraper({ isUnclassifiedActive: true, status: 'running', reason: 'default' }), null],
    ['structured waiting decides nothing', scraper({ isUnclassifiedActive: true, status: 'running', reason: 'default' }), structured('waiting', HOOK_STATUS_REASON.PERMISSION_PROMPT)],
    ['structured running over an unreadable frame', scraper({ isUnclassifiedActive: true, status: 'ready', reason: 'no_recent_output' }), structured('running', HOOK_STATUS_REASON.PROMPT_SUBMIT)],
    ['structured ready over a busy-looking pane', scraper({ isUnclassifiedActive: true, status: 'running', reason: 'default' }), structured('ready', HOOK_STATUS_REASON.STOP)],
    ['structured ready over an already-ready frame', scraper({ isUnclassifiedActive: true, status: 'ready', reason: 'no_recent_output' }), structured('ready', HOOK_STATUS_REASON.STOP)],
    ['both layers agree and both are confident', scraper(), structured('ready', HOOK_STATUS_REASON.STOP)],
  ];

  it.each(BRANCHES)('%s: isUnclassifiedActive is evidence === none', (_name, input, structuredState) => {
    const merged = mergeStructuredStatus(input, structuredState);

    expect(merged.isUnclassifiedActive).toBe(merged.evidence === 'none');
  });

  it('does not raise evidence for a structured stop over a pane nobody could read', () => {
    // Issue #1927 (DR2-003) closed the branch that used to raise evidence here.
    //
    // #1924 read a structured `Stop` over a scraper `running` as "the positive
    // completion evidence §4 D1 asks for". That was safe only while `running`
    // meant "the pane looks busy": `no_recent_output` still said `ready`, so the
    // only frame that could reach the branch with no evidence was
    // `running`/`default`. #1927 moves `no_recent_output` to `running` too, and
    // this branch would then clear the hatch at the one moment it is worth
    // keeping — the frame cannot be read AND the agent says it is done, which is
    // where a missed dialog hides (#1708).
    //
    // What #1723 actually needs is untouched: a pane whose spinner is still on
    // screen reads `thinking_indicator`, which IS positive evidence — see the
    // case below.
    const merged = mergeStructuredStatus(
      scraper({ status: 'running', reason: 'default', thinking: true, isUnclassifiedActive: true }),
      structured('ready', HOOK_STATUS_REASON.STOP),
    );

    expect(merged.status).toBe('ready');
    expect(merged.evidence).toBe('none');
    expect(merged.isUnclassifiedActive).toBe(true);
  });

  it('still clears the hatch when the pane it read was a busy one', () => {
    // The #1723 case, and the reason the assertion above is a narrowing rather
    // than a removal: `Stop` arrived while the spinner was still on screen. That
    // frame carries positive evidence, so the structured `ready` lands on a
    // verdict that was already classified and `wait` completes on it.
    const merged = mergeStructuredStatus(
      scraper({ status: 'running', reason: 'thinking_indicator', thinking: true }),
      structured('ready', HOOK_STATUS_REASON.STOP),
    );

    expect(merged.status).toBe('ready');
    expect(merged.evidence).toBe('positive');
    expect(merged.isUnclassifiedActive).toBe(false);
  });

  it('does not invent evidence for a frame the structured layer only says is busy', () => {
    // #1708's hatch: a `running` from the agent is not proof that no human is
    // needed, so an unreadable frame stays unreadable.
    const merged = mergeStructuredStatus(
      scraper({ status: 'ready', reason: 'no_recent_output', isUnclassifiedActive: true }),
      structured('running', HOOK_STATUS_REASON.PROMPT_SUBMIT),
    );

    expect(merged.evidence).toBe('none');
    expect(merged.isUnclassifiedActive).toBe(true);
  });
});

describe('[#1924] structuredEvents.source — the capabilities on the wire (§7)', () => {
  it('publishes the declared block for the tool that was asked about', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(IDLE_COMPOSER_FRAME);

    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload.structuredEvents.source).toEqual({
      cliToolId: 'claude',
      capabilities: getAgentEventSource('claude').capabilities,
    });
  });

  it('is the asked-about tool, not a hard-coded claude', async () => {
    // The failure this is aimed at: a `source` block that is correct for every
    // payload because it was written once, for the tool everything else in this
    // subsystem defaults to. opencode is the row where every declared value
    // differs from Claude's, so it is the one that shows the difference.
    vi.mocked(captureSessionOutput).mockResolvedValue(IDLE_COMPOSER_FRAME);

    const payload = await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');

    expect(payload.structuredEvents.source.cliToolId).toBe('opencode');
    expect(payload.structuredEvents.source.capabilities).toEqual(
      getAgentEventSource('opencode').capabilities,
    );
    expect(payload.structuredEvents.source.capabilities.eventIdentity).toBe('permission-id');
    expect(payload.structuredEvents.source.capabilities.resync).toBe('session-status-poll');
  });

  it('is present on the payload of a session that is not running', async () => {
    // The stopped-session early return builds the payload separately. A field
    // that is missing there reads as `undefined` exactly when an operator is
    // asking why nothing was recorded.
    isRunning.mockResolvedValue(false);

    const payload = await buildCurrentOutput(db, 'wt-1', 'copilot', 'copilot');

    expect(payload.isRunning).toBe(false);
    expect(payload.structuredEvents.source.capabilities.sessionStartMayArriveLate).toBe(true);
  });

  it('answers for a tool with no source of its own without guessing claude', async () => {
    // `vibe-local` has no implementation (§4 D3's seventh row: "ソース実装なし").
    // The registry hands back the compatibility source, whose capabilities say
    // "nothing measured" — a caller that read Claude's values here would act on
    // a permission-hook forecast for a tool nobody has ever hooked.
    vi.mocked(captureSessionOutput).mockResolvedValue(IDLE_COMPOSER_FRAME);

    const payload = await buildCurrentOutput(db, 'wt-1', 'vibe-local', 'vibe-local');

    expect(payload.structuredEvents.source.cliToolId).toBe('vibe-local');
    expect(payload.structuredEvents.source.capabilities.supportedEvents).toEqual([]);
    expect(payload.structuredEvents.source.capabilities.permissionHookPredictsDialog).toBe(false);
  });
});
