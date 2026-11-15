/**
 * Issue #4385 (A4 差し戻し): a send from the screen that the server refuses because of the role
 * (409 `roleRefusal`, nothing typed, the process left running) says why on the screen — as the
 * CLI's `send --role` (exit 32) does — in the composer's toast right after the send and on the
 * history's "Failed to send" row, and the composer keeps the body (it clears only what the server
 * took). The three reasons the judge sent back: A4 (`agy agent` did not list the agent:
 * `not-applied`), A5 (`agy agent` failed / could not be checked: `not-confirmed`), A8a (the role's
 * file could not be prepared: `artifact-failed`).
 *
 * Positive controls: red before #4385 A4 (the screen read nothing of the 409: the row said only
 * "Failed to send", no toast, the composer was empty) — and red under the mutant that takes the
 * reason away (`role-refusal-send-4385-mutant.test.tsx`). Negative controls: a failure that is
 * not a role refusal is shown as before (no reason, the draft is not handed back), and a retry
 * of the row does not hand the body back to the composer a second time.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MessageInput } from '@/components/worktree/MessageInput';
import { mockCommandGroups } from '@tests/helpers/message-input-test-utils';
import {
  BODY,
  ROLE_CASES,
  SERVER_SENTENCE,
  expectRoleReasonShown,
  installFetch,
  renderPane,
  roleRefusal409,
  sendBody,
  serverError500,
  textarea,
} from './role-refusal-4385-harness';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/wt-4385',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));
vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: vi.fn(() => ({
    groups: mockCommandGroups,
    filteredGroups: mockCommandGroups,
    allCommands: mockCommandGroups.flatMap((g) => g.commands),
    loading: false,
    error: null,
    isCatalogStale: false,
  })),
}));
// The connection verdict: reachable (a 409 is the server's answer, never a tunnel).
vi.mock('@/hooks/useConnectivity', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useConnectivity')>('@/hooks/useConnectivity');
  return {
    ...actual,
    useConnectivity: () => ({ signals: {} }),
    isServerConfirmedReachable: () => true,
    isConnectionKnownDown: () => false,
  };
});

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('[#4385 A4] a send refused because of the role says why on the screen', () => {
  it.each(ROLE_CASES)('$label: the toast, the failed row and the kept draft', async ({ roleRefusal, sentence }) => {
    const fetchFn = installFetch(() => roleRefusal409(roleRefusal));
    renderPane();
    await sendBody();
    await expectRoleReasonShown(sentence);
    // One send, nothing sent again on its own.
    expect(fetchFn.mock.calls.filter(([url]) => String(url).endsWith('/send'))).toHaveLength(1);
    // The screen's own words, not the server's English sentence (it carries the detail paths).
    expect(document.body.textContent).not.toContain(SERVER_SENTENCE);
  });

  it('a retry refused again says why again, and does not hand the body back a second time', async () => {
    installFetch(() => roleRefusal409('not-confirmed'));
    renderPane();
    await sendBody();
    await expectRoleReasonShown(ROLE_CASES[1].sentence);
    fireEvent.change(textarea(), { target: { value: 'something else' } });
    fireEvent.click(within(screen.getByTestId('pc-history')).getByTestId('pending-retry'));
    await waitFor(() => expect(screen.getAllByText(ROLE_CASES[1].sentence, { selector: '[data-testid^="toast-"] *' }).length).toBeGreaterThanOrEqual(2));
    expect(within(screen.getByTestId('pc-history')).getByTestId('optimistic-error-reason')).toHaveTextContent(ROLE_CASES[1].sentence);
    expect(textarea().value).toBe('something else');
  });

  it('discarding the row does not put the body into the composer twice', async () => {
    installFetch(() => roleRefusal409('not-applied'));
    renderPane();
    await sendBody();
    await expectRoleReasonShown(ROLE_CASES[0].sentence);
    fireEvent.click(within(screen.getByTestId('pc-history')).getByTestId('pending-discard'));
    await act(async () => undefined);
    expect(textarea().value).toBe(BODY);
  });
});

describe('[#4385 A4] (negative controls) other failures are shown as before', () => {
  it('a 500 fails the row with no reason, no role toast, and the composer is not refilled', async () => {
    installFetch(serverError500);
    renderPane();
    await sendBody();
    expect(screen.queryByTestId('optimistic-error-reason')).toBeNull();
    expect(screen.queryByTestId('chat-optimistic-error-reason')).toBeNull();
    expect(document.body.textContent).not.toMatch(/nothing was sent/);
    expect(textarea().value).toBe('');
  });

  it('a 409 without roleRefusal (another conflict) carries no role reason', async () => {
    installFetch(() => new Response(JSON.stringify({ error: 'conflict', code: 'FOREIGN_SESSION' }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
    renderPane();
    await sendBody();
    expect(screen.queryByTestId('optimistic-error-reason')).toBeNull();
    expect(textarea().value).toBe('');
  });
});

describe('[#4385 A4] the awaited send (a composer with no optimistic history)', () => {
  it.each(ROLE_CASES)('$label: the composer\'s error says why and the draft stays', async ({ roleRefusal, sentence }) => {
    installFetch(() => roleRefusal409(roleRefusal));
    render(<MessageInput worktreeId="wt-4385" cliToolId="antigravity" onMessageSent={() => undefined} />);
    fireEvent.change(textarea(), { target: { value: BODY } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    await waitFor(() => expect(screen.getByText(sentence)).toBeInTheDocument());
    expect(textarea().value).toBe(BODY);
    expect(document.body.textContent).not.toContain(SERVER_SENTENCE);
  });

  it('(negative control) a 500 still shows the server\'s error, as before', async () => {
    installFetch(serverError500);
    render(<MessageInput worktreeId="wt-4385" cliToolId="antigravity" onMessageSent={() => undefined} />);
    fireEvent.change(textarea(), { target: { value: BODY } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    await waitFor(() => expect(screen.getByText('Internal failure')).toBeInTheDocument());
    expect(textarea().value).toBe(BODY);
  });
});
