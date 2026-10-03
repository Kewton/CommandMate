/**
 * What an image in a chat body resolves to (Issue #3120).
 *
 * The pure half of the fix: which sources are loaded through the files API and
 * which are only ever drawn as alt text + a link. The renderer's half is
 * tests/unit/components/worktree/ChatImage-3120.test.tsx.
 */

import { describe, expect, it } from 'vitest';
import {
  chatImageApiUrl,
  resolveChatImageSource,
  splitChatUserBody,
} from '@/lib/chat/chat-image';

const ROOT = '/Users/me/repo';

describe('resolveChatImageSource', () => {
  it.each([
    ['docs/a.png', 'docs/a.png'],
    ['./docs/a.PNG', 'docs/a.PNG'],
    [`${ROOT}/docs/a.png`, 'docs/a.png'],
    [`file://${ROOT}/docs/a.jpg`, 'docs/a.jpg'],
    ['docs/%E5%9B%B3.png', 'docs/図.png'],
  ])('loads %s from the worktree as %s', (src, path) => {
    expect(resolveChatImageSource(src, ROOT)).toEqual({ kind: 'worktree', path });
  });

  it('never loads a path outside the worktree', () => {
    expect(resolveChatImageSource('/Users/other/a.png', ROOT)).toEqual({
      kind: 'file',
      href: '/Users/other/a.png',
    });
  });

  it('never loads an absolute path when the worktree root is unknown', () => {
    expect(resolveChatImageSource(`${ROOT}/a.png`)).toEqual({ kind: 'file', href: `${ROOT}/a.png` });
  });

  it('never loads a non-image extension', () => {
    expect(resolveChatImageSource('docs/a.md', ROOT)).toEqual({ kind: 'file', href: 'docs/a.md' });
  });

  it.each(['https://example.com/a.png', 'http://example.com/a.png'])('links %s without loading', (src) => {
    expect(resolveChatImageSource(src, ROOT)).toEqual({ kind: 'external', href: src });
  });

  it.each(['javascript:alert(1)', 'data:image/png;base64,AAAA', 'vscode://x', '', undefined])(
    'has nothing usable for %s',
    (src) => {
      expect(resolveChatImageSource(src, ROOT)).toEqual({ kind: 'none' });
    },
  );
});

describe('chatImageApiUrl', () => {
  it('encodes each segment of the path', () => {
    expect(chatImageApiUrl('wt1', 'docs/a b.png')).toBe('/api/worktrees/wt1/files/docs/a%20b.png');
  });
});

describe('splitChatUserBody', () => {
  it('turns an attachment reference into an image part', () => {
    const content = `見て\n![](${ROOT}/.commandmate/attachments/1700000000-1.png)`;
    expect(splitChatUserBody(content, ROOT)).toEqual([
      { type: 'text', content: '見て\n' },
      {
        type: 'image',
        src: `${ROOT}/.commandmate/attachments/1700000000-1.png`,
        alt: '',
        path: '.commandmate/attachments/1700000000-1.png',
      },
    ]);
  });

  it('leaves every other image reference as text', () => {
    const content = `![図](docs/a.png) ![x](https://e.com/a.png) ![](/elsewhere/.commandmate/attachments/a.png)`;
    expect(splitChatUserBody(content, ROOT)).toEqual([{ type: 'text', content }]);
  });

  it('leaves an absolute attachment path as text when the root is unknown', () => {
    const content = `![](${ROOT}/.commandmate/attachments/a.png)`;
    expect(splitChatUserBody(content)).toEqual([{ type: 'text', content }]);
  });
});
