/**
 * A Markdown link in a reply opens the file panel, not a new page (Issue #2345).
 *
 * The reported screen: `/worktrees/commandagent-develop`, Codex 2, a reply whose
 * body carries `[整理文書](/Users/…/workspace/tmp/0905/….md)`. Clicking it
 * navigated the CommandMate tab to `http://localhost:3000/Users/…` and landed on
 * Next's 404 — react-markdown's default `<a>` with no `target`, because
 * `ChatMarkdownBody` overrode `p` / `li` / `td` / `th` / `strong` / `em` and not
 * `a`. A link's destination is consumed by the parser, so the bare-path
 * linkifier (#2274) never saw it.
 *
 * What is asserted here is the behaviour a person can observe: which element the
 * click lands on, whether the browser's own navigation was cancelled, and what
 * path the surface was asked to open. The rewrite itself is a table in
 * `tests/unit/lib/chat/chat-file-path-2345.test.ts`.
 *
 * Both surfaces are asked the same questions, from the same fixture. #2274
 * established why: History and chat render the same bodies, and a rule that
 * lives in one copy per surface is a rule that is wrong in one of them.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import type { ConversationPair } from '@/types/conversation';
import { ChatTranscript } from '@/components/worktree/ChatTranscript';
import { ConversationPairCard } from '@/components/worktree/ConversationPairCard';
import { HistoryPane } from '@/components/worktree/HistoryPane';
import { CHAT_FILE_LINK_TESTID } from '@/components/worktree/ChatMessageBubble';
import { ChatFileLinkProvider } from '@/lib/chat/chat-file-link-scope';

const WORKTREE_ID = 'commandagent-develop';
const WORKTREE_PATH = '/Users/maenokota/share/work/github_kewton/CommandAgent-develop';
const T0 = Date.UTC(2026, 8, 5, 9, 0, 0);

/** The two destinations from the live capture, and the relative paths they are. */
const DOC_ABS = `${WORKTREE_PATH}/workspace/tmp/0905/commandagent-nextjs-validation-cause-and-countermeasures.md`;
const DOC_REL = 'workspace/tmp/0905/commandagent-nextjs-validation-cause-and-countermeasures.md';
const RUN_ABS = `${WORKTREE_PATH}/workspace/tmp/0905/runs/S2/external-checks.md`;
const RUN_REL = 'workspace/tmp/0905/runs/S2/external-checks.md';
/** A path belonging to some other repository — #2274's case, unchanged by this Issue. */
const OUTSIDE_ABS = '/Users/maenokota/localwork/other/build.log';

/**
 * The reported reply, verbatim in shape: prose, two Markdown links to files in
 * this worktree, one external URL, one in-document anchor, and one bare path.
 */
const CODEX_BODY = [
  '検証の結論は [整理文書](' + DOC_ABS + ') にまとめた。',
  '',
  '- [S2の検証記録](' + RUN_ABS + ')',
  '- [検証ページ](http://127.0.0.1:60302/)',
  '- [先の節へ](#section-2)',
  '- [別リポジトリのログ](' + OUTSIDE_ABS + ')',
  '',
  '生ログは ' + DOC_ABS + ' にもある。',
].join('\n');

function msg(
  id: string,
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role: 'assistant',
    content,
    timestamp: new Date(T0),
    messageType: 'normal',
    archived: false,
    cliToolId: 'codex',
    // #2041's distinction: only a row carrying a requestId is parsed as Markdown.
    requestId: 'oc-turn:m1',
    ...extra,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The anchor whose visible text is `label`. */
function link(label: string): HTMLAnchorElement {
  return screen.getByText(label).closest('a') as HTMLAnchorElement;
}

/** Click, reporting whether the browser's own navigation was left in place. */
function clickAllowsNavigation(node: Element): boolean {
  // `fireEvent` returns `dispatchEvent`'s verdict: false once preventDefault has
  // been called. That is the whole "the tab does not go anywhere" assertion —
  // jsdom does not navigate, so nothing else would notice a missing handler.
  return fireEvent.click(node);
}

// ---------------------------------------------------------------------------
// The chat surface
// ---------------------------------------------------------------------------

describe('[#2345] a Markdown link in a chat reply', () => {
  function renderTranscript(props: Record<string, unknown> = {}) {
    return render(
      <ChatTranscript
        messages={[msg('a1', CODEX_BODY)]}
        worktreeId={WORKTREE_ID}
        worktreePath={WORKTREE_PATH}
        cliToolId="codex"
        onFilePathClick={vi.fn()}
        {...props}
      />,
    );
  }

  it('opens an in-worktree destination in the file panel, as a relative path', async () => {
    const onFilePathClick = vi.fn();
    renderTranscript({ onFilePathClick });

    const anchor = link('整理文書');
    expect(anchor).toHaveAttribute('data-testid', CHAT_FILE_LINK_TESTID);
    expect(clickAllowsNavigation(anchor)).toBe(false);

    await waitFor(() => expect(onFilePathClick).toHaveBeenCalledWith(DOC_REL));
    // The link text stays the author's; only where it goes changed.
    expect(anchor.textContent).toBe('整理文書');
  });

  it('probes the file API with the relative path, never with `files//`', async () => {
    renderTranscript();
    clickAllowsNavigation(link('S2の検証記録'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe(`/api/worktrees/${WORKTREE_ID}/files/${RUN_REL}`);
    // The doubled slash is the defect: Next 308s it away and the route then
    // reads the remainder as a relative path that does not exist.
    expect(url).not.toContain('files//');
  });

  it('leaves an external URL to a new tab, and this tab where it is', () => {
    renderTranscript();
    const anchor = link('検証ページ');

    expect(anchor).toHaveAttribute('href', 'http://127.0.0.1:60302/');
    expect(anchor).toHaveAttribute('target', '_blank');
    expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
    // Not intercepted: the browser opens it, so nothing is asked of the panel.
    expect(anchor).not.toHaveAttribute('data-testid', CHAT_FILE_LINK_TESTID);
  });

  it('passes an in-document anchor straight through', () => {
    renderTranscript();
    const anchor = link('先の節へ');

    expect(anchor).toHaveAttribute('href', '#section-2');
    expect(anchor).not.toHaveAttribute('target');
    expect(clickAllowsNavigation(anchor)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the attributes remark put on a link of its own', () => {
    // GFM footnotes are anchors with an `id` and `data-footnote-ref`, and the
    // jump back needs both. An `a` renderer that only forwards `href` silently
    // breaks every footnote in every reply.
    render(
      <ChatTranscript
        messages={[msg('a1', 'a claim[^1]\n\n[^1]: the evidence')]}
        worktreeId={WORKTREE_ID}
        worktreePath={WORKTREE_PATH}
        cliToolId="codex"
        onFilePathClick={vi.fn()}
      />,
    );

    const ref = document.querySelector('a[data-footnote-ref]');
    expect(ref).not.toBeNull();
    expect(ref).toHaveAttribute('id');
    expect(ref?.getAttribute('href')).toMatch(/^#/);
  });

  it('still reports a path outside this worktree as itself (#2274 unchanged)', async () => {
    const onFilePathClick = vi.fn();
    const showToast = vi.fn();
    fetchMock.mockResolvedValue({ ok: false, status: 400 });
    renderTranscript({ onFilePathClick, showToast });

    clickAllowsNavigation(link('別リポジトリのログ'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/worktrees/${WORKTREE_ID}/files/${OUTSIDE_ABS}`,
        { method: 'HEAD', cache: 'no-store' },
      ),
    );
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('worktree.chatTranscript.filePathMissing', 'error'),
    );
    expect(onFilePathClick).not.toHaveBeenCalled();
  });

  it('opens the same file from the bare path in the same body', async () => {
    // Half B of the Issue: the button the linkifier already drew could not open
    // an in-worktree ABSOLUTE path either, because it went to the file API with
    // the same `files//Users/…` URL. One normalization now serves both.
    const onFilePathClick = vi.fn();
    renderTranscript({ onFilePathClick });

    const bare = screen.getByRole('button', { name: `worktree.conversation.openFile` });
    expect(bare.textContent).toBe(DOC_ABS);
    fireEvent.click(bare);

    await waitFor(() => expect(onFilePathClick).toHaveBeenCalledWith(DOC_REL));
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('files//');
  });

  it('falls back to the absolute path when no worktree root is known', async () => {
    // A mount that has neither the prop nor the screen's provider behaves
    // exactly as it did before this Issue — the path is passed through and
    // #2274's probe reports on it.
    const onFilePathClick = vi.fn();
    render(
      <ChatTranscript
        messages={[msg('a1', CODEX_BODY)]}
        worktreeId={WORKTREE_ID}
        cliToolId="codex"
        onFilePathClick={onFilePathClick}
      />,
    );

    clickAllowsNavigation(link('整理文書'));
    await waitFor(() => expect(onFilePathClick).toHaveBeenCalledWith(DOC_ABS));
  });
});

// ---------------------------------------------------------------------------
// History, same fixture
// ---------------------------------------------------------------------------

describe('[#2345] the same link in History', () => {
  function pair(): ConversationPair {
    return {
      id: 'pair-2345',
      userMessage: msg('u1', 'まとめて', { role: 'user', requestId: undefined }),
      assistantMessages: [msg('a1', CODEX_BODY)],
      status: 'completed',
    };
  }

  const PANE_MESSAGES: ChatMessage[] = [
    msg('u1', 'まとめて', { role: 'user', requestId: undefined }),
    msg('a1', CODEX_BODY),
  ];

  function renderPane(props: Record<string, unknown> = {}) {
    return render(
      <HistoryPane
        messages={PANE_MESSAGES}
        worktreeId={WORKTREE_ID}
        worktreePath={WORKTREE_PATH}
        onFilePathClick={vi.fn()}
        {...props}
      />,
    );
  }

  it('opens an in-worktree destination in the file panel, as a relative path', () => {
    const onFilePathClick = vi.fn();
    renderPane({ onFilePathClick });

    const anchor = link('整理文書');
    expect(clickAllowsNavigation(anchor)).toBe(false);
    expect(onFilePathClick).toHaveBeenCalledWith(DOC_REL);
  });

  it('opens the bare path in the same body as the same relative path', () => {
    const onFilePathClick = vi.fn();
    renderPane({ onFilePathClick });

    fireEvent.click(screen.getByRole('button', { name: 'worktree.conversation.openFile' }));
    expect(onFilePathClick).toHaveBeenCalledWith(DOC_REL);
  });

  it('leaves an external URL to a new tab', () => {
    renderPane();
    const anchor = link('検証ページ');
    expect(anchor).toHaveAttribute('target', '_blank');
    expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('reports a path outside this worktree unchanged', () => {
    const onFilePathClick = vi.fn();
    renderPane({ onFilePathClick });

    clickAllowsNavigation(link('別リポジトリのログ'));
    expect(onFilePathClick).toHaveBeenCalledWith(OUTSIDE_ABS);
  });

  it('renders the card`s own links the same way with no worktree root', () => {
    // `ConversationPairCard` is mounted directly by several suites and by the
    // pane above; with no root it must still intercept rather than navigate.
    const onFilePathClick = vi.fn();
    render(
      <ConversationPairCard pair={pair()} onFilePathClick={onFilePathClick} isExpanded />,
    );

    const anchor = link('整理文書');
    expect(clickAllowsNavigation(anchor)).toBe(false);
    // The card reports the href; the pane above it is what knows the root.
    expect(onFilePathClick).toHaveBeenCalledWith(DOC_ABS);
  });
});

// ---------------------------------------------------------------------------
// The PC mount, which cannot be handed a prop at all
// ---------------------------------------------------------------------------

describe('[#2345] the screen’s scope is the fallback for a mount with no prop', () => {
  // `TerminalSplitPaneContent` builds ONE frozen prop object and spreads it into
  // both the chat surface and the History column, so neither can be given
  // `worktreePath` from above. This is the path PC actually takes, and the two
  // components have to agree about it or one surface silently keeps the defect.

  it('ChatTranscript normalizes against the provider’s root', async () => {
    const onFilePathClick = vi.fn();
    render(
      <ChatFileLinkProvider value={{ worktreePath: WORKTREE_PATH }}>
        <ChatTranscript
          messages={[msg('a1', CODEX_BODY)]}
          worktreeId={WORKTREE_ID}
          cliToolId="codex"
          onFilePathClick={onFilePathClick}
        />
      </ChatFileLinkProvider>,
    );

    clickAllowsNavigation(link('整理文書'));
    await waitFor(() => expect(onFilePathClick).toHaveBeenCalledWith(DOC_REL));
  });

  it('HistoryPane normalizes against the provider’s root', () => {
    const onFilePathClick = vi.fn();
    render(
      <ChatFileLinkProvider value={{ worktreePath: WORKTREE_PATH }}>
        <HistoryPane
          messages={[msg('a1', CODEX_BODY)]}
          worktreeId={WORKTREE_ID}
          onFilePathClick={onFilePathClick}
        />
      </ChatFileLinkProvider>,
    );

    clickAllowsNavigation(link('整理文書'));
    expect(onFilePathClick).toHaveBeenCalledWith(DOC_REL);
  });

  it('lets an explicit prop win over the provider', async () => {
    // The phone states the root outright on its way down; a screen whose
    // provider disagreed must not quietly override what the caller said.
    const onFilePathClick = vi.fn();
    render(
      <ChatFileLinkProvider value={{ worktreePath: '/somewhere/else' }}>
        <ChatTranscript
          messages={[msg('a1', CODEX_BODY)]}
          worktreeId={WORKTREE_ID}
          worktreePath={WORKTREE_PATH}
          cliToolId="codex"
          onFilePathClick={onFilePathClick}
        />
      </ChatFileLinkProvider>,
    );

    clickAllowsNavigation(link('整理文書'));
    await waitFor(() => expect(onFilePathClick).toHaveBeenCalledWith(DOC_REL));
  });
});
