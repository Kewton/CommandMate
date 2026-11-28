/**
 * Issue #4604 (設計書 §3.1, W-1・4 回目・5 回目・N-6): the composer's text and the key of its draft are
 * one state.
 *
 * - W-1: the `/sessions` tile switches its instance (the draft's key changes). Between the commit of
 *   that render and its passive effects (the restore), a press — a command's Enter / [send] / the
 *   form's submit (a command does not wait for the start preview), the brief's three choices — POSTs
 *   nothing: the text in state is the previous instance's, and this render is the new instance's
 *   (develop sent the previous instance's text to the new instance in one press). Positive control:
 *   after the effects, the new instance's own text sends as before.
 * - 4 回目: the switch cannot read the new draft (`getItem` throws) — the composer is left empty with
 *   "the draft could not be read", never the previous draft's text.
 * - 5 回目: …and that previous text is never saved under the new key (the debounced save is the
 *   draft's own pair), so it does not come back there later without its mark.
 * - The previous draft's waiting save cannot be written at the switch: a toast says so (問い 2).
 * - N-6: a character typed between the commit and the restore is kept — after the new draft's stored
 *   text — and saved under the new key; the previous draft keeps its own text.
 *
 * @vitest-environment jsdom
 */
import React, { useLayoutEffect, useRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, act, cleanup } from '@testing-library/react';
import { MessageInput } from '@/components/worktree/MessageInput';
import { mockCommandGroups, getTextarea, pressEnter } from '@tests/helpers/message-input-test-utils';
import { getDraftValueKey, getInstanceDraftKey } from '@/lib/drafts/message-draft';
import { installStoreFaults, rawStore, storedDraft } from '@tests/helpers/draft-store-fault-4604';

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
  return { ...actual, worktreeApi: { ...actual.worktreeApi, sendMessage: sendMessageMock, uploadImageFile: vi.fn() } };
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

const WT = 'wt-4604-keyed';
const A = 'claude-2';
const B = 'claude-3';
const KEY_A = getInstanceDraftKey(WT, A);
const KEY_B = getInstanceDraftKey(WT, B);
const COMMAND = '!ls -la';
const PLAIN = 'hello agent';
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

type Press = 'enter' | 'send-button' | 'form-submit' | 'brief-short' | 'brief-full' | 'brief-decline' | 'type-x';
const TESTID: Partial<Record<Press, string>> = {
  'send-button': 'send-message-button',
  'brief-short': 'session-start-brief-short',
  'brief-full': 'session-start-brief-full',
  'brief-decline': 'session-start-brief-decline',
};

/** One press with the DOM's own events (no `act`: it runs inside the commit's layout effect). */
function press(kind: Press) {
  const testId = TESTID[kind];
  if (testId) {
    const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
    if (!el) throw new Error(`no ${kind} on screen`);
    el.click();
    return;
  }
  const textarea = document.querySelector('[data-testid="message-input-textarea"]') as HTMLTextAreaElement;
  if (kind === 'enter') textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  else if (kind === 'form-submit') textarea.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  else fireEvent.change(textarea, { target: { value: 'x' } });
}

function Harness({ instance, pressOnCommit, showToast }: { instance: string; pressOnCommit: Press | null; showToast?: (m: string, t?: string) => void }) {
  const pressed = useRef(false);
  useLayoutEffect(() => {
    // After the commit of the instance change, before its passive effects (the restore).
    if (pressOnCommit && !pressed.current && instance !== A) {
      pressed.current = true;
      press(pressOnCommit);
    }
  }, [instance, pressOnCommit]);
  return (
    <MessageInput
      worktreeId={WT}
      cliToolId="claude"
      instanceId={instance}
      draftScope="instance"
      isSessionRunning
      onMessageSent={vi.fn()}
      showToast={showToast as never}
    />
  );
}

async function settle(ms = 10) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  sendMessageMock.mockReset();
  sendMessageMock.mockImplementation(async (_wt: string, content: string) => ({ id: 's-1', role: 'user', content, timestamp: new Date() }));
  fetchStartPreviewMock.mockReset();
  fetchStartPreviewMock.mockResolvedValue(NOT_SHOWN);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('[#4604 W-1] a press between the commit of the instance switch and the restore sends nothing', () => {
  it.each<Press>(['enter', 'send-button', 'form-submit'])('a command, %s: POST 0 (and nothing left to send after the restore)', async (kind) => {
    window.localStorage.setItem(KEY_A, COMMAND);
    const view = render(<Harness instance={A} pressOnCommit={null} />);
    await settle();
    expect(getTextarea().value).toBe(COMMAND);
    view.rerender(<Harness instance={B} pressOnCommit={kind} />);
    await settle(50);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(getTextarea().value).toBe('');
    // The previous instance's draft stays its own (Issue #4604 S13: each draft is its one value).
    expect(storedDraft(KEY_A).text).toBe(COMMAND);
    expect(rawStore().get(getDraftValueKey(KEY_B))).toBeNull();
  });

  it.each<Press>(['brief-short', 'brief-full', 'brief-decline'])('the brief up for the previous instance, %s: POST 0', async (kind) => {
    window.localStorage.setItem(KEY_A, PLAIN);
    fetchStartPreviewMock.mockResolvedValue(SHOWN);
    const view = render(<Harness instance={A} pressOnCommit={null} />);
    await settle();
    act(() => pressEnter());
    await screen.findByTestId('session-start-brief-decline');
    fetchStartPreviewMock.mockResolvedValue(NOT_SHOWN);
    view.rerender(<Harness instance={B} pressOnCommit={kind} />);
    await settle(50);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('session-start-brief-dialog')).toBeNull();
    expect(storedDraft(KEY_A).text).toBe(PLAIN);
  });

  it('(positive control) after the restore, the new instance\'s own command sends as before', async () => {
    window.localStorage.setItem(KEY_A, COMMAND);
    window.localStorage.setItem(KEY_B, '!pwd');
    const view = render(<Harness instance={A} pressOnCommit={null} />);
    await settle();
    view.rerender(<Harness instance={B} pressOnCommit={null} />);
    await settle();
    expect(getTextarea().value).toBe('!pwd');
    act(() => pressEnter());
    await settle(20);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][1]).toBe('!pwd');
    expect(sendMessageMock.mock.calls[0][2]).toMatchObject({ instanceId: B });
  });
});

describe('[#4604 4 回目・5 回目] a switch that cannot read the new draft', () => {
  it('the composer is left empty with "the draft could not be read" — never the previous draft\'s text', async () => {
    window.localStorage.setItem(KEY_A, PLAIN);
    const view = render(<Harness instance={A} pressOnCommit={null} />);
    await settle();
    // Issue #4604 S13: the new draft's one value cannot be read.
    installStoreFaults([{ method: 'getItem', key: (k) => k === getDraftValueKey(KEY_B) }]);
    view.rerender(<Harness instance={B} pressOnCommit={null} />);
    await settle();
    expect(getTextarea().value).toBe('');
    expect(screen.getByTestId('message-input-draft-unreadable')).toHaveTextContent('下書きを読めませんでした');
  });

  it('…and the previous text is never saved under the new key (nor shown there once it can be read again)', async () => {
    window.localStorage.setItem(KEY_A, PLAIN);
    const view = render(<Harness instance={A} pressOnCommit={null} />);
    await settle();
    const faults = installStoreFaults([{ method: 'getItem', key: (k) => k === getDraftValueKey(KEY_B) }]);
    view.rerender(<Harness instance={B} pressOnCommit={null} />);
    await settle(600);
    expect(rawStore().get(getDraftValueKey(KEY_B))).toBeNull();
    faults.restore();
    view.rerender(<Harness instance={A} pressOnCommit={null} />);
    await settle();
    view.rerender(<Harness instance={B} pressOnCommit={null} />);
    await settle();
    expect(getTextarea().value).toBe('');
    expect(screen.queryByTestId('message-input-draft-unreadable')).toBeNull();
    expect(storedDraft(KEY_A).text).toBe(PLAIN);
  });

  it('the previous draft\'s waiting save cannot be written at the switch: a toast says so', async () => {
    const toast = vi.fn();
    const view = render(<Harness instance={A} pressOnCommit={null} showToast={toast} />);
    await settle();
    fireEvent.change(getTextarea(), { target: { value: 'typed for A' } });
    installStoreFaults([{ method: 'setItem', key: (k) => k === getDraftValueKey(KEY_A) }]);
    view.rerender(<Harness instance={B} pressOnCommit={null} showToast={toast} />);
    await settle();
    expect(toast).toHaveBeenCalledWith('前の下書きを保存できませんでした', 'warning');
  });

  it('(negative control) the save written: no toast', async () => {
    const toast = vi.fn();
    const view = render(<Harness instance={A} pressOnCommit={null} showToast={toast} />);
    await settle();
    fireEvent.change(getTextarea(), { target: { value: 'typed for A' } });
    view.rerender(<Harness instance={B} pressOnCommit={null} showToast={toast} />);
    await settle();
    expect(toast).not.toHaveBeenCalled();
    expect(storedDraft(KEY_A).text).toBe('typed for A');
  });
});

describe('[#4604 N-6] a character typed between the commit and the restore', () => {
  it('is kept after the new draft\'s text and saved under the new key; the previous draft keeps its own', async () => {
    window.localStorage.setItem(KEY_A, PLAIN);
    window.localStorage.setItem(KEY_B, 'b text');
    const view = render(<Harness instance={A} pressOnCommit={null} />);
    await settle();
    view.rerender(<Harness instance={B} pressOnCommit="type-x" />);
    await settle();
    expect(getTextarea().value).toBe('b text\n\nx');
    await settle(600);
    expect(storedDraft(KEY_B).text).toBe('b text\n\nx');
    expect(storedDraft(KEY_A).text).toBe(PLAIN);
  });
});

// r3 (review b PS-1): the restore adds what was typed only at a switch (`switched`): under StrictMode
// the mount's effects run twice on the same key, and the stored text is not doubled.
describe('[#4604 r3 PS-1] a StrictMode mount restores the stored text once', () => {
  it('the composer shows the stored text, not it twice; the store keeps it as it was', async () => {
    window.localStorage.setItem(KEY_A, 'abc');
    render(
      <React.StrictMode>
        <MessageInput worktreeId={WT} cliToolId="claude" instanceId={A} draftScope="instance" isSessionRunning onMessageSent={vi.fn()} />
      </React.StrictMode>,
    );
    await settle();
    expect(getTextarea().value).toBe('abc');
    await settle(600);
    expect(storedDraft(KEY_A).text).toBe('abc');
  });
});
