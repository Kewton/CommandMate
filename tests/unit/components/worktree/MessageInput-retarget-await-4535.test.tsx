/**
 * Issue #4535 r5 (review H1, opus P3-5・P3-6): the composer's awaited sends — the plain awaited send
 * (no optimistic history) and the send of the session-brief choice (always awaited) — when the send
 * fence (#4534) answers 409 `SEND_TARGET_CHANGED`:
 *
 * - `not_sent`: the text stays in the composer with a hold of its original target. After the To
 *   changed, Enter once POSTs nothing and asks (naming both targets); cancelled POSTs nothing.
 * - `unknown`: the composer says nobody knows whether it arrived (#4503), and why (the fence's reason).
 *
 * Negative control: the To still the original target — Enter sends at once.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, waitFor, act, cleanup } from '@testing-library/react';
import { MessageInput } from '@/components/worktree/MessageInput';
import { mockCommandGroups, getTextarea, typeMessage, pressEnter } from '@tests/helpers/message-input-test-utils';
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

import { ApiError } from '@/lib/api-client';

const WT = 'wt-4535-await';
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
const CHANGED: Target = { id: 'claude', tool: 'claude' };

function fence(reason: string, sendOutcome: 'not_sent' | 'unknown', original: Target = ORIGINAL): ApiError {
  return new ApiError('The send target changed', 409, {
    error: 'The send target changed',
    code: 'SEND_TARGET_CHANGED',
    reason,
    target: { worktreeId: WT, instanceId: original.id, cliToolId: original.tool },
    current: null,
    requestId: 'r-1',
    sendOutcome,
  });
}

function Composer({ target }: { target: Target }) {
  return <MessageInput worktreeId={WT} cliToolId={target.tool} instanceId={target.id} isSessionRunning onMessageSent={vi.fn()} />;
}

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function submitAndSettle() {
  await act(async () => {
    fireEvent.submit(getTextarea().closest('form')!);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  sendMessageMock.mockReset();
  fetchStartPreviewMock.mockReset();
  fetchStartPreviewMock.mockResolvedValue(NOT_SHOWN);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe.each([
  ['the plain awaited send', false],
  ['the brief-choice send', true],
])('[#4535 T19b r5] %s: the fence 409 not_sent, then the To changed', (_name, brief) => {
  async function sendThenRefuse(reason: string, current: Target) {
    if (brief) fetchStartPreviewMock.mockResolvedValue(SHOWN);
    sendMessageMock.mockRejectedValueOnce(fence(reason, 'not_sent')).mockResolvedValue({ id: 's2', role: 'user', content: TEXT, timestamp: new Date() });
    const view = render(<Composer target={ORIGINAL} />);
    typeMessage(TEXT);
    await submitAndSettle();
    if (brief) fireEvent.click(await screen.findByTestId('session-start-brief-decline'));
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    await settle(10);
    expect(getTextarea().value).toBe(TEXT);
    fetchStartPreviewMock.mockResolvedValue(NOT_SHOWN);
    view.rerender(<Composer target={current} />);
    await settle(10);
  }

  it('Enter once POSTs nothing and asks, naming both targets; cancelled POSTs nothing', async () => {
    await sendThenRefuse('target-gone', CHANGED);
    pressEnter();
    await settle(10);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const confirm = await screen.findByTestId('message-input-retarget-confirm');
    expect(confirm.textContent).toContain(ORIGINAL.id);
    expect(confirm.textContent).toContain(CHANGED.id);
    fireEvent.click(screen.getByTestId('message-input-retarget-confirm-no'));
    await settle(10);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(getTextarea().value).toBe(TEXT);
  });

  it('(negative control) the To still the original target: Enter sends at once', async () => {
    await sendThenRefuse('dispatch-changed', ORIGINAL);
    pressEnter();
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('message-input-retarget-confirm')).toBeNull();
  });
});

describe('[#4535 r5] the awaited send: the fence 409 unknown says why', () => {
  it('the unknown notice carries the fence\'s reason', async () => {
    sendMessageMock.mockRejectedValueOnce(fence('dispatch-changed', 'unknown'));
    render(<Composer target={ORIGINAL} />);
    typeMessage(TEXT);
    await submitAndSettle();
    await waitFor(() => expect(screen.getByTestId('message-input-send-unknown')).toBeInTheDocument());
    expect(screen.getByTestId('message-input-send-unknown-reason')).toHaveTextContent('送り先の起動の仕方が替わりました');
    expect(screen.getByTestId('message-input-send-unknown').textContent).not.toContain('送っていません');
  });
});
