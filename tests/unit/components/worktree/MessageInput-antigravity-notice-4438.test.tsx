/**
 * Issue #4438 再指示 1 (I6'): the Antigravity usage notice before the first launch
 * from the composer.
 *
 * An antigravity instance added elsewhere (CLI, another device, before this
 * version) is launched by the first send from the composer, never passing the
 * add form. So the composer shows the same notice — the same hook, the same
 * stored "closed" — while the instance's session is not running. It is guidance:
 * the send goes through with the notice up (I9), on the PC and the phone.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageInput } from '@/components/worktree/MessageInput';
import { ANTIGRAVITY_NOTICE_TEST_ID } from '@/components/worktree/antigravity-usage-notice';
import { ANTIGRAVITY_NOTICE_STORAGE_KEY } from '@/hooks/useAntigravityUsageNotice';
import { useIsMobile } from '@/hooks/useIsMobile';
import { ANTIGRAVITY_FAQ_URL, ANTIGRAVITY_TERMS_CHECKED_AT, ANTIGRAVITY_TERMS_URL } from '@/lib/tool-policy/policy';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import { mockCommandGroups, getSendButton, typeMessage } from '@tests/helpers/message-input-test-utils';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const { sendMessageMock } = vi.hoisted(() => ({ sendMessageMock: vi.fn() }));

vi.mock('@/lib/api-client', () => ({
  worktreeApi: {
    sendMessage: sendMessageMock,
    uploadImageFile: vi.fn().mockResolvedValue({ path: '.commandmate/attachments/test.png' }),
  },
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

// Not under test here, and its dictionary lookup does not resolve under the real-intl helper.
vi.mock('@/components/worktree/OpencodeSessionControls', () => ({ OpencodeSessionControls: () => null }));

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: vi.fn(() => false) }));

function notice(): HTMLElement | null {
  return screen.queryByTestId(ANTIGRAVITY_NOTICE_TEST_ID);
}

beforeEach(() => {
  window.localStorage.clear();
  sendMessageMock.mockReset();
  sendMessageMock.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

for (const device of ['pc', 'phone'] as const) {
  describe(`[#4438] composer, first launch of an existing antigravity instance (${device})`, () => {
    beforeEach(() => {
      vi.mocked(useIsMobile).mockReturnValue(device === 'phone');
    });

    function renderComposer(props: { cliToolId: (typeof CLI_TOOL_IDS)[number]; isSessionRunning: boolean; instanceId?: string }) {
      const onOptimisticSend = vi.fn();
      const view = render(
        <MessageInput
          worktreeId="w-4438"
          cliToolId={props.cliToolId}
          instanceId={props.instanceId ?? props.cliToolId}
          isSessionRunning={props.isSessionRunning}
          onOptimisticSend={onOptimisticSend}
        />,
      );
      return { ...view, onOptimisticSend };
    }

    it("shows the notice before the first send, and the send still goes through (I6', I9)", async () => {
      const { onOptimisticSend } = renderComposer({ cliToolId: 'antigravity', isSessionRunning: false, instanceId: 'antigravity-2' });
      const box = notice();
      expect(box).not.toBeNull();
      const links = Array.from((box as HTMLElement).querySelectorAll('a')).map((a) => a.getAttribute('href'));
      expect(links).toEqual([ANTIGRAVITY_TERMS_URL, ANTIGRAVITY_FAQ_URL]);
      typeMessage('hello');
      fireEvent.click(getSendButton());
      await waitFor(() => {
        expect(onOptimisticSend).toHaveBeenCalledWith('hello', { cliToolId: 'antigravity', instanceId: 'antigravity-2' });
      });
      expect(notice()).not.toBeNull();
    });

    it('stays up once the launch makes the session run, until it is closed', () => {
      const { rerender } = renderComposer({ cliToolId: 'antigravity', isSessionRunning: false });
      expect(notice()).not.toBeNull();
      rerender(<MessageInput worktreeId="w-4438" cliToolId="antigravity" instanceId="antigravity" isSessionRunning onOptimisticSend={vi.fn()} />);
      expect(notice()).not.toBeNull();
    });

    it("after it is closed the next send shows nothing, also in a later mount, with the add form's record (I6')", async () => {
      const first = renderComposer({ cliToolId: 'antigravity', isSessionRunning: false });
      fireEvent.click(screen.getByTestId('antigravity-usage-notice-dismiss'));
      expect(notice()).toBeNull();
      expect(window.localStorage.getItem(ANTIGRAVITY_NOTICE_STORAGE_KEY)).toBe(ANTIGRAVITY_TERMS_CHECKED_AT);
      typeMessage('again');
      fireEvent.click(getSendButton());
      await waitFor(() => expect(first.onOptimisticSend).toHaveBeenCalled());
      expect(notice()).toBeNull();
      first.unmount();
      renderComposer({ cliToolId: 'antigravity', isSessionRunning: false });
      expect(notice()).toBeNull();
    });

    it('a record closed at the add form hides it here too (one record)', () => {
      window.localStorage.setItem(ANTIGRAVITY_NOTICE_STORAGE_KEY, ANTIGRAVITY_TERMS_CHECKED_AT);
      renderComposer({ cliToolId: 'antigravity', isSessionRunning: false });
      expect(notice()).toBeNull();
    });

    it('shows nothing for an instance of another tool (I5)', () => {
      for (const tool of CLI_TOOL_IDS.filter((id) => id !== 'antigravity')) {
        const view = renderComposer({ cliToolId: tool, isSessionRunning: false });
        expect(notice()).toBeNull();
        view.unmount();
      }
    });

    it('shows nothing for an antigravity session that is already running (not a first launch)', () => {
      renderComposer({ cliToolId: 'antigravity', isSessionRunning: true });
      expect(notice()).toBeNull();
    });

    it('shows it when the storage cannot be read (I6)', () => {
      window.localStorage.setItem(ANTIGRAVITY_NOTICE_STORAGE_KEY, ANTIGRAVITY_TERMS_CHECKED_AT);
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError');
      });
      renderComposer({ cliToolId: 'antigravity', isSessionRunning: false });
      expect(notice()).not.toBeNull();
    });
  });
}
