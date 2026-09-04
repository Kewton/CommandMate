/**
 * Issue #2326 — what a selection-list card is allowed to take from the chat.
 *
 * The card that draws a TUI dialog sits in the surface's `shrink-0` live
 * region, so every pixel it is given comes out of the transcript above it. Two
 * fixed caps were measured on 2026-09-04 and both were wrong in opposite
 * directions:
 *
 * | platform | #2309's cap     | what it came to | measured consequence |
 * |----------|-----------------|-----------------|----------------------|
 * | PC       | `max-h-[28rem]` | 448px           | banner + card + arrow pad ≈ 560px of an 800px split; with the composer under it the transcript was left ≈ 60px, i.e. no readable chat while a picker was open |
 * | phone    | `max-h-32`      | 128px           | ≈ 8 rows for a search-type picker with a filter box and no number keys to jump by |
 *
 * The correction is one cap for both, expressed as a fraction of the viewport
 * rather than in `rem`: the thing the card competes with is the split, which is
 * viewport-tall, and a fixed cap cannot see it.
 *
 * ## This is arithmetic over a class, and says so
 *
 * jsdom lays nothing out, so no test in this file measures a rendered pixel.
 * What it does instead is take the ONE number the component chooses — the cap —
 * and check it against the chrome measured in the UAT above, on a stated
 * reference viewport. A case that only asserted the class string would pass on
 * `max-h-[95vh]`, which is the defect with a different spelling; the budget
 * case below is what refuses that.
 *
 * `ChatTranscript` is stubbed for the same reason `ChatSurface-dialog-card-2254
 * .test.tsx` stubs it.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: () => (
    <div data-testid="chat-transcript">
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

import {
  ChatSurface,
  SELECTION_LIST_TALL_CARD_MIN_ROWS,
  type ChatSurfaceLiveState,
} from '@/components/worktree/ChatSurface';

const WORKTREE_ID = 'wt-2326';

/** A Command Code-shaped picker: a heading, a filter row, a long list, a footer. */
const PICKER_FRAME = [
  'Select model',
  'Switch between the available models.',
  '',
  '› Type to search models...',
  ...Array.from({ length: 60 }, (_v, i) => `model row ${i}`),
  '',
  'type to search · ↑/↓ navigate · enter to select · esc to cancel',
].join('\n');

/**
 * A selection list of exactly `rows` rows, with no picker footer on it.
 *
 * No footer on purpose: Issue #2326's crop would otherwise cut this frame to
 * its own dialog and the row count under test would not be the row count the
 * surface sees. Every row carries a glyph, so blank-run compaction leaves the
 * count alone.
 */
function listFrame(rows: number): string {
  return Array.from({ length: rows }, (_v, i) => (i === 0 ? 'Select model' : `option ${i}`)).join(
    '\n',
  );
}

/** The phone's own capture, from `MobileTerminalTab-dialog-card-2254.test.tsx`. */
const SHORT_DIALOG_FRAME = ['Select model', '❯ 1. Default', '  2. Opus', 'Esc to cancel'].join('\n');

const IDLE: ChatSurfaceLiveState = {
  isRunning: false,
  sessionStatus: 'ready',
  isThinking: false,
  isPromptWaiting: false,
  promptData: null,
  isSelectionListActive: false,
  isPagerActive: false,
  isUnclassifiedActive: false,
};

function msg(id: string, role: ChatMessage['role']): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content: `content-${id}`,
    timestamp: new Date('2026-09-05T10:00:00Z'),
    messageType: 'normal',
    archived: false,
    cliToolId: 'command-code',
  };
}

/**
 * The `max-h-*` class the surface hands the card for this state.
 *
 * Unmounts first so a case may ask twice (PC and phone) without
 * `getByTestId` finding two frames.
 */
function capFor(
  live: Partial<ChatSurfaceLiveState>,
  compact = false,
  frame: string = PICKER_FRAME,
): string {
  cleanup();
  render(
    <ChatSurface
      messages={[msg('u1', 'user'), msg('a1', 'assistant')]}
      worktreeId={WORKTREE_ID}
      cliToolId="command-code"
      instanceId="command-code-1"
      live={{ ...IDLE, ...live }}
      onSurfaceModeChange={vi.fn()}
      frame={frame}
      compact={compact}
    />,
  );
  const classes = screen.getByTestId('chat-dialog-card-frame').className.split(/\s+/);
  const cap = classes.filter((name) => name.startsWith('max-h-'));
  expect(cap, 'exactly one height cap on the frame').toHaveLength(1);
  return cap[0];
}

// ---------------------------------------------------------------------------
// Reference geometry, all of it measured rather than chosen
// ---------------------------------------------------------------------------

/** The window the UAT ran in (PC 1440x900). */
const VIEWPORT_HEIGHT = 900;

/**
 * Everything in the live region that is NOT the card, measured in the same UAT:
 * the banner row, the two `gap-2`s, the strip's `py-2`, and the arrow pad under
 * the frame. 560px of live region minus the 448px card is 112.
 */
const LIVE_REGION_CHROME = 112;

/**
 * The composer below the transcript.
 *
 * DERIVED, not read off a ruler: the UAT reported a 560px live region and a
 * ≈60px transcript inside an 800px split, and 800 - 560 - 60 is what is left
 * for the input. Named so the arithmetic below can be checked rather than
 * trusted.
 */
const COMPOSER = 180;

/** One transcript row at the surface's `text-sm` — `leading-normal` on 14px. */
const CHAT_ROW = 20;

/**
 * Rows of chat that have to survive a picker being open.
 *
 * Chosen, not measured: eight rows is the last exchange plus its question,
 * which is what makes the transcript still a conversation rather than a strip
 * of one bubble. The UAT's 60px was three.
 */
const MIN_VISIBLE_CHAT_ROWS = 8;

/** `max-h-[35vh]` → 0.35; `max-h-64` → 16rem → 256px; `max-h-32` → 128px. */
function capPixels(cap: string, viewportHeight: number): number {
  const vh = /^max-h-\[(\d+(?:\.\d+)?)vh\]$/.exec(cap);
  if (vh) return (Number(vh[1]) / 100) * viewportHeight;
  const rem = /^max-h-\[(\d+(?:\.\d+)?)rem\]$/.exec(cap);
  if (rem) return Number(rem[1]) * 16;
  const step = /^max-h-(\d+)$/.exec(cap);
  if (step) return Number(step[1]) * 4;
  throw new Error(`unhandled cap: ${cap}`);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe('[#2326] a selection-list card scales with the viewport', () => {
  it('caps the PC card as a viewport fraction, not the fixed 28rem', () => {
    expect(capFor({ isSelectionListActive: true })).toBe('max-h-[35vh]');
  });

  it('gives the phone the same cap instead of #2106’s eight rows', () => {
    // #2106's vertical budget is conceded ONLY while a selection list is up,
    // which is the case directly below.
    const cap = capFor({ isSelectionListActive: true }, true);
    expect(cap).toBe('max-h-[35vh]');
    expect(capPixels(cap, VIEWPORT_HEIGHT)).toBeGreaterThan(capPixels('max-h-32', VIEWPORT_HEIGHT));
  });

  it.each([
    ['pager', { isPagerActive: true }],
    ['unclassified', { isUnclassifiedActive: true }],
  ] as const)('leaves the %s card on the caps #2106 and #2254 set', (_reason, live) => {
    expect(capFor(live)).toBe('max-h-64');
    expect(capFor(live, true)).toBe('max-h-32');
  });
});

describe('[#2326] the taller box is for a list that needs it', () => {
  it('leaves a four-row dialog on #2106’s budget', () => {
    // The frame the phone's own suite renders. Four rows in a 315px box is
    // 187px of transcript spent on whitespace, which is the budget given away
    // for nothing — so the concession is made on the CONTENT, not the reason.
    expect(capFor({ isSelectionListActive: true }, true, SHORT_DIALOG_FRAME)).toBe('max-h-32');
    expect(capFor({ isSelectionListActive: true }, false, SHORT_DIALOG_FRAME)).toBe('max-h-64');
  });

  it('switches over at the documented row count, in both directions', () => {
    // Both sides of the threshold, on frames that differ by ONE row: a case
    // that only checked the long side would pass on a gate that was never
    // consulted.
    const atLimit = listFrame(SELECTION_LIST_TALL_CARD_MIN_ROWS);
    const overLimit = listFrame(SELECTION_LIST_TALL_CARD_MIN_ROWS + 1);
    expect(capFor({ isSelectionListActive: true }, false, atLimit)).toBe('max-h-64');
    expect(capFor({ isSelectionListActive: true }, false, overLimit)).toBe('max-h-[35vh]');
    expect(capFor({ isSelectionListActive: true }, true, atLimit)).toBe('max-h-32');
    expect(capFor({ isSelectionListActive: true }, true, overLimit)).toBe('max-h-[35vh]');
  });

  it('never gives a long PAGER the taller box — the reason still gates it', () => {
    // `dialogRowCount` is only computed for a selection list, and this is what
    // says so: the same 65-row frame under a different reason keeps the caps
    // #2106 and #2254 set.
    expect(capFor({ isPagerActive: true })).toBe('max-h-64');
    expect(capFor({ isPagerActive: true }, true)).toBe('max-h-32');
  });
});

describe('[#2326] the cap leaves the transcript a readable share', () => {
  it('is small enough that eight rows of chat survive on the UAT’s window', () => {
    // The case that a class-name assertion cannot make: `max-h-[95vh]` would
    // satisfy every test above and still be the defect. The inputs are named
    // constants above, each one measured in the UAT except the eight rows.
    const card = capPixels(capFor({ isSelectionListActive: true }), VIEWPORT_HEIGHT);
    const remaining = VIEWPORT_HEIGHT - card - LIVE_REGION_CHROME - COMPOSER;
    expect(remaining / CHAT_ROW).toBeGreaterThanOrEqual(MIN_VISIBLE_CHAT_ROWS);
  });

  it('is what #2309’s fixed cap failed, so this is not a test of nothing', () => {
    // The positive control, run against the 800px SPLIT the card really sits
    // in rather than the whole window: #2309's 448px cap leaves 3 rows there,
    // under the floor, and this Issue's leaves 9. Without this case every
    // assertion in the block above would also have passed before the change.
    const split = 800;
    const rows = (card: number): number =>
      (split - card - LIVE_REGION_CHROME - COMPOSER) / CHAT_ROW;
    expect(rows(capPixels('max-h-[28rem]', VIEWPORT_HEIGHT))).toBeLessThan(MIN_VISIBLE_CHAT_ROWS);
    expect(rows(capPixels('max-h-[35vh]', VIEWPORT_HEIGHT))).toBeGreaterThanOrEqual(
      MIN_VISIBLE_CHAT_ROWS,
    );
  });

  it('is still bigger than the card a dozen rows fit in', () => {
    // The other direction: a picker is real scrollable content (#2309) and a
    // cap below the 12-20 row card's would be a regression on that.
    const selection = capPixels(capFor({ isSelectionListActive: true }), VIEWPORT_HEIGHT);
    expect(selection).toBeGreaterThan(capPixels('max-h-64', VIEWPORT_HEIGHT));
  });
});
