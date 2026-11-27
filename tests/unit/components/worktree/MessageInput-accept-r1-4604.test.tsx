/**
 * Issue #4604 受け入れ r1 (審判 s12-ui の F1〜F3; 設計書 §3.4.1「保存の失敗」「閉じない道」, #4604 コメント 7185751687).
 *
 * - T-F1 (U4-1, INV-V2b): this document is tab B; tab A is another document — it writes the store alone and
 *   B hears the `StorageEvent` (`otherTabWrites`). B shows the draft (mounted before A's 409). A's send is
 *   stopped by the fence (the tag goes into the store), the To changes, A says yes and sends (its text and
 *   its marks go from the store). B still shows the same text: its next Enter asks, POST 0. Only B's own
 *   send lets the question go. The same for an "unknown" A's store held.
 *   Control (green before the fix): B opened after the 409 (it read the tag at its restore) asks.
 * - T-F2 (U1-1, a P2-2): only the list of tags cannot be written (a long `:retarget` value throws) and
 *   the short "unknown" goes in — a toast says so, with its own sentence (`retargetPartiallyStored`), and
 *   that sentence is true: this tab's other composer and a composer that reads the store afresh both ask
 *   (POST 0). When not even the "unknown" goes in: `retargetUnstored` as before. When it is written:
 *   neither toast. The optimistic road's handed-back text (`returnRetargetedText`) says so too.
 * - T-F3 (U5-2): the two write-backs keep the mark in the store — pinned by the store's value (the
 *   judge's mutations M1 `storage` and M2 the switch turn these red).
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, act, cleanup, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MessageInput } from '@/components/worktree/MessageInput';
import { ApiError } from '@/lib/api-client';
import { mockCommandGroups } from '@tests/helpers/message-input-test-utils';
import {
  getInstanceDraftKey,
  getRetargetTagKey,
  newRetargetTag,
  readRetargetTagState,
  returnRetargetedText,
  type RetargetTag,
} from '@/lib/drafts/message-draft';
import { installStoreFaults, isRetargetKey, otherTabWrites, rawStore, releasePageMarks, type StoreFaultRule } from '@tests/helpers/draft-store-fault-4604';
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

const WT = 'wt-4604-accept-r1';
const I = 'codex-2';
const I2 = 'codex-3';
const KEY = getInstanceDraftKey(WT, I);
const KEY2 = getInstanceDraftKey(WT, I2);
const TAG_KEY = getRetargetTagKey(KEY);
const TEXT = 'TABS tile hello';
const ORIGINAL = { instanceId: I, cliToolId: 'codex' };

const PARTIAL_JA = '宛先の確認を保存に書けませんでした。このタブとほかのタブは、送る前にもう一度確かめます';
const PARTIAL_EN = 'The target check could not be saved in full. This tab and other tabs will ask again before sending';
const UNSTORED_JA = '宛先の確認を保存できません';

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
const tag = (id: string): RetargetTag => ({ id, original: { ...ORIGINAL } });

function One({ tool, instanceId = I, name = 'b' }: { tool: CLIToolType; instanceId?: string; name?: string }) {
  return (
    <div data-testid={`composer-${name}`}>
      <MessageInput worktreeId={WT} cliToolId={tool} instanceId={instanceId} draftScope="instance" isSessionRunning onMessageSent={vi.fn()} showToast={toast} />
    </div>
  );
}
const ta = (name: string) => within(screen.getByTestId(`composer-${name}`)).getByTestId('message-input-textarea') as HTMLTextAreaElement;
const band = (name: string) => within(screen.getByTestId(`composer-${name}`)).queryByTestId('message-input-retarget-confirm');
const enter = (name: string) => act(() => {
  fireEvent.keyDown(ta(name), { key: 'Enter', code: 'Enter' });
});
const yes = (name: string) => act(() => {
  within(screen.getByTestId(`composer-${name}`)).getByTestId('message-input-retarget-confirm-yes').click();
});

async function settle(ms = 10) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const toasted = (text: string) => toast.mock.calls.some(([message]) => typeof message === 'string' && message.includes(text));

beforeEach(() => {
  window.localStorage.clear();
  toast.mockReset();
  sendMessageMock.mockReset();
  sendMessageMock.mockImplementation(async (_wt: string, content: string) => ({ id: 's', role: 'user', content, timestamp: new Date() }));
  fetchStartPreviewMock.mockReset();
  fetchStartPreviewMock.mockResolvedValue({ ok: true, show: false, attended: false });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  releasePageMarks([KEY, KEY2]);
  window.localStorage.clear();
});

describe('[#4604 accept r1 T-F1] another tab sent the draft after a yes: this tab, still showing the text, asks', () => {
  /** B shows the draft; then tab A's 409 puts `aMarks` into the store; the tool changes; A sends after its yes. */
  async function arrange(aMarks: string) {
    window.localStorage.setItem(KEY, TEXT);
    const view = render(<One tool="codex" />);
    await settle();
    expect(ta('b').value).toBe(TEXT);
    // Tab A: its send to X was stopped by the fence — its mark goes into the store (B hears the event).
    otherTabWrites(TAG_KEY, aMarks);
    await settle();
    // Both tabs read the roster again: X's tool changed.
    view.rerender(<One tool="claude" />);
    await settle();
    // Tab A: asked, said yes and sent (POST 1 in A) — its text goes first, then the marks it saw.
    otherTabWrites(KEY, null);
    otherTabWrites(TAG_KEY, null);
    await settle();
    expect(ta('b').value).toBe(TEXT);
    return view;
  }

  it('a list tag: B\'s Enter is POST 0 and the question', async () => {
    await arrange(JSON.stringify([tag('t-a')]));
    enter('b');
    await settle(30);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(band('b')).not.toBeNull();
    expect(ta('b').value).toBe(TEXT);
  });

  it('an "unknown" (A could not keep the list): B\'s Enter is POST 0 and the question', async () => {
    await arrange(JSON.stringify({ unknown: 'g-a', tags: [] }));
    enter('b');
    await settle(30);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(band('b')).not.toBeNull();
  });

  it('only B\'s own send lets it go: yes → POST 1 to this To, then B\'s next text is not asked about', async () => {
    await arrange(JSON.stringify([tag('t-a')]));
    enter('b');
    await settle(30);
    expect(band('b')).not.toBeNull();
    yes('b');
    await settle(30);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][2]).toMatchObject({ cliToolId: 'claude', instanceId: I });
    act(() => {
      fireEvent.change(ta('b'), { target: { value: 'next one' } });
    });
    enter('b');
    await settle(30);
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(band('b')).toBeNull();
  });

  it('(control) B opened after A\'s 409 (it read the tag at its restore): it asks', async () => {
    window.localStorage.setItem(KEY, TEXT);
    window.localStorage.setItem(TAG_KEY, JSON.stringify([tag('t-a')]));
    render(<One tool="claude" />);
    await settle();
    otherTabWrites(KEY, null);
    otherTabWrites(TAG_KEY, null);
    await settle();
    enter('b');
    await settle(30);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(band('b')).not.toBeNull();
  });
});

describe('[#4604 accept r1 T-F2] only the short "unknown" went in: a toast says so, and what it says is true', () => {
  function Two({ tool }: { tool: CLIToolType }) {
    return (
      <>
        <One tool={tool} name="one" />
        <One tool={tool} name="two" />
      </>
    );
  }
  /** Composer one's awaited send is stopped by the fence under `rules`; then the tool changes. */
  async function arrange(rules: StoreFaultRule[]) {
    sendMessageMock.mockRejectedValueOnce(fence());
    window.localStorage.setItem(KEY, TEXT);
    const view = render(<Two tool="codex" />);
    await settle();
    const faults = installStoreFaults(rules);
    enter('one');
    await settle(30);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    view.rerender(<Two tool="claude" />);
    await settle();
    return { faults, view };
  }

  it('the sentence of the new key (ja and en)', () => {
    const read = (lang: string) => JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'locales', lang, 'worktree.json'), 'utf8'));
    expect(read('ja').conversation.sendTargetChanged.retargetPartiallyStored).toBe(PARTIAL_JA);
    expect(read('en').conversation.sendTargetChanged.retargetPartiallyStored).toBe(PARTIAL_EN);
  });

  it('a long :retarget value throws (U1-1): the new toast, not the old one; the other composer and a fresh reader ask (POST 0)', async () => {
    const { faults } = await arrange([{ method: 'setItem', key: isRetargetKey, overBytes: 60 }]);
    expect(readRetargetTagState(KEY).known).toBe(false);
    expect(toasted(PARTIAL_JA)).toBe(true);
    expect(toasted(UNSTORED_JA)).toBe(false);
    // This tab's other composer.
    enter('two');
    await settle(30);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(band('two')).not.toBeNull();
    faults.restore();
    // Another tab: a composer that reads the store afresh (this page holds no mark of its own here).
    cleanup();
    render(<One tool="claude" name="fresh" />);
    await settle();
    expect(ta('fresh').value).toBe(TEXT);
    enter('fresh');
    await settle(30);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(band('fresh')).not.toBeNull();
  });

  it('not even the "unknown" goes in: the old toast only', async () => {
    await arrange([{ method: 'setItem', key: isRetargetKey }]);
    expect(toasted(UNSTORED_JA)).toBe(true);
    expect(toasted(PARTIAL_JA)).toBe(false);
  });

  it('(negative control) the store works: neither toast', async () => {
    await arrange([]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('the optimistic road: a handed-back text whose tag went in only as the short "unknown" says so too', async () => {
    window.localStorage.setItem(KEY, '');
    render(<One tool="claude" />);
    await settle();
    const faults = installStoreFaults([{ method: 'setItem', key: isRetargetKey, overBytes: 60 }]);
    let handed = false;
    act(() => {
      handed = returnRetargetedText(KEY, { text: TEXT, tag: newRetargetTag(ORIGINAL) });
    });
    await settle();
    faults.restore();
    expect(handed).toBe(true);
    expect(ta('b').value).toBe(TEXT);
    expect(toasted(PARTIAL_JA)).toBe(true);
    enter('b');
    await settle(30);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(band('b')).not.toBeNull();
  });
});

describe('[#4604 accept r1 T-F3] the write-backs put the mark back into the store (pinned by its value)', () => {
  it('M1 — `storage`: another tab let the tags go, this composer still holds them: the store has them again', async () => {
    window.localStorage.setItem(KEY, TEXT);
    window.localStorage.setItem(TAG_KEY, JSON.stringify([tag('t-held')]));
    render(<One tool="claude" />);
    await settle();
    otherTabWrites(TAG_KEY, null);
    await settle();
    expect(JSON.parse(rawStore().get(TAG_KEY) ?? 'null')).toEqual([tag('t-held')]);
  });

  it('M2 — the switch: the store lost the tags before its event came, the tile switches: the previous key has them again', async () => {
    window.localStorage.setItem(KEY, TEXT);
    window.localStorage.setItem(TAG_KEY, JSON.stringify([tag('t-held')]));
    const view = render(<One tool="claude" />);
    await settle();
    // Another tab's release, whose `StorageEvent` has not come yet: the store alone changed.
    rawStore().remove(TAG_KEY);
    view.rerender(<One tool="claude" instanceId={I2} />);
    await settle();
    expect(JSON.parse(rawStore().get(TAG_KEY) ?? 'null')).toEqual([tag('t-held')]);
  });
});
