/**
 * Images in chat bodies are drawn through the files API (Issue #3120).
 *
 * fetch and IntersectionObserver are both replaced: the first so no server is
 * needed, the second so "not fetched until it scrolls into view" can be pinned
 * by holding the observer back.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ChatMarkdownBody, ChatMessageBubble } from '@/components/worktree/ChatMessageBubble';
import {
  CHAT_IMAGE_FALLBACK_TESTID,
  CHAT_IMAGE_LOADING_TESTID,
  CHAT_IMAGE_TESTID,
} from '@/components/worktree/ChatImage';
import { ChatImageScopeProvider, type ChatImageScope } from '@/lib/chat/chat-image';
import type { ChatMessage } from '@/types/models';

const ROOT = '/Users/me/repo';
const SCOPE: ChatImageScope = { worktreeId: 'wt1', worktreePath: ROOT };
const DATA_URI = 'data:image/png;base64,iVBORw0KGgo=';

// ---------------------------------------------------------------------------
// IntersectionObserver stand-in
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

/** Scroll everything observed so far into view. */
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

const mockFetch = vi.fn();

beforeEach(() => {
  observers = [];
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true, content: DATA_URI, isImage: true }) });
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderMarkdown(content: string, onFilePathClick = vi.fn(), scope: ChatImageScope = SCOPE) {
  render(
    <ChatImageScopeProvider value={scope}>
      <ChatMarkdownBody content={content} onFilePathClick={onFilePathClick} />
    </ChatImageScopeProvider>,
  );
  return onFilePathClick;
}

// ---------------------------------------------------------------------------
// Assistant bodies
// ---------------------------------------------------------------------------

describe('ChatMarkdownBody images', () => {
  it.each([
    ['a relative path', '![図](docs/a.png)'],
    ['an absolute path inside the worktree', `![図](${ROOT}/docs/a.png)`],
    ['a file:// URL', `![図](file://${ROOT}/docs/a.png)`],
  ])('loads %s through the files API once in view', async (_label, markdown) => {
    const onFilePathClick = renderMarkdown(markdown);

    // Held back until it scrolls into view.
    expect(screen.getByTestId(CHAT_IMAGE_LOADING_TESTID)).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();

    revealAll();
    await waitFor(() => expect(screen.getByRole('img', { name: '図' })).toHaveAttribute('src', DATA_URI));
    expect(mockFetch).toHaveBeenCalledWith('/api/worktrees/wt1/files/docs/a.png');

    const img = screen.getByRole('img', { name: '図' });
    expect(img).toHaveStyle({ maxHeight: '320px' });
    expect(img.className).toContain('max-w-full');

    fireEvent.click(screen.getByTestId(CHAT_IMAGE_TESTID));
    expect(onFilePathClick).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a path outside the worktree', '![外](/Users/other/a.png)', '/Users/other/a.png'],
    ['an https URL', '![外](https://example.com/a.png)', 'https://example.com/a.png'],
    ['an http URL', '![外](http://example.com/a.png)', 'http://example.com/a.png'],
  ])('draws %s as alt text and a link without loading it', (_label, markdown, shown) => {
    renderMarkdown(markdown);
    revealAll();

    const fallback = screen.getByTestId(CHAT_IMAGE_FALLBACK_TESTID);
    expect(fallback).toHaveTextContent('外');
    expect(screen.getByRole('link')).toHaveTextContent(shown);
    expect(screen.queryByRole('img')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('draws a javascript: image as alt text only, with nothing loaded', () => {
    renderMarkdown('![悪](javascript:alert(1))');
    revealAll();
    expect(screen.getByTestId(CHAT_IMAGE_FALLBACK_TESTID)).toHaveTextContent('悪');
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('falls back to alt text and the path link when the load fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
    renderMarkdown('![図](docs/missing.png)');
    revealAll();

    await waitFor(() => expect(screen.getByTestId(CHAT_IMAGE_FALLBACK_TESTID)).toBeInTheDocument());
    expect(screen.getByTestId(CHAT_IMAGE_FALLBACK_TESTID)).toHaveTextContent('図');
    expect(screen.getByRole('link')).toHaveTextContent('docs/missing.png');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('falls back when the fetch rejects', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    renderMarkdown('![図](docs/a.png)');
    revealAll();
    await waitFor(() => expect(screen.getByTestId(CHAT_IMAGE_FALLBACK_TESTID)).toBeInTheDocument());
  });

  it('loads nothing without a worktree scope', () => {
    renderMarkdown('![図](docs/a.png)', vi.fn(), {});
    revealAll();
    expect(screen.getByTestId(CHAT_IMAGE_FALLBACK_TESTID)).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches only the images that scrolled into view', async () => {
    renderMarkdown('![一](docs/1.png)\n\n![二](docs/2.png)');
    expect(observers.filter((o) => o.elements.length > 0)).toHaveLength(2);

    const first = observers[0];
    act(() => {
      first.callback(
        first.elements.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry),
        first as unknown as IntersectionObserver,
      );
    });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(mockFetch).toHaveBeenCalledWith('/api/worktrees/wt1/files/docs/1.png');
  });
});

// ---------------------------------------------------------------------------
// User bubbles
// ---------------------------------------------------------------------------

function userMessage(content: string): ChatMessage {
  return {
    id: 'u1',
    worktreeId: 'wt1',
    role: 'user',
    content,
    timestamp: new Date('2026-10-03T00:00:00Z'),
    messageType: 'normal',
    archived: false,
  };
}

function renderUser(content: string) {
  render(
    <ChatImageScopeProvider value={SCOPE}>
      <ChatMessageBubble message={userMessage(content)} showHeader onFilePathClick={vi.fn()} />
    </ChatImageScopeProvider>,
  );
}

describe('user bubble attachments', () => {
  it('draws an attachment reference as a shrunk image and keeps the text', async () => {
    renderUser(`この画面を見て\n![](${ROOT}/.commandmate/attachments/1700000000-1.png)`);

    expect(screen.getByText('この画面を見て', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(/!\[\]/)).toBeNull();

    revealAll();
    await waitFor(() => expect(screen.getByTestId(CHAT_IMAGE_TESTID)).toBeInTheDocument());
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/worktrees/wt1/files/.commandmate/attachments/1700000000-1.png',
    );
  });

  it('leaves any other image reference as text', () => {
    const content = '![図](docs/a.png) と ![x](https://example.com/a.png)';
    renderUser(content);
    revealAll();
    expect(screen.getByText(/!\[図\]\(/)).toBeInTheDocument();
    expect(screen.queryByTestId(CHAT_IMAGE_LOADING_TESTID)).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Dictionary
// ---------------------------------------------------------------------------

describe('i18n keys', () => {
  const load = (locale: string) =>
    JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../../../locales', locale, 'worktree.json'), 'utf-8'),
    ) as { conversation: Record<string, string> };

  it.each(['imageLoading', 'imageUnavailable', 'openImage'])('has conversation.%s in ja and en', (key) => {
    const ja = load('ja').conversation[key];
    const en = load('en').conversation[key];
    expect(typeof ja).toBe('string');
    expect(typeof en).toBe('string');
    expect(ja.length).toBeGreaterThan(0);
    expect(en.length).toBeGreaterThan(0);
  });

  it('keeps the {path} placeholder in both openImage strings', () => {
    expect(load('ja').conversation.openImage).toContain('{path}');
    expect(load('en').conversation.openImage).toContain('{path}');
  });
});
