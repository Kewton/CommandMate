/**
 * Issue #4607 (INV-V2c', 設計書 §3.4.1): the send's check reads the draft's stored tags too — the
 * tags in this composer's state ∪ the ones stored next to the draft (`<draftKey>:retarget`), and a
 * store it cannot read asks. On the three draft keys a composer uses: a PC split pane (`splitIndex`
 * 1), the single composer of the mobile / one-pane page (`splitIndex` 0) and a `/sessions` tile
 * (`draftScope="instance"`).
 *
 * - T4 (another tab): the composer holds the text but no tag in its state; another tab stored a tag
 *   whose original target is not this To (with and without the `storage` event) → Enter once POSTs
 *   nothing and asks; cancelled POSTs nothing; yes POSTs once to this To.
 * - T5 (unreadable): `getItem` of `<draftKey>:retarget` throws, or it holds broken JSON, a value that
 *   is not an array, an element of another shape → Enter once POSTs nothing and asks; yes POSTs once;
 *   the next send asks again (the yes holds for that one send only — through the brief choice too).
 * - T6 (positive control): the store readable with no tag, or a tag for this very To → no question,
 *   POST once.
 * - r2 (reviews a P2-1, b P2-1〜P2-4・P3-3): the one-send yes to an unreadable store is never left for
 *   a later send — a stop before the POST (#4503's hold, the brief choice's hold), the brief closed
 *   (Escape, its close button), the To changed under the brief; the brief choice reads the store
 *   again; a yes is for the tags that were asked about (a tag that came later asks); the mobile
 *   [send] button asks the same.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, waitFor, act, cleanup } from '@testing-library/react';
import { MessageInput } from '@/components/worktree/MessageInput';
import { mockCommandGroups, getTextarea, typeMessage, pressEnter } from '@tests/helpers/message-input-test-utils';
import { getDraftValueKey, getInstanceDraftKey, getRetargetTagKey, getSplitDraftKey, readRetargetTags, writeRetarget } from '@/lib/drafts/message-draft';
import { draftValue, releasePageMarks } from '@tests/helpers/draft-store-fault-4604';
import type { CLIToolType } from '@/lib/cli-tools/types';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

const { sendMessageMock, fetchStartPreviewMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  fetchStartPreviewMock: vi.fn(),
}));

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    worktreeApi: { ...actual.worktreeApi, sendMessage: sendMessageMock, uploadImageFile: vi.fn() },
  };
});

vi.mock('@/lib/handoff/screen-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/handoff/screen-client')>();
  return { ...actual, fetchStartPreview: fetchStartPreviewMock };
});

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

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mobile.value }));

const WT = 'wt-4607-stored';
const TEXT = 'hello agent';
const NOT_SHOWN = { ok: true, show: false, attended: false };
const SHOWN = {
  ok: true,
  show: true,
  attended: true,
  injectOnStart: true,
  mode: 'on',
  boundary: { id: 'b-1', kind: 'launch' },
  preview: { open: { count: 1, unreflected: 1 }, humanQuestions: { count: 0, unknownSources: [] }, lastUpdatedAt: null },
};

interface Target {
  id: string;
  tool: CLIToolType;
}

const ORIGINAL: Target = { id: 'codex-2', tool: 'codex' };
const CURRENT: Target = { id: 'claude-2', tool: 'claude' };

interface Shape {
  name: string;
  props: { splitIndex?: number; draftScope?: 'split' | 'instance' };
  key: string;
}

const SHAPES: Shape[] = [
  { name: 'a PC split pane (splitIndex 1)', props: { splitIndex: 1 }, key: getSplitDraftKey(WT, 1) },
  { name: 'the mobile / one-pane composer (splitIndex 0)', props: { splitIndex: 0 }, key: getSplitDraftKey(WT, 0) },
  { name: 'a /sessions tile (instance draft)', props: { draftScope: 'instance' }, key: getInstanceDraftKey(WT, CURRENT.id) },
];

function tagOf(id: string, original: Target) {
  return { id, original: { instanceId: original.id, cliToolId: original.tool } };
}

async function settle(ms = 10) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function created() {
  return { id: `s-${sendMessageMock.mock.calls.length}`, role: 'user', content: TEXT, timestamp: new Date() };
}

beforeEach(() => {
  mobile.value = false;
  window.localStorage.clear();
  sendMessageMock.mockReset();
  sendMessageMock.mockImplementation(async () => created());
  fetchStartPreviewMock.mockReset();
  fetchStartPreviewMock.mockResolvedValue(NOT_SHOWN);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe.each(SHAPES)('[#4607] $name', ({ props, key }) => {
  const tagKey = getRetargetTagKey(key);
  // Issue #4604 S13: the draft's one value (its text and its marks).
  const valueKey = getDraftValueKey(key);

  function renderComposer() {
    return render(
      <MessageInput worktreeId={WT} cliToolId={CURRENT.tool} instanceId={CURRENT.id} isSessionRunning onMessageSent={vi.fn()} {...props} />,
    );
  }

  /** `getItem` of this draft's tag key alone throws; every other key reads as usual. */
  // Issue #4604 S13: the tags are in the draft's one value — its key is the one that throws.
  function throwOnTagKey() {
    const real = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, k: string) {
      if (k === valueKey) throw new DOMException('denied', 'SecurityError');
      return real.call(this, k);
    });
  }

  function expectSentToCurrent(call: unknown[]) {
    expect(call[0]).toBe(WT);
    expect(call[1]).toBe(TEXT);
    expect(call[2]).toEqual(expect.objectContaining({ cliToolId: CURRENT.tool, instanceId: CURRENT.id }));
  }

  describe.each([
    ['with the storage event', true],
    ['without the storage event', false],
  ])('T4 another tab stored a tag (original ≠ To), %s', (_n, withEvent) => {
    async function arrange() {
      renderComposer();
      typeMessage(TEXT);
      await settle();
      const raw = JSON.stringify([tagOf('other-tab-1', ORIGINAL)]);
      window.localStorage.setItem(tagKey, raw);
      if (withEvent) {
        act(() => {
          window.dispatchEvent(new StorageEvent('storage', { key: tagKey, newValue: raw }));
        });
      }
      await settle();
    }

    it('Enter once POSTs nothing and asks (both targets named); cancelled POSTs nothing', async () => {
      await arrange();
      pressEnter();
      await settle();
      expect(sendMessageMock).not.toHaveBeenCalled();
      const confirm = await screen.findByTestId('message-input-retarget-confirm');
      expect(confirm.textContent).toContain(ORIGINAL.id);
      expect(confirm.textContent).toContain(CURRENT.id);
      fireEvent.click(screen.getByTestId('message-input-retarget-confirm-no'));
      await settle();
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(getTextarea().value).toBe(TEXT);
    });

    it('yes POSTs once, to this To; the stored tag stays (V2b: only its own tags go)', async () => {
      await arrange();
      pressEnter();
      await screen.findByTestId('message-input-retarget-confirm');
      fireEvent.click(screen.getByTestId('message-input-retarget-confirm-yes'));
      await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
      await settle();
      expectSentToCurrent(sendMessageMock.mock.calls[0]);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      // Issue #4604 S13: read from the draft's one value.
      expect(readRetargetTags(key)).toEqual([tagOf('other-tab-1', ORIGINAL)]);
    });
  });

  describe('T5 the stored tags cannot be read', () => {
    it.each([
      ['getItem throws', () => undefined, true],
      ['broken JSON', (k: string) => window.localStorage.setItem(k, '[{"id":'), false],
      ['not an array', (k: string) => window.localStorage.setItem(k, '{"id":"x"}'), false],
      ['an element of another shape', (k: string) => window.localStorage.setItem(k, JSON.stringify([{ id: 'x', original: 3 }])), false],
    ])('%s: Enter once POSTs nothing and asks; cancelled POSTs nothing', async (_n, store, throws) => {
      store(tagKey);
      if (throws) throwOnTagKey();
      renderComposer();
      typeMessage(TEXT);
      await settle();
      pressEnter();
      await settle();
      expect(sendMessageMock).not.toHaveBeenCalled();
      const confirm = await screen.findByTestId('message-input-retarget-confirm');
      expect(confirm.textContent).toContain(CURRENT.id);
      fireEvent.click(screen.getByTestId('message-input-retarget-confirm-no'));
      await settle();
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(getTextarea().value).toBe(TEXT);
    });

    it('yes POSTs once to this To; the next send asks again (every time)', async () => {
      throwOnTagKey();
      renderComposer();
      typeMessage(TEXT);
      await settle();
      pressEnter();
      await screen.findByTestId('message-input-retarget-confirm');
      fireEvent.click(screen.getByTestId('message-input-retarget-confirm-yes'));
      await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
      await settle();
      expectSentToCurrent(sendMessageMock.mock.calls[0]);
      await waitFor(() => expect(getTextarea().value).toBe(''));
      expect(screen.queryByTestId('message-input-retarget-confirm')).toBeNull();

      typeMessage(TEXT);
      await settle();
      pressEnter();
      await settle();
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('message-input-retarget-confirm')).toBeInTheDocument();
    });

    it('yes holds through the brief choice of that one send (POST once), then asks again', async () => {
      throwOnTagKey();
      fetchStartPreviewMock.mockResolvedValue(SHOWN);
      renderComposer();
      typeMessage(TEXT);
      await settle();
      pressEnter();
      await screen.findByTestId('message-input-retarget-confirm');
      fireEvent.click(screen.getByTestId('message-input-retarget-confirm-yes'));
      fireEvent.click(await screen.findByTestId('session-start-brief-decline'));
      await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
      await settle();
      expect(sendMessageMock.mock.calls[0][1]).toBe(TEXT);
      expect(screen.queryByTestId('message-input-retarget-confirm')).toBeNull();
      await waitFor(() => expect(getTextarea().value).toBe(''));

      fetchStartPreviewMock.mockResolvedValue(NOT_SHOWN);
      typeMessage(TEXT);
      await settle();
      pressEnter();
      await settle();
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('message-input-retarget-confirm')).toBeInTheDocument();
    });
  });

  describe('T6 (positive control) nothing asks', () => {
    it.each([
      ['the store readable, no tag', () => undefined],
      ['the store readable, an empty array', (k: string) => window.localStorage.setItem(k, '[]')],
      ['a stored tag for this very To', (k: string) => window.localStorage.setItem(k, JSON.stringify([tagOf('same-1', CURRENT)]))],
    ])('%s: Enter once POSTs once, to this To, no question', async (_n, store) => {
      store(tagKey);
      renderComposer();
      typeMessage(TEXT);
      await settle();
      pressEnter();
      await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
      await settle();
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expectSentToCurrent(sendMessageMock.mock.calls[0]);
      expect(screen.queryByTestId('message-input-retarget-confirm')).toBeNull();
    });
  });
  describe('r2 the one-send yes is never left for a later send', () => {
    const OTHER: Target = { id: 'codex-3', tool: 'codex' };
    const previewKey = `${WT}\u0000${CURRENT.id}`;

    /** `getItem` of any draft's tag key throws while `state.unreadable`; every other key as usual. */
    // Issue #4604 S13: the tags are in a draft's one value — its key is the one that throws.
    function switchableTagStore() {
      const state = { unreadable: true };
      const real = Storage.prototype.getItem;
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, k: string) {
        if (state.unreadable && k.endsWith(':value')) throw new DOMException('denied', 'SecurityError');
        return real.call(this, k);
      });
      return state;
    }

    async function askedThenYes() {
      typeMessage(TEXT);
      await settle();
      pressEnter();
      await screen.findByTestId('message-input-retarget-confirm');
      fireEvent.click(screen.getByTestId('message-input-retarget-confirm-yes'));
    }

    async function expectAsksWithoutPost(posts = 0) {
      await settle();
      expect(sendMessageMock).toHaveBeenCalledTimes(posts);
      expect(screen.getByTestId('message-input-retarget-confirm')).toBeInTheDocument();
    }

    it('A: a yes held by #4503 before the POST is not spent on another text — Enter POSTs nothing and asks', async () => {
      // Issue #4604 S13: the #4503 mark is in the draft's one value with its tags, so a value that cannot be
      // read hides it too — the tags not known here are this page's mark (nothing could be stored), and
      // the value stays readable for the #4503 mark.
      const throwing = { getItem: () => null, setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('full'); } };
      writeRetarget(key, { kind: 'add', tags: [tagOf('t-page', ORIGINAL)] }, { storage: throwing });
      renderComposer();
      typeMessage(TEXT);
      await settle();
      pressEnter();
      await screen.findByTestId('message-input-retarget-confirm');
      // Meanwhile another composer of the same draft marked the same text's send as unknown here.
      window.localStorage.setItem(valueKey, draftValue({ text: TEXT, sendMark: { text: TEXT, target: previewKey } }));
      fireEvent.click(screen.getByTestId('message-input-retarget-confirm-yes'));
      await settle();
      expect(sendMessageMock).not.toHaveBeenCalled();

      typeMessage('another text');
      await settle();
      pressEnter();
      await expectAsksWithoutPost();
      releasePageMarks([key]);
    });

    it('B: a yes carried to the brief, held at its choice by a new tag, is not spent later — Enter POSTs nothing and asks', async () => {
      const store = switchableTagStore();
      fetchStartPreviewMock.mockResolvedValue(SHOWN);
      renderComposer();
      await askedThenYes();
      await screen.findByTestId('session-start-brief-decline');
      // The store reads again, with a tag whose original target is not this To (S13: in the draft's value).
      store.unreadable = false;
      window.localStorage.setItem(valueKey, draftValue({ text: TEXT, tags: [tagOf('t-b', ORIGINAL)] }));
      fireEvent.click(screen.getByTestId('session-start-brief-decline'));
      await expectAsksWithoutPost();
      expect(screen.queryByTestId('session-start-brief-dialog')).toBeNull();
      fireEvent.click(screen.getByTestId('message-input-retarget-confirm-no'));
      // The store cannot be read again (the tag gone with it).
      store.unreadable = true;
      window.localStorage.removeItem(valueKey);
      fetchStartPreviewMock.mockResolvedValue(NOT_SHOWN);
      await settle();

      pressEnter();
      await expectAsksWithoutPost();
      expect(getTextarea().value).toBe(TEXT);
    });

    it.each([
      ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
      ['its close button', () => fireEvent.click(screen.getByRole('button', { name: '閉じる' }))],
    ])('b P2-1: a yes to an unreadable store, the brief closed by %s — the next Enter POSTs nothing and asks', async (_n, close) => {
      switchableTagStore();
      fetchStartPreviewMock.mockResolvedValue(SHOWN);
      renderComposer();
      await askedThenYes();
      await screen.findByTestId('session-start-brief-dialog');
      act(() => close());
      await waitFor(() => expect(screen.queryByTestId('session-start-brief-dialog')).toBeNull());
      fetchStartPreviewMock.mockResolvedValue(NOT_SHOWN);

      pressEnter();
      await expectAsksWithoutPost();
    });

    it('b P2-2: another tab stores a tag (original ≠ To) while the brief is up — its choice POSTs nothing and asks', async () => {
      fetchStartPreviewMock.mockResolvedValue(SHOWN);
      renderComposer();
      typeMessage(TEXT);
      await settle();
      pressEnter();
      await screen.findByTestId('session-start-brief-decline');
      // Issue #4604 S13: another tab writes the draft's one value.
      window.localStorage.setItem(valueKey, draftValue({ text: TEXT, tags: [tagOf('other-tab-1', ORIGINAL)] }));
      fireEvent.click(screen.getByTestId('session-start-brief-decline'));
      await expectAsksWithoutPost();
      expect(screen.getByTestId('message-input-retarget-confirm').textContent).toContain(ORIGINAL.id);
    });

    it('b P2-3: a tag stored while the question is up — yes asks again (for the new tag); the next yes POSTs once', async () => {
      window.localStorage.setItem(tagKey, JSON.stringify([tagOf('t-a', ORIGINAL)]));
      renderComposer();
      typeMessage(TEXT);
      await settle();
      pressEnter();
      await screen.findByTestId('message-input-retarget-confirm');
      // Issue #4604 S13: another tab writes the draft's one value.
      window.localStorage.setItem(valueKey, draftValue({ text: TEXT, tags: [tagOf('t-a', ORIGINAL), tagOf('t-b', OTHER)] }));
      fireEvent.click(screen.getByTestId('message-input-retarget-confirm-yes'));
      await expectAsksWithoutPost();

      fireEvent.click(screen.getByTestId('message-input-retarget-confirm-yes'));
      await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
      expectSentToCurrent(sendMessageMock.mock.calls[0]);
    });

    it('b P2-3: a tag stored after a yes was sent — the next Enter POSTs nothing and asks', async () => {
      window.localStorage.setItem(tagKey, JSON.stringify([tagOf('t-a', ORIGINAL)]));
      renderComposer();
      await askedThenYes();
      await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(getTextarea().value).toBe(''));
      // Issue #4604 S13: another tab writes the draft's one value.
      window.localStorage.setItem(valueKey, draftValue({ tags: [tagOf('t-a', ORIGINAL), tagOf('t-b', OTHER)] }));

      typeMessage(TEXT);
      await settle();
      pressEnter();
      await expectAsksWithoutPost(1);
    });

    it('b P2-4: a yes to an unreadable store, then the To changes under the brief — Enter POSTs nothing and asks', async () => {
      switchableTagStore();
      fetchStartPreviewMock.mockResolvedValue(SHOWN);
      const NEXT: Target = { id: 'claude-3', tool: 'claude' };
      const view = renderComposer();
      await askedThenYes();
      await screen.findByTestId('session-start-brief-dialog');
      view.rerender(
        <MessageInput worktreeId={WT} cliToolId={NEXT.tool} instanceId={NEXT.id} isSessionRunning onMessageSent={vi.fn()} {...props} />,
      );
      await waitFor(() => expect(screen.queryByTestId('session-start-brief-dialog')).toBeNull());
      fetchStartPreviewMock.mockResolvedValue(NOT_SHOWN);

      typeMessage(TEXT);
      await settle();
      pressEnter();
      await expectAsksWithoutPost();
      expect(screen.getByTestId('message-input-retarget-confirm').textContent).toContain(NEXT.id);
    });

    describe('b P3-3 the mobile [send] button', () => {
      function pressSend() {
        fireEvent.click(screen.getByTestId('send-message-button'));
      }

      it.each([
        ['T4 another tab stored a tag (original ≠ To)', () => window.localStorage.setItem(tagKey, JSON.stringify([tagOf('other-tab-1', ORIGINAL)]))],
        ['T5 the stored tags cannot be read', () => switchableTagStore()],
      ])('%s: the button once POSTs nothing and asks; cancelled POSTs nothing', async (_n, arrange) => {
        mobile.value = true;
        arrange();
        renderComposer();
        typeMessage(TEXT);
        await settle();
        pressSend();
        await expectAsksWithoutPost();
        fireEvent.click(screen.getByTestId('message-input-retarget-confirm-no'));
        await settle();
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(getTextarea().value).toBe(TEXT);
      });

      it('positive control: after a yes to a tag, the same tag (nothing new stored) — the next send asks nothing, POSTs once', async () => {
        mobile.value = true;
        window.localStorage.setItem(tagKey, JSON.stringify([tagOf('t-a', ORIGINAL)]));
        renderComposer();
        typeMessage(TEXT);
        await settle();
        pressSend();
        await screen.findByTestId('message-input-retarget-confirm');
        fireEvent.click(screen.getByTestId('message-input-retarget-confirm-yes'));
        await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(getTextarea().value).toBe(''));

        typeMessage(TEXT);
        await settle();
        pressSend();
        await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(2));
        await settle();
        expect(sendMessageMock).toHaveBeenCalledTimes(2);
        expectSentToCurrent(sendMessageMock.mock.calls[1]);
        expect(screen.queryByTestId('message-input-retarget-confirm')).toBeNull();
      });
    });
  });
});

/**
 * Issue #4607 r3 (INV-V2c'', 設計書 §3.4.1): a yes is for the To (instance and tool) it answered. The
 * To changes — the instance only, the tool only (the roster read again after a 409 `tool-changed`;
 * `previewKey` stays), or both — while the question is up, or after a yes (a stop before the POST, the
 * brief up, the preview being read): one press POSTs nothing and asks again, naming the To now.
 * Cancelled POSTs nothing; yes to the new question POSTs once, to the To now. The store readable (a
 * tag whose original is neither To) or not (`getItem` throws).
 *
 * The tile (instance draft) runs only the tool-only change: its draft key is the instance's, so an
 * instance change moves it to another draft (no handed-back text there — a different case).
 */
describe('[#4607 r3] a yes holds only for the To it answered', () => {
  const FROM: Target = CURRENT;
  type Change = 'instance' | 'tool' | 'both';
  const NEXT: Record<Change, Target> = {
    instance: { id: 'claude-3', tool: 'claude' },
    tool: { id: 'claude-2', tool: 'codex' },
    both: { id: 'claude-3', tool: 'codex' },
  };
  type Scene = 'band' | 'stopped' | 'brief' | 'reading';
  type Store = 'readable' | 'unreadable';
  const describe_ = (t: Target) => `${t.id} (${t.tool})`;

  const CASES: Array<[string, Shape, Change, Scene, Store]> = [];
  for (const shape of SHAPES) {
    const changes: Change[] = shape.props.draftScope === 'instance' ? ['tool'] : ['instance', 'tool', 'both'];
    for (const change of changes) {
      for (const scene of ['band', 'stopped', 'brief', 'reading'] as Scene[]) {
        for (const store of ['readable', 'unreadable'] as Store[]) {
          CASES.push([`${shape.name} / ${change} / ${scene} / ${store}`, shape, change, scene, store]);
        }
      }
    }
  }

  function setup(shape: Shape, store: Store) {
    const tagKey = getRetargetTagKey(shape.key);
    if (store === 'readable') {
      window.localStorage.setItem(tagKey, JSON.stringify([tagOf('t-r3', ORIGINAL)]));
    } else {
      // Issue #4604 S13: the tags are in the draft's one value — its key is the one that throws.
      const real = Storage.prototype.getItem;
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, k: string) {
        if (k === getDraftValueKey(shape.key)) throw new DOMException('denied', 'SecurityError');
        return real.call(this, k);
      });
    }
    const el = (to: Target) => (
      <MessageInput worktreeId={WT} cliToolId={to.tool} instanceId={to.id} isSessionRunning onMessageSent={vi.fn()} {...shape.props} />
    );
    const view = render(el(FROM));
    return { switchTo: (to: Target) => view.rerender(el(to)) };
  }

  const band = () => screen.queryByTestId('message-input-retarget-confirm');

  async function askedFirst() {
    typeMessage(TEXT);
    await settle();
    pressEnter();
    await settle();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(band()?.textContent).toContain(describe_(FROM));
  }

  it.each(CASES)('%s: one press POSTs nothing and asks again naming the To now; cancel 0, yes POSTs once there', async (_n, shape, change, scene, store) => {
    const next = NEXT[change];
    const { switchTo } = setup(shape, store);
    if (scene === 'stopped') fetchStartPreviewMock.mockResolvedValue(null);
    if (scene === 'brief') fetchStartPreviewMock.mockResolvedValue(SHOWN);
    let release: (v: unknown) => void = () => undefined;
    if (scene === 'reading') fetchStartPreviewMock.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    await askedFirst();

    if (scene === 'band') {
      // The question is up for the To before; the To changes.
      act(() => switchTo(next));
      await settle();
      expect(band()?.textContent ?? '').not.toContain(describe_(FROM));
      if (band()) fireEvent.click(screen.getByTestId('message-input-retarget-confirm-yes'));
    } else {
      fireEvent.click(screen.getByTestId('message-input-retarget-confirm-yes'));
      await settle();
      if (scene === 'brief') await screen.findByTestId('session-start-brief-decline');
      act(() => switchTo(next));
      await settle();
      if (scene === 'reading') {
        await act(async () => release(SHOWN));
        await settle();
      }
      fetchStartPreviewMock.mockReset();
      fetchStartPreviewMock.mockResolvedValue(NOT_SHOWN);
      const decline = screen.queryByTestId('session-start-brief-decline');
      if (decline) fireEvent.click(decline);
      else pressEnter();
    }
    await settle();
    expect(sendMessageMock).not.toHaveBeenCalled();
    if (!band()) pressEnter();
    await settle();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(band()?.textContent).toContain(describe_(next));
    expect(band()?.textContent).not.toContain(describe_(FROM));

    fireEvent.click(screen.getByTestId('message-input-retarget-confirm-no'));
    await settle();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(getTextarea().value).toBe(TEXT);

    pressEnter();
    await settle();
    expect(sendMessageMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('message-input-retarget-confirm-yes'));
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    await settle();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const call = sendMessageMock.mock.calls[0];
    expect(call[1]).toBe(TEXT);
    expect(call[2]).toEqual(expect.objectContaining({ cliToolId: next.tool, instanceId: next.id }));
  });

  describe.each(SHAPES)('(positive control) the To unchanged — $name', (shape) => {
    it.each(['readable', 'unreadable'] as Store[])('%s: yes, then the brief choice POSTs once, to this To, with the choice', async (store) => {
      setup(shape, store);
      fetchStartPreviewMock.mockResolvedValue(SHOWN);
      await askedFirst();
      fireEvent.click(screen.getByTestId('message-input-retarget-confirm-yes'));
      fireEvent.click(await screen.findByTestId('session-start-brief-decline'));
      await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
      await settle();
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const call = sendMessageMock.mock.calls[0];
      expect(call[0]).toBe(WT);
      expect(call[1]).toBe(TEXT);
      expect(call[2]).toEqual(expect.objectContaining({ cliToolId: FROM.tool, instanceId: FROM.id, brief: 'decline' }));
      expect(band()).toBeNull();
    });

    it('readable: a yes to a tag kept in the store (V2b) holds for the same To and tag — the next send asks nothing, POST 2', async () => {
      const { switchTo } = setup(shape, 'unreadable');
      vi.restoreAllMocks();
      switchTo(FROM);
      typeMessage(TEXT);
      await settle();
      // Stored after the draft was read: in the store only (this composer's send does not let it go).
      // Issue #4604 S13: another tab writes the draft's one value.
      window.localStorage.setItem(getDraftValueKey(shape.key), draftValue({ tags: [tagOf('t-kept', ORIGINAL)] }));
      pressEnter();
      await settle();
      expect(band()?.textContent).toContain(describe_(FROM));
      fireEvent.click(screen.getByTestId('message-input-retarget-confirm-yes'));
      await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(getTextarea().value).toBe(''));
      expect(readRetargetTags(shape.key)).toEqual([tagOf('t-kept', ORIGINAL)]);

      typeMessage(TEXT);
      await settle();
      pressEnter();
      await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(2));
      await settle();
      expect(sendMessageMock).toHaveBeenCalledTimes(2);
      expect(sendMessageMock.mock.calls[1][2]).toEqual(expect.objectContaining({ cliToolId: FROM.tool, instanceId: FROM.id }));
      expect(band()).toBeNull();
    });
  });
});
