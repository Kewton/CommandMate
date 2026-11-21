/**
 * A `file://` Markdown link in a reply survives the render pipeline (Issue #4501).
 *
 * Antigravity writes a file as `[post.md](file:///Users/…/post.md)`. `file:` is
 * one of the three shapes react-markdown's `defaultUrlTransform` and
 * rehype-sanitize's default schema both drop, so the href arrived at
 * `ChatFileLink` as nothing and the link was text a click could not act on
 * (measured on the shipped screen: 14 links, none of them an `<a>` with an href
 * or a handler).
 *
 * This pins the rendering half: the href the author wrote reaches the anchor,
 * the anchor is the in-app file link, and the click is intercepted before the
 * browser can try to navigate the CommandMate tab to a `file:` URL. What the
 * click then OPENS is the surface's own decision and is pinned in
 * `ChatTranscript-file-href-4501.test.tsx`.
 *
 * The negative controls are the schemes that must keep falling through:
 * `javascript:` / `data:` / `vbscript:` are never file links, and the image
 * `src` handling of #3120 is unchanged.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatMarkdownBody } from '@/components/worktree/ChatMessageBubble';
import { CHAT_FILE_LINK_TESTID } from '@/components/worktree/ChatMessageBubble';
import {
  CHAT_IMAGE_LOADING_TESTID,
  CHAT_IMAGE_TESTID,
} from '@/components/worktree/ChatImage';
import { ChatImageScopeProvider, type ChatImageScope } from '@/lib/chat/chat-image';

const ROOT = '/wt';
const SCOPE: ChatImageScope = { worktreeId: 'wt1', worktreePath: ROOT };
const DATA_URI = 'data:image/png;base64,iVBORw0KGgo=';

// ---------------------------------------------------------------------------
// IntersectionObserver stand-in (the image case below)
// ---------------------------------------------------------------------------

type Observed = { callback: IntersectionObserverCallback; elements: Element[] };
let observers: Observed[] = [];

class FakeIntersectionObserver {
  private record: Observed;
  constructor(callback: IntersectionObserverCallback) {
    this.record = { callback, elements: [] };
    observers.push(this.record);
  }
  observe(element: Element) {
    this.record.elements.push(element);
  }
  unobserve() {}
  disconnect() {
    this.record.elements = [];
  }
  takeRecords() {
    return [];
  }
}

function revealAll() {
  act(() => {
    for (const record of observers) {
      if (record.elements.length === 0) continue;
      record.callback(
        record.elements.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry),
        record as unknown as IntersectionObserver,
      );
    }
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  observers = [];
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, content: DATA_URI, isImage: true }),
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The anchor whose visible text is `label`. */
function anchorFor(label: string): HTMLAnchorElement | null {
  return screen.getByText(label).closest('a');
}

function renderBody(content: string, onFilePathClick = vi.fn()) {
  const view = render(
    <ChatImageScopeProvider value={SCOPE}>
      <ChatMarkdownBody content={content} onFilePathClick={onFilePathClick} />
    </ChatImageScopeProvider>,
  );
  return { ...view, onFilePathClick };
}

// ---------------------------------------------------------------------------
// The reported case
// ---------------------------------------------------------------------------

describe('[#4501] a file:// Markdown link reaches ChatFileLink with its href', () => {
  it('renders it as the in-app file link, keeping the author’s href', () => {
    renderBody('[post.md](file:///wt/docs/post.md)');

    const anchor = anchorFor('post.md');
    expect(anchor).not.toBeNull();
    expect(anchor).toHaveAttribute('data-testid', CHAT_FILE_LINK_TESTID);
    // `file:` used to be stripped here, which is the whole defect.
    expect(anchor).toHaveAttribute('href', 'file:///wt/docs/post.md');
  });

  it('stops the browser from acting on it and reports the href verbatim', () => {
    const { onFilePathClick } = renderBody('[post.md](file:///wt/docs/post.md)');

    const anchor = anchorFor('post.md') as HTMLAnchorElement;
    // `fireEvent` returns `dispatchEvent`'s verdict: false once preventDefault
    // has been called. jsdom does not navigate, so that is the only way a
    // missing handler would be visible at all.
    expect(fireEvent.click(anchor)).toBe(false);
    expect(onFilePathClick).toHaveBeenCalledWith('file:///wt/docs/post.md');
  });

  it('carries the `file://localhost/…` authority form too', () => {
    const { onFilePathClick } = renderBody('[l.md](file://localhost/wt/docs/l.md)');

    const anchor = anchorFor('l.md') as HTMLAnchorElement;
    expect(anchor).toHaveAttribute('href', 'file://localhost/wt/docs/l.md');
    expect(fireEvent.click(anchor)).toBe(false);
    expect(onFilePathClick).toHaveBeenCalledWith('file://localhost/wt/docs/l.md');
  });
});

// ---------------------------------------------------------------------------
// Negative controls — the schemes that must keep falling through
// ---------------------------------------------------------------------------

describe('[#4501] other schemes are still not file links', () => {
  it.each([
    ['javascript:', '[x](javascript:alert(1))', 'javascript:'],
    ['data:', '[x](data:text/html,<script>alert(1)</script>)', 'data:'],
    ['vbscript:', '[x](vbscript:msgbox(1))', 'vbscript:'],
  ])('drops the href of a %s link', (_label, markdown, scheme) => {
    const { onFilePathClick } = renderBody(markdown);

    expect(screen.queryByTestId(CHAT_FILE_LINK_TESTID)).toBeNull();
    const anchor = anchorFor('x');
    expect(anchor).not.toBeNull();
    // The sanitizer is what removes it; the point is that nothing here put it
    // back. An empty href is what react-markdown's transform leaves behind.
    expect(anchor?.getAttribute('href') ?? '').not.toMatch(new RegExp(`^${scheme}`));
    fireEvent.click(anchor as HTMLAnchorElement);
    expect(onFilePathClick).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Negative control — the image `src` handling of #3120 is unchanged
// ---------------------------------------------------------------------------

describe('[#4501] an in-worktree file:// image is still loaded through the files API', () => {
  it('keeps loading the image source as #3120 shipped it', async () => {
    renderBody(`![図](file://${ROOT}/docs/a.png)`);

    // Held back until it scrolls into view, exactly as before this Issue.
    expect(screen.getByTestId(CHAT_IMAGE_LOADING_TESTID)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    revealAll();
    await waitFor(() => expect(screen.getByRole('img', { name: '図' })).toHaveAttribute('src', DATA_URI));
    expect(fetchMock).toHaveBeenCalledWith('/api/worktrees/wt1/files/docs/a.png');
    expect(screen.getByTestId(CHAT_IMAGE_TESTID)).toBeInTheDocument();
  });

  it('still draws a javascript: image as alt text only', () => {
    renderBody('![悪](javascript:alert(1))');
    revealAll();

    expect(screen.queryByRole('img')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
