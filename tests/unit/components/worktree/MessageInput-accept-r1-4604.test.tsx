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

/*
 * ---------------------------------------------------------------------------------------------
 * Issue #4604 accept r1c (PM の処分: F1 は案 i). A composer takes in the marks another tab wrote (the
 * `storage` event); the marks it took in ask in it, but its own send does not let them go from the store
 * — only the marks it received itself (its 409, its handed-back text, its restore) go. Rows:
 *
 * - P1: a composer that asked only because of the marks it took in sends after its yes — the store keeps
 *   them (the review's `storeAfterARelease`).
 * - Two tabs, both real composers: the store's writes reach the other tab only, as a `StorageEvent`
 *   (a bridge: the `storage` listeners are held per composer, a write is the acting composer's, and its
 *   event goes to the other one; a write-back answered by a write-back is delivered too, up to a bound).
 *   U4-1 with a list tag and with the short "unknown": the second tab asks; after both tabs said yes
 *   once, their sends end asking (finite) and the store ends empty.
 * - O4: a page that hears no event (bfcache, frozen) — today's behaviour, pinned as a candidate for the
 *   known limit (人の判断待ち; not a safe-side expectation).
 * ---------------------------------------------------------------------------------------------
 */

describe('[#4604 accept r1c] P1 — the marks a composer took in are not let go by its own send', () => {
  it('a composer with a new text takes in another tab\'s tag, asks, says yes and sends: the store keeps the tag', async () => {
    window.localStorage.setItem(KEY, 'a new text');
    render(<One tool="claude" name="a" />);
    await settle();
    otherTabWrites(TAG_KEY, JSON.stringify([tag('t-a')]));
    await settle();
    enter('a');
    await settle(30);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(band('a')).not.toBeNull();
    yes('a');
    await settle(30);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(rawStore().get(TAG_KEY) ?? 'null')).toEqual([tag('t-a')]);
  });
});

describe('[#4604 accept r1c] two tabs (real composers, a storage-event bridge): U4-1 asks, and the asking ends', () => {
  type Tab = 'a' | 'b';
  let slots: Array<{ tab: Tab; listener: EventListener | null }>;
  let actor: Tab | null;
  let queue: Array<{ writer: Tab | null; oldValue: string | null; newValue: string | null }>;
  let fullStore: boolean;
  let delivered: number;
  const DELIVERY_BOUND = 40;
  // Three rounds of 600 ms saves and the bounded deliveries: past vitest's 5 s, a slow row would time out
  // and run into the next test.
  const BRIDGE_TIMEOUT_MS = 30_000;

  beforeEach(() => {
    slots = [{ tab: 'a', listener: null }, { tab: 'b', listener: null }];
    actor = null;
    queue = [];
    fullStore = false;
    delivered = 0;
    const realAdd = window.addEventListener.bind(window);
    const realRemove = window.removeEventListener.bind(window);
    // The composers' `storage` listeners of the draft's marks (the one that reads `retargetTagsRef`; other
    // hooks' `storage` listeners stay on the window), by slot: React runs every passive clean-up before
    // every set-up, so a listener added fills the first empty slot in tree order (a: first, b: second).
    const isMarksListener = (type: string, listener: EventListener) => type === 'storage' && String(listener).includes('retargetTagsRef');
    vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) => {
      if (!isMarksListener(type, listener)) return realAdd(type, listener, options);
      const slot = slots.find((s) => s.listener === null);
      if (!slot) throw new Error('a third storage listener');
      slot.listener = listener;
    }) as typeof window.addEventListener);
    vi.spyOn(window, 'removeEventListener').mockImplementation(((type: string, listener: EventListener, options?: boolean | EventListenerOptions) => {
      if (!isMarksListener(type, listener)) return realRemove(type, listener, options);
      const slot = slots.find((s) => s.listener === listener);
      if (slot) slot.listener = null;
    }) as typeof window.removeEventListener);
    const realGet = Storage.prototype.getItem;
    const realSet = Storage.prototype.setItem;
    const realRemoveItem = Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === TAG_KEY) {
        // U1-1: the store is full — a long `:retarget` value throws, the short "unknown" fits.
        if (fullStore && value.length > 60) throw new DOMException('full', 'QuotaExceededError');
        const oldValue = realGet.call(this, key);
        realSet.call(this, key, value);
        queue.push({ writer: actor, oldValue, newValue: value });
        return;
      }
      realSet.call(this, key, value);
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
      if (key === TAG_KEY) {
        const oldValue = realGet.call(this, key);
        realRemoveItem.call(this, key);
        if (oldValue !== null) queue.push({ writer: actor, oldValue, newValue: null });
        return;
      }
      realRemoveItem.call(this, key);
    });
  });

  /** The other tab hears each write (a write it answers with is delivered in turn). */
  async function deliver() {
    while (queue.length > 0) {
      const write = queue.shift()!;
      for (const slot of slots) {
        if (slot.tab === write.writer || slot.listener === null) continue;
        delivered += 1;
        if (delivered > DELIVERY_BOUND) throw new Error('the two tabs write back and forth without end');
        actor = slot.tab;
        const listener = slot.listener;
        act(() => {
          listener(new StorageEvent('storage', { key: TAG_KEY, oldValue: write.oldValue, newValue: write.newValue, storageArea: window.localStorage }));
        });
        actor = null;
      }
      await settle();
    }
  }
  /** `tab` acts (its writes are its own), then the other tab hears them. */
  async function as(tab: Tab, fn: () => void, ms = 30) {
    actor = tab;
    fn();
    await settle(ms);
    actor = null;
    await deliver();
  }
  function Tabs({ tool }: { tool: CLIToolType }) {
    return (
      <>
        <One tool={tool} name="a" />
        <One tool={tool} name="b" />
      </>
    );
  }
  /** Each tab, in turn, types a new text and presses Enter (a yes when asked); whether each asked. */
  async function round(): Promise<Record<Tab, boolean>> {
    const asked: Record<Tab, boolean> = { a: false, b: false };
    for (const tab of ['a', 'b'] as const) {
      await as(tab, () => {
        fireEvent.change(ta(tab), { target: { value: `new text ${tab} ${sendMessageMock.mock.calls.length}` } });
      }, 600);
      const before = sendMessageMock.mock.calls.length;
      await as(tab, () => enter(tab));
      if (band(tab)) {
        asked[tab] = true;
        expect(sendMessageMock.mock.calls.length).toBe(before);
        await as(tab, () => yes(tab));
      }
      expect(sendMessageMock.mock.calls.length).toBe(before + 1);
    }
    return asked;
  }

  /** r1d: `bTypesFirst` — B types (its save runs) before its first Enter, as a person who edits it does. */
  /**
   * r1d: `pinEveryRound` — instead of the asking ending, pin that each of three rounds asks in both tabs
   * (and each send still goes once, after its yes): today's behaviour of a known-limit candidate.
   */
  async function u41(full: boolean, bTypesFirst = false, pinEveryRound = false) {
    window.localStorage.setItem(KEY, TEXT);
    sendMessageMock.mockRejectedValueOnce(fence());
    const view = render(<Tabs tool="codex" />);
    await settle();
    expect(slots.every((s) => s.listener !== null)).toBe(true);
    expect(ta('b').value).toBe(TEXT);
    // Tab A's awaited send to X is stopped by the fence (the store full or not).
    fullStore = full;
    await as('a', () => enter('a'));
    fullStore = false;
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    // Both tabs read the roster again: X's tool changed.
    view.rerender(<Tabs tool="claude" />);
    await settle();
    // Tab A asks, says yes and sends.
    await as('a', () => enter('a'));
    expect(band('a')).not.toBeNull();
    await as('a', () => yes('a'));
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMock.mock.calls[1][2]).toMatchObject({ cliToolId: 'claude', instanceId: I });
    // Tab B still shows the same text: its Enter asks (POST 0).
    expect(ta('b').value).toBe(TEXT);
    if (bTypesFirst) {
      await as('b', () => {
        fireEvent.change(ta('b'), { target: { value: `${TEXT} more` } });
      }, 600);
    }
    await as('b', () => enter('b'));
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(band('b')).not.toBeNull();
    await as('b', () => yes('b'));
    expect(sendMessageMock).toHaveBeenCalledTimes(3);
    // The asking ends: within three rounds of new texts, a round where neither tab asks; the store ends empty.
    if (pinEveryRound) {
      const rounds: Array<Record<Tab, boolean>> = [];
      for (let i = 0; i < 3; i += 1) rounds.push(await round());
      expect(rounds).toEqual([{ a: true, b: true }, { a: true, b: true }, { a: true, b: true }]);
      expect(sendMessageMock).toHaveBeenCalledTimes(9);
      return;
    }
    let last: Record<Tab, boolean> = { a: true, b: true };
    for (let i = 0; i < 3 && (last.a || last.b); i += 1) last = await round();
    expect(last).toEqual({ a: false, b: false });
    expect(rawStore().get(TAG_KEY)).toBeNull();
  }

  it('a list tag (the store works)', async () => {
    await u41(false);
  }, BRIDGE_TIMEOUT_MS);

  it('the short "unknown" (U1-1: a long :retarget value throws at the 409)', async () => {
    await u41(true);
  }, BRIDGE_TIMEOUT_MS);

  // r1d (INV-S1 の広げ): B edits the text before its first send (its save writes the text) — still asks,
  // and the asking ends once each tab, in turn, types a new text and sends.
  it('INV-S1 の広げ — a list tag, B types before its first send: it asks, and the asking ends', async () => {
    await u41(false, true);
  }, BRIDGE_TIMEOUT_MS);

  // 既知の限界の候補（人の判断待ち、#4604 受け入れ r1d）: 保存の空きが足りず短い「分からない」しか書けない
  // 時、2 つのタブで打っては送ると毎回確かめる（安全側）。Each tab's save makes the "unknown" it took in its
  // own (a new generation), the other tab takes that in, and a yes to an "unknown" is for one send — so
  // while both tabs type before they send, every send asks. Pinned as today's behaviour (not an end).
  it('INV-S1 の広げ — the short "unknown", B types before its first send: while both tabs type then send, every send asks (known-limit candidate, 人の判断待ち)', async () => {
    await u41(true, true, true);
  }, BRIDGE_TIMEOUT_MS);
});

describe('[#4604 accept r1c] O4 — a page that hears no event (known limit candidate, 人の判断待ち)', () => {
  it('today: the store took the tag and let it go with no event reaching this page — its Enter sends (POST 1, no question)', async () => {
    window.localStorage.setItem(KEY, TEXT);
    const view = render(<One tool="codex" />);
    await settle();
    // Another tab's 409 and its send after a yes, while this page was frozen (no `StorageEvent`).
    rawStore().set(TAG_KEY, JSON.stringify([tag('t-a')]));
    view.rerender(<One tool="claude" />);
    await settle();
    rawStore().remove(KEY);
    rawStore().remove(TAG_KEY);
    enter('b');
    await settle(30);
    // Pinned as today's behaviour (not the safe side): the design's §3.4.1 does not decide this road yet.
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][2]).toMatchObject({ cliToolId: 'claude', instanceId: I });
    expect(band('b')).toBeNull();
  });
});

/*
 * ---------------------------------------------------------------------------------------------
 * Issue #4604 accept r1d (PM の処分: F1 は案 A = 案 i + INV-S1 の広げ). INV-S1 widened: a composer that
 * writes its text into the store writes first the marks it holds then — the ones it received and the ones
 * it took in — and the ones it took in become its own (its send lets them go). So while the store holds the
 * text, it holds the text's marks: whoever opens the text asks. Rows Q1〜Q5 (the review's probe2):
 * B took in A's mark, A sent (text, then marks, went from the store), B typed (its save wrote the text).
 * ---------------------------------------------------------------------------------------------
 */
describe('[#4604 accept r1d] INV-S1 の広げ — the text B saves keeps the marks it took in', () => {
  const type = (name: string, v: string) => act(() => {
    fireEvent.change(ta(name), { target: { value: v } });
  });
  /** B shows the draft; A's 409 puts `aMarks` in (event); the tool changes; A sends (event); B types and saves. */
  async function tookInThenASendsThenBSaves(aMarks: string) {
    window.localStorage.setItem(KEY, TEXT);
    const view = render(<One tool="codex" />);
    await settle();
    otherTabWrites(TAG_KEY, aMarks);
    await settle();
    view.rerender(<One tool="claude" />);
    await settle();
    otherTabWrites(KEY, null);
    otherTabWrites(TAG_KEY, null);
    await settle();
    type('b', `${TEXT} more`);
    await settle(700);
    expect(rawStore().get(KEY)).toBe(`${TEXT} more`);
    return view;
  }
  const LIST = JSON.stringify([tag('t-a')]);
  const UNKNOWN = JSON.stringify({ unknown: 'g-a', tags: [] });

  it('Q1: the saved text has its mark in the store; after a reload, Enter asks (POST 0)', async () => {
    await tookInThenASendsThenBSaves(LIST);
    expect(readRetargetTagState(KEY)).toEqual({ tags: [tag('t-a')], known: true });
    cleanup();
    render(<One tool="claude" />);
    await settle();
    expect(ta('b').value).toBe(`${TEXT} more`);
    enter('b');
    await settle(30);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(band('b')).not.toBeNull();
  });

  it('Q2: the tile switches away and back: Enter asks (POST 0)', async () => {
    const view = await tookInThenASendsThenBSaves(LIST);
    view.rerender(<One tool="claude" instanceId={I2} />);
    await settle();
    view.rerender(<One tool="claude" instanceId={I} />);
    await settle();
    expect(ta('b').value).toBe(`${TEXT} more`);
    enter('b');
    await settle(30);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(band('b')).not.toBeNull();
  });

  it('Q3: a new composer opens the saved text: its Enter asks (POST 0)', async () => {
    await tookInThenASendsThenBSaves(LIST);
    cleanup();
    render(<One tool="claude" name="c" />);
    await settle();
    expect(ta('c').value).toBe(`${TEXT} more`);
    enter('c');
    await settle(30);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(band('c')).not.toBeNull();
  });

  it('Q5: the "unknown" B took in — the saved text is "unknown" in the store; after a reload, Enter asks (POST 0)', async () => {
    await tookInThenASendsThenBSaves(UNKNOWN);
    expect(readRetargetTagState(KEY).known).toBe(false);
    cleanup();
    render(<One tool="claude" />);
    await settle();
    enter('b');
    await settle(30);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(band('b')).not.toBeNull();
  });

  it('Q1 then B\'s own send: the mark it made its own goes (the store ends empty), its next text is not asked about', async () => {
    await tookInThenASendsThenBSaves(LIST);
    enter('b');
    await settle(30);
    expect(band('b')).not.toBeNull();
    yes('b');
    await settle(30);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(rawStore().get(TAG_KEY)).toBeNull();
    type('b', 'next one');
    await settle(700);
    enter('b');
    await settle(30);
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(band('b')).toBeNull();
  });

  it('Q4: the owner never sends (A\'s "unknown" stays in the store), B sends new texts: the asking ends, the store ends empty', async () => {
    window.localStorage.setItem(KEY, 'b text');
    render(<One tool="claude" />);
    await settle();
    otherTabWrites(TAG_KEY, UNKNOWN);
    await settle();
    const asks: boolean[] = [];
    for (let i = 0; i < 3; i += 1) {
      type('b', `b text ${i}`);
      await settle();
      enter('b');
      await settle(30);
      asks.push(band('b') !== null);
      if (band('b')) {
        yes('b');
        await settle(30);
      }
    }
    expect(asks.at(-1)).toBe(false);
    expect(sendMessageMock).toHaveBeenCalledTimes(3);
    expect(rawStore().get(TAG_KEY)).toBeNull();
  });
});
