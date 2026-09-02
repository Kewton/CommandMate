/**
 * The #1123 zero-measurement fallback, carried into the chat transcript
 * (Issue #2232).
 *
 * `@tanstack/react-virtual` decides how many rows to mount from the scroll
 * element's `offsetHeight`, and materializes ZERO of them while that is 0. Three
 * real situations report 0:
 *
 *   - the first render, before the layout effect has measured anything;
 *   - server rendering;
 *   - jsdom, which performs no layout at all — i.e. every test in this
 *     repository that renders a transcript.
 *
 * `HistoryPane` answers that with a bounded slice rendered in ordinary flow
 * (`HISTORY_FALLBACK_RENDER_COUNT`). Issue #2232 requires the same branch here,
 * and requires it to be a REGRESSION GUARD rather than a note: without it the
 * chat surface paints an empty box on first paint and every component test above
 * this one asserts against a transcript with no messages in it.
 *
 * The second half of the file drives the virtualized branch, because a fallback
 * that never hands over is just "virtualization turned off".
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import { ChatTranscript } from '@/components/worktree/ChatTranscript';
import {
  CHAT_ESTIMATED_MESSAGE_HEIGHT_PX,
  CHAT_FALLBACK_RENDER_COUNT,
  CHAT_VIRTUAL_OVERSCAN,
  shouldShowRoleHeader,
  splitFilePathParts,
} from '@/lib/chat/chat-transcript-view';
import { installVirtualLayout } from '@tests/helpers/virtual-layout';

const WORKTREE_ID = 'wt-2232-virtual';

function makeMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m-${i}`,
    worktreeId: WORKTREE_ID,
    role: (i % 2 === 0 ? 'user' : 'assistant') as ChatMessage['role'],
    content: `message body ${i}`,
    timestamp: new Date(Date.UTC(2026, 8, 2, 10, 0, i)),
    messageType: 'normal' as const,
    archived: false,
    cliToolId: 'claude' as const,
  }));
}

function renderTranscript(messages: ChatMessage[]) {
  return render(
    <ChatTranscript
      messages={messages}
      worktreeId={WORKTREE_ID}
      cliToolId="claude"
      onFilePathClick={vi.fn()}
    />,
  );
}

describe('[#2232] ChatTranscript zero-measurement fallback', () => {
  it('renders the leading messages in plain flow when nothing can be measured', () => {
    renderTranscript(makeMessages(5));

    expect(screen.getByTestId('chat-transcript-fallback-list')).toBeInTheDocument();
    expect(screen.getByText('message body 0')).toBeInTheDocument();
    expect(screen.getByText('message body 4')).toBeInTheDocument();
  });

  it('bounds the fallback so it never becomes "virtualization off"', () => {
    renderTranscript(makeMessages(CHAT_FALLBACK_RENDER_COUNT + 15));

    const rows = document.querySelectorAll('[data-testid="chat-message-row"]');
    expect(rows).toHaveLength(CHAT_FALLBACK_RENDER_COUNT);
    expect(screen.getByText(`message body ${CHAT_FALLBACK_RENDER_COUNT - 1}`)).toBeInTheDocument();
    expect(screen.queryByText(`message body ${CHAT_FALLBACK_RENDER_COUNT}`)).toBeNull();
  });

  it('keeps the fallback big enough to be worth having', () => {
    // A slice of 2 would technically satisfy "renders something".
    expect(CHAT_FALLBACK_RENDER_COUNT).toBeGreaterThanOrEqual(20);
    expect(CHAT_VIRTUAL_OVERSCAN).toBeGreaterThan(0);
    expect(CHAT_ESTIMATED_MESSAGE_HEIGHT_PX).toBeGreaterThan(0);
  });
});

describe('[#2232] ChatTranscript virtualized branch', () => {
  let restoreLayout: (() => void) | undefined;

  afterEach(() => {
    restoreLayout?.();
    restoreLayout = undefined;
  });

  it('hands over to the virtualizer the moment a viewport measures', () => {
    restoreLayout = installVirtualLayout({
      scrollContainerTestId: 'chat-transcript-scroll-container',
      viewportHeight: 600,
      rowHeight: 100,
    });
    renderTranscript(makeMessages(200));

    // The fallback is gone, a sizer reserves the full scroll height, and only a
    // window of rows is mounted.
    expect(screen.queryByTestId('chat-transcript-fallback-list')).toBeNull();
    const rows = document.querySelectorAll('[data-testid="chat-message-row"]');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(200);
    expect(screen.getByText('message body 0')).toBeInTheDocument();
  });

  it('measures each row instead of trusting the estimate', () => {
    restoreLayout = installVirtualLayout({
      scrollContainerTestId: 'chat-transcript-scroll-container',
      viewportHeight: 600,
      rowHeight: 100,
    });
    renderTranscript(makeMessages(50));

    // `measureElement` reads `data-index` off the row wrapper; without it a
    // variable-height transcript (a 7,000-character reply next to a one-line
    // one) mispositions everything below the first tall row.
    const positioned = document.querySelectorAll('[data-index]');
    expect(positioned.length).toBeGreaterThan(0);
    expect(positioned[0].getAttribute('data-index')).toBe('0');
  });
});

describe('[#2232] shouldShowRoleHeader', () => {
  it('labels the first row of the transcript', () => {
    const [first] = makeMessages(1);
    expect(shouldShowRoleHeader(undefined, first)).toBe(true);
  });

  it('labels a row whose role differs from the one above it', () => {
    const [user, assistant] = makeMessages(2);
    expect(shouldShowRoleHeader(user, assistant)).toBe(true);
  });

  it('omits the label on a continuation of the same role', () => {
    const messages = makeMessages(1);
    const continuation = { ...messages[0], id: 'm-0b' };
    expect(shouldShowRoleHeader(messages[0], continuation)).toBe(false);
  });
});

describe('[#2232] splitFilePathParts', () => {
  it('splits a body around the paths it can link', () => {
    expect(splitFilePathParts('see /a/b.ts now')).toEqual([
      { type: 'text', content: 'see ' },
      { type: 'path', content: '/a/b.ts' },
      { type: 'text', content: ' now' },
    ]);
  });

  it('returns one text part when there is nothing to link', () => {
    expect(splitFilePathParts('nothing here')).toEqual([{ type: 'text', content: 'nothing here' }]);
  });

  it('survives a row whose content is not a string', () => {
    // A whole transcript must not white-screen because one row arrived
    // malformed — the live region and the "open the terminal" banner go with it.
    expect(splitFilePathParts(undefined as unknown as string)).toEqual([
      { type: 'text', content: '' },
    ]);
  });
});
