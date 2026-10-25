/**
 * The New task dialog's Auto-Yes field offers the answer mode (Issue #3863).
 *
 * Once a duration is picked, the field shows the same two choices the
 * Auto-Yes confirm dialog does — 「質問は推奨で回答（おまかせ）」 (the default)
 * and 「質問は自分で回答（慎重）」 — with the note that permissions are
 * answered under either. The choice reaches the arming `POST .../auto-yes` as
 * `answerMode`, the default named too (an omitted mode on an instance already
 * on keeps its current mode). Same harness as `NewTaskDialog.test.tsx`.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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
import { KeyboardShortcutsOverlay } from '@/components/common/KeyboardShortcutsOverlay';
import { KeyboardShortcutsProvider } from '@/contexts/KeyboardShortcutsContext';
import {
  buildRepositories,
  buildWorktrees,
  jsonResponse,
} from '../../lib/new-task/new-task-fixtures';

const server = vi.hoisted(() => ({
  send: { status: 201, body: {} } as { status: number; body: unknown },
  calls: [] as Array<{ url: string; method: string; body: unknown }>,
  /** When set, `/send` answers only once this resolves. */
  sendGate: null as Promise<void> | null,
  /** Overrides the list payload's worktrees. */
  worktrees: null as unknown[] | null,
}));

function ScreenTarget({ worktreeId, instanceId }: { worktreeId: string; instanceId: string }) {
  useNewTaskScreenTarget(worktreeId, instanceId);
  return null;
}

function OpenButton() {
  const { openNewTask, closeNewTask } = useNewTask();
  return (
    <>
      <button type="button" data-testid="open-new-task" onClick={() => openNewTask()}>
        open
      </button>
      {/* Somebody else closing it (the dialog's own controls aside). */}
      <button type="button" data-testid="external-close" onClick={() => closeNewTask()}>
        close
      </button>
    </>
  );
}

function renderShell(
  screenTarget?: { worktreeId: string; instanceId: string },
  extra?: React.ReactNode,
) {
  return render(
    <ToastProvider>
      <KeyboardShortcutsProvider>
        <NewTaskProvider>
          {screenTarget && <ScreenTarget {...screenTarget} />}
          {extra}
          <OpenButton />
          <NewTaskDialogHost />
          <KeyboardShortcutsOverlay />
        </NewTaskProvider>
      </KeyboardShortcutsProvider>
    </ToastProvider>,
  );
}

function pressOpenChord() {
  fireEvent.keyDown(window, { key: 'O', code: 'KeyO', metaKey: true, shiftKey: true });
}

async function openDialog() {
  pressOpenChord();
  return screen.findByTestId('new-task-message');
}

beforeEach(() => {
  window.localStorage.clear();
  nav.push.mockClear();
  server.calls = [];
  server.send = { status: 201, body: { id: 'm1' } };
  server.sendGate = null;
  server.worktrees = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      server.calls.push({ url, method, body });
      if (url === '/api/worktrees' && method === 'GET') {
        return jsonResponse({ worktrees: server.worktrees ?? buildWorktrees(), repositories: buildRepositories() });
      }
      if (url.endsWith('/auto-yes')) {
        return jsonResponse({ enabled: true, expiresAt: Date.now() + Number(body?.duration ?? 3600000), pollingStarted: true });
      }
      if (url.endsWith('/send')) {
        if (server.sendGate) await server.sendGate;
        return jsonResponse(server.send.body, server.send.status);
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

describe('[#3863] NewTaskDialog — the Auto-Yes answer mode', () => {
  it('offers the two modes only once a duration is picked, おまかせ selected', async () => {
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'codex-2' });
    await openDialog();
    expect(screen.queryByTestId('new-task-auto-yes-answer-mode-options')).toBeNull();

    fireEvent.change(screen.getByTestId('new-task-auto-yes'), { target: { value: '3600000' } });

    expect(screen.getByTestId('new-task-auto-yes-answer-mode-recommended')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('new-task-auto-yes-answer-mode-careful')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('new-task-auto-yes-answer-mode-recommended')).toHaveTextContent('autoYes.answerModes.recommended');
    expect(screen.getByTestId('new-task-auto-yes-answer-mode-careful')).toHaveTextContent('autoYes.answerModes.careful');
    expect(screen.getByTestId('new-task-auto-yes-answer-mode-permission-note')).toHaveTextContent(
      'autoYes.answerModePermissionNote',
    );
  });

  it('arms in 慎重 when it is picked', async () => {
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'codex-2' });
    const textarea = await openDialog();
    fireEvent.change(screen.getByTestId('new-task-auto-yes'), { target: { value: '10800000' } });
    fireEvent.click(screen.getByTestId('new-task-auto-yes-answer-mode-careful'));
    expect(screen.getByTestId('new-task-auto-yes-answer-mode-careful')).toHaveAttribute('aria-checked', 'true');
    fireEvent.change(textarea, { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('new-task-send'));

    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    const posts = server.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.url)).toEqual(['/api/worktrees/wt-a-main/auto-yes', '/api/worktrees/wt-a-main/send']);
    expect(posts[0].body).toEqual({
      enabled: true,
      cliToolId: 'codex',
      instanceId: 'codex-2',
      duration: 10800000,
      answerMode: 'careful',
    });
  });

  it('names おまかせ when it is left as it is', async () => {
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'codex-2' });
    const textarea = await openDialog();
    fireEvent.change(screen.getByTestId('new-task-auto-yes'), { target: { value: '3600000' } });
    fireEvent.change(textarea, { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('new-task-send'));

    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    const arm = server.calls.find((c) => c.url.endsWith('/auto-yes'));
    expect(arm?.body).toMatchObject({ enabled: true, answerMode: 'recommended' });
  });

  it('arms nothing when no duration is picked (negative control)', async () => {
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'codex-2' });
    const textarea = await openDialog();
    fireEvent.change(textarea, { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('new-task-send'));

    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    expect(server.calls.some((c) => c.url.endsWith('/auto-yes'))).toBe(false);
  });
});
