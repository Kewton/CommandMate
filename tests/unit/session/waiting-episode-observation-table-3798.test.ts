/**
 * Issue #3798 (PR 1b): the observation tables — what one observer's reading of
 * a frame does to the open waiting episode (`docs/design/issue-3798-waiting-episode.md`
 * §2.4 規則 3・4・5, tables O-1 / O-2 and the preconditions 1–3).
 *
 * Driven through `planWaitingObservation` / `observeWaiting` on the real
 * episode store and the real turn model (`recordAgentEvent`), so `c` — the
 * binding the turn model gives a wait opening now — is what production
 * computes, not a stand-in.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { PromptData } from '@/types/models';
import type { ScreenReading } from '@/lib/detection/waiting-screen-reading';
import { promptScreenKey } from '@/lib/detection/prompt-screen-key';
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';
import { getAgentTurn } from '@/lib/session/agent-event-turn';
import {
  captureFrameTime,
  observeWaiting,
  planWaitingObservation,
  startWaitingObservation,
  type ObservationAction,
  type WaitingObservation,
  type WaitingObserverKind,
} from '@/lib/session/waiting-episode-binding';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  closeEpisode,
  getLastClosedEpisode,
  getWaitingEpisodeRecord,
  onWaitingEpisodeTransition,
  openEpisode,
  type EpisodeBinding,
  type GenerationRef,
  type WaitingEpisodeTransition,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-3798-observe';
const TOOL = 'claude' as const;
const PARTS = { worktreeId: WT, cliToolId: TOOL, instanceId: TOOL };
const NOW = 1_800_000_000_000;
const OLD_GEN: GenerationRef = { kind: 'opened', at: NOW - 60_000 };

function yesNo(question: string): PromptData {
  return { type: 'yes_no', question, status: 'pending', options: ['yes', 'no'] };
}
const PROMPT_A = yesNo('Run ls?');
const PROMPT_B = yesNo('Run rm?');
const KEY_A = promptScreenKey(PROMPT_A);

type WaitingReading = Extract<ScreenReading, { kind: 'waiting' }>;

const prompt = (promptData: PromptData | null = PROMPT_A): WaitingReading => ({
  kind: 'waiting',
  waitingKind: 'prompt',
  humanHeld: false,
  promptData,
  structuredSince: null,
});
const screen: WaitingReading = { kind: 'waiting', waitingKind: 'menu', humanHeld: true, promptData: null, structuredSince: null };

// ---------------------------------------------------------------------------
// the turn model, driven by real events
// ---------------------------------------------------------------------------

function event(e: string, at: number, detail: string | null = null): void {
  recordAgentEvent(WT, TOOL, TOOL, { event: e as never, at, detail, sessionId: 's-1' });
}

/** A generation began at NOW. */
function generation(): GenerationRef {
  event('session_start', NOW);
  return startWaitingObservation(WT, TOOL, TOOL).generation;
}

/** An open turn; its id. */
function openTurn(at: number = NOW + 10): string {
  event('user_prompt_submit', at);
  return getAgentTurn(WT, TOOL, TOOL, at)!.turnId;
}

/** A turn that opened and stopped; its id. */
function closedTurn(): string {
  const id = openTurn(NOW + 10);
  event('stop', NOW + 20);
  return id;
}

/** A dialog the agent reported with no turn open; the record's id. */
function dialogOnly(): string {
  recordAgentEvent(WT, TOOL, TOOL, {
    event: 'notification',
    at: NOW + 30,
    detail: 'permission_prompt',
    sessionId: 's-1',
    message: 'Claude needs your permission to use Bash',
  });
  const turn = getAgentTurn(WT, TOOL, TOOL, NOW + 30)!;
  expect(turn.openedAt).toBeNull();
  return turn.turnId;
}

function open(binding: EpisodeBinding, promptScreenKey: string | null = null, at = NOW + 100) {
  return openEpisode(PARTS, { since: at, kind: 'prompt', binding, openedBy: 'status-probe', promptScreenKey }, at);
}

function observation(
  reading: ScreenReading,
  extra: Partial<WaitingObservation> = {},
  observer: WaitingObserverKind = 'status-probe'
): WaitingObservation {
  return {
    ...PARTS,
    observer,
    start: startWaitingObservation(WT, TOOL, TOOL),
    reading,
    frameCapturedAt: NOW + 1_000,
    now: NOW + 2_000,
    ...extra,
  };
}

function plan(reading: ScreenReading, extra: Partial<WaitingObservation> = {}, observer?: WaitingObserverKind) {
  return planWaitingObservation(observation(reading, extra, observer));
}

beforeEach(() => {
  clearAgentStopEvents();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
});

afterEach(() => {
  clearAgentStopEvents();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
});

// ---------------------------------------------------------------------------
// Table O-1
// ---------------------------------------------------------------------------

describe('[#3798] table O-1: no episode open', () => {
  it.each([
    ['no turn record', (): unknown => undefined, 'unattributed'],
    ['an open turn', () => openTurn(), 'turn'],
    ['a closed turn', () => closedTurn(), 'unattributed'],
    ['a dialog-only record', () => dialogOnly(), 'dialog-only'],
  ] as const)('%s: opened as c (%s)', (_label, setUp, kind) => {
    generation();
    setUp();
    const result = observeWaiting(observation(prompt()));
    expect(result.action).toBe('opened');
    expect(getWaitingEpisodeRecord(WT, TOOL, TOOL)).toMatchObject({
      binding: { kind },
      promptScreenKey: KEY_A,
      openedBy: 'status-probe',
      since: NOW + 2_000,
    });
  });

  it('humanHeld: opened as screen, with the open turn as its origin', () => {
    generation();
    const t = openTurn();
    expect(observeWaiting(observation(screen)).action).toBe('opened');
    expect(getWaitingEpisodeRecord(WT, TOOL, TOOL)?.binding).toMatchObject({ kind: 'screen', originTurnId: t });
  });

  it('humanHeld with no turn open: screen with no origin', () => {
    generation();
    observeWaiting(observation(screen));
    expect(getWaitingEpisodeRecord(WT, TOOL, TOOL)?.binding).toMatchObject({ kind: 'screen', originTurnId: null });
  });

  it('opens at the structured wait\'s own start when the reading carries one', () => {
    generation();
    observeWaiting(observation({ ...prompt(), structuredSince: NOW + 5 }));
    expect(getWaitingEpisodeRecord(WT, TOOL, TOOL)?.since).toBe(NOW + 5);
  });
});

describe('[#3798] table O-1: turn(T), T open', () => {
  it('c = turn(T): kept, and the kind is refreshed without a version change', () => {
    const gen = generation();
    const t = openTurn();
    const opened = open({ kind: 'turn', generation: gen, turnId: t }, KEY_A);
    const p = plan({ ...prompt(), waitingKind: 'unclassified' });
    expect(p.action).toBe('kept');
    expect(p.since).toBe(opened.since);
    const done = observeWaiting(observation({ ...prompt(), waitingKind: 'unclassified' }));
    expect(done.action).toBe('kept');
    expect(getWaitingEpisodeRecord(WT, TOOL, TOOL)).toMatchObject({ episodeId: opened.episodeId, kind: 'unclassified' });
  });

  it('c = turn(T), the poller answered it and another confirmation shows: replaced (R1-7)', () => {
    const gen = generation();
    const t = openTurn();
    const opened = open({ kind: 'turn', generation: gen, turnId: t }, KEY_A);
    const p = plan(prompt(PROMPT_B), { freshPrompt: true, lastAnswer: { episodeId: opened.episodeId, screenKey: KEY_A } });
    expect(p.action).toBe('replaced');
    // The same confirmation the poller answered is kept.
    expect(plan(prompt(PROMPT_A), { freshPrompt: true, lastAnswer: { episodeId: opened.episodeId, screenKey: KEY_A } }).action).toBe(
      'kept'
    );
  });

  it('c = turn(N ≠ T): replaced', () => {
    const gen = generation();
    openTurn();
    open({ kind: 'turn', generation: gen, turnId: 'turn-older' }, KEY_A);
    expect(plan(prompt()).action).toBe('replaced');
  });
});

describe('[#3798] table O-1: turn(T), T closed', () => {
  it('c = unattributed (T stopped): kept', () => {
    const gen = generation();
    const t = closedTurn();
    open({ kind: 'turn', generation: gen, turnId: t }, KEY_A);
    expect(plan(prompt()).action).toBe('kept');
    expect(plan(prompt(PROMPT_B)).action).toBe('kept');
  });

  it('c = unattributed, a fresh prompt with another screen key: replaced (R2-3)', () => {
    const gen = generation();
    const t = closedTurn();
    open({ kind: 'turn', generation: gen, turnId: t }, KEY_A);
    expect(plan(prompt(PROMPT_B), { freshPrompt: true }).action).toBe('replaced');
    expect(plan(prompt(PROMPT_A), { freshPrompt: true }).action).toBe('kept');
    expect(plan(prompt(null), { freshPrompt: true }).action).toBe('kept');
  });

  it('c = dialog-only: kept', () => {
    const gen = generation();
    dialogOnly();
    open({ kind: 'turn', generation: gen, turnId: 'turn-ended' }, KEY_A);
    expect(plan(prompt()).action).toBe('kept');
  });

  it('c = turn(N): replaced', () => {
    // The turn model is set up first: the turn transitions act on an open wait
    // themselves (the T table), and this row is about the observation alone.
    const gen = generation();
    const t = closedTurn();
    openTurn(NOW + 40);
    open({ kind: 'turn', generation: gen, turnId: t }, KEY_A);
    expect(plan(prompt()).action).toBe('replaced');
  });
});

describe('[#3798] table O-1: dialog-only(R)', () => {
  it('c = dialog-only(R): kept', () => {
    const gen = generation();
    const r = dialogOnly();
    open({ kind: 'dialog-only', generation: gen, recordTurnId: r, sessionId: null });
    expect(plan(prompt()).action).toBe('kept');
  });

  it('c = turn(N): rebound to turn(N), same id and since', () => {
    const gen = generation();
    const n = openTurn(NOW + 40);
    const opened = open({ kind: 'dialog-only', generation: gen, recordTurnId: 'record-r', sessionId: null });
    const done = observeWaiting(observation(prompt()));
    expect(done.action).toBe('rebound');
    expect(getWaitingEpisodeRecord(WT, TOOL, TOOL)).toMatchObject({
      episodeId: opened.episodeId,
      since: opened.since,
      binding: { kind: 'turn', turnId: n },
      boundAt: NOW + 2_000,
    });
  });

  it('c = dialog-only(R′ ≠ R): replaced', () => {
    const gen = generation();
    dialogOnly();
    open({ kind: 'dialog-only', generation: gen, recordTurnId: 'record-other', sessionId: null });
    expect(plan(prompt()).action).toBe('replaced');
  });

  it('c = unattributed: kept', () => {
    const gen = generation();
    open({ kind: 'dialog-only', generation: gen, recordTurnId: 'record-r', sessionId: null });
    expect(plan(prompt()).action).toBe('kept');
  });
});

describe('[#3798] table O-1: unattributed', () => {
  it('c = unattributed: kept', () => {
    const gen = generation();
    open({ kind: 'unattributed', generation: gen, lastClosedTurnId: null }, KEY_A);
    expect(plan(prompt()).action).toBe('kept');
  });

  it('c = unattributed, the poller answered it and another confirmation shows: replaced', () => {
    const gen = generation();
    const opened = open({ kind: 'unattributed', generation: gen, lastClosedTurnId: null }, KEY_A);
    expect(
      plan(prompt(PROMPT_B), { freshPrompt: true, lastAnswer: { episodeId: opened.episodeId, screenKey: KEY_A } }).action
    ).toBe('replaced');
  });

  it('c = dialog-only(R): rebound', () => {
    const gen = generation();
    const r = dialogOnly();
    open({ kind: 'unattributed', generation: gen, lastClosedTurnId: null }, KEY_A);
    const p = plan(prompt());
    expect(p.action).toBe('rebound');
    expect(p.binding).toMatchObject({ kind: 'dialog-only', recordTurnId: r });
  });

  it('c = turn(N) on the same confirmation: rebound (R2-4)', () => {
    const gen = generation();
    const n = openTurn(NOW + 40);
    open({ kind: 'unattributed', generation: gen, lastClosedTurnId: null }, KEY_A);
    const p = plan(prompt(PROMPT_A));
    expect(p.action).toBe('rebound');
    expect(p.binding).toMatchObject({ kind: 'turn', turnId: n });
  });

  it.each([
    ['another confirmation', PROMPT_B],
    ['no confirmation read', null],
  ] as const)('c = turn(N) on %s: replaced', (_label, promptData) => {
    const gen = generation();
    openTurn(NOW + 40);
    open({ kind: 'unattributed', generation: gen, lastClosedTurnId: null }, KEY_A);
    expect(plan(prompt(promptData)).action).toBe('replaced');
  });
});

describe('[#3798] table O-1: screen(origin O)', () => {
  it('c = turn(O): rebound back to turn(O)', () => {
    const gen = generation();
    const o = openTurn();
    open({ kind: 'screen', generation: gen, originTurnId: o });
    const p = plan(prompt());
    expect(p.action).toBe('rebound');
    expect(p.binding).toMatchObject({ kind: 'turn', turnId: o });
  });

  it.each([
    ['turn(N ≠ O)', () => openTurn()],
    ['unattributed', (): unknown => undefined],
    ['dialog-only', () => dialogOnly()],
  ] as const)('c = %s: replaced', (_label, setUp) => {
    const gen = generation();
    setUp();
    open({ kind: 'screen', generation: gen, originTurnId: 'turn-origin' });
    expect(plan(prompt()).action).toBe('replaced');
  });

  it('humanHeld: kept', () => {
    const gen = generation();
    open({ kind: 'screen', generation: gen, originTurnId: null });
    expect(plan(screen).action).toBe('kept');
  });
});

describe('[#3798] table O-1: humanHeld on a wait that is not a screen', () => {
  it('turn(T): rebound to screen(origin T)', () => {
    const gen = generation();
    const t = openTurn();
    const opened = open({ kind: 'turn', generation: gen, turnId: t });
    const transitions: WaitingEpisodeTransition[] = [];
    onWaitingEpisodeTransition((tr) => transitions.push(tr));
    expect(observeWaiting(observation(screen)).action).toBe('rebound');
    expect(getWaitingEpisodeRecord(WT, TOOL, TOOL)).toMatchObject({
      episodeId: opened.episodeId,
      binding: { kind: 'screen', originTurnId: t },
    });
    // I3: a rebind is not an edge.
    expect(transitions).toEqual([]);
  });

  it.each([
    ['dialog-only', (gen: GenerationRef): EpisodeBinding => ({ kind: 'dialog-only', generation: gen, recordTurnId: 'r', sessionId: null })],
    ['unattributed', (gen: GenerationRef): EpisodeBinding => ({ kind: 'unattributed', generation: gen, lastClosedTurnId: null })],
  ] as const)('%s: rebound to screen(origin null)', (_label, binding) => {
    const gen = generation();
    open(binding(gen));
    const p = plan(screen);
    expect(p.action).toBe('rebound');
    expect(p.binding).toMatchObject({ kind: 'screen', originTurnId: null });
  });
});

describe('[#3798] table O-1: a binding of another generation (P3-2)', () => {
  it.each([
    ['humanHeld=false', prompt(), 'unattributed'],
    ['humanHeld=true', screen, 'screen'],
  ] as const)('%s: replaced as c', (_label, reading, kind) => {
    generation();
    open({ kind: 'screen', generation: OLD_GEN, originTurnId: null });
    const done = observeWaiting(observation(reading));
    expect(done.action).toBe('replaced');
    expect(done.closeReason).toBe('generation');
    expect(getWaitingEpisodeRecord(WT, TOOL, TOOL)?.binding.kind).toBe(kind);
  });
});

// ---------------------------------------------------------------------------
// Table O-2
// ---------------------------------------------------------------------------

describe('[#3798] table O-2: the closing side, whatever the binding (R3-5)', () => {
  const bindings = (gen: GenerationRef): Array<[string, EpisodeBinding]> => [
    ['turn (T stopped)', { kind: 'turn', generation: gen, turnId: 'turn-ended' }],
    ['dialog-only', { kind: 'dialog-only', generation: gen, recordTurnId: 'r', sessionId: null }],
    ['unattributed', { kind: 'unattributed', generation: gen, lastClosedTurnId: null }],
    ['screen', { kind: 'screen', generation: gen, originTurnId: null }],
  ];

  const cases: Array<[WaitingObserverKind, ScreenReading['kind'], string | null]> = [
    ['status-probe', 'not-waiting', 'screen-cleared'],
    ['status-probe', 'gone', 'session-gone'],
    ['status-probe', 'unknown', null],
    ['response-checker', 'not-waiting', 'response-recorded'],
    ['response-checker', 'gone', 'session-gone'],
    ['response-checker', 'unknown', null],
    ['auto-yes-poller', 'gone', 'session-gone'],
    ['auto-yes-poller', 'unknown', null],
  ];

  for (const [observer, readingKind, reason] of cases) {
    it(`${observer} × ${readingKind}: ${reason === null ? 'ignored' : `closed (${reason})`} for every binding`, () => {
      const gen = generation();
      for (const [, binding] of bindings(gen)) {
        clearWaitingEpisodes();
        open(binding);
        const done = observeWaiting(observation({ kind: readingKind } as ScreenReading, {}, observer));
        expect(done.action).toBe(reason === null ? 'ignored' : 'closed');
        if (reason !== null) {
          expect(done.closeReason).toBe(reason);
          expect(getWaitingEpisodeRecord(WT, TOOL, TOOL)).toBeNull();
        }
      }
    });
  }

  it('auto-yes-poller × not-waiting: closes a screen only on a frame fetched after it became one (R3-1, P3-1)', () => {
    const gen = generation();
    const opened = open({ kind: 'screen', generation: gen, originTurnId: null }, null, NOW + 100);
    const notWaiting: ScreenReading = { kind: 'not-waiting' };
    expect(plan(notWaiting, { frameCapturedAt: NOW + 100 }, 'auto-yes-poller').action).toBe('ignored');
    expect(plan(notWaiting, { frameCapturedAt: NOW + 50 }, 'auto-yes-poller').action).toBe('ignored');
    const done = observeWaiting(observation(notWaiting, { frameCapturedAt: NOW + 101 }, 'auto-yes-poller'));
    expect(done).toMatchObject({ action: 'closed', closeReason: 'screen-cleared', episodeId: opened.episodeId });
  });

  it('auto-yes-poller × not-waiting: a wait rebound to screen is closed only after the rebind (P3-1)', () => {
    const gen = generation();
    open({ kind: 'unattributed', generation: gen, lastClosedTurnId: null }, null, NOW + 100);
    observeWaiting(observation(screen, { now: NOW + 500 }));
    expect(getWaitingEpisodeRecord(WT, TOOL, TOOL)).toMatchObject({ binding: { kind: 'screen' }, boundAt: NOW + 500 });
    const notWaiting: ScreenReading = { kind: 'not-waiting' };
    expect(plan(notWaiting, { frameCapturedAt: NOW + 300 }, 'auto-yes-poller').action).toBe('ignored');
    expect(plan(notWaiting, { frameCapturedAt: NOW + 501 }, 'auto-yes-poller').action).toBe('closed');
  });

  it.each([
    ['turn', { kind: 'turn', turnId: 't' }],
    ['dialog-only', { kind: 'dialog-only', recordTurnId: 'r', sessionId: null }],
    ['unattributed', { kind: 'unattributed', lastClosedTurnId: null }],
  ] as const)('auto-yes-poller × not-waiting on %s: ignored without its own answer (規則 3)', (_label, shape) => {
    const gen = generation();
    const opened = open({ ...shape, generation: gen } as EpisodeBinding, null, NOW + 100);
    const notWaiting: ScreenReading = { kind: 'not-waiting' };
    expect(plan(notWaiting, { frameCapturedAt: NOW + 5_000 }, 'auto-yes-poller').action).toBe('ignored');
    // PR 3's cell, already decided by the table: the wait it answered.
    expect(
      plan(
        notWaiting,
        { frameCapturedAt: NOW + 5_000, lastAnswer: { episodeId: opened.episodeId, screenKey: 'k' } },
        'auto-yes-poller'
      )
    ).toMatchObject({ action: 'closed', closeReason: 'poller-answered' });
  });

  it.each(['status-probe', 'response-checker', 'auto-yes-poller'] as const)(
    '%s with no episode open: ignored',
    (observer) => {
      generation();
      for (const kind of ['not-waiting', 'gone', 'unknown'] as const) {
        expect(plan({ kind }, {}, observer).action).toBe('ignored');
      }
    }
  );
});

// ---------------------------------------------------------------------------
// The preconditions
// ---------------------------------------------------------------------------

describe('[#3798] precondition 1: the observer started in another generation', () => {
  it.each([
    ['a waiting reading', prompt()],
    ['a closing reading', { kind: 'not-waiting' } as ScreenReading],
  ] as const)('%s is ignored', (_label, reading) => {
    generation();
    const start = startWaitingObservation(WT, TOOL, TOOL);
    open({ kind: 'unattributed', generation: start.generation, lastClosedTurnId: null });
    event('session_start', NOW + 500);
    // The session start rebinds nothing it closed; open a wait in the new generation.
    if (getWaitingEpisodeRecord(WT, TOOL, TOOL) === null) {
      open({ kind: 'unattributed', generation: startWaitingObservation(WT, TOOL, TOOL).generation, lastClosedTurnId: null });
    }
    const p = planWaitingObservation(observation(reading, { start }));
    expect(p).toMatchObject({ action: 'ignored', ignoredBecause: 'generation' });
  });
});

describe('[#3798] precondition 2: the episode moved since the observer started (I5 (b))', () => {
  it('a close, a rebind and a replacement are refused', () => {
    const gen = generation();
    openTurn(NOW + 40);
    const start = startWaitingObservation(WT, TOOL, TOOL);
    const opened = open({ kind: 'unattributed', generation: gen, lastClosedTurnId: null }, KEY_A);

    expect(planWaitingObservation(observation({ kind: 'not-waiting' }, { start }))).toMatchObject({
      action: 'ignored',
      ignoredBecause: 'version',
    });
    expect(planWaitingObservation(observation(screen, { start })).ignoredBecause).toBe('version');
    // c = turn(N): the same confirmation would rebind, another would replace.
    expect(planWaitingObservation(observation(prompt(PROMPT_A), { start })).ignoredBecause).toBe('version');
    expect(planWaitingObservation(observation(prompt(PROMPT_B), { start })).ignoredBecause).toBe('version');
    expect(observeWaiting(observation(prompt(PROMPT_B), { start })).action).toBe('ignored');
    expect(getWaitingEpisodeRecord(WT, TOOL, TOOL)?.episodeId).toBe(opened.episodeId);
  });

  it('an open is refused when a wait opened and closed meanwhile (ABA)', () => {
    generation();
    const start = startWaitingObservation(WT, TOOL, TOOL);
    const e = open({ kind: 'unattributed', generation: start.generation, lastClosedTurnId: null }, KEY_A, NOW + 100);
    closeEpisode(PARTS, e.episodeId, 'turn-stop', NOW + 200);
    expect(planWaitingObservation(observation(prompt(PROMPT_B), { start, frameCapturedAt: NOW + 300 }))).toMatchObject({
      action: 'ignored',
      ignoredBecause: 'version',
    });
  });

  it('a kept wait refreshes its kind even when the version moved', () => {
    const gen = generation();
    const start = startWaitingObservation(WT, TOOL, TOOL);
    open({ kind: 'unattributed', generation: gen, lastClosedTurnId: null }, KEY_A);
    const done = observeWaiting(observation({ ...prompt(), waitingKind: 'unclassified' }, { start }));
    expect(done.action).toBe('kept');
    expect(getWaitingEpisodeRecord(WT, TOOL, TOOL)?.kind).toBe('unclassified');
  });

  it('a fresh prompt is planned against the state as it is now (I5 (d))', () => {
    const gen = generation();
    const start = startWaitingObservation(WT, TOOL, TOOL);
    const t = closedTurn();
    open({ kind: 'turn', generation: gen, turnId: t }, KEY_A);
    const p = planWaitingObservation(observation(prompt(PROMPT_B), { start, freshPrompt: true }));
    expect(p.action).toBe('replaced');
  });
});

describe('[#3798] precondition 3: a frame fetched before the close of what it shows (I6)', () => {
  function closeAt(at: number, key: string | null): void {
    const e = open({ kind: 'unattributed', generation: startWaitingObservation(WT, TOOL, TOOL).generation, lastClosedTurnId: null }, key, at - 10);
    closeEpisode(PARTS, e.episodeId, 'turn-stop', at);
    expect(getLastClosedEpisode(WT, TOOL, TOOL)).toEqual({ at, promptScreenKey: key });
  }

  const cases: Array<[string, number, PromptData | null, ObservationAction]> = [
    ['the same confirmation, fetched before the close', NOW + 500, PROMPT_A, 'ignored'],
    ['the same confirmation, fetched at the close', NOW + 1_000, PROMPT_A, 'ignored'],
    ['no confirmation read, fetched before the close', NOW + 500, null, 'ignored'],
    ['another confirmation, fetched before the close', NOW + 500, PROMPT_B, 'opened'],
    ['the same confirmation, fetched after the close', NOW + 1_001, PROMPT_A, 'opened'],
  ];

  for (const [label, frameCapturedAt, promptData, expected] of cases) {
    it(`${label}: ${expected}`, () => {
      generation();
      closeAt(NOW + 1_000, KEY_A);
      const start = startWaitingObservation(WT, TOOL, TOOL);
      const p = planWaitingObservation(observation(prompt(promptData), { start, frameCapturedAt }));
      expect(p.action).toBe(expected);
      if (expected === 'ignored') expect(p.ignoredBecause).toBe('stale-frame');
    });
  }

  it('a frame the observer fetched itself after its start is not stale, even in the close\'s millisecond', () => {
    generation();
    closeAt(NOW + 1_000, KEY_A);
    const start = startWaitingObservation(WT, TOOL, TOOL);
    expect(
      planWaitingObservation(observation(prompt(), { start, frameCapturedAt: NOW + 1_000, frameFetchedAfterStart: true })).action
    ).toBe('opened');
    // …but only while nothing closed after the start.
    const late = startWaitingObservation(WT, TOOL, TOOL);
    const e = open({ kind: 'unattributed', generation: late.generation, lastClosedTurnId: null }, KEY_A, NOW + 1_100);
    closeEpisode(PARTS, e.episodeId, 'turn-stop', NOW + 1_200);
    expect(
      planWaitingObservation(
        observation(prompt(), { start: late, frameCapturedAt: NOW + 1_150, frameFetchedAfterStart: true, freshPrompt: true })
      ).ignoredBecause
    ).toBe('stale-frame');
  });

  it('captureFrameTime: a cached frame is as old as its fetch; an own fetch is after the request', () => {
    expect(captureFrameTime(() => ({ fetchStartedAt: NOW + 10, source: 'cache' }), NOW + 50)).toEqual({
      frameCapturedAt: NOW + 10,
      frameFetchedAfterStart: false,
    });
    expect(captureFrameTime(() => ({ fetchStartedAt: NOW + 60, source: 'fetched' }), NOW + 50)).toEqual({
      frameCapturedAt: NOW + 50,
      frameFetchedAfterStart: true,
    });
    expect(captureFrameTime(() => ({ fetchStartedAt: NOW + 50, source: 'fetched' }), NOW + 50)).toEqual({
      frameCapturedAt: NOW + 50,
      frameFetchedAfterStart: true,
    });
  });

  it('captureFrameTime: a cached or joined frame of the request\'s own millisecond is not an own fetch', () => {
    for (const source of ['cache', 'joined'] as const) {
      expect(captureFrameTime(() => ({ fetchStartedAt: NOW + 50, source }), NOW + 50)).toEqual({
        frameCapturedAt: NOW + 50,
        frameFetchedAfterStart: false,
      });
    }
  });

  it('captureFrameTime: an unknown source is not an own fetch', () => {
    expect(captureFrameTime(() => null, NOW + 50)).toEqual({ frameCapturedAt: NOW + 50, frameFetchedAfterStart: false });
    expect(
      captureFrameTime(() => {
        throw new Error('replaced module');
      }, NOW + 50)
    ).toEqual({ frameCapturedAt: NOW + 50, frameFetchedAfterStart: false });
  });

  it('applies to a fresh prompt too (R2-1)', () => {
    generation();
    closeAt(NOW + 1_000, KEY_A);
    expect(plan(prompt(), { frameCapturedAt: NOW + 900, freshPrompt: true }).ignoredBecause).toBe('stale-frame');
  });

  it('does not stop a close', () => {
    const gen = generation();
    closeAt(NOW + 1_000, KEY_A);
    open({ kind: 'unattributed', generation: gen, lastClosedTurnId: null }, KEY_A, NOW + 1_500);
    expect(plan({ kind: 'not-waiting' }, { frameCapturedAt: NOW + 900 }).action).toBe('closed');
  });
});

describe('[#3798] replaced is one edge (規則 5)', () => {
  it('one `replaced` crossing, no closing one; the last close names the old wait', () => {
    const gen = generation();
    const t = closedTurn();
    const old = open({ kind: 'turn', generation: gen, turnId: t }, KEY_A);
    const transitions: WaitingEpisodeTransition[] = [];
    onWaitingEpisodeTransition((tr) => transitions.push(tr));

    const done = observeWaiting(observation(prompt(PROMPT_B), { freshPrompt: true }, 'response-checker'));
    expect(done.action).toBe('replaced');
    const now = getWaitingEpisodeRecord(WT, TOOL, TOOL)!;
    expect(now.episodeId).not.toBe(old.episodeId);
    expect(now.since).toBe(NOW + 2_000);
    expect(transitions).toEqual([
      expect.objectContaining({ cause: 'replaced', waiting: true, episodeId: now.episodeId, previousEpisodeId: old.episodeId }),
    ]);
    expect(getLastClosedEpisode(WT, TOOL, TOOL)).toEqual({ at: NOW + 2_000, promptScreenKey: KEY_A });
  });

  it('a plan committed after the episode moved changes nothing', () => {
    const gen = generation();
    const opened = open({ kind: 'unattributed', generation: gen, lastClosedTurnId: null }, KEY_A);
    const p = plan({ kind: 'not-waiting' });
    expect(p.action).toBe('closed');
    closeEpisode(PARTS, opened.episodeId, 'turn-stop', NOW + 1_500);
    const next = open({ kind: 'unattributed', generation: gen, lastClosedTurnId: null }, KEY_A, NOW + 1_600);
    expect(observeWaiting(observation({ kind: 'not-waiting' }, { start: p.observation.start })).action).toBe('ignored');
    expect(getWaitingEpisodeRecord(WT, TOOL, TOOL)?.episodeId).toBe(next.episodeId);
  });
});
