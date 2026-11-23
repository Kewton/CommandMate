/**
 * Issue #4535 (T15 / INV-S10, design `send-outcome-4535.md` 第 2.1 版 §3.4・C9): the New task dialog
 * never sends again on a plain press after a send whose outcome is unknown. It says so, offers the
 * destination's screen, and sends again only after the person confirmed ("the same request is sent
 * again; it may arrive twice") — then exactly once. Cancelling the question sends nothing.
 *
 * Positive control: a `not_sent` refusal (409 PROMPT_WAITING) is sent again on the next press, as
 * before. Rendered as `NewTaskDialog.test.tsx` renders it (provider, host, the browser's `fetch`).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/sessions',
  useSearchParams: () => new URLSearchParams(),
}));

import { NewTaskProvider, useNewTask } from '@/contexts/NewTaskContext';
import { NewTaskDialogHost } from '@/components/new-task/NewTaskDialogHost';
import { ToastProvider } from '@/components/common/Toast';
import { useNewTaskScreenTarget } from '@/hooks/useNewTaskScreenTarget';
import { getSendTimeoutMs } from '@/config/api-timeout-config';
import { buildRepositories, buildWorktrees, jsonResponse } from '../../lib/new-task/new-task-fixtures';

const server = vi.hoisted(() => ({
  answers: [] as Array<{ status: number; body: unknown }>,
  calls: [] as Array<{ url: string; method: string; body: unknown }>,
}));

function ScreenTarget({ worktreeId, instanceId }: { worktreeId: string; instanceId: string }) {
  useNewTaskScreenTarget(worktreeId, instanceId);
  return null;
}

function OpenButton() {
  const { openNewTask } = useNewTask();
  return (
    <button type="button" data-testid="open-new-task" onClick={() => openNewTask()}>
      open
    </button>
  );
}

function renderShell() {
  return render(
    <ToastProvider>
      <NewTaskProvider>
        <ScreenTarget worktreeId="wt-a-main" instanceId="codex-2" />
        <OpenButton />
        <NewTaskDialogHost />
      </NewTaskProvider>
    </ToastProvider>,
  );
}

const sendCalls = () => server.calls.filter((c) => c.url.endsWith('/send'));

async function openAndType(text: string) {
  fireEvent.click(screen.getByTestId('open-new-task'));
  const textarea = await screen.findByTestId('new-task-message');
  fireEvent.change(textarea, { target: { value: text } });
}

beforeEach(() => {
  window.localStorage.clear();
  nav.push.mockClear();
  server.calls = [];
  server.answers = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      server.calls.push({ url, method, body });
      if (url === '/api/worktrees' && method === 'GET') {
        return jsonResponse({ worktrees: buildWorktrees(), repositories: buildRepositories() });
      }
      if (url.endsWith('/send')) {
        const answer = server.answers.shift() ?? { status: 201, body: { id: 'm1' } };
        return jsonResponse(answer.body, answer.status);
      }
      return jsonResponse({}, 404);
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('[#4535 T15] NewTaskDialog — an unknown outcome is not sent again without a confirmation', () => {
  it('a second press after unknown asks first and sends once', async () => {
    server.answers = [{ status: 500, body: { error: 'submit could not be confirmed', sendOutcome: 'unknown' } }];
    renderShell();
    await openAndType('did it arrive');
    fireEvent.click(screen.getByTestId('new-task-send'));
    await waitFor(() => expect(screen.getByTestId('new-task-error')).toHaveAttribute('data-kind', 'unknown'));
    expect(screen.getByTestId('new-task-open-target')).toBeInTheDocument();
    expect(sendCalls()).toHaveLength(1);

    // A plain press asks; nothing is sent.
    fireEvent.click(screen.getByTestId('new-task-send'));
    expect(await screen.findByTestId('new-task-resend-confirm')).toBeInTheDocument();
    expect(sendCalls()).toHaveLength(1);

    // Cancelled: still nothing.
    fireEvent.click(screen.getByTestId('new-task-resend-confirm-no'));
    expect(screen.queryByTestId('new-task-resend-confirm')).toBeNull();
    expect(sendCalls()).toHaveLength(1);

    // The keyboard chord asks too.
    fireEvent.keyDown(screen.getByTestId('new-task-message'), { key: 'Enter', ctrlKey: true });
    expect(await screen.findByTestId('new-task-resend-confirm')).toBeInTheDocument();
    expect(sendCalls()).toHaveLength(1);

    // Confirmed: sent exactly once more.
    fireEvent.click(screen.getByTestId('new-task-resend-confirm-yes'));
    await waitFor(() => expect(sendCalls()).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId('new-task-dialog')).toBeNull());
    expect(sendCalls()).toHaveLength(2);
  });

  it('a send that never answered (the transport timed out) asks first too', async () => {
    renderShell();
    await openAndType('slow');
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementationOnce((url) => {
      server.calls.push({ url: String(url), method: 'POST', body: undefined });
      return new Promise<Response>(() => {});
    });
    fireEvent.click(screen.getByTestId('new-task-send'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(getSendTimeoutMs());
    });
    vi.useRealTimers();
    expect(screen.getByTestId('new-task-error')).toHaveAttribute('data-kind', 'unknown');
    fireEvent.click(screen.getByTestId('new-task-send'));
    expect(await screen.findByTestId('new-task-resend-confirm')).toBeInTheDocument();
    expect(sendCalls()).toHaveLength(1);
  });

  it('the destination button opens the destination instead of sending', async () => {
    server.answers = [{ status: 500, body: { error: 'x', sendOutcome: 'unknown' } }];
    renderShell();
    await openAndType('look first');
    fireEvent.click(screen.getByTestId('new-task-send'));
    fireEvent.click(await screen.findByTestId('new-task-open-target'));
    expect(nav.push).toHaveBeenCalledWith('/worktrees/wt-a-main?instance=codex-2');
    expect(sendCalls()).toHaveLength(1);
  });

  it('(positive control) a not_sent refusal is sent again on the next press, as before', async () => {
    server.answers = [{ status: 409, body: { error: 'prompt up', code: 'PROMPT_WAITING', sendOutcome: 'not_sent' } }];
    renderShell();
    await openAndType('again');
    fireEvent.click(screen.getByTestId('new-task-send'));
    await waitFor(() => expect(screen.getByTestId('new-task-error')).toHaveAttribute('data-kind', 'prompt_waiting'));
    fireEvent.click(screen.getByTestId('new-task-send'));
    await waitFor(() => expect(sendCalls()).toHaveLength(2));
    expect(screen.queryByTestId('new-task-resend-confirm')).toBeNull();
  });

  it('a 409 SEND_TARGET_CHANGED not_sent says the reason, and the next press sends directly', async () => {
    server.answers = [
      {
        status: 409,
        body: {
          error: 'x',
          code: 'SEND_TARGET_CHANGED',
          reason: 'target-gone',
          target: { worktreeId: 'wt-a-main', instanceId: 'codex-2', cliToolId: 'codex' },
          current: null,
          requestId: null,
          sendOutcome: 'not_sent',
        },
      },
    ];
    renderShell();
    await openAndType('moved');
    fireEvent.click(screen.getByTestId('new-task-send'));
    const error = await screen.findByTestId('new-task-error');
    expect(error).toHaveAttribute('data-kind', 'conflict');
    expect(screen.getByTestId('new-task-error-reason')).toHaveTextContent('worktree.conversation.sendTargetChanged.notSent');
    fireEvent.click(screen.getByTestId('new-task-send'));
    await waitFor(() => expect(sendCalls()).toHaveLength(2));
  });
});
