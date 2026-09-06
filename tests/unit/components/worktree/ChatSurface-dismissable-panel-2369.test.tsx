/**
 * One key for a one-key panel (Issue #2369).
 *
 * Command Code's `/usage` opens a read-only overlay whose last row is
 * `Press Esc to close`. Nothing on it moves and nothing commits — and the chat
 * surface answered it with `TerminalEscapeHatch` (◀ ▲ ▼ ▶ ↵ Esc) plus
 * `PromptAnswerKeys` (`1`–`9` `y` `n` ↵): eighteen buttons, seventeen of which
 * do nothing to the panel and several of which are characters queued for
 * whatever takes focus once it closes.
 *
 * ## What is asserted, and what would be vacuous
 *
 * Two halves, and the second is the one that keeps this honest:
 *
 *  - **the panel gets the Esc button and neither full pad.** Asserted by the
 *    ABSENCE of `terminal-escape-hatch`'s keys and of `prompt-answer-keys`, not
 *    only by the presence of the new one — a card that drew all three would pass
 *    a presence-only test;
 *  - **an `unclassified` frame is untouched.** Issue #2369's acceptance list
 *    calls this out by name: a screen that stays unclassified must still get the
 *    arrows and the answer keys. A regression here is the whole cost of getting
 *    the new branch's ordering wrong.
 *
 * `ChatTranscript` is stubbed (a layout-less DOM cannot give the real one scroll
 * metrics); everything below it is the real implementation, and `fetch` is the
 * seam every claim about a key lands on.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: ({ messages }: { messages: Array<{ id: string }> }) => (
    <div data-testid="chat-transcript" data-message-count={String(messages.length)}>
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

import {
  ChatSurface,
  resolveBlockedReason,
  type ChatSurfaceLiveState,
} from '@/components/worktree/ChatSurface';
import { DISMISS_KEY, PROMPT_ANSWER_KEYS } from '@/components/worktree/PromptAnswerKeys';

const WORKTREE_ID = 'wt-2369';
const ESC = '\x1b';
const ST = `${ESC}\\`;

/** The `/usage` panel as Issue #2369 records it, OSC 8 breakdown link included. */
const USAGE_PANEL = [
  '> what is my usage',
  '',
  '  ✻ Worked for 4s',
  '',
  ' USAGE  Go Plan · active',
  '█░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 4% used',
  'Cycle: $9.61 left · 259 requests · 26 days to renewal',
  'Usage limits',
  '5-hour  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 0%',
  'Weekly  ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 7% · resets in 2d 23h',
  `Full breakdown at ${ESC}]8;;https://commandcode.ai/Kewton/settings/usage${ST}` +
    `commandcode.ai/Kewton/settings/usage${ESC}]8;;${ST}`,
  'Press Esc to close',
].join('\n');

/** An overlay nobody measured: no dismiss footer, no picker footer, no options. */
const UNCLASSIFIED_OVERLAY = [
  '  Keyboard shortcuts',
  '',
  '  ctrl+o   expand the last tool call',
  '  ctrl+r   search the transcript',
  '',
  '  Basics      Advanced      About',
].join('\n');

const PANEL_LIVE: ChatSurfaceLiveState = {
  isRunning: true,
  sessionStatus: 'waiting',
  isThinking: false,
  isPromptWaiting: false,
  promptData: null,
  isSelectionListActive: false,
  isPagerActive: false,
  isDismissablePanelActive: true,
  isUnclassifiedActive: false,
};

const UNCLASSIFIED_LIVE: ChatSurfaceLiveState = {
  isRunning: true,
  sessionStatus: 'running',
  isThinking: false,
  isPromptWaiting: false,
  promptData: null,
  isSelectionListActive: false,
  isPagerActive: false,
  isDismissablePanelActive: false,
  isUnclassifiedActive: true,
};

function msg(id: string, role: ChatMessage['role']): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content: `content-${id}`,
    timestamp: new Date('2026-09-07T10:00:00Z'),
    messageType: 'normal',
    archived: false,
    cliToolId: 'command-code',
  };
}

function renderSurface(
  options: {
    frame?: string;
    cliToolId?: CLIToolType;
    instanceId?: string;
    live?: Partial<ChatSurfaceLiveState>;
  } = {},
) {
  return render(
    <ChatSurface
      messages={[msg('u1', 'user'), msg('a1', 'assistant')]}
      worktreeId={WORKTREE_ID}
      cliToolId={options.cliToolId ?? 'command-code'}
      instanceId={options.instanceId}
      live={{ ...PANEL_LIVE, ...options.live }}
      onSurfaceModeChange={vi.fn()}
      frame={options.frame ?? USAGE_PANEL}
    />,
  );
}

/** The card's action row, the only place these controls may appear. */
function actions(): HTMLElement {
  return screen.getByTestId('chat-dialog-card-actions');
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

// ===========================================================================
// A. The reason
// ===========================================================================

describe('[#2369] A. resolveBlockedReason', () => {
  it('answers dismissablePanel for the flag', () => {
    expect(resolveBlockedReason(PANEL_LIVE)).toBe('dismissablePanel');
  });

  it('still answers unclassified when only that flag is up', () => {
    expect(resolveBlockedReason(UNCLASSIFIED_LIVE)).toBe('unclassified');
  });

  it('lets a selection list keep its own reason', () => {
    // A screen with a highlight AND a dismiss is a selection list whose Esc is
    // one of its keys; it must not lose its arrows to this Issue.
    expect(
      resolveBlockedReason({
        ...PANEL_LIVE,
        isSelectionListActive: true,
      }),
    ).toBe('selectionList');
  });

  it('reads the frame when the flag is absent, and obeys it when it is false', () => {
    // The pane components that build this object (`TerminalSplitPaneContent`,
    // `MobileTerminalTab`) copy the live fields across one by one and do not yet
    // copy this one, so `undefined` is what the surface actually receives today.
    const { isDismissablePanelActive: _omitted, ...withoutFlag } = PANEL_LIVE;
    expect(resolveBlockedReason(withoutFlag, USAGE_PANEL)).toBe('dismissablePanel');

    // An explicit `false` from a server that knows the field is an answer, and
    // outranks the frame.
    expect(
      resolveBlockedReason({ ...withoutFlag, isDismissablePanelActive: false }, USAGE_PANEL),
    ).toBeNull();
  });

  it('does not read a dismiss footer into an unclassified overlay', () => {
    const { isDismissablePanelActive: _omitted, ...withoutFlag } = UNCLASSIFIED_LIVE;
    expect(resolveBlockedReason(withoutFlag, UNCLASSIFIED_OVERLAY)).toBe('unclassified');
  });
});

// ===========================================================================
// B. The card
// ===========================================================================

describe('[#2369] B. the panel gets one button and neither full pad', () => {
  it('draws the Esc button', () => {
    renderSurface();

    expect(within(actions()).getByTestId('dismiss-panel-keys')).toBeInTheDocument();
  });

  it('draws NEITHER the answer keys NOR the navigation hatch', () => {
    renderSurface();

    expect(screen.queryByTestId('prompt-answer-keys')).toBeNull();
    // The hatch has no testid of its own; its keys do not exist either way.
    for (const label of ['Send Left', 'Send Up', 'Send Down', 'Send Right', 'Send Enter']) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
    for (const key of PROMPT_ANSWER_KEYS) {
      expect(screen.queryByTestId(`prompt-answer-key-${key}`)).toBeNull();
    }
  });

  it('sends exactly Escape when it is pressed', () => {
    renderSurface();

    fireEvent.click(screen.getByTestId(`dismiss-panel-key-${DISMISS_KEY}`));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/worktrees/${WORKTREE_ID}/special-keys`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      cliToolId: 'command-code',
      keys: ['Escape'],
    });
  });

  it('names a non-primary instance the way every other strip does (#869)', () => {
    renderSurface({ instanceId: 'command-code-2' });

    fireEvent.click(screen.getByTestId(`dismiss-panel-key-${DISMISS_KEY}`));

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      cliToolId: 'command-code',
      keys: ['Escape'],
      instanceId: 'command-code-2',
    });
  });

  it('shows the panel itself in the card, with the OSC 8 link reduced to its label', () => {
    renderSurface();

    const card = screen.getByTestId('chat-dialog-card');
    expect(card.textContent).toContain('Press Esc to close');
    expect(card.textContent).toContain('commandcode.ai/Kewton/settings/usage');
    // Issue #2369's third symptom: the hyperlink's own escape leaking as text.
    expect(card.textContent).not.toContain(']8;;');
  });
});

// ===========================================================================
// C. The regression the acceptance list names
// ===========================================================================

describe('[#2369] C. an unclassified frame keeps both pads', () => {
  it('still draws the arrows and the answer keys', () => {
    renderSurface({ live: UNCLASSIFIED_LIVE, frame: UNCLASSIFIED_OVERLAY });

    const row = actions();
    expect(within(row).getByTestId('prompt-answer-keys')).toBeInTheDocument();
    expect(within(row).getByLabelText('Send Left')).toBeInTheDocument();
    expect(within(row).getByLabelText('Send Escape')).toBeInTheDocument();
    expect(screen.queryByTestId('dismiss-panel-keys')).toBeNull();
  });
});
