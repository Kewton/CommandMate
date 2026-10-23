/**
 * Issue #3798: the T table — what each turn-transition outcome does to the
 * open waiting episode (`docs/design/issue-3798-waiting-episode.md` §2.4).
 *
 * Every row (T1–T21) against every column (A–I), driven through
 * `applyTurnOutcomesToEpisode` on the real episode store. A cell the design
 * marks as impossible (※1 / ※5) must leave the episode as it was and log
 * `waiting-episode-unmatched`.
 *
 * Columns, for a row whose target turn is X, whose taken-over record is R and
 * whose previous record is P:
 *   A none · B turn(X) · C turn(Y) · D dialog-only(R) · E dialog-only(R')
 *   F unattributed(lastClosed=P) · G unattributed(other) · H screen
 *   I any binding of another generation
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const warnLines = vi.hoisted(() => [] as string[]);
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const mockLogger: Record<string, unknown> = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: (event: string) => {
        warnLines.push(event);
      },
      error: vi.fn(),
      withContext: vi.fn(() => mockLogger),
    };
    return mockLogger;
  },
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

import { buildCompositeKey } from '@/lib/auto-yes-state';
import { clearAgentStopEvents } from '@/lib/session/agent-event-state';
import { generationStartedAt, type TurnTransitionOutcome } from '@/lib/session/agent-event-turn';
import { applyTurnOutcomesToEpisode } from '@/lib/session/waiting-episode-binding';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  getWaitingEpisodeRecord,
  openEpisode,
  type EpisodeBinding,
  type GenerationRef,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-3798-table';
const TOOL = 'claude' as const;
const PARTS = { worktreeId: WT, cliToolId: TOOL, instanceId: TOOL };
const G0 = 1_000;
const G1 = 2_000;
const G2 = 3_000;
const GEN0: GenerationRef = { kind: 'opened', at: G0 };
const GEN1: GenerationRef = { kind: 'opened', at: G1 };
const GEN2: GenerationRef = { kind: 'opened', at: G2 };

type Col = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I';
/** close · rebind (to the binding the row names) · none (unchanged) · unmatched (unchanged + warn) · n/a (no such column for this row) */
type Expect = 'close' | 'rebind' | 'none' | 'unmatched' | 'n/a';

interface Row {
  id: string;
  outcome: TurnTransitionOutcome;
  /** X, R and P as the columns read them. */
  x: string;
  r: string | null;
  p: string | null;
  /** The binding a `rebind` cell must leave, given the column's binding. */
  rebindTo?: (binding: EpisodeBinding) => EpisodeBinding;
  cells: Record<Col, Expect>;
}

const turnN = (n: string): EpisodeBinding => ({ kind: 'turn', generation: GEN1, turnId: n });

const ROWS: Row[] = [
  {
    id: 'T1 opened(post_tool_use, previous=closed(P))',
    outcome: { kind: 'opened', turnId: 'N', event: 'post_tool_use', generation: GEN1, previous: { kind: 'closed', turnId: 'P', closedBy: 'stop' } },
    x: 'N', r: 'P', p: 'P',
    rebindTo: () => turnN('N'),
    cells: { A: 'none', B: 'unmatched', C: 'close', D: 'unmatched', E: 'close', F: 'rebind', G: 'close', H: 'none', I: 'close' },
  },
  {
    id: 'T2 opened(post_tool_use, previous=dialog-only(R))',
    outcome: { kind: 'opened', turnId: 'N', event: 'post_tool_use', generation: GEN1, previous: { kind: 'dialog-only', turnId: 'R', decisions: 1, sessionId: null } },
    x: 'N', r: 'R', p: 'R',
    rebindTo: () => turnN('N'),
    cells: { A: 'none', B: 'unmatched', C: 'close', D: 'rebind', E: 'close', F: 'rebind', G: 'close', H: 'none', I: 'close' },
  },
  {
    id: 'T3 opened(pre_tool_use, previous=display-only(R))',
    outcome: { kind: 'opened', turnId: 'N', event: 'pre_tool_use', generation: GEN1, previous: { kind: 'display-only', turnId: 'R' } },
    x: 'N', r: 'R', p: 'R',
    rebindTo: () => turnN('N'),
    cells: { A: 'none', B: 'unmatched', C: 'close', D: 'rebind', E: 'close', F: 'rebind', G: 'close', H: 'none', I: 'close' },
  },
  {
    id: 'T3 opened(post_tool_use, previous=none)',
    outcome: { kind: 'opened', turnId: 'N', event: 'post_tool_use', generation: GEN1, previous: { kind: 'none' } },
    x: 'N', r: null, p: null,
    rebindTo: () => turnN('N'),
    cells: { A: 'none', B: 'unmatched', C: 'close', D: 'n/a', E: 'close', F: 'rebind', G: 'close', H: 'none', I: 'close' },
  },
  {
    id: 'T4 opened(user_prompt_submit, previous=dialog-only(R))',
    outcome: { kind: 'opened', turnId: 'N', event: 'user_prompt_submit', generation: GEN1, previous: { kind: 'dialog-only', turnId: 'R', decisions: 1, sessionId: null } },
    x: 'N', r: 'R', p: 'R',
    cells: { A: 'none', B: 'unmatched', C: 'close', D: 'close', E: 'close', F: 'close', G: 'close', H: 'none', I: 'close' },
  },
  {
    id: 'T4 opened(user_prompt_submit, previous=closed(P))',
    outcome: { kind: 'opened', turnId: 'N', event: 'user_prompt_submit', generation: GEN1, previous: { kind: 'closed', turnId: 'P', closedBy: 'stop' } },
    x: 'N', r: 'P', p: 'P',
    cells: { A: 'none', B: 'unmatched', C: 'close', D: 'close', E: 'close', F: 'close', G: 'close', H: 'none', I: 'close' },
  },
  {
    id: 'T5 opened(user_prompt_submit, previous=open-same-session(P))',
    outcome: { kind: 'opened', turnId: 'N', event: 'user_prompt_submit', generation: GEN1, previous: { kind: 'open-same-session', turnId: 'P' } },
    x: 'N', r: 'P', p: 'P',
    cells: { A: 'none', B: 'unmatched', C: 'close', D: 'unmatched', E: 'close', F: 'close', G: 'close', H: 'none', I: 'close' },
  },
  {
    id: 'T5 opened(post_tool_use, previous=open-other-session(P))',
    outcome: { kind: 'opened', turnId: 'N', event: 'post_tool_use', generation: GEN1, previous: { kind: 'open-other-session', turnId: 'P' } },
    x: 'N', r: 'P', p: 'P',
    cells: { A: 'none', B: 'unmatched', C: 'close', D: 'unmatched', E: 'close', F: 'close', G: 'close', H: 'none', I: 'close' },
  },
  {
    id: 'T6 continued(T)',
    outcome: { kind: 'continued', turnId: 'X' },
    x: 'X', r: 'R', p: 'P',
    cells: { A: 'none', B: 'none', C: 'none', D: 'none', E: 'none', F: 'none', G: 'none', H: 'none', I: 'none' },
  },
  {
    id: 'T7 restored(R, discarded N)',
    outcome: { kind: 'restored', restoredTurnId: 'R0', discardedTurnId: 'X' },
    x: 'X', r: 'R', p: 'P',
    rebindTo: () => turnN('R0'),
    cells: { A: 'none', B: 'rebind', C: 'none', D: 'none', E: 'none', F: 'none', G: 'none', H: 'none', I: 'none' },
  },
  {
    id: 'T8 stopped(T)',
    outcome: { kind: 'stopped', turnId: 'X', generation: GEN1 },
    x: 'X', r: 'R', p: 'P',
    cells: { A: 'none', B: 'close', C: 'none', D: 'none', E: 'none', F: 'none', G: 'none', H: 'none', I: 'close' },
  },
  {
    id: 'T9 stop-without-turn(previous=closed(X, scraper_evidence))',
    outcome: { kind: 'stop-without-turn', recordTurnId: 'S', generation: GEN1, previous: { kind: 'closed', turnId: 'X', closedBy: 'scraper_evidence' } },
    x: 'X', r: 'X', p: 'X',
    cells: { A: 'none', B: 'close', C: 'none', D: 'unmatched', E: 'none', F: 'close', G: 'none', H: 'none', I: 'close' },
  },
  {
    id: 'T10 stop-without-turn(previous=dialog-only(R))',
    outcome: { kind: 'stop-without-turn', recordTurnId: 'S', generation: GEN1, previous: { kind: 'dialog-only', turnId: 'R', decisions: 1, sessionId: null } },
    x: 'X', r: 'R', p: 'R',
    cells: { A: 'none', B: 'none', C: 'none', D: 'close', E: 'none', F: 'close', G: 'close', H: 'none', I: 'close' },
  },
  {
    id: 'T11 stop-without-turn(previous=display-only(R))',
    outcome: { kind: 'stop-without-turn', recordTurnId: 'S', generation: GEN1, previous: { kind: 'display-only', turnId: 'R' } },
    x: 'X', r: 'R', p: 'R',
    cells: { A: 'none', B: 'none', C: 'none', D: 'close', E: 'none', F: 'close', G: 'none', H: 'none', I: 'close' },
  },
  {
    id: 'T11 stop-without-turn(previous=none)',
    outcome: { kind: 'stop-without-turn', recordTurnId: 'S', generation: GEN1, previous: { kind: 'none' } },
    x: 'X', r: null, p: null,
    cells: { A: 'none', B: 'none', C: 'none', D: 'n/a', E: 'none', F: 'close', G: 'none', H: 'none', I: 'close' },
  },
  {
    id: 'T12 stop-rejected(other-session)',
    outcome: { kind: 'stop-rejected', reason: 'other-session' },
    x: 'X', r: 'R', p: 'P',
    cells: { A: 'none', B: 'none', C: 'none', D: 'none', E: 'none', F: 'none', G: 'none', H: 'none', I: 'none' },
  },
  {
    id: 'T13 session-ended(T)',
    outcome: { kind: 'session-ended', turnId: 'X' },
    x: 'X', r: 'R', p: 'P',
    cells: { A: 'none', B: 'close', C: 'none', D: 'none', E: 'none', F: 'none', G: 'none', H: 'none', I: 'close' },
  },
  {
    id: 'T14 session-end-rejected',
    outcome: { kind: 'session-end-rejected', reason: 'no-turn' },
    x: 'X', r: 'R', p: 'P',
    cells: { A: 'none', B: 'none', C: 'none', D: 'none', E: 'none', F: 'none', G: 'none', H: 'none', I: 'none' },
  },
  {
    id: 'T15 decision-opened(R, dialog-only)',
    outcome: { kind: 'decision-opened', recordTurnId: 'R', recordKind: 'dialog-only' },
    x: 'X', r: 'R', p: 'P',
    rebindTo: () => ({ kind: 'dialog-only', generation: GEN1, recordTurnId: 'R', sessionId: null }),
    cells: { A: 'none', B: 'none', C: 'none', D: 'none', E: 'none', F: 'rebind', G: 'rebind', H: 'none', I: 'none' },
  },
  {
    id: 'T16 decision-opened(R, turn)',
    outcome: { kind: 'decision-opened', recordTurnId: 'X', recordKind: 'turn' },
    x: 'X', r: 'R', p: 'P',
    cells: { A: 'none', B: 'none', C: 'none', D: 'none', E: 'none', F: 'none', G: 'none', H: 'none', I: 'none' },
  },
  {
    id: 'T17 decision-answered(before 1, remaining 0) on a turn',
    outcome: { kind: 'decision-answered', recordTurnId: 'X', recordKind: 'turn', before: 1, remaining: 0 },
    x: 'X', r: 'X', p: 'P',
    cells: { A: 'none', B: 'close', C: 'none', D: 'close', E: 'none', F: 'none', G: 'none', H: 'none', I: 'none' },
  },
  {
    id: 'T18 decision-answered(remaining 1)',
    outcome: { kind: 'decision-answered', recordTurnId: 'X', recordKind: 'turn', before: 2, remaining: 1 },
    x: 'X', r: 'X', p: 'P',
    cells: { A: 'none', B: 'none', C: 'none', D: 'none', E: 'none', F: 'none', G: 'none', H: 'none', I: 'none' },
  },
  {
    id: 'T19 generation-fenced(process-start)',
    outcome: { kind: 'generation-fenced', source: 'process-start', generation: GEN2, fencedTurnId: 'X' },
    x: 'X', r: 'R', p: 'P',
    cells: { A: 'none', B: 'close', C: 'close', D: 'close', E: 'close', F: 'close', G: 'close', H: 'close', I: 'close' },
  },
  {
    id: 'T20 generation-fenced(session-start)',
    outcome: { kind: 'generation-fenced', source: 'session-start', generation: GEN2, fencedTurnId: 'X' },
    x: 'X', r: 'R', p: 'P',
    rebindTo: (b) => ({ ...b, generation: GEN2 }),
    cells: { A: 'none', B: 'close', C: 'close', D: 'close', E: 'close', F: 'close', G: 'close', H: 'rebind', I: 'close' },
  },
  {
    id: 'T21 none',
    outcome: { kind: 'none' },
    x: 'X', r: 'R', p: 'P',
    cells: { A: 'none', B: 'none', C: 'none', D: 'none', E: 'none', F: 'none', G: 'none', H: 'none', I: 'none' },
  },
];

function bindingFor(col: Col, row: Row): EpisodeBinding | null {
  switch (col) {
    case 'A':
      return null;
    case 'B':
      return { kind: 'turn', generation: GEN1, turnId: row.x };
    case 'C':
      return { kind: 'turn', generation: GEN1, turnId: 'Y' };
    case 'D':
      return { kind: 'dialog-only', generation: GEN1, recordTurnId: row.r ?? 'unused', sessionId: null };
    case 'E':
      return { kind: 'dialog-only', generation: GEN1, recordTurnId: 'R-other', sessionId: null };
    case 'F':
      return { kind: 'unattributed', generation: GEN1, lastClosedTurnId: row.p };
    case 'G':
      return { kind: 'unattributed', generation: GEN1, lastClosedTurnId: 'G-other' };
    case 'H':
      return { kind: 'screen', generation: GEN1, originTurnId: null };
    case 'I':
      return { kind: 'turn', generation: GEN0, turnId: 'Y' };
  }
}

beforeEach(() => {
  clearAgentStopEvents();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  warnLines.length = 0;
});

afterEach(() => {
  clearAgentStopEvents();
  clearWaitingEpisodes();
});

describe('[#3798] the T table, row by column', () => {
  for (const row of ROWS) {
    for (const col of Object.keys(row.cells) as Col[]) {
      const expected = row.cells[col];
      if (expected === 'n/a') continue;

      it(`${row.id} × ${col}: ${expected}`, () => {
        // The generation the row runs in. A fence row runs after its new generation began.
        const current = row.outcome.kind === 'generation-fenced' ? G2 : G1;
        generationStartedAt.set(buildCompositeKey(WT, TOOL, TOOL), current);

        const binding = bindingFor(col, row);
        const opened =
          binding === null
            ? null
            : openEpisode(PARTS, { since: 100, kind: 'prompt', binding, openedBy: 'status-probe' }, 100);

        const effects = applyTurnOutcomesToEpisode(PARTS, [row.outcome], 500);
        const after = getWaitingEpisodeRecord(WT, TOOL, TOOL);

        expect(effects).toHaveLength(1);
        if (opened === null) {
          expect(after).toBeNull();
          expect(effects[0].action).toBe('none');
          return;
        }
        if (expected === 'close') {
          expect(after).toBeNull();
          expect(effects[0]).toMatchObject({ action: 'closed', episodeId: opened.episodeId });
          return;
        }
        expect(after?.episodeId).toBe(opened.episodeId);
        expect(after?.since).toBe(100);
        if (expected === 'rebind') {
          expect(effects[0].action).toBe('rebound');
          expect(after?.binding).toEqual(row.rebindTo!(binding!));
          expect(after?.boundAt).toBe(500);
          return;
        }
        expect(effects[0].action).toBe('none');
        expect(after?.binding).toEqual(binding);
        expect(warnLines.includes('waiting-episode-unmatched')).toBe(expected === 'unmatched');
      });
    }
  }
});

describe('[#3798] outcomes in one delivery are applied in order', () => {
  it('a session start fences, then the stop of the new generation finds nothing left to close', () => {
    generationStartedAt.set(buildCompositeKey(WT, TOOL, TOOL), G2);
    const opened = openEpisode(
      PARTS,
      { since: 100, kind: 'prompt', binding: { kind: 'turn', generation: GEN1, turnId: 'X' }, openedBy: 'status-probe' },
      100
    );
    const effects = applyTurnOutcomesToEpisode(PARTS, [
      { kind: 'generation-fenced', source: 'session-start', generation: GEN2, fencedTurnId: 'X' },
      { kind: 'none' },
    ]);
    expect(effects.map((e) => e.action)).toEqual(['closed', 'none']);
    expect(effects[0].episodeId).toBe(opened.episodeId);
    expect(effects[1].episodeId).toBeNull();
  });
});
