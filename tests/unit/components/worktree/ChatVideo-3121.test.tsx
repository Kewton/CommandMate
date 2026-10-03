/**
 * Videos in chat bodies are embedded from the files API's `?raw=1` (Issue #3121).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { ChatMarkdownBody } from '@/components/worktree/ChatMessageBubble';
import { CHAT_VIDEO_TESTID } from '@/components/worktree/ChatVideo';
import { CHAT_IMAGE_FALLBACK_TESTID } from '@/components/worktree/ChatImage';
import { ChatImageScopeProvider, type ChatImageScope } from '@/lib/chat/chat-image';
import { chatVideoRawUrl, resolveChatVideoPath } from '@/lib/chat/chat-video';

const ROOT = '/Users/me/repo';
const SCOPE: ChatImageScope = { worktreeId: 'wt1', worktreePath: ROOT };

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderMarkdown(content: string, onFilePathClick = vi.fn(), scope: ChatImageScope = SCOPE) {
  const { container } = render(
    <ChatImageScopeProvider value={scope}>
      <ChatMarkdownBody content={content} onFilePathClick={onFilePathClick} />
    </ChatImageScopeProvider>,
  );
  return { onFilePathClick, container };
}

describe('resolveChatVideoPath', () => {
  it.each([
    ['demo/clip.mp4', 'demo/clip.mp4'],
    [`${ROOT}/demo/clip.mp4`, 'demo/clip.mp4'],
    [`file://${ROOT}/demo/clip.MP4`, 'demo/clip.MP4'],
  ])('resolves %s', (target, expected) => {
    expect(resolveChatVideoPath(target, ROOT)).toBe(expected);
  });

  it.each([
    '/Users/other/clip.mp4',
    'https://example.com/clip.mp4',
    'demo/a.png',
    'javascript:alert(1)',
    '',
    undefined,
  ])('does not resolve %s', (target) => {
    expect(resolveChatVideoPath(target, ROOT)).toBeNull();
  });

  it('builds the raw URL', () => {
    expect(chatVideoRawUrl('wt1', 'demo/my clip.mp4')).toBe('/api/worktrees/wt1/files/demo/my%20clip.mp4?raw=1');
  });
});

describe('ChatMarkdownBody videos', () => {
  it.each([
    ['an image reference', '![デモ](demo/clip.mp4)', 'デモ'],
    ['an absolute image reference', `![デモ](${ROOT}/demo/clip.mp4)`, 'デモ'],
    ['a link', '[デモ動画](demo/clip.mp4)', 'デモ動画'],
  ])('embeds %s as <video controls preload="none">', (_label, markdown, linkText) => {
    const { onFilePathClick } = renderMarkdown(markdown);

    const video = screen.getByTestId(CHAT_VIDEO_TESTID);
    expect(video.tagName).toBe('VIDEO');
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveAttribute('preload', 'none');
    expect(video).toHaveAttribute('src', '/api/worktrees/wt1/files/demo/clip.mp4?raw=1');
    expect(video.className).toContain('w-full');
    expect(video).toHaveStyle({ maxHeight: '360px' });
    // Nothing fetched by the component itself.
    expect(mockFetch).not.toHaveBeenCalled();

    // The label stays under the video as the file link.
    const link = screen.getByRole('link');
    expect(link).toHaveTextContent(linkText);
    fireEvent.click(link);
    expect(onFilePathClick).toHaveBeenCalledTimes(1);
  });

  it('falls back to the link when the video fails to load', () => {
    renderMarkdown('[デモ動画](demo/clip.mp4)');
    fireEvent.error(screen.getByTestId(CHAT_VIDEO_TESTID));
    expect(screen.queryByTestId(CHAT_VIDEO_TESTID)).toBeNull();
    expect(screen.getByRole('link')).toHaveTextContent('デモ動画');
  });

  it.each([
    ['a link outside the worktree', '[外](/Users/other/clip.mp4)'],
    ['an external link', '[外](https://example.com/clip.mp4)'],
    ['an image outside the worktree', '![外](/Users/other/clip.mp4)'],
    ['an external image', '![外](https://example.com/clip.mp4)'],
  ])('does not embed %s', (_label, markdown) => {
    const { container } = renderMarkdown(markdown);
    expect(screen.queryByTestId(CHAT_VIDEO_TESTID)).toBeNull();
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByRole('link')).toBeInTheDocument();
  });

  it('draws an out-of-worktree video image as the image fallback', () => {
    renderMarkdown('![外](/Users/other/clip.mp4)');
    expect(screen.getByTestId(CHAT_IMAGE_FALLBACK_TESTID)).toHaveTextContent('外');
  });

  it('does not embed without a worktree scope', () => {
    const { container } = renderMarkdown('[デモ](demo/clip.mp4)', vi.fn(), {});
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByRole('link')).toHaveTextContent('デモ');
  });

  it('leaves a link to a non-video file a plain link', () => {
    const { container } = renderMarkdown('[メモ](docs/a.md)');
    expect(container.querySelector('video')).toBeNull();
  });
});

describe('locales', () => {
  const load = (lang: string) =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'locales', lang, 'worktree.json'), 'utf-8')) as {
      conversation: Record<string, string>;
    };

  it('has conversation.videoLabel with {path} in ja and en', () => {
    expect(load('ja').conversation.videoLabel).toContain('{path}');
    expect(load('en').conversation.videoLabel).toContain('{path}');
  });
});
