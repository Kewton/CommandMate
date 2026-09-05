/**
 * Clicking a file path in a chat reply (Issue #2274).
 *
 * Two defects, one screen. A reply mentioning another repository's
 * `commandmate-skills/docs/uat/harness-pack-uat-report-template.md` turned the
 * TAIL of that path into a button — so one path was drawn in two colors — and
 * clicking that button opened a file tab for a path this worktree does not have,
 * because nothing had ever asked whether the file was there.
 *
 * The fix has two halves and this file covers both from the surface a person
 * actually touches:
 *
 *  1. the linkifier only starts a link at a body boundary (asserted here as
 *     "which text is a `<button>`"; the pattern itself, including the mutation
 *     that proves the fixtures discriminate, is
 *     `tests/unit/lib/chat/file-path-linkify-2274.test.ts`);
 *  2. a click probes `HEAD /api/worktrees/:id/files/:path` first and shows a
 *     toast instead of opening when the answer is a definite no.
 *
 * `ConversationPairCard` is exercised against the SAME fixtures at the bottom.
 * Issue #2232 had frozen History's copy of the regex apart from chat's; the two
 * surfaces now share one splitter, and "share" is only worth asserting if both
 * are asked the same questions.
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

const WORKTREE_ID = 'wt-2274';
const T0 = Date.UTC(2026, 8, 3, 9, 0, 0);

/** The path from the Issue. It belongs to a different repository. */
const OTHER_REPO_PATH = 'commandmate-skills/docs/uat/harness-pack-uat-report-template.md';
/** The slice the pre-#2274 pattern turned into a button. */
const OTHER_REPO_TAIL = '/docs/uat/harness-pack-uat-report-template.md';
/** A path in this worktree, which must keep working exactly as before. */
const OWN_PATH = '/src/app/page.tsx';

function msg(
  id: string,
  role: ChatMessage['role'],
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content,
    timestamp: new Date(T0),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
    ...extra,
  };
}

const fetchMock = vi.fn();

function renderTranscript(messages: ChatMessage[], props: Record<string, unknown> = {}) {
  return render(
    <ChatTranscript
      messages={messages}
      worktreeId={WORKTREE_ID}
      cliToolId="claude"
      onFilePathClick={vi.fn()}
      {...props}
    />,
  );
}

/** The element rendering `text`, asserted to be (or not to be) a link button. */
function nodeFor(text: string): HTMLElement {
  return screen.getByText(text);
}

beforeEach(() => {
  fetchMock.mockReset();
  // Default: the file is there. Cases that care override it.
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Half 1 — what becomes a button
// ---------------------------------------------------------------------------

describe('[#2274] ChatTranscript stops splitting one path into two colors', () => {
  it('renders another repository’s relative path as plain text', () => {
    renderTranscript([msg('a1', 'assistant', `template: ${OTHER_REPO_PATH}`)]);

    // The whole path is one text node...
    expect(nodeFor(`template: ${OTHER_REPO_PATH}`).tagName).not.toBe('BUTTON');
    // ...and its tail is specifically NOT a control of its own.
    expect(screen.queryByText(OTHER_REPO_TAIL)).toBeNull();
  });

  it('still renders a worktree-absolute path as a button', () => {
    renderTranscript([msg('a1', 'assistant', `edited ${OWN_PATH} just now`)]);
    expect(nodeFor(OWN_PATH).tagName).toBe('BUTTON');
  });

  it('applies the same rule inside an agent-authored Markdown body', () => {
    // #2041's distinction: a row with a requestId is parsed as Markdown, and the
    // linkifier is spliced into its block elements. The boundary must hold there
    // too, or the defect simply moves to the other renderer.
    renderTranscript([
      msg('a1', 'assistant', `template: ${OTHER_REPO_PATH}`, { requestId: 'oc-turn:m1' }),
    ]);
    expect(screen.queryByText(OTHER_REPO_TAIL)).toBeNull();

    renderTranscript([
      msg('a2', 'assistant', `edited ${OWN_PATH} just now`, { requestId: 'oc-turn:m2' }),
    ]);
    expect(nodeFor(OWN_PATH).tagName).toBe('BUTTON');
  });

  it('makes no request for a path it never turned into a button', () => {
    renderTranscript([msg('a1', 'assistant', `template: ${OTHER_REPO_PATH}`)]);
    fireEvent.click(nodeFor(`template: ${OTHER_REPO_PATH}`));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Half 2 — the click probes before it opens
// ---------------------------------------------------------------------------

describe('[#2274] ChatTranscript asks whether the file is here before opening it', () => {
  it('probes with HEAD on the same URL the file panel would GET', () => {
    // The probe is only worth having if it is exactly as capable as the open it
    // gates, which is why the URL is built the way `FilePanelContent` builds it
    // — leading empty segment and all.
    renderTranscript([msg('a1', 'assistant', `edited ${OWN_PATH} just now`)]);
    fireEvent.click(nodeFor(OWN_PATH));

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/worktrees/${WORKTREE_ID}/files/${OWN_PATH}`,
      { method: 'HEAD', cache: 'no-store' },
    );
  });

  it('opens the panel when the probe says the file is there', async () => {
    const onFilePathClick = vi.fn();
    const showToast = vi.fn();
    renderTranscript([msg('a1', 'assistant', `edited ${OWN_PATH} just now`)], {
      onFilePathClick,
      showToast,
    });

    fireEvent.click(nodeFor(OWN_PATH));

    await waitFor(() => expect(onFilePathClick).toHaveBeenCalledWith(OWN_PATH));
    expect(showToast).not.toHaveBeenCalled();
  });

  it.each([
    [404, 'nothing is at that path'],
    [400, 'the path is outside this worktree'],
    [403, 'the path is deny-tier (#2014)'],
  ])('says so and opens nothing when the probe answers %i (%s)', async (status) => {
    const onFilePathClick = vi.fn();
    const showToast = vi.fn();
    fetchMock.mockResolvedValue({ ok: false, status });
    renderTranscript([msg('a1', 'assistant', `edited ${OWN_PATH} just now`)], {
      onFilePathClick,
      showToast,
    });

    fireEvent.click(nodeFor(OWN_PATH));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('worktree.chatTranscript.filePathMissing', 'error'),
    );
    expect(onFilePathClick).not.toHaveBeenCalled();
  });

  it.each([
    ['a server error', { ok: false, status: 500 }],
    ['a gateway error', { ok: false, status: 502 }],
  ])('opens anyway on %s, because that is not evidence of absence', async (_label, response) => {
    const onFilePathClick = vi.fn();
    const showToast = vi.fn();
    fetchMock.mockResolvedValue(response);
    renderTranscript([msg('a1', 'assistant', `edited ${OWN_PATH} just now`)], {
      onFilePathClick,
      showToast,
    });

    fireEvent.click(nodeFor(OWN_PATH));

    await waitFor(() => expect(onFilePathClick).toHaveBeenCalledWith(OWN_PATH));
    expect(showToast).not.toHaveBeenCalled();
  });

  it('opens anyway when the request cannot be made at all', async () => {
    // Offline / aborted. The toast CLAIMS the file is absent; a probe that never
    // reached the server has established nothing, so it must not be shown.
    const onFilePathClick = vi.fn();
    const showToast = vi.fn();
    fetchMock.mockRejectedValue(new Error('network down'));
    renderTranscript([msg('a1', 'assistant', `edited ${OWN_PATH} just now`)], {
      onFilePathClick,
      showToast,
    });

    fireEvent.click(nodeFor(OWN_PATH));

    await waitFor(() => expect(onFilePathClick).toHaveBeenCalledWith(OWN_PATH));
    expect(showToast).not.toHaveBeenCalled();
  });

  it('probes an in-worktree absolute path RELATIVELY (Issue #2345)', async () => {
    // The URL #2274 pinned above is `files/` + the path verbatim, which for an
    // absolute path is `files//Users/…`. Next 308-normalizes the doubled slash
    // away and the route reads the remainder as a relative path, so the file
    // this worktree DOES have answered 404 and the toast said it was missing.
    // #2345 makes the surface hand the probe the worktree-relative path instead;
    // everything above still holds, because it is asked without a worktree root.
    const onFilePathClick = vi.fn();
    const worktreePath = '/Users/dev/wt-2274';
    renderTranscript([msg('a1', 'assistant', `edited ${worktreePath}/src/app/page.tsx now`)], {
      onFilePathClick,
      worktreePath,
    });

    fireEvent.click(nodeFor(`${worktreePath}/src/app/page.tsx`));

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/worktrees/${WORKTREE_ID}/files/src/app/page.tsx`,
      { method: 'HEAD', cache: 'no-store' },
    );
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('files//');
    await waitFor(() => expect(onFilePathClick).toHaveBeenCalledWith('src/app/page.tsx'));
  });

  it('probes nothing when the caller wired no open handler', () => {
    renderTranscript([msg('a1', 'assistant', `edited ${OWN_PATH} just now`)], {
      onFilePathClick: undefined,
    });
    fireEvent.click(nodeFor(OWN_PATH));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The other surface, same fixtures
// ---------------------------------------------------------------------------

describe('[#2274] ConversationPairCard splits bodies the same way chat does', () => {
  function renderCard(content: string, props: Record<string, unknown> = {}) {
    const pair: ConversationPair = {
      id: 'pair-2274',
      userMessage: msg('u1', 'user', content),
      assistantMessages: [],
      status: 'completed',
    };
    return render(
      <ConversationPairCard
        pair={pair}
        onFilePathClick={vi.fn()}
        onCopy={vi.fn()}
        {...props}
      />,
    );
  }

  it('renders another repository’s relative path as plain text', () => {
    renderCard(`template: ${OTHER_REPO_PATH}`);
    expect(screen.queryByText(OTHER_REPO_TAIL)).toBeNull();
    expect(nodeFor(`template: ${OTHER_REPO_PATH}`).tagName).not.toBe('BUTTON');
  });

  it('still renders a worktree-absolute path as a button that reports the path', () => {
    const onFilePathClick = vi.fn();
    renderCard(`edited ${OWN_PATH} just now`, { onFilePathClick });

    const button = nodeFor(OWN_PATH);
    expect(button.tagName).toBe('BUTTON');
    fireEvent.click(button);
    expect(onFilePathClick).toHaveBeenCalledWith(OWN_PATH);
  });

  it.each([
    [`template: ${OTHER_REPO_PATH}`, [] as string[]],
    [`edited ${OWN_PATH} just now`, [OWN_PATH]],
    ['edit `/src/x.ts` now', ['/src/x.ts']],
    ['(/src/x.ts)', ['/src/x.ts']],
    ['published at https://example.com/a/b.js today', [] as string[]],
    ['a /x.ts /y.ts', ['/x.ts', '/y.ts']],
  ])('links the same runs of %j as the chat transcript does', (content, expected) => {
    // Every path-shaped button in the tree, NOT just the ones expected — an
    // `expected: []` row is only worth writing if a stray link would fail it.
    // The copy / insert / expand controls of both surfaces are icon buttons and
    // never carry text starting with `/`.
    const linkTexts = (root: HTMLElement): string[] =>
      Array.from(root.querySelectorAll('button'))
        .map((button) => button.textContent ?? '')
        .filter((text) => text.startsWith('/'));

    const card = renderCard(content);
    const cardLinks = linkTexts(card.container);
    card.unmount();

    const transcript = renderTranscript([msg('a1', 'assistant', content)]);
    const transcriptLinks = linkTexts(transcript.container);

    expect(cardLinks).toEqual(expected);
    expect(transcriptLinks).toEqual(expected);
  });
});
