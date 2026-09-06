/**
 * History asks whether a file is here before opening it (Issue #2352).
 *
 * The reported screen: `/worktrees/commandagent-develop` on `:3000`, the
 * History column, a reply naming `/private/tmp/commandagent-verify-epic.md` — a
 * path outside the worktree. Clicking it in the CHAT surface showed "That path
 * is not in this worktree" and opened nothing (#2274's probe). Clicking the very
 * same text in HISTORY sent the file panel's own `GET …/files//private/tmp/…`,
 * showed nothing, and left a tab that could not be read. #2345 had put the same
 * normalization on both surfaces; the probe had only ever been on one.
 *
 * What is asserted here is the observable half of the fix — which request a
 * click makes, whether the toast appears, whether the panel is asked to open —
 * and that chat and History now give the same answers to the same body. The
 * status → verdict table itself is pinned in
 * `tests/unit/lib/chat/chat-file-probe-2352.test.ts`.
 *
 * Mutation that must turn this file red: delete the `probeChatFilePath` await
 * from `HistoryPane.handleFilePathClick` and call `onFilePathClick` directly.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import { ChatTranscript } from '@/components/worktree/ChatTranscript';
import { HistoryPane } from '@/components/worktree/HistoryPane';

const WORKTREE_ID = 'commandagent-develop';
const WORKTREE_PATH = '/Users/maenokota/share/work/github_kewton/CommandAgent-develop';
const T0 = Date.UTC(2026, 9, 6, 9, 0, 0);

/** The path from the Issue's live capture: absolute, and not in this worktree. */
const OUTSIDE_ABS = '/private/tmp/commandagent-verify-epic.md';
/** A file the worktree has, as the absolute path Codex writes and as the API wants it. */
const DOC_ABS = `${WORKTREE_PATH}/workspace/tmp/0905/notes.md`;
const DOC_REL = 'workspace/tmp/0905/notes.md';
/** A file the worktree does NOT have, in the same two forms. */
const GONE_ABS = `${WORKTREE_PATH}/docs/removed-last-week.md`;
const GONE_REL = 'docs/removed-last-week.md';

const MISSING_KEY = 'worktree.conversation.filePathMissing';

function msg(id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role: 'assistant',
    content,
    timestamp: new Date(T0),
    messageType: 'normal',
    archived: false,
    cliToolId: 'codex',
    // #2041: only a row carrying a requestId is parsed as Markdown.
    requestId: 'oc-turn:m1',
    ...extra,
  };
}

/** A user turn followed by one assistant reply — the shape History groups. */
function conversation(reply: string): ChatMessage[] {
  return [
    msg('u1', 'まとめて', { role: 'user', requestId: undefined }),
    msg('a1', reply),
  ];
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

function renderPane(messages: ChatMessage[], props: Record<string, unknown> = {}) {
  return render(
    <HistoryPane
      messages={messages}
      worktreeId={WORKTREE_ID}
      worktreePath={WORKTREE_PATH}
      onFilePathClick={vi.fn()}
      {...props}
    />,
  );
}

/** The bare-path button whose visible text is `path`. */
function pathButton(path: string): HTMLButtonElement {
  return screen.getByText(path).closest('button') as HTMLButtonElement;
}

/** The Markdown anchor whose visible text is `label`. */
function link(label: string): HTMLAnchorElement {
  return screen.getByText(label).closest('a') as HTMLAnchorElement;
}

/** Let every microtask the click queued run, so a "was not called" holds. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// The reported case
// ---------------------------------------------------------------------------

describe('[#2352] History and a path this worktree does not have', () => {
  it('shows the toast and opens nothing for the Issue’s path (a 404 from outside)', async () => {
    // Exactly the live capture: the bare path, outside the worktree, and the
    // files API (since #2349) answering 404. Chat already ended here in a toast.
    const onFilePathClick = vi.fn();
    const showToast = vi.fn();
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    renderPane(conversation(`検証 epic は ${OUTSIDE_ABS} に置いた。`), {
      onFilePathClick,
      showToast,
    });

    fireEvent.click(pathButton(OUTSIDE_ABS));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(MISSING_KEY, 'error'));
    expect(onFilePathClick).not.toHaveBeenCalled();
  });

  it('asked with HEAD, on the URL the file panel would GET, before deciding', async () => {
    // The capture showed the panel's own GET going out; a probe that goes to a
    // different URL than the open it gates is a second opinion, not a gate.
    renderPane(conversation(`検証 epic は ${OUTSIDE_ABS} に置いた。`));

    fireEvent.click(pathButton(OUTSIDE_ABS));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/worktrees/${WORKTREE_ID}/files/${OUTSIDE_ABS}`,
        { method: 'HEAD', cache: 'no-store' },
      ),
    );
  });

  it.each([
    [404, 'nothing is at that path'],
    [400, 'the path is outside this worktree'],
    [403, 'the path is deny-tier (#2014)'],
  ])('says so and opens nothing when the probe answers %i (%s)', async (status) => {
    const onFilePathClick = vi.fn();
    const showToast = vi.fn();
    fetchMock.mockResolvedValue({ ok: false, status });
    renderPane(conversation(`削除済み: ${GONE_ABS}`), { onFilePathClick, showToast });

    fireEvent.click(pathButton(GONE_ABS));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(MISSING_KEY, 'error'));
    expect(onFilePathClick).not.toHaveBeenCalled();
  });

  it('still refuses to open when no toast channel is wired', async () => {
    // Half of the acceptance is "the tab does not open"; that half must not
    // depend on whether the mount happened to pass `showToast`.
    const onFilePathClick = vi.fn();
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    renderPane(conversation(`削除済み: ${GONE_ABS}`), { onFilePathClick });

    fireEvent.click(pathButton(GONE_ABS));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await settle();
    expect(onFilePathClick).not.toHaveBeenCalled();
  });

  it('gates a Markdown link through the same probe as the bare path', async () => {
    // #2345 made both affordances meet in one handler; the probe sits in that
    // handler, so a `[label](path)` to a missing file ends the same way.
    const onFilePathClick = vi.fn();
    const showToast = vi.fn();
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    renderPane(conversation(`[消えた文書](${GONE_ABS}) を参照。`), {
      onFilePathClick,
      showToast,
    });

    expect(fireEvent.click(link('消えた文書'))).toBe(false);

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(MISSING_KEY, 'error'));
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/worktrees/${WORKTREE_ID}/files/${GONE_REL}`,
      { method: 'HEAD', cache: 'no-store' },
    );
    expect(onFilePathClick).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// No regression for the files that ARE here, and for the answers that are not answers
// ---------------------------------------------------------------------------

describe('[#2352] History still opens what is here', () => {
  it('opens the panel, with the relative path, when the probe says present', async () => {
    const onFilePathClick = vi.fn();
    const showToast = vi.fn();
    renderPane(conversation(`結論は ${DOC_ABS} にまとめた。`), { onFilePathClick, showToast });

    fireEvent.click(pathButton(DOC_ABS));

    await waitFor(() => expect(onFilePathClick).toHaveBeenCalledWith(DOC_REL));
    expect(onFilePathClick).toHaveBeenCalledTimes(1);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('probes an in-worktree absolute path RELATIVELY, never as `files//`', async () => {
    renderPane(conversation(`結論は ${DOC_ABS} にまとめた。`));

    fireEvent.click(pathButton(DOC_ABS));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe(`/api/worktrees/${WORKTREE_ID}/files/${DOC_REL}`);
    expect(url).not.toContain('files//');
  });

  it.each([
    ['a server error', { ok: false, status: 500 }],
    ['a gateway error', { ok: false, status: 502 }],
  ])('opens anyway on %s, because that is not evidence of absence', async (_label, response) => {
    // Showing "not in this worktree" for a 500 would hide the internal error
    // the panel is about to report — the #2349 trap. The table is not widened.
    const onFilePathClick = vi.fn();
    const showToast = vi.fn();
    fetchMock.mockResolvedValue(response);
    renderPane(conversation(`削除済み: ${GONE_ABS}`), { onFilePathClick, showToast });

    fireEvent.click(pathButton(GONE_ABS));

    await waitFor(() => expect(onFilePathClick).toHaveBeenCalledWith(GONE_REL));
    expect(showToast).not.toHaveBeenCalled();
  });

  it('opens anyway when the request cannot be made at all', async () => {
    const onFilePathClick = vi.fn();
    const showToast = vi.fn();
    fetchMock.mockRejectedValue(new Error('network down'));
    renderPane(conversation(`削除済み: ${GONE_ABS}`), { onFilePathClick, showToast });

    fireEvent.click(pathButton(GONE_ABS));

    await waitFor(() => expect(onFilePathClick).toHaveBeenCalledWith(GONE_REL));
    expect(showToast).not.toHaveBeenCalled();
  });

  it('probes nothing for a link that names no file', async () => {
    renderPane(conversation('[先の節へ](#section-2) を見よ。'));

    expect(fireEvent.click(link('先の節へ'))).toBe(true);
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// One body, two surfaces, one answer
// ---------------------------------------------------------------------------

describe('[#2352] chat and History answer the same click the same way', () => {
  const BODY = `検証 epic は ${OUTSIDE_ABS} に置いた。結論は ${DOC_ABS} にまとめた。`;

  function renderTranscript(props: Record<string, unknown>) {
    return render(
      <ChatTranscript
        messages={[msg('a1', BODY)]}
        worktreeId={WORKTREE_ID}
        worktreePath={WORKTREE_PATH}
        cliToolId="codex"
        onFilePathClick={vi.fn()}
        {...props}
      />,
    );
  }

  it('both toast the same message and open nothing for the missing path', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });

    const chatOpen = vi.fn();
    const chatToast = vi.fn();
    const chat = renderTranscript({ onFilePathClick: chatOpen, showToast: chatToast });
    fireEvent.click(pathButton(OUTSIDE_ABS));
    await waitFor(() => expect(chatToast).toHaveBeenCalledWith(MISSING_KEY, 'error'));
    chat.unmount();

    const historyOpen = vi.fn();
    const historyToast = vi.fn();
    renderPane(conversation(BODY), { onFilePathClick: historyOpen, showToast: historyToast });
    fireEvent.click(pathButton(OUTSIDE_ABS));
    await waitFor(() => expect(historyToast).toHaveBeenCalledWith(MISSING_KEY, 'error'));

    expect(chatOpen).not.toHaveBeenCalled();
    expect(historyOpen).not.toHaveBeenCalled();
    // Same key on both — one dictionary entry, so the wording cannot drift.
    expect(historyToast.mock.calls).toEqual(chatToast.mock.calls);
  });

  it('both open the same relative path for the file that is here', async () => {
    const chatOpen = vi.fn();
    const chat = renderTranscript({ onFilePathClick: chatOpen });
    fireEvent.click(pathButton(DOC_ABS));
    await waitFor(() => expect(chatOpen).toHaveBeenCalledWith(DOC_REL));
    chat.unmount();

    const historyOpen = vi.fn();
    renderPane(conversation(BODY), { onFilePathClick: historyOpen });
    fireEvent.click(pathButton(DOC_ABS));
    await waitFor(() => expect(historyOpen).toHaveBeenCalledWith(DOC_REL));

    // And both asked the same question first.
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([
      `/api/worktrees/${WORKTREE_ID}/files/${DOC_REL}`,
      `/api/worktrees/${WORKTREE_ID}/files/${DOC_REL}`,
    ]);
  });
});
