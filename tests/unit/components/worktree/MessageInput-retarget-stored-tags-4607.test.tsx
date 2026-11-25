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
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, waitFor, act, cleanup } from '@testing-library/react';
import { MessageInput } from '@/components/worktree/MessageInput';
import { mockCommandGroups, getTextarea, typeMessage, pressEnter } from '@tests/helpers/message-input-test-utils';
import { getInstanceDraftKey, getRetargetTagKey, getSplitDraftKey } from '@/lib/drafts/message-draft';
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

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

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

  function renderComposer() {
    return render(
      <MessageInput worktreeId={WT} cliToolId={CURRENT.tool} instanceId={CURRENT.id} isSessionRunning onMessageSent={vi.fn()} {...props} />,
    );
  }

  /** `getItem` of this draft's tag key alone throws; every other key reads as usual. */
  function throwOnTagKey() {
    const real = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, k: string) {
      if (k === tagKey) throw new DOMException('denied', 'SecurityError');
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
      expect(JSON.parse(window.localStorage.getItem(tagKey) ?? '[]')).toEqual([tagOf('other-tab-1', ORIGINAL)]);
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
});
