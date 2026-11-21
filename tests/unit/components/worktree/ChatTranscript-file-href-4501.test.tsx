/**
 * A `file://` file link in a chat reply opens the file panel (Issue #4501).
 *
 * `ChatMessageBubble-file-href-4501.test.tsx` pins the rendering half: the href
 * reaches the anchor and the click is intercepted. This pins the other half —
 * the click the surface actually receives, from the parent the reader touches —
 * for the one shape Antigravity writes, `[post.md](file:///…/post.md)`.
 *
 * Scope of this file: the parts of #4501 that are settled — `file:` reaching
 * the handler, and macOS's `/tmp` / `/private/tmp` being one root. The
 * outside-worktree wording (やること 2) is decided separately and is NOT
 * asserted here.
 *
 * Both surfaces are asked the same questions, for the reason
 * `ChatFileLink-2345` gives: History and chat render the same bodies, and a
 * rule that lives in one copy per surface is wrong in one of them.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import { ChatTranscript } from '@/components/worktree/ChatTranscript';
import { HistoryPane } from '@/components/worktree/HistoryPane';
import { CHAT_FILE_LINK_TESTID } from '@/components/worktree/ChatMessageBubble';

const copyToClipboardMock = vi.fn(async (_text: string) => {});
vi.mock('@/lib/clipboard-utils', () => ({
  copyToClipboard: (text: string) => copyToClipboardMock(text),
}));

const WORKTREE_ID = 'wt-4501';
const WORKTREE_PATH = '/wt';
const T0 = Date.UTC(2026, 10, 19, 9, 0, 0);

/** The file Antigravity names, exactly as it writes it. */
const DOC_HREF = `file://${WORKTREE_PATH}/docs/post.md`;
const DOC_REL = 'docs/post.md';

function msg(id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role: 'assistant',
    content,
    timestamp: new Date(T0),
    messageType: 'normal',
    archived: false,
    cliToolId: 'antigravity',
    // #2041: only a row carrying a requestId is parsed as Markdown.
    requestId: 'antigravity-turn:m1',
    ...extra,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal('fetch', fetchMock);
  copyToClipboardMock.mockReset();
  copyToClipboardMock.mockImplementation(async () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The anchor whose visible text is `label`. */
function link(label: string): HTMLAnchorElement {
  return screen.getByText(label).closest('a') as HTMLAnchorElement;
}

// ---------------------------------------------------------------------------
// The chat surface
// ---------------------------------------------------------------------------

describe('[#4501] a file:// link in a chat reply opens the file panel', () => {
  function renderTranscript(props: Record<string, unknown> = {}) {
    return render(
      <ChatTranscript
        messages={[msg('a1', `[post.md](${DOC_HREF}) にまとめた。`)]}
        worktreeId={WORKTREE_ID}
        worktreePath={WORKTREE_PATH}
        cliToolId="antigravity"
        onFilePathClick={vi.fn()}
        {...props}
      />,
    );
  }

  it('is drawn as the in-app file link, and the click opens the relative path', async () => {
    const onFilePathClick = vi.fn();
    renderTranscript({ onFilePathClick });

    const anchor = link('post.md');
    expect(anchor).toHaveAttribute('data-testid', CHAT_FILE_LINK_TESTID);
    // The browser must not act on a `file:` href: the surface does.
    expect(fireEvent.click(anchor)).toBe(false);

    await waitFor(() => expect(onFilePathClick).toHaveBeenCalledWith(DOC_REL));
    // And it asked the file API about the path the panel would GET, not `files//`.
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe(`/api/worktrees/${WORKTREE_ID}/files/${DOC_REL}`);
  });

  it('says the file is missing, and opens nothing, for a file inside this worktree', async () => {
    // Unchanged by this Issue: a definite "no" from the probe still ends in the
    // #2274 toast. Only a path OUTSIDE the worktree gets a different one, and
    // that is decided elsewhere.
    const onFilePathClick = vi.fn();
    const showToast = vi.fn();
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    renderTranscript({ onFilePathClick, showToast });

    expect(fireEvent.click(link('post.md'))).toBe(false);

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('worktree.conversation.filePathMissing', 'error'),
    );
    expect(onFilePathClick).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(`/api/worktrees/${WORKTREE_ID}/files/${DOC_REL}`, {
      method: 'HEAD',
      cache: 'no-store',
    });
  });

  it('keeps an external URL a new tab and an anchor in this tab', () => {
    render(
      <ChatTranscript
        messages={[msg('a1', '[site](https://example.com/x) [節](#s-2)')]}
        worktreeId={WORKTREE_ID}
        worktreePath={WORKTREE_PATH}
        cliToolId="antigravity"
        onFilePathClick={vi.fn()}
      />,
    );

    const external = link('site');
    expect(external).toHaveAttribute('target', '_blank');
    expect(external).not.toHaveAttribute('data-testid', CHAT_FILE_LINK_TESTID);

    const anchor = link('節');
    expect(anchor).toHaveAttribute('href', '#s-2');
    expect(fireEvent.click(anchor)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not turn a javascript: destination into a file link', () => {
    render(
      <ChatTranscript
        messages={[msg('a1', '[x](javascript:alert(1))')]}
        worktreeId={WORKTREE_ID}
        worktreePath={WORKTREE_PATH}
        cliToolId="antigravity"
        onFilePathClick={vi.fn()}
      />,
    );

    expect(screen.queryByTestId(CHAT_FILE_LINK_TESTID)).toBeNull();
    expect(link('x').getAttribute('href') ?? '').not.toMatch(/^javascript:/);
  });
});

// ---------------------------------------------------------------------------
// macOS's two spellings of /tmp, from the surface a person clicks
// ---------------------------------------------------------------------------

describe('[#4501] a worktree rooted at one spelling of /tmp opens the other', () => {
  it.each([
    ['/tmp/wt-4501', '/private/tmp/wt-4501/docs/post.md'],
    ['/private/tmp/wt-4501', '/tmp/wt-4501/docs/post.md'],
  ])('opens a file under root %j named as %j', async (root, absPath) => {
    const onFilePathClick = vi.fn();
    render(
      <ChatTranscript
        messages={[msg('a1', `[post.md](file://${absPath})`)]}
        worktreeId={WORKTREE_ID}
        worktreePath={root}
        cliToolId="antigravity"
        onFilePathClick={onFilePathClick}
      />,
    );

    fireEvent.click(link('post.md'));

    await waitFor(() => expect(onFilePathClick).toHaveBeenCalledWith(DOC_REL));
    // The probe asks for the SAME relative path whichever spelling was written.
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `/api/worktrees/${WORKTREE_ID}/files/${DOC_REL}`,
    );
  });
});

// ---------------------------------------------------------------------------
// A destination outside this worktree: copied, not asked about
// ---------------------------------------------------------------------------

/** A path that belongs to some other repository, as a reply would name it. */
const OUTSIDE_ABS = '/Users/other/project/build.log';
/** The same directory named the `file://` way Antigravity writes it. */
const OUTSIDE_HREF = `file://${OUTSIDE_ABS}`;

describe('[#4501] a file:// destination outside this worktree', () => {
  function renderTranscript(props: Record<string, unknown> = {}) {
    return render(
      <ChatTranscript
        messages={[msg('a1', `[build.log](${OUTSIDE_HREF}) を見よ。`)]}
        worktreeId={WORKTREE_ID}
        worktreePath={WORKTREE_PATH}
        cliToolId="antigravity"
        onFilePathClick={vi.fn()}
        {...props}
      />,
    );
  }

  it('copies the path, says why, and asks the file API nothing', async () => {
    const onFilePathClick = vi.fn();
    const showToast = vi.fn();
    renderTranscript({ onFilePathClick, showToast });

    expect(fireEvent.click(link('build.log'))).toBe(false);

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        'worktree.conversation.filePathOutsideWorktree',
        'info',
      ),
    );
    expect(copyToClipboardMock).toHaveBeenCalledWith(OUTSIDE_ABS);
    // The files API cannot serve it, so the question is never asked.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onFilePathClick).not.toHaveBeenCalled();
  });

  it('does not claim the path was copied when the clipboard refuses', async () => {
    // A phone on the LAN has no `navigator.clipboard`; the fallback can throw.
    // The wording must not say "copied" when it was not.
    const showToast = vi.fn();
    copyToClipboardMock.mockRejectedValue(new Error('no clipboard'));
    renderTranscript({ showToast });

    fireEvent.click(link('build.log'));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        'worktree.conversation.filePathOutsideWorktreeNoCopy',
        'error',
      ),
    );
    expect(showToast).not.toHaveBeenCalledWith(
      'worktree.conversation.filePathOutsideWorktree',
      'info',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses a different wording than a file this worktree does not have', async () => {
    // 条件 (4): the two reasons must be told apart. Here the file IS in the
    // worktree but absent; that keeps #2274's wording.
    const showToast = vi.fn();
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    render(
      <ChatTranscript
        messages={[msg('a1', `[post.md](${DOC_HREF}) にまとめた。`)]}
        worktreeId={WORKTREE_ID}
        worktreePath={WORKTREE_PATH}
        cliToolId="antigravity"
        onFilePathClick={vi.fn()}
        showToast={showToast}
      />,
    );

    fireEvent.click(link('post.md'));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('worktree.conversation.filePathMissing', 'error'),
    );
    expect(copyToClipboardMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Positive controls for 条件 (3): a path INSIDE this worktree is never "outside"
// ---------------------------------------------------------------------------

describe('[#4501] an in-worktree path is opened, whatever its spelling', () => {
  it.each([
    // The /tmp / /private/tmp pair, both directions.
    ['/tmp/wt-4501', '/private/tmp/wt-4501/docs/post.md'],
    ['/private/tmp/wt-4501', '/tmp/wt-4501/docs/post.md'],
    // A trailing slash on the root, and on the destination's directory.
    ['/tmp/wt-4501/', '/tmp/wt-4501/docs/post.md'],
    ['/tmp/wt-4501', '/tmp/wt-4501//docs/post.md'],
    // The plain case, for the table's sake.
    [WORKTREE_PATH, `${WORKTREE_PATH}/docs/post.md`],
  ])('opens a file under root %j named as %j', async (root, absPath) => {
    const onFilePathClick = vi.fn();
    const showToast = vi.fn();
    render(
      <ChatTranscript
        messages={[msg('a1', `[post.md](file://${absPath})`)]}
        worktreeId={WORKTREE_ID}
        worktreePath={root}
        cliToolId="antigravity"
        onFilePathClick={onFilePathClick}
        showToast={showToast}
      />,
    );

    fireEvent.click(link('post.md'));

    await waitFor(() => expect(onFilePathClick).toHaveBeenCalledWith(DOC_REL));
    expect(showToast).not.toHaveBeenCalledWith(
      'worktree.conversation.filePathOutsideWorktree',
      expect.anything(),
    );
    expect(copyToClipboardMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// History, same body, same answer
// ---------------------------------------------------------------------------

describe('[#4501] History answers the same click the same way', () => {
  // History draws bodies through `ConversationPairCard`, which still sanitizes
  // with the default schema (no `urlTransform`), so a `file:` href is dropped
  // there before its own `ChatFileLink` sees it — reported in the commit body,
  // not fixed here. These use the bare absolute path, which does reach it.
  function renderPane(content: string, props: Record<string, unknown> = {}) {
    return render(
      <HistoryPane
        messages={[
          msg('u1', 'まとめて', { role: 'user', requestId: undefined }),
          msg('a1', content),
        ]}
        worktreeId={WORKTREE_ID}
        worktreePath={WORKTREE_PATH}
        onFilePathClick={vi.fn()}
        {...props}
      />,
    );
  }

  it('copies a path outside this worktree instead of opening it', async () => {
    const onFilePathClick = vi.fn();
    const showToast = vi.fn();
    renderPane(`[build.log](${OUTSIDE_ABS}) を見よ。`, { onFilePathClick, showToast });

    fireEvent.click(link('build.log'));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        'worktree.conversation.filePathOutsideWorktree',
        'info',
      ),
    );
    expect(copyToClipboardMock).toHaveBeenCalledWith(OUTSIDE_ABS);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onFilePathClick).not.toHaveBeenCalled();
  });

  it('still says a file inside this worktree is missing when the probe says so', async () => {
    const onFilePathClick = vi.fn();
    const showToast = vi.fn();
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    renderPane(`[post.md](${WORKTREE_PATH}/${DOC_REL}) にまとめた。`, {
      onFilePathClick,
      showToast,
    });

    fireEvent.click(link('post.md'));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('worktree.conversation.filePathMissing', 'error'),
    );
    expect(copyToClipboardMock).not.toHaveBeenCalled();
    expect(onFilePathClick).not.toHaveBeenCalled();
  });
});

