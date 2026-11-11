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
 * Table-driven over the two send paths (optimistic: split panes and the tile; awaited: the
 * phone) and the two layouts.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, waitFor, act } from '@testing-library/react';
import { MessageInput } from '@/components/worktree/MessageInput';
import { mockCommandGroups, createDefaultProps, getTextarea, typeMessage } from '@tests/helpers/message-input-test-utils';

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
const SHOWN = (id = 'b-1') => ({
  ok: true,
  show: true,
  attended: true,
  injectOnStart: true,
  mode: 'on',
  boundary: { id, kind: 'launch' },
  preview: { open: { count: 3, unreflected: 1 }, humanQuestions: { count: 0, unknownSources: ['state'] }, lastUpdatedAt: null },
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

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  sendMessageMock.mockResolvedValue({ id: 'srv-1', role: 'user', content: 'x', timestamp: new Date() });
});
afterEach(() => window.localStorage.clear());

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
    fetchStartPreviewMock.mockResolvedValueOnce(SHOWN('b-1')).mockResolvedValueOnce(SHOWN('b-2'));
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
      expect(onOptimisticSend).toHaveBeenCalledWith('hello agent', { cliToolId: 'claude', imagePath: IMAGE });
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

describe('H19 the preview is never awaited by a send', () => {
  it('a preview still in flight: the send goes as before (no dialog, no wait)', async () => {
    isMobileMock.mockReturnValue(false);
    fetchStartPreviewMock.mockReturnValue(new Promise(() => undefined));
    const { onOptimisticSend } = renderComposer('optimistic');
    fireEvent.focus(getTextarea());
    typeMessage('hello agent');
    submit();
    expect(onOptimisticSend).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('session-start-brief-dialog')).toBeNull();
  });

  it('isCommandBody is the server’s isSlashCommandBody on the cases that matter', async () => {
    const { isCommandBody } = await vi.importActual<typeof import('@/lib/handoff/screen-client')>('@/lib/handoff/screen-client');
    const { isSlashCommandBody } = await vi.importActual<typeof import('@/lib/session/session-boundary')>('@/lib/session/session-boundary');
    for (const body of ['/clear', '  /compact  ', '/model opus', '!ls', 'hello', '/ space', 'a /clear', '', '/x\ny']) {
      expect([body, isCommandBody(body)]).toEqual([body, isSlashCommandBody(body)]);
    }
  });
});
