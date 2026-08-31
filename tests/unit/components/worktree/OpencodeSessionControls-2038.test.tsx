/**
 * The opencode-only session controls beside the composer (Issue #2038).
 *
 * Two properties are load-bearing and neither is visible from the route tests:
 *
 *  - **Nothing renders for any other tool.** The three endpoints behind these
 *    buttons exist only on opencode's own server, so a claude split showing a
 *    "fork" button would be offering an action that cannot succeed.
 *  - **The action names travel verbatim.** `new` / `list` / `fork` are the words
 *    `POST /api/worktrees/:id/opencode/session` validates against; a rename on
 *    this side alone is a 400 the operator sees as "nothing happened".
 *
 * Issue #2051 added a share control, and with it a `GET …/opencode/share` on
 * mount. The `fetch` stub here therefore routes by URL, and the action
 * assertions look at the session `POST` rather than at call index 0 — otherwise
 * they would be reading the share probe. The labels moved to `next-intl` in the
 * same Issue, so what used to be a two-locale map assertion now lives in
 * `tests/unit/i18n/opencode-session-keys-2083.test.ts`, which reads the real
 * dictionaries off disk. The `next-intl` stub below returns the key, so this
 * file pins *which* key each surface asks for and nothing about its wording.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

import { OpencodeSessionControls } from '@/components/worktree/OpencodeSessionControls';

const WORKTREE_ID = 'wt-2038';

/** The session-route calls only — never the share probe the mount effect makes. */
function sessionCalls(mock: ReturnType<typeof vi.fn>): [string, RequestInit][] {
  return (mock.mock.calls as [string, RequestInit][]).filter(([url]) =>
    url.endsWith('/opencode/session')
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/opencode/share')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          instanceId: 'opencode',
          shareMode: 'disabled',
          canShare: false,
          sessionId: null,
          lastShareUrl: null,
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ action: 'new', accepted: true }) };
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('rendering', () => {
  it('shows the three opencode session actions', () => {
    render(<OpencodeSessionControls worktreeId={WORKTREE_ID} cliToolId="opencode" />);

    expect(screen.getByTestId('opencode-session-new')).toBeInTheDocument();
    expect(screen.getByTestId('opencode-session-list')).toBeInTheDocument();
    expect(screen.getByTestId('opencode-session-fork')).toBeInTheDocument();
  });

  it.each(['claude', 'codex', 'gemini', 'copilot'] as const)(
    'renders nothing at all for %s',
    (cliToolId) => {
      const { container } = render(
        <OpencodeSessionControls worktreeId={WORKTREE_ID} cliToolId={cliToolId} />
      );
      expect(container).toBeEmptyDOMElement();
    }
  );

  it('disables every action while no session is running', () => {
    render(
      <OpencodeSessionControls worktreeId={WORKTREE_ID} cliToolId="opencode" disabled />
    );
    for (const action of ['new', 'list', 'fork']) {
      expect(screen.getByTestId(`opencode-session-${action}`)).toBeDisabled();
    }
  });

  it('labels the buttons from the worktree.opencodeSession namespace', () => {
    // The stub returns the key, so this pins the key the component asks for.
    // Whether both dictionaries answer it is checked in the #2051 suite.
    render(<OpencodeSessionControls worktreeId={WORKTREE_ID} cliToolId="opencode" />);
    expect(screen.getByTestId('opencode-session-new')).toHaveAttribute('aria-label', 'new');
    expect(screen.getByTestId('opencode-session-fork')).toHaveAttribute('aria-label', 'fork');
  });
});

describe('actions', () => {
  it.each(['new', 'list', 'fork'] as const)('posts action=%s for the primary instance', async (action) => {
    render(<OpencodeSessionControls worktreeId={WORKTREE_ID} cliToolId="opencode" />);

    fireEvent.click(screen.getByTestId(`opencode-session-${action}`));

    await waitFor(() => expect(sessionCalls(fetchMock)).toHaveLength(1));
    const [url, init] = sessionCalls(fetchMock)[0];
    expect(url).toBe(`/api/worktrees/${WORKTREE_ID}/opencode/session`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ action, instanceId: 'opencode' });
  });

  it('targets the split it belongs to, not the primary instance', async () => {
    render(
      <OpencodeSessionControls
        worktreeId={WORKTREE_ID}
        cliToolId="opencode"
        instanceId="opencode-2"
      />
    );

    fireEvent.click(screen.getByTestId('opencode-session-fork'));

    await waitFor(() => expect(sessionCalls(fetchMock)).toHaveLength(1));
    const [, init] = sessionCalls(fetchMock)[0];
    expect(JSON.parse(String(init.body))).toMatchObject({ instanceId: 'opencode-2' });
  });

  it('reports completion only when the server accepted', async () => {
    const onActionComplete = vi.fn();
    render(
      <OpencodeSessionControls
        worktreeId={WORKTREE_ID}
        cliToolId="opencode"
        onActionComplete={onActionComplete}
      />
    );

    fireEvent.click(screen.getByTestId('opencode-session-new'));
    await waitFor(() => expect(onActionComplete).toHaveBeenCalledWith('new'));
  });

  it('does not report completion when the instance has no server', async () => {
    const onActionComplete = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Routed rather than `mockImplementationOnce`: the mount share probe would
    // otherwise consume the one-shot and the fork would get a 200.
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/opencode/share')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ canShare: false, sessionId: null, lastShareUrl: null }),
        };
      }
      return {
        ok: false,
        status: 409,
        statusText: 'Conflict',
        json: async () => ({ error: 'No opencode server is attached to this instance' }),
      };
    });

    render(
      <OpencodeSessionControls
        worktreeId={WORKTREE_ID}
        cliToolId="opencode"
        onActionComplete={onActionComplete}
      />
    );

    fireEvent.click(screen.getByTestId('opencode-session-fork'));

    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(onActionComplete).not.toHaveBeenCalled();
  });
});
