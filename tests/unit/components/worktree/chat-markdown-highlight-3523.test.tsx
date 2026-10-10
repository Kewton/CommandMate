/**
 * Search hits on a Markdown body land on the word searched for (Issue #3523).
 *
 * Hits are counted in the message as written; the highlighter counts the DOM
 * Markdown drew. Every marker Markdown does not draw (`**`, `` ` ``, a link's
 * `[..](..)`, a heading's `#`, a list's `- `) put the mark that many characters
 * later than the word. Both surfaces are rendered from their parents through
 * the real Markdown pipelines.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import { opencodeTurnRequestId } from '@/types/agent-transcript';
import { TURN_TOOL_LOG_LABEL } from '@/lib/hooks/sources/turn-body';

import { ChatTranscript } from '@/components/worktree/ChatTranscript';
import { HistoryPane } from '@/components/worktree/HistoryPane';
import { installVirtualLayout } from '@tests/helpers/virtual-layout';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-3523',
    worktreeId: 'wt-3523',
    role: 'assistant',
    content: '',
    timestamp: new Date(Date.UTC(2026, 9, 10, 10, 0, 0)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'opencode',
    requestId: opencodeTurnRequestId('msg_3523'),
    ...overrides,
  };
}

const USER = message({ id: 'u-1', role: 'user', content: 'explain', requestId: undefined });

class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

let registry: Map<string, FakeHighlight>;
let originalCSS: PropertyDescriptor | undefined;
let originalHighlight: PropertyDescriptor | undefined;
let restoreLayout: () => void;
let originalScroll: typeof Element.prototype.scrollIntoView;

beforeEach(() => {
  registry = new Map();
  originalCSS = Object.getOwnPropertyDescriptor(globalThis, 'CSS');
  originalHighlight = Object.getOwnPropertyDescriptor(globalThis, 'Highlight');
  Object.defineProperty(globalThis, 'CSS', {
    value: { highlights: registry, escape: (s: string) => s },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'Highlight', { value: FakeHighlight, configurable: true, writable: true });
  restoreLayout = installVirtualLayout();
  originalScroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function () {};
});

afterEach(() => {
  Element.prototype.scrollIntoView = originalScroll;
  restoreLayout();
  if (originalCSS) Object.defineProperty(globalThis, 'CSS', originalCSS);
  else delete (globalThis as { CSS?: unknown }).CSS;
  if (originalHighlight) Object.defineProperty(globalThis, 'Highlight', originalHighlight);
  else delete (globalThis as { Highlight?: unknown }).Highlight;
});

type Surface = 'ChatTranscript' | 'HistoryPane';
const SURFACES: Array<[Surface, string]> = [
  ['ChatTranscript', 'chat-search'],
  ['HistoryPane', 'history-search-2'],
];

function searchOn(surface: Surface, content: string, query: string): void {
  const messages = [USER, message({ content })];
  if (surface === 'ChatTranscript') {
    render(<ChatTranscript messages={messages} worktreeId="wt-3523" cliToolId="opencode" onFilePathClick={vi.fn()} />);
    fireEvent.click(screen.getByTestId('chat-transcript-search-toggle'));
    fireEvent.change(screen.getByLabelText('worktree.history.search.keywordLabel'), { target: { value: query } });
  } else {
    render(<HistoryPane messages={messages} worktreeId="wt-3523" onFilePathClick={vi.fn()} splitIndex={2} />);
    fireEvent.click(screen.getByRole('button', { name: /search/i }));
    fireEvent.change(screen.getByLabelText(/keyword/i), { target: { value: query } });
  }
}

/** Text of every marked range: the non-current ones, then the current one (overlay). */
function markedTexts(name: string): string[] {
  return (registry.get(name)?.ranges ?? []).map((range) => range.toString());
}

// Each hit appears twice so one is non-current (registered in CSS.highlights).
const CASES: Array<[string, string, string]> = [
  ['bold', '**Bold** sentinel here\n\n**Bold** sentinel again', 'sentinel'],
  ['inline code', 'Run `npm test` then sentinel\n\nRun `npm test` then sentinel', 'sentinel'],
  ['a link', 'See [docs](https://example.com/x) sentinel\n\nSee [docs](https://example.com/x) sentinel', 'sentinel'],
  ['a heading', '## Title sentinel\n\n## Title sentinel', 'sentinel'],
  ['a list', '- one sentinel\n- two sentinel', 'sentinel'],
  ['a word inside bold', 'Intro **sentinel** and\n\nIntro **sentinel** and', 'sentinel'],
  ['a code block', '```js\nconst sentinel = 1;\n```\n\nThen **x** sentinel', 'sentinel'],
  ['a quote with an escape and a continuation line', '> quoted \\*star\\* sentinel\n> next sentinel', 'sentinel'],
  ['a table', '| a | b |\n|---|---|\n| **x** sentinel | y |\n\nsentinel', 'sentinel'],
  ['a bare URL', 'Open https://example.com/a now\n\n**Then** sentinel and sentinel', 'sentinel'],
  // Offsets are UTF-16 units: an emoji is two of them.
  ['an emoji before the word', '**Bold** 😀 sentinel\n\n**Bold** 😀 sentinel', 'sentinel'],
  // Chat draws a link to a video in this worktree as the video with the link
  // under it, and an image as the image; History draws the link / alt text.
  ['a link to a video', 'See [clip](clip.mp4) sentinel\n\nSee [clip](clip.mp4) sentinel', 'sentinel'],
  ['a link to a video, hit in its label', 'See [sentinel clip](clip.mp4) now\n\nSee [sentinel clip](clip.mp4) now', 'sentinel'],
  ['an image', 'See ![shot](shot.png) sentinel\n\nSee ![shot](shot.png) sentinel', 'sentinel'],
  ['an image as a video', 'See ![clip](clip.mp4) sentinel\n\nSee ![clip](clip.mp4) sentinel', 'sentinel'],
];

describe.each(SURFACES)('[#3523] %s: hits after Markdown markers land on the word', (surface, name) => {
  it.each(CASES)('%s', async (_label, content, query) => {
    searchOn(surface, content, query);
    await waitFor(() => {
      const marked = markedTexts(name);
      expect(marked).toHaveLength(1);
      expect(marked[0]).toBe(query);
    });
  });
});

describe.each(SURFACES)('[#3523] %s: plain text', (surface, name) => {
  // Negative control: one paragraph, no markers — raw and DOM offsets agree,
  // and the mark is where it always was.
  it('one paragraph without markers is marked as before', async () => {
    searchOn(surface, 'plain sentinel line, sentinel again', 'sentinel');
    await waitFor(() => {
      expect(markedTexts(name)).toEqual(['sentinel']);
    });
  });

  // A blank line between paragraphs is two raw characters and one DOM one.
  it('a hit in the second paragraph lands on the word', async () => {
    searchOn(surface, 'plain sentinel line\n\nplain sentinel line', 'sentinel');
    await waitFor(() => {
      expect(markedTexts(name)).toEqual(['sentinel']);
    });
  });
});

// Chat folds the reasoning quote and the tool log out of the answer and draws
// them under chips, after it; History draws the message as written.
const FOLDED = [
  '> **Thinking**',
  '>',
  '> Weighing **the** sentinel',
  '> and more',
  '',
  'The **answer** sentinel.',
  '',
  `> **${TURN_TOOL_LOG_LABEL} (1)**`,
  '>',
  '> - `Read` — sentinel.md',
].join('\n');

describe.each(SURFACES)('[#3523] %s: reasoning and tool log', (surface, name) => {
  it('every non-current hit lands on its word', async () => {
    searchOn(surface, FOLDED, 'sentinel');
    await waitFor(() => {
      const marked = markedTexts(name);
      expect(marked).toHaveLength(2);
      expect(marked).toEqual(['sentinel', 'sentinel']);
    });
  });
});

// The cases above are only about the video when chat really drew one.
describe('[#3523] ChatTranscript draws the link to a video as a video', () => {
  it('the video is on screen with its link under it', async () => {
    searchOn('ChatTranscript', 'See [clip](clip.mp4) sentinel', 'sentinel');
    await waitFor(() => expect(screen.getByTestId('chat-video')).toBeTruthy());
  });
});
