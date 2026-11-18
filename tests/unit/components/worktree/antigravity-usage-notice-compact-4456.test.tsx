/**
 * Issue #4456 item 4: in a narrow pane (the 3-way split) the composer's
 * Antigravity usage notice wrapped into a tall block and pushed the input box
 * below the pane's edge. In the composer the notice is compact: its body
 * scrolls inside a capped height, while the headline and the Close button stay
 * in view. The add forms (wide enough, not above an input) render as before.
 *
 * jsdom has no layout, so the cap is pinned as the classes that make it.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MessageInput } from '@/components/worktree/MessageInput';
import { AntigravityUsageNotice, ANTIGRAVITY_NOTICE_TEST_ID } from '@/components/worktree/antigravity-usage-notice';
import { ANTIGRAVITY_FAQ_URL, ANTIGRAVITY_TERMS_URL } from '@/lib/tool-policy/policy';
import { mockCommandGroups } from '@tests/helpers/message-input-test-utils';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('@/lib/api-client', () => ({
  worktreeApi: { sendMessage: vi.fn(), uploadImageFile: vi.fn() },
  handleApiError: vi.fn((err: Error) => err?.message || 'Unknown error'),
}));

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

vi.mock('@/components/worktree/OpencodeSessionControls', () => ({ OpencodeSessionControls: () => null }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: vi.fn(() => false) }));

const BODY = `${ANTIGRAVITY_NOTICE_TEST_ID}-body`;

function classesOf(el: HTMLElement): string[] {
  return el.className.split(/\s+/);
}

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe('[#4456] the composer notice does not push the input out of a narrow pane', () => {
  it('positive: in the composer the body scrolls inside a capped height; headline and Close stay outside it (4456)', () => {
    render(<MessageInput worktreeId="w-4456" cliToolId="antigravity" instanceId="antigravity" isSessionRunning={false} />);
    const box = screen.getByTestId(ANTIGRAVITY_NOTICE_TEST_ID);
    const body = within(box).getByTestId(BODY);
    expect(classesOf(body)).toEqual(expect.arrayContaining(['overflow-y-auto']));
    expect(classesOf(body).some((c) => c.startsWith('max-h-'))).toBe(true);
    // Close is not inside the scrolling part, so it never scrolls out of reach.
    const dismiss = within(box).getByTestId(`${ANTIGRAVITY_NOTICE_TEST_ID}-dismiss`);
    expect(body.contains(dismiss)).toBe(false);
    // The links are all still there (I1: reason and links are not reduced).
    const links = Array.from(body.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(links).toEqual([ANTIGRAVITY_TERMS_URL, ANTIGRAVITY_FAQ_URL]);
    // The input box is still rendered below it.
    expect(screen.getByRole('textbox')).not.toBeNull();
  });

  it('negative: the notice outside the composer (add forms) has no height cap (4456)', () => {
    render(<AntigravityUsageNotice onDismiss={vi.fn()} />);
    const body = screen.getByTestId(BODY);
    expect(classesOf(body)).not.toContain('overflow-y-auto');
    expect(classesOf(body).some((c) => c.startsWith('max-h-'))).toBe(false);
  });
});
