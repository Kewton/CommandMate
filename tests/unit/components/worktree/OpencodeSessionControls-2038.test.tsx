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
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const locale = vi.hoisted(() => ({ value: 'en' }));

vi.mock('next-intl', () => ({
  useLocale: () => locale.value,
  useTranslations: () => (key: string) => key,
}));

import { OpencodeSessionControls } from '@/components/worktree/OpencodeSessionControls';

const WORKTREE_ID = 'wt-2038';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  locale.value = 'en';
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ action: 'new', accepted: true }),
  }));
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

  it('labels the buttons in the viewer locale', () => {
    locale.value = 'ja';
    render(<OpencodeSessionControls worktreeId={WORKTREE_ID} cliToolId="opencode" />);
    expect(screen.getByTestId('opencode-session-new')).toHaveAttribute(
      'aria-label',
      '新規セッション'
    );
  });
});

describe('actions', () => {
  it.each(['new', 'list', 'fork'] as const)('posts action=%s for the primary instance', async (action) => {
    render(<OpencodeSessionControls worktreeId={WORKTREE_ID} cliToolId="opencode" />);

    fireEvent.click(screen.getByTestId(`opencode-session-${action}`));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
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

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
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
    fetchMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      json: async () => ({ error: 'No opencode server is attached to this instance' }),
    }));

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
