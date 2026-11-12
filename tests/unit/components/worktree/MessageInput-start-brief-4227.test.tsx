/**
 * H19 / H21(h): the composer's G-3 (Issue #4227 G-PR3, design `mem-ui-4227.md` §3.2・§3.2.1).
 *
 * Every screen send goes through `MessageInput` (the phone's composer, the PC's split panes
 * and the sessions screen's tile all render it — `git grep '<MessageInput' -- src`), so the
 * choice is asked there, once, for every path:
 *
 *  - a preview that says to ask opens the dialog BEFORE the draft is cleared or handed to
 *    the optimistic layer; closing it sends nothing and keeps the text and the image;
 *  - a choice is sent with the boundary the preview showed (`brief`・`briefDetail`・
 *    `briefBoundary`), and the draft is cleared only once the server took it;
 *  - 409 `boundary_changed` (nothing typed) is not sent again: the preview is read again and
 *    the dialog reopens with the draft as it was;
 *  - with no preview to ask (unattended, the default), the send is the request it was.
 *
 * G-PR6 (design §3.2, the UAT's S10-der・S10-full): every plain send reads the preview afresh and
 * waits for it (at most 2 s) — the cache never decides a send; a read that fails sends nothing
 * and keeps the draft. The controls below fix the order with deferred reads, on mode `on` and
 * `derived` alike (the composer has no mode rule of its own). Every test here sets its own
 * `fetchStartPreview`; the suite's default (tests/setup.ts) must never be reached — its mark is
 * checked after each test.
 *
 * Table-driven over the two send paths (optimistic: split panes and the tile; awaited: the
 * phone) and the two layouts.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, waitFor, act } from '@testing-library/react';
import { MessageInput } from '@/components/worktree/MessageInput';
import { mockCommandGroups, createDefaultProps, getTextarea, getSendButton, typeMessage, pressEnter } from '@tests/helpers/message-input-test-utils';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const { sendMessageMock, fetchStartPreviewMock, resetAfterSendMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  fetchStartPreviewMock: vi.fn(),
  resetAfterSendMock: vi.fn(),
}));

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    worktreeApi: { ...actual.worktreeApi, sendMessage: sendMessageMock, uploadImageFile: vi.fn() },
    handleApiError: vi.fn((err: Error) => err?.message || 'Unknown error'),
  };
});

vi.mock('@/lib/handoff/screen-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/handoff/screen-client')>();
  return { ...actual, fetchStartPreview: fetchStartPreviewMock };
});

vi.mock('@/hooks/useImageAttachment', () => ({
  useImageAttachment: () => ({
    attachedImage: { path: '.commandmate/attachments/shot.png', file: new File(['x'], 'shot.png') },
    fileInputRef: { current: null },
    isUploading: false,
    error: null,
    acceptAttribute: 'image/*',
    openFileDialog: vi.fn(),
    handleFileSelect: vi.fn(),
    removeAttachment: vi.fn(),
    resetAfterSend: resetAfterSendMock,
  }),
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

const { isMobileMock } = vi.hoisted(() => ({ isMobileMock: vi.fn(() => false) }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: isMobileMock }));

import { ApiError } from '@/lib/api-client';

const IMAGE = '.commandmate/attachments/shot.png';
const SHOWN = (id = 'b-1', mode: 'on' | 'derived' = 'on', count = 3) => ({
  ok: true,
  show: true,
  attended: true,
  injectOnStart: true,
  mode,
  boundary: { id, kind: 'launch' },
  preview: { open: { count, unreflected: 1 }, humanQuestions: { count: 0, unknownSources: ['state'] }, lastUpdatedAt: null },
});
const NOT_SHOWN = { ok: true, show: false, attended: false };

type Path = 'optimistic' | 'awaited';
const PATHS: Array<[string, Path, boolean]> = [
  ['split pane / tile (optimistic), PC', 'optimistic', false],
  ['split pane / tile (optimistic), phone', 'optimistic', true],
  ['phone composer (awaited)', 'awaited', true],
  ['awaited, PC', 'awaited', false],
];

function renderComposer(path: Path) {
  const onOptimisticSend = vi.fn();
  const props = { ...createDefaultProps({ cliToolId: 'claude', isSessionRunning: true }), ...(path === 'optimistic' ? { onOptimisticSend } : {}) };
  render(<MessageInput {...props} />);
  return { onOptimisticSend, onMessageSent: props.onMessageSent };
}

/** Focus reads the preview in the background; wait until it is cached. */
async function focusAndRead() {
  fireEvent.focus(getTextarea());
  await waitFor(() => expect(fetchStartPreviewMock).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
}

function submit() {
  fireEvent.submit(getTextarea().closest('form')!);
}

const marks = globalThis as { __cmDefaultStartPreviewCalls?: number };

beforeEach(() => {
  vi.clearAllMocks();
  fetchStartPreviewMock.mockReset();
  window.localStorage.clear();
  marks.__cmDefaultStartPreviewCalls = 0;
  sendMessageMock.mockResolvedValue({ id: 'srv-1', role: 'user', content: 'x', timestamp: new Date() });
});
afterEach(() => {
  window.localStorage.clear();
  // G-PR6: the choice tests never lean on the suite's unattended default (tests/setup.ts).
  expect(marks.__cmDefaultStartPreviewCalls ?? 0).toBe(0);
});

describe.each(PATHS)('H19 %s', (_name, path, mobile) => {
  beforeEach(() => isMobileMock.mockReturnValue(mobile));

  it('(a) the dialog opens before the draft is cleared; closing sends nothing and keeps text and image', async () => {
    fetchStartPreviewMock.mockResolvedValue(SHOWN());
    const { onOptimisticSend } = renderComposer(path);
    await focusAndRead();
    typeMessage('hello agent');
    submit();
    expect(await screen.findByTestId('session-start-brief-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('session-start-brief-open').textContent).toContain('3');
    expect(screen.getByTestId('session-start-brief-questions').textContent).toMatch(/unknown/);
    expect(getTextarea().value).toBe('hello agent');
    expect(onOptimisticSend).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('session-start-brief-dialog')).toBeNull());
    expect(getTextarea().value).toBe('hello agent');
    expect(resetAfterSendMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it.each([
    ['decline', 'session-start-brief-decline', { brief: 'decline', briefBoundary: 'b-1' }],
    ['full', 'session-start-brief-full', { briefDetail: 'full', briefBoundary: 'b-1' }],
    ['short', 'session-start-brief-short', { briefDetail: 'short', briefBoundary: 'b-1' }],
  ] as const)('(c) %s: sent with the shown boundary and the image; the draft cleared after the server took it', async (_choice, testId, expected) => {
    fetchStartPreviewMock.mockResolvedValue(SHOWN());
    renderComposer(path);
    await focusAndRead();
    typeMessage('hello agent');
    submit();
    fireEvent.click(await screen.findByTestId(testId));
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    expect(sendMessageMock).toHaveBeenCalledWith('test-worktree', 'hello agent', { cliToolId: 'claude', imagePath: IMAGE, ...expected });
    await waitFor(() => expect(getTextarea().value).toBe(''));
    expect(resetAfterSendMock).toHaveBeenCalled();
  });

  it('(h) 409 boundary_changed: not sent again, the preview read again, the dialog reopens with the draft and image kept', async () => {
    // G-PR6: the focus read and the send's own read see b-1; the read after the 409 sees b-2.
    fetchStartPreviewMock.mockResolvedValueOnce(SHOWN('b-1')).mockResolvedValueOnce(SHOWN('b-1')).mockResolvedValueOnce(SHOWN('b-2'));
    sendMessageMock.mockRejectedValueOnce(new ApiError('boundary_changed', 409, { error: 'boundary_changed', reason: 'superseded', boundary: null }));
    renderComposer(path);
    await focusAndRead();
    typeMessage('hello agent');
    submit();
    fireEvent.click(await screen.findByTestId('session-start-brief-decline'));
    expect(await screen.findByTestId('session-start-brief-notice')).toBeInTheDocument();
    expect(screen.getByTestId('session-start-brief-notice').textContent).toMatch(/superseded/);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(getTextarea().value).toBe('hello agent');
    expect(resetAfterSendMock).not.toHaveBeenCalled();
    // Chosen again: the new boundary is named.
    fireEvent.click(screen.getByTestId('session-start-brief-decline'));
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(2));
    expect(sendMessageMock.mock.calls[1][2]).toMatchObject({ brief: 'decline', briefBoundary: 'b-2' });
  });

  it('negative: unattended (no preview to ask) sends the request it always did', async () => {
    fetchStartPreviewMock.mockResolvedValue(NOT_SHOWN);
    const { onOptimisticSend } = renderComposer(path);
    await focusAndRead();
    typeMessage('hello agent');
    submit();
    expect(screen.queryByTestId('session-start-brief-dialog')).toBeNull();
    if (path === 'optimistic') {
      // G-PR6: after the send's own read of the preview (asynchronous), the same request.
      await waitFor(() => expect(onOptimisticSend).toHaveBeenCalledWith('hello agent', { cliToolId: 'claude', imagePath: IMAGE }));
    } else {
      await waitFor(() => expect(sendMessageMock).toHaveBeenCalledWith('test-worktree', 'hello agent', { cliToolId: 'claude', imagePath: IMAGE }));
    }
  });

  it('negative: a command is never asked about (D1: no brief for it)', async () => {
    fetchStartPreviewMock.mockResolvedValue(SHOWN());
    renderComposer(path);
    await focusAndRead();
    typeMessage('/clear');
    submit();
    expect(screen.queryByTestId('session-start-brief-dialog')).toBeNull();
  });
});

describe('H19 a send waits for its own read of the preview (G-PR6; was: never awaited)', () => {
  it('a preview still in flight: nothing is sent, no dialog, the draft stays until it answers', async () => {
    isMobileMock.mockReturnValue(false);
    fetchStartPreviewMock.mockReturnValue(new Promise(() => undefined));
    const { onOptimisticSend } = renderComposer('optimistic');
    fireEvent.focus(getTextarea());
    typeMessage('hello agent');
    submit();
    await act(async () => {
      await Promise.resolve();
    });
    expect(onOptimisticSend).not.toHaveBeenCalled();
    expect(screen.queryByTestId('session-start-brief-dialog')).toBeNull();
    expect(getTextarea().value).toBe('hello agent');
  });

  it('isCommandBody is the server’s isSlashCommandBody on the cases that matter', async () => {
    const { isCommandBody } = await vi.importActual<typeof import('@/lib/handoff/screen-client')>('@/lib/handoff/screen-client');
    const { isSlashCommandBody } = await vi.importActual<typeof import('@/lib/session/session-boundary')>('@/lib/session/session-boundary');
    for (const body of ['/clear', '  /compact  ', '/model opus', '!ls', 'hello', '/ space', 'a /clear', '', '/x\ny']) {
      expect([body, isCommandBody(body)]).toEqual([body, isSlashCommandBody(body)]);
    }
  });
});

// --- G-PR6: the send's own read, in a fixed order -----------------------------------------

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
const NOT_SHOWN_ATTENDED = (mode: 'on' | 'derived') => ({ ok: true, show: false, attended: true, injectOnStart: true, mode });

const MODES: Array<'on' | 'derived'> = ['on', 'derived'];
const G6_CASES: Array<[string, Path, boolean, 'on' | 'derived']> = PATHS.flatMap(([name, path, mobile]) =>
  MODES.map((mode) => [name, path, mobile, mode] as [string, Path, boolean, 'on' | 'derived'])
);

describe.each(G6_CASES)('G-PR6 %s (%s, phone %s), mode %s', (_name, path, mobile, mode) => {
  beforeEach(() => isMobileMock.mockReturnValue(mobile));

  it('(1) sent while the preview is read: nothing goes out until it answers, then show:true asks', async () => {
    const read = deferred<unknown>();
    fetchStartPreviewMock.mockReturnValueOnce(read.promise);
    const { onOptimisticSend } = renderComposer(path);
    typeMessage('hello agent');
    submit();
    await flush();
    expect(onOptimisticSend).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(getTextarea().value).toBe('hello agent');
    expect(screen.queryByTestId('session-start-brief-dialog')).toBeNull();
    await act(async () => read.resolve(SHOWN('b-1', mode)));
    expect(await screen.findByTestId('session-start-brief-dialog')).toBeInTheDocument();
    expect(onOptimisticSend).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(getTextarea().value).toBe('hello agent');
  });

  it('(2) an old show:false in the cache, a new boundary since: the send reads again (within 10 s, no new focus) and asks for B', async () => {
    fetchStartPreviewMock.mockResolvedValueOnce(NOT_SHOWN_ATTENDED(mode)).mockResolvedValueOnce(SHOWN('b-B', mode));
    const { onOptimisticSend } = renderComposer(path);
    await focusAndRead();
    typeMessage('hello agent');
    submit();
    expect(await screen.findByTestId('session-start-brief-dialog')).toBeInTheDocument();
    expect(onOptimisticSend).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('session-start-brief-short'));
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    expect(sendMessageMock.mock.calls[0][2]).toMatchObject({ briefDetail: 'short', briefBoundary: 'b-B' });
  });

  it('(3) an old show:true for A in the cache, B now: the dialog shows B’s lines and the choice names B, never A', async () => {
    fetchStartPreviewMock.mockResolvedValueOnce(SHOWN('b-A', mode, 3)).mockResolvedValueOnce(SHOWN('b-B', mode, 7));
    renderComposer(path);
    await focusAndRead();
    typeMessage('hello agent');
    submit();
    expect(await screen.findByTestId('session-start-brief-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('session-start-brief-open').textContent).toContain('7');
    fireEvent.click(screen.getByTestId('session-start-brief-decline'));
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    expect(sendMessageMock.mock.calls[0][2]).toMatchObject({ brief: 'decline', briefBoundary: 'b-B' });
  });

  it('(4) the read after a 409 (B) and an older background read (A) landing after it: the next send still asks for B', async () => {
    const background = deferred<unknown>();
    fetchStartPreviewMock
      .mockReturnValueOnce(background.promise) // focus: A, held
      .mockResolvedValueOnce(SHOWN('b-A', mode)) // the send's read
      .mockResolvedValueOnce(SHOWN('b-B', mode)) // after the 409
      .mockResolvedValue(SHOWN('b-B', mode)); // any later read
    sendMessageMock.mockRejectedValueOnce(new ApiError('boundary_changed', 409, { error: 'boundary_changed', reason: 'superseded', boundary: null }));
    renderComposer(path);
    fireEvent.focus(getTextarea());
    typeMessage('hello agent');
    submit();
    fireEvent.click(await screen.findByTestId('session-start-brief-full'));
    expect(await screen.findByTestId('session-start-brief-notice')).toBeInTheDocument();
    // The older background read lands last.
    await act(async () => background.resolve(SHOWN('b-A', mode)));
    // Closed and sent again: asked for B.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('session-start-brief-dialog')).toBeNull());
    submit();
    fireEvent.click(await screen.findByTestId('session-start-brief-decline'));
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(2));
    expect(sendMessageMock.mock.calls[1][2]).toMatchObject({ brief: 'decline', briefBoundary: 'b-B' });
  });

  it('(6) the read fails: nothing is sent, the draft stays with the reason; "try again" reads again and sends', async () => {
    fetchStartPreviewMock.mockResolvedValueOnce(null).mockResolvedValueOnce(NOT_SHOWN);
    const { onOptimisticSend } = renderComposer(path);
    typeMessage('hello agent');
    submit();
    expect(await screen.findByTestId('session-start-brief-check-failed')).toBeInTheDocument();
    expect(onOptimisticSend).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(getTextarea().value).toBe('hello agent');
    expect(resetAfterSendMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('session-start-brief-check-retry'));
    if (path === 'optimistic') {
      await waitFor(() => expect(onOptimisticSend).toHaveBeenCalledWith('hello agent', { cliToolId: 'claude', imagePath: IMAGE }));
    } else {
      await waitFor(() => expect(sendMessageMock).toHaveBeenCalledWith('test-worktree', 'hello agent', { cliToolId: 'claude', imagePath: IMAGE }));
    }
    expect(fetchStartPreviewMock).toHaveBeenCalledTimes(2);
  });

  it('(8) the server answers 409 boundary_changed (the boundary moved under its read): nothing sent, draft kept; "try again" asks for B', async () => {
    // fetchStartPreview turns any non-200 into null (pinned below with the real function).
    fetchStartPreviewMock.mockResolvedValueOnce(null).mockResolvedValueOnce(SHOWN('b-B', mode));
    const { onOptimisticSend } = renderComposer(path);
    typeMessage('hello agent');
    submit();
    expect(await screen.findByTestId('session-start-brief-check-failed')).toBeInTheDocument();
    expect(onOptimisticSend).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(getTextarea().value).toBe('hello agent');
    fireEvent.click(screen.getByTestId('session-start-brief-check-retry'));
    fireEvent.click(await screen.findByTestId('session-start-brief-short'));
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    expect(sendMessageMock.mock.calls[0][2]).toMatchObject({ briefDetail: 'short', briefBoundary: 'b-B' });
    expect(onOptimisticSend).not.toHaveBeenCalled();
  });

  it('(7) a second Enter while the read is waiting: sent once, the draft not cleared meanwhile', async () => {
    const read = deferred<unknown>();
    fetchStartPreviewMock.mockReturnValueOnce(read.promise);
    const { onOptimisticSend } = renderComposer(path);
    typeMessage('hello agent');
    pressEnter();
    await flush();
    pressEnter();
    fireEvent.click(getSendButton());
    await flush();
    expect(fetchStartPreviewMock).toHaveBeenCalledTimes(1);
    expect(getTextarea().value).toBe('hello agent');
    expect(onOptimisticSend).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    await act(async () => read.resolve(NOT_SHOWN));
    if (path === 'optimistic') {
      await waitFor(() => expect(onOptimisticSend).toHaveBeenCalledTimes(1));
    } else {
      await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    }
    await flush();
    expect(onOptimisticSend.mock.calls.length + sendMessageMock.mock.calls.length).toBe(1);
  });

  it('negative: show:true with the three lines unreadable still asks (as before)', async () => {
    fetchStartPreviewMock.mockResolvedValue({ ...SHOWN('b-1', mode), preview: null });
    renderComposer(path);
    await focusAndRead();
    typeMessage('hello agent');
    submit();
    expect(await screen.findByTestId('session-start-brief-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('session-start-brief-preview-failed')).toBeInTheDocument();
  });

  it('negative: attended with no pending boundary (show:false) sends the request it always did', async () => {
    fetchStartPreviewMock.mockResolvedValue(NOT_SHOWN_ATTENDED(mode));
    const { onOptimisticSend } = renderComposer(path);
    typeMessage('hello agent');
    submit();
    if (path === 'optimistic') {
      await waitFor(() => expect(onOptimisticSend).toHaveBeenCalledWith('hello agent', { cliToolId: 'claude', imagePath: IMAGE }));
    } else {
      await waitFor(() => expect(sendMessageMock).toHaveBeenCalledWith('test-worktree', 'hello agent', { cliToolId: 'claude', imagePath: IMAGE }));
    }
    expect(screen.queryByTestId('session-start-brief-dialog')).toBeNull();
  });

  it('negative: a command does not wait for a read and is never asked about', async () => {
    fetchStartPreviewMock.mockResolvedValue(SHOWN('b-1', mode));
    const { onOptimisticSend } = renderComposer(path);
    typeMessage('/clear');
    submit();
    if (path === 'optimistic') expect(onOptimisticSend).toHaveBeenCalledTimes(1);
    else await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    expect(fetchStartPreviewMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('session-start-brief-dialog')).toBeNull();
  });
});

describe('G-PR6 the real fetchStartPreview on the server’s 409 boundary_changed', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is null (a read that failed: the composer sends nothing)', async () => {
    const { fetchStartPreview } = await vi.importActual<typeof import('@/lib/handoff/screen-client')>('@/lib/handoff/screen-client');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: false, code: 'boundary_changed' }), { status: 409, headers: { 'Content-Type': 'application/json' } }))
    );
    expect(await fetchStartPreview('wt-1', 'claude')).toBeNull();
  });
});

describe('G-PR6 the send’s read voided or cut', () => {
  beforeEach(() => isMobileMock.mockReturnValue(false));

  it.each(MODES)('(6) mode %s: a read past the 2 s limit sends nothing and keeps the draft', async (mode) => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    try {
      fetchStartPreviewMock.mockReturnValueOnce(new Promise(() => undefined));
      const { onOptimisticSend } = renderComposer('optimistic');
      typeMessage('hello agent');
      submit();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1999);
      });
      expect(screen.queryByTestId('session-start-brief-check-failed')).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2);
      });
      expect(screen.getByTestId('session-start-brief-check-failed')).toBeInTheDocument();
      expect(onOptimisticSend).not.toHaveBeenCalled();
      expect(getTextarea().value).toBe('hello agent');
      void mode;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(MODES)('mode %s: the instance changes while the read waits — the old target’s answer is dropped, nothing sent', async (mode) => {
    const read = deferred<unknown>();
    fetchStartPreviewMock.mockReturnValueOnce(read.promise);
    const onOptimisticSend = vi.fn();
    const props = { ...createDefaultProps({ cliToolId: 'claude', isSessionRunning: true }), onOptimisticSend };
    const { rerender } = render(<MessageInput {...props} />);
    typeMessage('hello agent');
    submit();
    await flush();
    rerender(<MessageInput {...props} instanceId="claude-2" />);
    await act(async () => read.resolve(NOT_SHOWN));
    await flush();
    expect(onOptimisticSend).not.toHaveBeenCalled();
    expect(screen.queryByTestId('session-start-brief-dialog')).toBeNull();
    void mode;
  });

  it.each(MODES)('mode %s: unmounted while the read waits — nothing is sent', async (mode) => {
    const read = deferred<unknown>();
    fetchStartPreviewMock.mockReturnValueOnce(read.promise);
    const onOptimisticSend = vi.fn();
    const { unmount } = render(<MessageInput {...createDefaultProps({ cliToolId: 'claude' })} onOptimisticSend={onOptimisticSend} />);
    typeMessage('hello agent');
    submit();
    await flush();
    unmount();
    await act(async () => read.resolve(SHOWN('b-1', mode)));
    await flush();
    expect(onOptimisticSend).not.toHaveBeenCalled();
  });

  it('the draft edited while the read waits: that attempt is dropped (the edited draft is not sent unseen)', async () => {
    const read = deferred<unknown>();
    fetchStartPreviewMock.mockReturnValueOnce(read.promise);
    const onOptimisticSend = vi.fn();
    render(<MessageInput {...createDefaultProps({ cliToolId: 'claude' })} onOptimisticSend={onOptimisticSend} />);
    typeMessage('hello agent');
    submit();
    await flush();
    typeMessage('hello agent, and more');
    await act(async () => read.resolve(NOT_SHOWN));
    await flush();
    expect(onOptimisticSend).not.toHaveBeenCalled();
    expect(getTextarea().value).toBe('hello agent, and more');
  });
});
