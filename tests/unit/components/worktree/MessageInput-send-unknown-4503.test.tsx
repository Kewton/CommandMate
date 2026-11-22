/**
 * Issue #4503 (PR-B2, design-4503.md 第 2 版 §3.3・§6.3 U5): the composer's two awaited sends — the
 * plain awaited send (no optimistic history: the phone's terminal view and others) and the send of
 * the session-brief choice (always awaited) — when the outcome is unknown.
 *
 *  - the draft (text and image) stays: if it really did not arrive, the text is not lost;
 *  - the composer says that nobody knows whether it arrived and to check the terminal;
 *  - the next send of the same draft — Enter, the button, the brief choice — asks first; only the
 *    confirmation sends it again. Editing the draft makes it another send (no question).
 *  - (positive control) a 4xx / `not_sent` failure keeps the old behaviour: its error, and the next
 *    Enter sends again directly.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen, waitFor, act } from '@testing-library/react';
import { MessageInput } from '@/components/worktree/MessageInput';
import { mockCommandGroups, createDefaultProps, getTextarea, typeMessage, pressEnter } from '@tests/helpers/message-input-test-utils';
import ja from '../../../../locales/ja/worktree.json';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
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

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

import { ApiError } from '@/lib/api-client';

const JA = ja.conversation.sendUnknown;
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
const unknown500 = () => new ApiError('submit could not be confirmed', 500, { error: 'submit could not be confirmed', sendOutcome: 'unknown' });

function renderComposer(optimistic = false) {
  const onOptimisticSend = vi.fn();
  const props = {
    ...createDefaultProps({ cliToolId: 'antigravity', isSessionRunning: true }),
    ...(optimistic ? { onOptimisticSend } : {}),
  };
  render(<MessageInput {...props} />);
  return { onOptimisticSend };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function submitAndSettle() {
  await act(async () => {
    fireEvent.submit(getTextarea().closest('form')!);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchStartPreviewMock.mockReset();
  fetchStartPreviewMock.mockResolvedValue(NOT_SHOWN);
  window.localStorage.clear();
  sendMessageMock.mockReset();
});

describe('[#4503] U5 (a) the plain awaited send', () => {
  it.each([
    ['500 sendOutcome:unknown', unknown500],
    ['502 with no sendOutcome', () => new ApiError('HTTP error 502', 502, {})],
    ['fetch rejected (network)', () => new ApiError('Failed to fetch', 0, undefined, 'network')],
  ])('%s: the draft stays, the guidance shows, and Enter asks before sending again', async (_name, make) => {
    sendMessageMock.mockRejectedValueOnce(make()).mockResolvedValue({ id: 's2', role: 'user', content: 'x', timestamp: new Date() });
    renderComposer();
    typeMessage('hello agent');
    await submitAndSettle();
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    await settle();
    expect(getTextarea().value).toBe('hello agent');
    expect(resetAfterSendMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('message-input-send-unknown')).toHaveTextContent(JA.status);
    expect(screen.getByTestId('message-input-send-unknown')).toHaveTextContent(JA.guidance);

    // Enter: nothing is sent, the question is asked.
    pressEnter();
    await settle();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('message-input-resend-confirm')).toHaveTextContent(JA.resendConfirm);
    // The button: nothing either.
    await submitAndSettle();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    // Only the confirmation sends it again.
    await act(async () => {
      fireEvent.click(screen.getByTestId('message-input-resend-confirm-yes'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(2));
    expect(sendMessageMock.mock.calls[1][1]).toBe('hello agent');
  });

  it('cancelling the question sends nothing and keeps the draft', async () => {
    sendMessageMock.mockRejectedValueOnce(unknown500());
    renderComposer();
    typeMessage('hello agent');
    await submitAndSettle();
    await waitFor(() => expect(screen.getByTestId('message-input-send-unknown')).toBeInTheDocument());
    pressEnter();
    await settle();
    fireEvent.click(screen.getByTestId('message-input-resend-confirm-no'));
    expect(screen.queryByTestId('message-input-resend-confirm')).toBeNull();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(getTextarea().value).toBe('hello agent');
  });

  it('an edited draft is another send: no question', async () => {
    sendMessageMock.mockRejectedValueOnce(unknown500()).mockResolvedValue({ id: 's2', role: 'user', content: 'x', timestamp: new Date() });
    renderComposer();
    typeMessage('hello agent');
    await submitAndSettle();
    await waitFor(() => expect(screen.getByTestId('message-input-send-unknown')).toBeInTheDocument());
    typeMessage('hello agent, only the missing part');
    expect(screen.queryByTestId('message-input-send-unknown')).toBeNull();
    await submitAndSettle();
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('message-input-resend-confirm')).toBeNull();
  });

  it.each([
    ['400', () => new ApiError('content is required', 400, { error: 'content is required' })],
    ['500 sendOutcome:not_sent', () => new ApiError('session start failed', 500, { error: 'session start failed', sendOutcome: 'not_sent' })],
  ])('(positive control) %s: its error shows and Enter sends again directly', async (_name, make) => {
    sendMessageMock.mockRejectedValueOnce(make()).mockResolvedValue({ id: 's2', role: 'user', content: 'x', timestamp: new Date() });
    renderComposer();
    typeMessage('hello agent');
    await submitAndSettle();
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    await settle();
    expect(screen.queryByTestId('message-input-send-unknown')).toBeNull();
    expect(getTextarea().value).toBe('hello agent');
    pressEnter();
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('message-input-resend-confirm')).toBeNull();
  });
});

describe.each([
  ['awaited composer', false],
  ['optimistic composer', true],
])('[#4503] U5 (b) the brief-choice send (%s)', (_name, optimistic) => {
  it('unknown: the dialog closes, the draft stays, and the next send asks first', async () => {
    fetchStartPreviewMock.mockResolvedValue(SHOWN);
    sendMessageMock.mockRejectedValueOnce(unknown500()).mockResolvedValue({ id: 's2', role: 'user', content: 'x', timestamp: new Date() });
    const { onOptimisticSend } = renderComposer(optimistic);
    typeMessage('hello agent');
    await submitAndSettle();
    fireEvent.click(await screen.findByTestId('session-start-brief-decline'));
    await waitFor(() => expect(screen.getByTestId('message-input-send-unknown')).toBeInTheDocument());
    expect(screen.queryByTestId('session-start-brief-dialog')).toBeNull();
    expect(getTextarea().value).toBe('hello agent');
    expect(resetAfterSendMock).not.toHaveBeenCalled();

    const previewReads = fetchStartPreviewMock.mock.calls.length;
    pressEnter();
    await settle();
    expect(screen.getByTestId('message-input-resend-confirm')).toBeInTheDocument();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(onOptimisticSend).not.toHaveBeenCalled();
    // Asked before anything else: the preview is not even read.
    expect(fetchStartPreviewMock.mock.calls.length).toBe(previewReads);

    // Confirmed: the send goes on as a new send (the dialog asks the brief again).
    await act(async () => {
      fireEvent.click(screen.getByTestId('message-input-resend-confirm-yes'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(await screen.findByTestId('session-start-brief-decline'));
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(2));
  });
});

describe('[#4503 U-0 / review P2-5] the mark lives as long as the draft', () => {
  const base = () => createDefaultProps({ cliToolId: 'antigravity', isSessionRunning: true });

  async function typeAndWaitForSave(text: string) {
    typeMessage(text);
    // The draft's debounced save (500 ms) — what a reload brings back.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
  }

  async function expectEnterAsks(calls: number) {
    pressEnter();
    await settle();
    expect(screen.getByTestId('message-input-resend-confirm')).toBeInTheDocument();
    expect(sendMessageMock).toHaveBeenCalledTimes(calls);
  }

  it('a remount (a reload) brings the draft back with its mark: Enter asks', async () => {
    sendMessageMock.mockRejectedValueOnce(unknown500()).mockResolvedValue({ id: 's2', role: 'user', content: 'x', timestamp: new Date() });
    const first = render(<MessageInput {...base()} />);
    await typeAndWaitForSave('hello agent');
    await submitAndSettle();
    await waitFor(() => expect(screen.getByTestId('message-input-send-unknown')).toBeInTheDocument());
    first.unmount();

    render(<MessageInput {...base()} />);
    await settle();
    expect(getTextarea().value).toBe('hello agent');
    expect(screen.getByTestId('message-input-send-unknown')).toHaveTextContent(JA.status);
    await expectEnterAsks(1);
    await submitAndSettle();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('a switch of the target and back (one draft for the split): Enter asks again', async () => {
    sendMessageMock.mockRejectedValueOnce(unknown500()).mockResolvedValue({ id: 's2', role: 'user', content: 'x', timestamp: new Date() });
    const view = render(<MessageInput {...base()} instanceId="antigravity" />);
    await typeAndWaitForSave('hello agent');
    await submitAndSettle();
    await waitFor(() => expect(screen.getByTestId('message-input-send-unknown')).toBeInTheDocument());

    view.rerender(<MessageInput {...base()} instanceId="antigravity-2" />);
    await settle();
    // The same draft, another target: not that send (no notice there).
    expect(screen.queryByTestId('message-input-send-unknown')).toBeNull();
    view.rerender(<MessageInput {...base()} instanceId="antigravity" />);
    await settle();
    expect(getTextarea().value).toBe('hello agent');
    expect(screen.getByTestId('message-input-send-unknown')).toBeInTheDocument();
    await expectEnterAsks(1);
  });

  it("the tile's per-instance draft: switching away and back brings the draft and its question back", async () => {
    sendMessageMock.mockRejectedValueOnce(unknown500()).mockResolvedValue({ id: 's2', role: 'user', content: 'x', timestamp: new Date() });
    const view = render(<MessageInput {...base()} draftScope="instance" instanceId="antigravity" />);
    await typeAndWaitForSave('hello agent');
    await submitAndSettle();
    await waitFor(() => expect(screen.getByTestId('message-input-send-unknown')).toBeInTheDocument());

    view.rerender(<MessageInput {...base()} draftScope="instance" instanceId="antigravity-2" />);
    await settle();
    expect(getTextarea().value).toBe('');
    expect(screen.queryByTestId('message-input-send-unknown')).toBeNull();
    view.rerender(<MessageInput {...base()} draftScope="instance" instanceId="antigravity" />);
    await settle();
    expect(getTextarea().value).toBe('hello agent');
    await expectEnterAsks(1);
  });

  it('(negative control) a draft sent successfully leaves no mark behind', async () => {
    sendMessageMock.mockRejectedValueOnce(unknown500()).mockResolvedValue({ id: 's2', role: 'user', content: 'x', timestamp: new Date() });
    const first = render(<MessageInput {...base()} />);
    await typeAndWaitForSave('hello agent');
    await submitAndSettle();
    await waitFor(() => expect(screen.getByTestId('message-input-send-unknown')).toBeInTheDocument());
    pressEnter();
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByTestId('message-input-resend-confirm-yes'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getTextarea().value).toBe(''));
    first.unmount();

    render(<MessageInput {...base()} />);
    await typeAndWaitForSave('hello agent');
    await submitAndSettle();
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(3));
    expect(screen.queryByTestId('message-input-resend-confirm')).toBeNull();
  });
});
