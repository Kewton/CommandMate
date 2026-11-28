/**
 * Issue #4604 (a P2-2, #4604 comment 7162107549; 設計書 §3.4.1): two composers of the same draft
 * (instance scope, one key). The first one's awaited send is stopped by the send fence (409
 * `SEND_TARGET_CHANGED` `not_sent`, `tool-changed`) while the draft's `:retarget` cannot be written:
 *
 * | shape | what is left | the second composer's Enter | another tab |
 * |---|---|---|---|
 * | `:retarget` `setItem` throws for a long value only (the store is full) | the short "unknown" | asks, POST 0 | asks (it reads `known: false`) |
 * | `:retarget` `setItem` always throws | this page's mark (+ a toast) | asks, POST 0 | the known limit: nothing tells it |
 * | every `setItem` throws | this page's mark (+ a toast) | asks, POST 0 | the known limit |
 *
 * develop wrote nothing and the second composer sent to the changed To in one press. The last column's
 * known limit is recorded as today's behaviour (named, not hidden): with not even the short value
 * stored, another document reads no mark (`readRetargetTagState` is `known: true`, no tags).
 *
 * Negative control: the store works — the tag is stored as a list, the second composer asks too.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, act, cleanup, within } from '@testing-library/react';
import { MessageInput } from '@/components/worktree/MessageInput';
import { ApiError } from '@/lib/api-client';
import { mockCommandGroups } from '@tests/helpers/message-input-test-utils';
import { getInstanceDraftKey, readRetargetTagState, readRetargetTags, readRetargetUnstorable } from '@/lib/drafts/message-draft';
import { installStoreFaults, isDraftValueKey, releasePageMarks, shortValueLength, type StoreFaultRule } from '@tests/helpers/draft-store-fault-4604';
import type { CLIToolType } from '@/lib/cli-tools/types';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});
const { sendMessageMock, fetchStartPreviewMock } = vi.hoisted(() => ({ sendMessageMock: vi.fn(), fetchStartPreviewMock: vi.fn() }));
vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return { ...actual, worktreeApi: { ...actual.worktreeApi, sendMessage: sendMessageMock, uploadImageFile: vi.fn() } };
});
vi.mock('@/lib/handoff/screen-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/handoff/screen-client')>();
  return { ...actual, fetchStartPreview: fetchStartPreviewMock };
});
vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: vi.fn(() => ({
    groups: mockCommandGroups, filteredGroups: mockCommandGroups, allCommands: [], loading: false, error: null, isCatalogStale: false,
  })),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

const WT = 'wt-4604-write-fail';
const I = 'codex-2';
const KEY = getInstanceDraftKey(WT, I);
const TEXT = 'hello';

function fence(): ApiError {
  return new ApiError('The send target changed', 409, {
    error: 'The send target changed',
    code: 'SEND_TARGET_CHANGED',
    reason: 'tool-changed',
    target: { worktreeId: WT, instanceId: I, cliToolId: 'codex' },
    current: null,
    requestId: 'r-1',
    sendOutcome: 'not_sent',
  });
}

const toast = vi.fn();
function Two({ tool }: { tool: CLIToolType }) {
  return (
    <>
      {(['one', 'two'] as const).map((name) => (
        <div key={name} data-testid={`composer-${name}`}>
          <MessageInput worktreeId={WT} cliToolId={tool} instanceId={I} draftScope="instance" isSessionRunning onMessageSent={vi.fn()} showToast={toast} />
        </div>
      ))}
    </>
  );
}
const ta = (name: 'one' | 'two') => within(screen.getByTestId(`composer-${name}`)).getByTestId('message-input-textarea') as HTMLTextAreaElement;
const band = (name: 'one' | 'two') => within(screen.getByTestId(`composer-${name}`)).queryByTestId('message-input-retarget-confirm');

async function settle(ms = 10) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  toast.mockReset();
  sendMessageMock.mockReset();
  sendMessageMock.mockRejectedValueOnce(fence());
  sendMessageMock.mockImplementation(async (_wt: string, content: string) => ({ id: 's', role: 'user', content, timestamp: new Date() }));
  fetchStartPreviewMock.mockReset();
  fetchStartPreviewMock.mockResolvedValue({ ok: true, show: false, attended: false });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  releasePageMarks([KEY]);
  window.localStorage.clear();
});

/** Composer one's awaited send is stopped by the fence under `rules`; then the tool changes. */
async function arrange(rules: StoreFaultRule[]) {
  window.localStorage.setItem(KEY, TEXT);
  const view = render(<Two tool="codex" />);
  await settle();
  expect(ta('two').value).toBe(TEXT);
  const faults = installStoreFaults(rules);
  act(() => {
    fireEvent.keyDown(ta('one'), { key: 'Enter', code: 'Enter' });
  });
  await settle(30);
  expect(sendMessageMock).toHaveBeenCalledTimes(1);
  // The roster read again: the instance's tool changed.
  view.rerender(<Two tool="claude" />);
  await settle();
  return faults;
}

describe('[#4604 a P2-2] the 409\'s tag cannot be written: the other composer of the draft asks', () => {
  it.each<[string, StoreFaultRule[], 'short' | 'page']>([
    // Issue #4604 S13: the tag goes into the draft's one value — the rules pick its key (the names are the
    // cases of before: a value with the tag does not fit, no value goes in).
    ['the store is full (a long :retarget value throws)', [{ method: 'setItem', key: isDraftValueKey, overBytes: shortValueLength(TEXT) }], 'short'],
    ['every :retarget setItem throws', [{ method: 'setItem', key: isDraftValueKey }], 'page'],
    ['every setItem throws', [{ method: 'setItem' }], 'page'],
  ])('%s — Enter in the second composer: POST 0 and the question', async (_name, rules, left) => {
    const faults = await arrange(rules);
    act(() => {
      fireEvent.keyDown(ta('two'), { key: 'Enter', code: 'Enter' });
    });
    await settle(30);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(band('two')).not.toBeNull();
    expect(ta('two').value).toBe(TEXT);
    faults.restore();
    if (left === 'short') {
      // Another tab reads the store: not known → it asks too.
      expect(readRetargetTagState(KEY).known).toBe(false);
      expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('宛先の確認を保存できません'), 'warning');
    } else {
      // The known limit (設計書 §4, 閉じない道): nothing is in the store for another tab to read.
      expect(readRetargetTagState(KEY)).toEqual({ tags: [], known: true });
      expect(readRetargetUnstorable(KEY)).not.toBeNull();
      expect(toast).toHaveBeenCalledWith(expect.stringContaining('宛先の確認を保存できません'), 'warning');
    }
  });

  it('a yes in the second composer sends once to this To and lets go of the generation it saw', async () => {
    const faults = await arrange([{ method: 'setItem', key: isDraftValueKey }]);
    act(() => {
      fireEvent.keyDown(ta('two'), { key: 'Enter', code: 'Enter' });
    });
    await settle(30);
    faults.restore();
    act(() => {
      within(screen.getByTestId('composer-two')).getByTestId('message-input-retarget-confirm-yes').click();
    });
    await settle(30);
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMock.mock.calls[1][2]).toMatchObject({ cliToolId: 'claude', instanceId: I });
    expect(readRetargetUnstorable(KEY)).toBeNull();
  });

  it('(negative control) the store works: the tag is a list in the store, and the second composer asks', async () => {
    await arrange([]);
    expect(readRetargetTags(KEY)).toHaveLength(1);
    act(() => {
      fireEvent.keyDown(ta('two'), { key: 'Enter', code: 'Enter' });
    });
    await settle(30);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(band('two')).not.toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });
});
