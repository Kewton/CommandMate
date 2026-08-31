/**
 * The opencode share control (Issue #2051).
 *
 * This suite carries the Issue's first acceptance criterion — *the button does
 * not appear when share is disabled* — and it is worth stating why that has to
 * be a UI test rather than a route test.
 *
 * Measured on opencode 1.18.22: with `share: "disabled"` configured, opencode
 * answers `POST /session/:id/share` with a bare **HTTP 500 `UnknownError`**
 * whose only distinguishing mark is a line in the server's own log. There is no
 * code in the body. So the refusal cannot be decoded after the fact, the
 * feature cannot ask forgiveness, and the *absence of the button* is the only
 * mechanism that honours the setting. If this file goes green while the button
 * renders, the setting does nothing.
 *
 * The second property here is the confirmation. `useConfirm()` outside a
 * `ConfirmProvider` resolves to `false`, so the tests that expect a publish wrap
 * the tree in a provider and answer it; the test that expects *no* publish
 * leaves it unwrapped, which is also the shape of the safe default.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

import { OpencodeSessionControls } from '@/components/worktree/OpencodeSessionControls';
import { ConfirmProvider } from '@/components/ui';
import type { OpencodeShareState } from '@/types/opencode-share';

const WORKTREE_ID = 'wt-2051';
const SESSION_ID = 'ses_fc35f3dadffe2uirJpjJBtxFhy';
/** The URL shape measured on 1.18.22, not the one the Issue body describes. */
const SHARE_URL = 'https://opncd.ai/share/jJBtxFhy';

let fetchMock: ReturnType<typeof vi.fn>;

/** A `GET …/opencode/share` answer, with the disabled case as the default. */
function shareState(overrides: Partial<OpencodeShareState> = {}): OpencodeShareState {
  return {
    instanceId: 'opencode',
    shareMode: 'disabled',
    canShare: false,
    sessionId: SESSION_ID,
    lastShareUrl: null,
    ...overrides,
  };
}

/**
 * Route `fetch` by URL and method.
 *
 * @param state - what `GET …/opencode/share` answers
 * @param post - what `POST …/opencode/share` answers
 * @param del - what `DELETE …/opencode/share` answers
 */
function stubFetch(options: {
  state: OpencodeShareState;
  post?: { ok: boolean; status: number; body: unknown };
  del?: { ok: boolean; status: number; body: unknown };
}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (String(url).includes('/opencode/share')) {
      if (method === 'POST') {
        const answer = options.post ?? { ok: true, status: 200, body: { url: SHARE_URL } };
        return {
          ok: answer.ok,
          status: answer.status,
          statusText: '',
          json: async () => answer.body,
        };
      }
      if (method === 'DELETE') {
        const answer = options.del ?? {
          ok: true,
          status: 200,
          body: { sessionId: SESSION_ID, removed: true },
        };
        return {
          ok: answer.ok,
          status: answer.status,
          statusText: '',
          json: async () => answer.body,
        };
      }
      return { ok: true, status: 200, json: async () => options.state };
    }
    return { ok: true, status: 200, json: async () => ({ action: 'new', accepted: true }) };
  });
  vi.stubGlobal('fetch', fetchMock);
}

/** Render with a provider that answers the confirmation the way `answer` says. */
function renderWithConfirm(answer: boolean) {
  const result = render(
    <ConfirmProvider>
      <OpencodeSessionControls worktreeId={WORKTREE_ID} cliToolId="opencode" />
    </ConfirmProvider>
  );
  const respond = async () => {
    const button = await screen.findByRole('button', {
      name: answer ? 'shareConfirmLabel' : /cancel/i,
    });
    fireEvent.click(button);
  };
  return { ...result, respond };
}

beforeEach(() => {
  stubFetch({ state: shareState() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the share: disabled gate (acceptance criterion)', () => {
  it('does not render the share button when the server reports share: disabled', async () => {
    stubFetch({ state: shareState({ shareMode: 'disabled', canShare: false }) });
    render(<OpencodeSessionControls worktreeId={WORKTREE_ID} cliToolId="opencode" />);

    // The other three controls prove the component mounted and the probe ran,
    // so the absence below is a decision rather than a component that failed.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByTestId('opencode-session-new')).toBeInTheDocument();
    expect(screen.queryByTestId('opencode-session-share')).not.toBeInTheDocument();
  });

  it.each(['manual', 'auto'] as const)('renders it when share is %s', async (shareMode) => {
    stubFetch({ state: shareState({ shareMode, canShare: true }) });
    render(<OpencodeSessionControls worktreeId={WORKTREE_ID} cliToolId="opencode" />);

    expect(await screen.findByTestId('opencode-session-share')).toBeInTheDocument();
  });

  it('renders it when the config has no share key at all', async () => {
    // Measured: `GET /config` omits `share` unless it is set, and absent is not
    // `disabled`. Hiding the button here would hide it on every default install.
    stubFetch({ state: shareState({ shareMode: null, canShare: true }) });
    render(<OpencodeSessionControls worktreeId={WORKTREE_ID} cliToolId="opencode" />);

    expect(await screen.findByTestId('opencode-session-share')).toBeInTheDocument();
  });

  it('does not render it when the probe itself fails', async () => {
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/opencode/share')) throw new Error('offline');
      return { ok: true, status: 200, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<OpencodeSessionControls worktreeId={WORKTREE_ID} cliToolId="opencode" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId('opencode-session-share')).not.toBeInTheDocument();
  });

  it('never probes for any tool other than opencode', () => {
    render(<OpencodeSessionControls worktreeId={WORKTREE_ID} cliToolId="claude" />);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('confirmation', () => {
  it('publishes nothing when the operator cancels', async () => {
    stubFetch({ state: shareState({ shareMode: 'manual', canShare: true }) });
    const view = renderWithConfirm(false);

    fireEvent.click(await screen.findByTestId('opencode-session-share'));
    await view.respond();

    await waitFor(() => {
      const posts = (fetchMock.mock.calls as [string, RequestInit?][]).filter(
        ([, init]) => init?.method === 'POST'
      );
      expect(posts).toHaveLength(0);
    });
    expect(screen.queryByTestId('opencode-share-result')).not.toBeInTheDocument();
  });

  it('publishes nothing when there is no ConfirmProvider to answer', async () => {
    // `useConfirm()` resolves to false without a provider. That the safe default
    // is also the unwrapped default is worth pinning: a refactor that swapped in
    // a hook defaulting to `true` would publish on the first click.
    stubFetch({ state: shareState({ shareMode: 'manual', canShare: true }) });
    render(<OpencodeSessionControls worktreeId={WORKTREE_ID} cliToolId="opencode" />);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    fireEvent.click(await screen.findByTestId('opencode-session-share'));

    await waitFor(() => {
      const posts = (fetchMock.mock.calls as [string, RequestInit?][]).filter(
        ([, init]) => init?.method === 'POST'
      );
      expect(posts).toHaveLength(0);
    });
  });

  it('publishes only after the operator confirms', async () => {
    stubFetch({ state: shareState({ shareMode: 'manual', canShare: true }) });
    const view = renderWithConfirm(true);

    fireEvent.click(await screen.findByTestId('opencode-session-share'));
    await view.respond();

    await waitFor(() => {
      const posts = (fetchMock.mock.calls as [string, RequestInit?][]).filter(
        ([, init]) => init?.method === 'POST'
      );
      expect(posts).toHaveLength(1);
      expect(posts[0][0]).toBe(`/api/worktrees/${WORKTREE_ID}/opencode/share`);
      expect(JSON.parse(String(posts[0][1]?.body))).toEqual({ instanceId: 'opencode' });
    });
  });
});

describe('the published link', () => {
  it('shows the minted URL so it can be revoked', async () => {
    stubFetch({ state: shareState({ shareMode: 'manual', canShare: true }) });
    const view = renderWithConfirm(true);

    fireEvent.click(await screen.findByTestId('opencode-session-share'));
    await view.respond();

    const link = await screen.findByTestId('opencode-share-url');
    expect(link).toHaveAttribute('href', SHARE_URL);
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(screen.getByTestId('opencode-session-unshare')).toBeInTheDocument();
  });

  it('says the link is public wherever it is shown, not only in the dialog', async () => {
    stubFetch({ state: shareState({ shareMode: 'manual', canShare: true }) });
    const view = renderWithConfirm(true);

    fireEvent.click(await screen.findByTestId('opencode-session-share'));
    await view.respond();

    const result = await screen.findByTestId('opencode-share-result');
    expect(result).toHaveTextContent('sharePublicNotice');
  });

  it('clears the link when the revoke succeeds', async () => {
    stubFetch({ state: shareState({ shareMode: 'manual', canShare: true }) });
    const view = renderWithConfirm(true);

    fireEvent.click(await screen.findByTestId('opencode-session-share'));
    await view.respond();
    fireEvent.click(await screen.findByTestId('opencode-session-unshare'));

    await waitFor(() =>
      expect(screen.queryByTestId('opencode-share-result')).not.toBeInTheDocument()
    );
    const deletes = (fetchMock.mock.calls as [string, RequestInit?][]).filter(
      ([, init]) => init?.method === 'DELETE'
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0][0]).toContain('instance=opencode');
  });

  it('keeps the link on screen when the revoke fails', async () => {
    // The one outcome where hiding it would be actively harmful: the page is
    // still up and the operator would have no way back to it.
    stubFetch({
      state: shareState({ shareMode: 'manual', canShare: true }),
      del: { ok: false, status: 502, body: { error: 'opencode refused to unshare' } },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = renderWithConfirm(true);

    fireEvent.click(await screen.findByTestId('opencode-session-share'));
    await view.respond();
    fireEvent.click(await screen.findByTestId('opencode-session-unshare'));

    await waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(screen.getByTestId('opencode-share-result')).toBeInTheDocument();
  });

  it('does not show a link from a session that was shared and revoked earlier', async () => {
    // Measured: `session.share` survives `DELETE` and a server restart, so
    // `lastShareUrl` means "was published once", not "is published now".
    // Rendering it as a live link would report a revoked page as still up.
    stubFetch({
      state: shareState({ shareMode: 'manual', canShare: true, lastShareUrl: SHARE_URL }),
    });
    render(<OpencodeSessionControls worktreeId={WORKTREE_ID} cliToolId="opencode" />);

    expect(await screen.findByTestId('opencode-session-share')).toBeInTheDocument();
    expect(screen.queryByTestId('opencode-share-result')).not.toBeInTheDocument();
  });

  it('shows no link when the publish is refused', async () => {
    stubFetch({
      state: shareState({ shareMode: 'manual', canShare: true }),
      post: { ok: false, status: 409, body: { error: 'disabled', code: 'SHARE_DISABLED' } },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = renderWithConfirm(true);

    fireEvent.click(await screen.findByTestId('opencode-session-share'));
    await view.respond();

    await waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(screen.queryByTestId('opencode-share-result')).not.toBeInTheDocument();
  });
});

describe('the dictionaries behind the labels', () => {
  // The component asks `next-intl` for these; a key with no entry renders the
  // key path to the operator, and for the confirmation body that would mean
  // publishing behind a dialog that explains nothing.
  const KEYS = [
    'new',
    'list',
    'fork',
    'share',
    'unshare',
    'shareCopy',
    'shareConfirmTitle',
    'shareConfirmBody',
    'shareConfirmLabel',
    'sharePublicNotice',
  ];

  it.each(['ja', 'en'])('locales/%s/worktree.json answers every key', (locale) => {
    const dictionary = JSON.parse(
      readFileSync(join(process.cwd(), `locales/${locale}/worktree.json`), 'utf8')
    ) as { opencodeSession?: Record<string, string> };

    expect(dictionary.opencodeSession).toBeDefined();
    for (const key of KEYS) {
      expect(typeof dictionary.opencodeSession?.[key]).toBe('string');
      expect(dictionary.opencodeSession?.[key]).not.toBe('');
    }
  });

  it.each(['ja', 'en'])('the %s confirmation body says the link is readable by anyone', (locale) => {
    // The Issue asks for wording that makes the external publication legible.
    // Pinned rather than left to review: this is the only warning between an
    // operator and a public URL.
    const dictionary = JSON.parse(
      readFileSync(join(process.cwd(), `locales/${locale}/worktree.json`), 'utf8')
    ) as { opencodeSession: Record<string, string> };
    const body = dictionary.opencodeSession.shareConfirmBody;

    const readableByAnyone = locale === 'ja' ? /誰でも読める/ : /anyone with the link can read/i;
    expect(body).toMatch(readableByAnyone);
    // And that it is not redacted — measured: the published page carries the
    // conversation and the absolute directory path verbatim.
    expect(body).toMatch(locale === 'ja' ? /伏せ字になりません/ : /Nothing is redacted/i);
  });
});
