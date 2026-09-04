/**
 * The chat surface's dialog card (Issue #2254).
 *
 * Epic #2192's decision 5 made four frames terminal-only — a selection list, a
 * pager, an unclassified overlay, and a wait whose payload nobody could parse —
 * and `ChatSurface` answered all four with a banner and one button. **#2254
 * withdrew that decision**, so the properties worth pinning changed shape:
 *
 *  1. **The card appears for each of the four, and shows the pane's TAIL.** Not
 *     "a card appears": the frame's last rows have to be IN it, because the
 *     failure this Issue is about is a user being told they can answer a dialog
 *     they cannot see.
 *  2. **It stays absent for everything else** — most importantly for an
 *     ANSWERABLE wait, which `PromptPanel` / `MobilePromptSheet` are already on
 *     screen for. Two controls answering one dialog is the regression #2194
 *     avoided and #2254 must not reintroduce.
 *  3. **The controls under the card match the reason.** A moving highlight gets
 *     arrows; a dialog that asks gets the `1`-`9` / `y` / `n` characters #2254
 *     added to the special-keys vocabulary. Getting this backwards is not
 *     cosmetic: Enter on a numbered dialog takes whatever the CLI highlighted,
 *     which is how a "no" is delivered as an approval (#1681).
 *  4. **The keys reach `/special-keys`, verbatim.** A button that posts nothing
 *     looks identical on screen to one that works.
 *
 * `ChatTranscript` is stubbed (a layout-less DOM cannot give the real one scroll
 * metrics); everything below the transcript — the card, its frame, its buttons —
 * is the real implementation.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { ChatMessage, PromptData } from '@/types/models';
import { UNCLASSIFIED_PROMPT_TYPE } from '@/types/models';
import type { StructuredPromptWaitingData } from '@/lib/session/structured-prompt';

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: ({ messages }: { messages: Array<{ id: string }> }) => (
    <div data-testid="chat-transcript" data-message-count={String(messages.length)}>
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

import { ChatSurface, type ChatSurfaceLiveState } from '@/components/worktree/ChatSurface';
import { PROMPT_ANSWER_KEYS } from '@/components/worktree/PromptAnswerKeys';
import { ANSWER_KEY_VALUES } from '@/types/terminal-keys';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKTREE_ID = 'wt-2254';

/**
 * A pane shaped like the ones this Issue measured: a transcript, then the long
 * blank run a 200x1000 pane leaves (claude's `/model` capture has ~980 rows of
 * it), then the dialog at the very end.
 *
 * The transcript is 30 rows on purpose. Blank runs COLLAPSE, so a frame whose
 * content is shorter than the row budget survives whole and nothing is dropped —
 * which would make "the head is not in the card" vacuously false. 30 rows plus
 * the collapsed gap plus the 6-row dialog is 37, comfortably past the 16-row
 * default, so the tail really does have to cut.
 */
const FRAME = [
  'a-line-from-far-above-that-must-not-be-in-the-card',
  ...Array.from({ length: 29 }, (_v, i) => `transcript row ${i}`),
  ...Array.from({ length: 40 }, () => ''),
  'Select model',
  '  1. Default (recommended)',
  '❯ 2. Opus (1M context)',
  '  3. Fable',
  '',
  'Enter to set as default · s to use this session only · Esc to cancel',
].join('\n');

/** The row a correct tail always ends on. */
const FRAME_LAST_ROW = 'Enter to set as default · s to use this session only · Esc to cancel';

function msg(id: string, role: ChatMessage['role']): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content: `content-${id}`,
    timestamp: new Date('2026-09-03T10:00:00Z'),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
  };
}

const ANSWERABLE_PROMPT: PromptData = {
  type: 'yes_no',
  status: 'pending',
  question: 'Proceed?',
  options: ['yes', 'no'],
};

/** #1725's degraded payload: a wait is up and its options were never in it. */
const UNREADABLE_PROMPT: StructuredPromptWaitingData = {
  type: UNCLASSIFIED_PROMPT_TYPE,
  status: 'pending',
  question: 'A dialog is waiting.',
  options: [],
  source: 'notification',
};

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

/** The four states the card exists for, each raised ALONE. */
const BLOCKED_STATES: ReadonlyArray<{ reason: string; live: Partial<ChatSurfaceLiveState> }> = [
  { reason: 'selectionList', live: { isSelectionListActive: true } },
  { reason: 'pager', live: { isPagerActive: true } },
  { reason: 'unclassified', live: { isUnclassifiedActive: true } },
  {
    reason: 'promptUnreadable',
    live: { isPromptWaiting: true, promptData: UNREADABLE_PROMPT },
  },
];

function renderSurface(
  live: Partial<ChatSurfaceLiveState> = {},
  extra: { frame?: string; compact?: boolean; onKeysSent?: () => void } = {},
) {
  const onSurfaceModeChange = vi.fn();
  const result = render(
    <ChatSurface
      messages={[msg('u1', 'user'), msg('a1', 'assistant')]}
      worktreeId={WORKTREE_ID}
      cliToolId="claude"
      instanceId="claude-2"
      live={{ ...IDLE, ...live }}
      onSurfaceModeChange={onSurfaceModeChange}
      frame={'frame' in extra ? extra.frame : FRAME}
      compact={extra.compact}
      onKeysSent={extra.onKeysSent}
    />,
  );
  return { ...result, onSurfaceModeChange };
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
// (1) The card, and the tail inside it
// ---------------------------------------------------------------------------

describe('[#2254] the dialog card appears for every state chat used to refuse', () => {
  it.each(BLOCKED_STATES)('draws the card for $reason', ({ reason, live }) => {
    renderSurface(live);

    const card = screen.getByTestId('chat-dialog-card');
    expect(card).toHaveAttribute('data-reason', reason);
    // The banner stays — reworded, and now above a card rather than instead of
    // one. Both, not either.
    expect(screen.getByTestId('chat-surface-terminal-banner')).toHaveAttribute(
      'data-reason',
      reason,
    );
  });

  it.each(BLOCKED_STATES)('puts the frame’s LAST row in the card for $reason', ({ live }) => {
    renderSurface(live);
    expect(screen.getByTestId('chat-dialog-card-frame')).toHaveTextContent(FRAME_LAST_ROW);
  });

  it('shows the dialog rows and not the row 40 blank lines above them', () => {
    // The specific failure a "first content row onwards" implementation has, and
    // the reason `extractDialogFrameTail` drops leading blank runs rather than
    // slicing from the first non-blank row.
    //
    // A pager, not a selection list: Issue #2309 stops tail-slicing a selection
    // list altogether (see the describe block below), so this frame's actual
    // top row would legitimately survive there. The pager keeps the original
    // tail behaviour this test pins.
    renderSurface({ isPagerActive: true });
    const frame = screen.getByTestId('chat-dialog-card-frame');
    expect(frame).toHaveTextContent('❯ 2. Opus (1M context)');
    expect(frame).not.toHaveTextContent('a-line-from-far-above');
  });

  it('keeps the escape hatch back to the terminal as a secondary way out', () => {
    const { onSurfaceModeChange } = renderSurface({ isSelectionListActive: true });
    fireEvent.click(screen.getByTestId('chat-surface-open-terminal'));
    expect(onSurfaceModeChange).toHaveBeenCalledWith('terminal');
  });
});

// ---------------------------------------------------------------------------
// (2) When it must NOT appear
// ---------------------------------------------------------------------------

describe('[#2254] the card stays away from everything else', () => {
  it('draws neither card nor banner when every flag is false', () => {
    renderSurface();
    expect(screen.queryByTestId('chat-dialog-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-surface-terminal-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-surface-live')).not.toBeInTheDocument();
  });

  it('draws nothing for an ANSWERABLE wait — the composer already has that dialog', () => {
    // `PromptPanel` (PC) / `MobilePromptSheet` (phone) render in chat mode since
    // #2193. A card here would be a second control for one dialog, and its
    // arrow/number keys would race the panel's own answer.
    renderSurface({ isPromptWaiting: true, promptData: ANSWERABLE_PROMPT });
    expect(screen.queryByTestId('chat-dialog-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-surface-terminal-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('prompt-answer-keys')).not.toBeInTheDocument();
  });

  it('still draws nothing for an answerable wait on a RUNNING session', () => {
    // Guards the same rule against the state it is most likely to be broken in:
    // `isRunning` / `sessionStatus` move independently of the prompt flags.
    renderSurface({
      isRunning: true,
      sessionStatus: 'running',
      isPromptWaiting: true,
      promptData: ANSWERABLE_PROMPT,
    });
    expect(screen.queryByTestId('chat-dialog-card')).not.toBeInTheDocument();
  });

  it('falls back to the banner alone when the caller passes no frame', () => {
    // A caller that has not been updated must degrade to the pre-#2254 surface,
    // not to a black box.
    renderSurface({ isSelectionListActive: true }, { frame: undefined });
    expect(screen.getByTestId('chat-surface-terminal-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-dialog-card')).not.toBeInTheDocument();
  });

  it('falls back to the banner alone when the pane has nothing on it', () => {
    // A pane captured between frames, or a session that just died: the flags
    // still say a dialog is up and there is genuinely nothing to draw.
    renderSurface({ isUnclassifiedActive: true }, { frame: '\n\n\n   \n' });
    expect(screen.getByTestId('chat-surface-terminal-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-dialog-card')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// (3) The controls under the card
// ---------------------------------------------------------------------------

describe('[#2254] the controls match the reason', () => {
  it('gives a selection list the arrow pad and no pager keys', () => {
    renderSurface({ isSelectionListActive: true });
    const actions = screen.getByTestId('chat-dialog-card-actions');
    expect(within(actions).getAllByRole('toolbar').length).toBeGreaterThan(0);
    expect(within(actions).getByLabelText('Up')).toBeInTheDocument();
    expect(within(actions).getByLabelText('Escape')).toBeInTheDocument();
    // `showPagerKeys` is off, so no PgUp and no pager quit.
    expect(within(actions).queryByLabelText('Page Up')).not.toBeInTheDocument();
    // …and no `PromptAnswerKeys`: that strip is the fixed 1-9 / y / n pad for a
    // dialog NOBODY could read, and a selection list has a highlight the
    // detectors DID read. Issue #2297 puts a different control here for a
    // numbered list — `SelectionNumberKeys`, sized to the options the frame is
    // actually offering — and this FRAME is claude's `/model`, whose footer
    // names a session-scoped key, so it gets the two labelled commits instead
    // of numbers (a number key on that overlay commits AND rewrites
    // ~/.claude/settings.json in one press; measured on 2.1.260).
    expect(within(actions).queryByTestId('prompt-answer-keys')).not.toBeInTheDocument();
    expect(within(actions).queryByTestId('selection-number-keys')).not.toBeInTheDocument();
    expect(within(actions).getByTestId('selection-commit-keys')).toBeInTheDocument();
  });

  it('gives a pager the arrow pad WITH the pager keys', () => {
    renderSurface({ isPagerActive: true });
    const actions = screen.getByTestId('chat-dialog-card-actions');
    expect(within(actions).getByLabelText('Page Up')).toBeInTheDocument();
    expect(within(actions).getByLabelText('Page Down')).toBeInTheDocument();
    expect(within(actions).getByLabelText('Home')).toBeInTheDocument();
    expect(within(actions).getByLabelText('End')).toBeInTheDocument();
  });

  it('gives an unclassified frame the escape hatch AND the answer keys', () => {
    // Nobody classified the frame, so nobody can promise it navigates rather
    // than asks. Issue #2254 §B: "the yes/no in an unclassified frame".
    renderSurface({ isUnclassifiedActive: true });
    const actions = screen.getByTestId('chat-dialog-card-actions');
    expect(within(actions).getByLabelText('Send Escape')).toBeInTheDocument();
    expect(within(actions).getByTestId('prompt-answer-keys')).toBeInTheDocument();
  });

  it('gives an unreadable wait the notice and the answer keys, and no arrow pad', () => {
    renderSurface({ isPromptWaiting: true, promptData: UNREADABLE_PROMPT });
    const actions = screen.getByTestId('chat-dialog-card-actions');
    expect(within(actions).getByTestId('chat-surface-unreadable-hint')).toBeInTheDocument();
    expect(within(actions).getByTestId('prompt-answer-keys')).toBeInTheDocument();
    expect(within(actions).queryByLabelText('Up')).not.toBeInTheDocument();
  });

  it('offers 1-9, y, n and Enter — and nothing that would need a chord', () => {
    renderSurface({ isPromptWaiting: true, promptData: UNREADABLE_PROMPT });
    const keys = screen.getByTestId('prompt-answer-keys');
    for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'y', 'n', 'Enter']) {
      expect(within(keys).getByTestId(`prompt-answer-key-${key}`), key).toBeInTheDocument();
    }
    // `0` and `10` are deliberately absent: no measured dialog offers option 0,
    // and `10` is two characters the per-key transport cannot deliver as one.
    expect(within(keys).queryByTestId('prompt-answer-key-0')).not.toBeInTheDocument();
    expect(within(keys).queryByTestId('prompt-answer-key-10')).not.toBeInTheDocument();
  });

  it('offers exactly the vocabulary the route accepts, plus Enter', () => {
    // The toolbar writes its own key list (each button needs a cap and an aria
    // label), so it can drift from `ANSWER_KEY_VALUES` — and a drift is silent:
    // a button for a key the route does not publish looks identical on screen
    // and answers 400 when pressed. Asserted in both directions.
    expect(PROMPT_ANSWER_KEYS).toEqual([...ANSWER_KEY_VALUES, 'Enter']);
  });

  it('never renders a prompt panel of its own', () => {
    for (const { live } of BLOCKED_STATES) {
      const { unmount } = renderSurface(live);
      expect(screen.queryByTestId('prompt-panel')).not.toBeInTheDocument();
      expect(screen.queryByTestId('mobile-prompt-sheet')).not.toBeInTheDocument();
      unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// (4) The keys actually go somewhere
// ---------------------------------------------------------------------------

describe('[#2254] the answer keys reach /special-keys verbatim', () => {
  it('POSTs the pressed character to this worktree and this instance', () => {
    renderSurface({ isPromptWaiting: true, promptData: UNREADABLE_PROMPT });

    fireEvent.click(screen.getByTestId('prompt-answer-key-2'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/worktrees/${WORKTREE_ID}/special-keys`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      cliToolId: 'claude',
      keys: ['2'],
      // Issue #869: a non-primary instance names itself.
      instanceId: 'claude-2',
    });
  });

  it.each(['y', 'n', 'Enter'])('POSTs %s as a single-key array', (key) => {
    renderSurface({ isUnclassifiedActive: true });
    fireEvent.click(screen.getByTestId(`prompt-answer-key-${key}`));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).keys).toEqual([key]);
  });

  it('sends the arrow pad through the same route for a selection list', () => {
    renderSurface({ isSelectionListActive: true });
    fireEvent.click(
      within(screen.getByTestId('chat-dialog-card-actions')).getByLabelText('Down'),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).keys).toEqual(['Down']);
  });
});

// ---------------------------------------------------------------------------
// The phone's budget
// ---------------------------------------------------------------------------

describe('[#2254] the phone gets a shorter card, not a different one', () => {
  it('caps the frame’s height so it scrolls instead of eating the transcript', () => {
    // Issue #2106: the live region is `shrink-0`, so an uncapped card takes its
    // rows straight out of the transcript. The class is the cap.
    //
    // Issue #2326 moved a SELECTION LIST off this cap — see the case it added
    // below — so the state measured here is a pager, which keeps #2106's
    // budget exactly as this case pinned it.
    renderSurface({ isPagerActive: true }, { compact: true });
    expect(screen.getByTestId('chat-dialog-card-frame').className).toContain('max-h-32');
  });

  it('uses the taller cap on PC', () => {
    // Not a selection list: Issue #2309 raises the PC cap specifically for
    // selectionList (see the describe block below), so a pager stays at the
    // original default this test pins.
    renderSurface({ isPagerActive: true });
    expect(screen.getByTestId('chat-dialog-card-frame').className).toContain('max-h-64');
  });

  it('still shows the dialog’s last row at the phone’s row budget', () => {
    renderSurface({ isSelectionListActive: true }, { compact: true });
    expect(screen.getByTestId('chat-dialog-card-frame')).toHaveTextContent(FRAME_LAST_ROW);
  });
});

// ---------------------------------------------------------------------------
// (5) Issue #2309: a selection list is not given a tail at all
// ---------------------------------------------------------------------------

describe('[#2309] a selection list keeps everything, and gets room to show it', () => {
  it('keeps content the tail window would have cut, instead of dropping it', () => {
    // The exact row `[#2254] shows the dialog rows…` above proves is EXCLUDED
    // for a pager. For a selection list #2309 reverses that: a search-type
    // picker (command-code's 89-row `/model`, opencode's pickers) is content
    // the user needs, not padding around a short dialog, so nothing before the
    // dialog's own footer may be thrown away before the card can scroll to it.
    renderSurface({ isSelectionListActive: true });
    const frameEl = screen.getByTestId('chat-dialog-card-frame');
    expect(frameEl).toHaveTextContent('a-line-from-far-above-that-must-not-be-in-the-card');
    expect(frameEl).toHaveTextContent(FRAME_LAST_ROW);
  });

  it('raises the PC height cap so the extra content is real scrollable space', () => {
    // Issue #2326 replaced #2309's `max-h-[28rem]` with a viewport fraction:
    // 448px of an 800px split left the transcript about 60px once the banner
    // and the arrow pad were counted, which is no readable chat at all. The
    // cap still has to be a REAL cap — bigger than the 12–20 row card's and
    // small enough that the picker scrolls rather than pushing the transcript
    // out — which is what the two neighbours of this assertion check.
    renderSurface({ isSelectionListActive: true });
    const className = screen.getByTestId('chat-dialog-card-frame').className;
    expect(className).toContain('max-h-[35vh]');
    expect(className).not.toContain('max-h-[28rem]');
    expect(className).not.toContain('max-h-64');
  });

  it('gives the phone the same room, not #2106’s eight rows', () => {
    // Issue #2326: `max-h-32` is 128px, about eight rows, and a search-type
    // picker with a filter box and no number keys cannot be worked in eight
    // rows. #2106's vertical budget is conceded ONLY while a selection list is
    // up — the case above in "the phone's budget" holds the line for every
    // other state.
    renderSurface({ isSelectionListActive: true }, { compact: true });
    const className = screen.getByTestId('chat-dialog-card-frame').className;
    expect(className).toContain('max-h-[35vh]');
    expect(className).not.toContain('max-h-32');
  });

  it('does not raise the cap for the other three states, which are still tail-sliced', () => {
    for (const live of [{ isPagerActive: true }, { isUnclassifiedActive: true }]) {
      const { unmount } = renderSurface(live);
      expect(screen.getByTestId('chat-dialog-card-frame').className).toContain('max-h-64');
      unmount();
    }
  });
});
