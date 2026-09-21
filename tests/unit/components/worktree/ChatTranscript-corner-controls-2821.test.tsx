/**
 * The transcript's top-right corner, and the shared tool-activity answer (Issue #2821).
 *
 * On the phone, `MobileTerminalTab` floats its surface pill over the exact
 * corner where this component draws its two 28px icons (the tool-activity
 * toggle and the search toggle), so neither could be seen or pressed. The phone
 * mount now passes `hideCornerControls` and the pill carries the tool-activity
 * toggle itself. What this file pins on the transcript's side:
 *
 *  1. the default is unchanged — the PC still gets both icons;
 *  2. `hideCornerControls` draws neither icon, and the column still publishes
 *     `data-tool-activity` and still follows the shared answer;
 *  3. two transcripts side by side (the PC split) move together;
 *  4. the search BAR is not gated by the prop: while search is open it is drawn
 *     whatever the prop says. Issue #2823 opens search on the phone from outside
 *     this component and relies on exactly that.
 *
 * jsdom performs no layout, so #1123's fallback list is what renders here.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import {
  ChatTranscript,
  CHAT_TRANSCRIPT_TOOL_ACTIVITY_TESTID,
} from '@/components/worktree/ChatTranscript';
import { CHAT_TOOL_LOG_TOGGLE_TESTID } from '@/components/worktree/ChatMessageBubble';
import { CHAT_TOOL_ACTIVITY_STORAGE_KEY } from '@/lib/chat/chat-tool-activity';
import { separateTurnBody } from '@/lib/hooks/sources/turn-body';

const WORKTREE_ID = 'wt-2821';
const SEARCH_TOGGLE_TESTID = 'chat-transcript-search-toggle';
/** The next-intl stub echoes keys, so the search input's label is its key. */
const SEARCH_INPUT_LABEL = 'worktree.history.search.keywordLabel';
const SEARCH_CLOSE_LABEL = 'worktree.history.search.close';

/** A claude turn that answered and called two tools: one folded tool chip. */
const TURN_BODY = separateTurnBody([
  { kind: 'prose', text: 'Created `probe.txt`.' },
  { kind: 'tool', text: '- `Bash` — ls' },
  { kind: 'tool', text: '- `apply_patch` — probe.txt' },
]).body;

const MESSAGES: ChatMessage[] = [
  {
    id: 'a1',
    worktreeId: WORKTREE_ID,
    role: 'assistant',
    content: TURN_BODY,
    timestamp: new Date(Date.UTC(2026, 8, 21, 10, 0, 0)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
    // A `claude-turn:` request id puts the row on the Markdown path, where the
    // tool section is folded (Issue #2041 / #2284).
    requestId: 'claude-turn:u-1a1',
  },
];

function transcript(props: Partial<React.ComponentProps<typeof ChatTranscript>> = {}) {
  return (
    <ChatTranscript
      messages={MESSAGES}
      worktreeId={WORKTREE_ID}
      cliToolId="claude"
      onFilePathClick={vi.fn()}
      {...props}
    />
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('[#2821] the corner icons', () => {
  it('are both drawn by default (the PC keeps them)', () => {
    render(transcript());

    expect(screen.getByTestId(CHAT_TRANSCRIPT_TOOL_ACTIVITY_TESTID)).toBeInTheDocument();
    expect(screen.getByTestId(SEARCH_TOGGLE_TESTID)).toBeInTheDocument();
  });

  it('are both withdrawn with hideCornerControls, and the column still says where it stands', () => {
    render(transcript({ hideCornerControls: true }));

    expect(screen.queryByTestId(CHAT_TRANSCRIPT_TOOL_ACTIVITY_TESTID)).toBeNull();
    expect(screen.queryByTestId(SEARCH_TOGGLE_TESTID)).toBeNull();
    expect(screen.queryByLabelText(SEARCH_INPUT_LABEL)).toBeNull();
    expect(screen.getByTestId('chat-transcript')).toHaveAttribute('data-tool-activity', 'folded');
  });

  it('starts a hidden-icon transcript from the stored answer', () => {
    window.localStorage.setItem(CHAT_TOOL_ACTIVITY_STORAGE_KEY, 'true');
    render(transcript({ hideCornerControls: true }));

    expect(screen.getByTestId('chat-transcript')).toHaveAttribute('data-tool-activity', 'shown');
    expect(screen.getByTestId(CHAT_TOOL_LOG_TOGGLE_TESTID)).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});

describe('[#2821] one answer for every transcript on the page', () => {
  it('moves a hidden-icon transcript when another control toggles', () => {
    render(
      <>
        <div data-testid="with-icons">{transcript({ splitIndex: 0 })}</div>
        <div data-testid="without-icons">
          {transcript({ splitIndex: 1, hideCornerControls: true })}
        </div>
      </>,
    );
    const hidden = within(screen.getByTestId('without-icons'));
    expect(hidden.getByTestId('chat-transcript')).toHaveAttribute('data-tool-activity', 'folded');

    fireEvent.click(
      within(screen.getByTestId('with-icons')).getByTestId(CHAT_TRANSCRIPT_TOOL_ACTIVITY_TESTID),
    );

    expect(hidden.getByTestId('chat-transcript')).toHaveAttribute('data-tool-activity', 'shown');
    expect(hidden.getByTestId(CHAT_TOOL_LOG_TOGGLE_TESTID)).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('keeps two side-by-side transcripts in step, whichever one is pressed', () => {
    render(
      <>
        <div data-testid="split-0">{transcript({ splitIndex: 0 })}</div>
        <div data-testid="split-1">{transcript({ splitIndex: 1 })}</div>
      </>,
    );
    const left = within(screen.getByTestId('split-0'));
    const right = within(screen.getByTestId('split-1'));

    fireEvent.click(left.getByTestId(CHAT_TRANSCRIPT_TOOL_ACTIVITY_TESTID));

    for (const pane of [left, right]) {
      expect(pane.getByTestId('chat-transcript')).toHaveAttribute('data-tool-activity', 'shown');
      expect(pane.getByTestId(CHAT_TRANSCRIPT_TOOL_ACTIVITY_TESTID)).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    }
    expect(window.localStorage.getItem(CHAT_TOOL_ACTIVITY_STORAGE_KEY)).toBe('true');

    fireEvent.click(right.getByTestId(CHAT_TRANSCRIPT_TOOL_ACTIVITY_TESTID));

    for (const pane of [left, right]) {
      expect(pane.getByTestId('chat-transcript')).toHaveAttribute('data-tool-activity', 'folded');
      expect(pane.getByTestId(CHAT_TRANSCRIPT_TOOL_ACTIVITY_TESTID)).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    }
    expect(window.localStorage.getItem(CHAT_TOOL_ACTIVITY_STORAGE_KEY)).toBe('false');
  });
});

describe('[#2821] the search bar is not gated by hideCornerControls', () => {
  it('stays on screen while search is open, and no icon comes back when it closes', () => {
    const { rerender } = render(transcript());
    fireEvent.click(screen.getByTestId(SEARCH_TOGGLE_TESTID));
    expect(screen.getByLabelText(SEARCH_INPUT_LABEL)).toBeInTheDocument();

    rerender(transcript({ hideCornerControls: true }));

    expect(screen.getByLabelText(SEARCH_INPUT_LABEL)).toBeInTheDocument();
    expect(screen.queryByTestId(CHAT_TRANSCRIPT_TOOL_ACTIVITY_TESTID)).toBeNull();

    fireEvent.click(screen.getByLabelText(SEARCH_CLOSE_LABEL));

    expect(screen.queryByLabelText(SEARCH_INPUT_LABEL)).toBeNull();
    expect(screen.queryByTestId(SEARCH_TOGGLE_TESTID)).toBeNull();
    expect(screen.queryByTestId(CHAT_TRANSCRIPT_TOOL_ACTIVITY_TESTID)).toBeNull();
  });
});
