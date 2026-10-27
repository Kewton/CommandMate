/**
 * The New task dialog's Auto-Yes select offers 1〜24 hours (Issue #3913).
 *
 * An OFF destination armed for 5h / 24h posts that many ms before the send; an
 * ON destination is never re-armed (no select is offered); "keep" arms
 * nothing. Harness copied from `NewTaskDialog.test.tsx`.
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

const HOUR = 3_600_000;

describe('[#3913] NewTaskDialog — Auto-Yes for 1〜24 hours', () => {
  it('offers "keep" and every whole hour from 1 to 24', async () => {
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'codex-2' });
    await openDialog();
    const values = Array.from((screen.getByTestId('new-task-auto-yes') as HTMLSelectElement).options, (o) => o.value);
    expect(values).toEqual(['', ...Array.from({ length: 24 }, (_, i) => String((i + 1) * HOUR))]);
  });

  it.each([5, 24])('arms an OFF destination for %ih before sending', async (hours) => {
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'codex-2' });
    const textarea = await openDialog();
    fireEvent.change(screen.getByTestId('new-task-auto-yes'), { target: { value: String(hours * HOUR) } });
    fireEvent.change(textarea, { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('new-task-send'));

    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    const posts = server.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.url)).toEqual(['/api/worktrees/wt-a-main/auto-yes', '/api/worktrees/wt-a-main/send']);
    expect(posts[0].body).toMatchObject({ enabled: true, instanceId: 'codex-2', duration: hours * HOUR });
  });

  it('"keep" arms nothing (negative control)', async () => {
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'codex-2' });
    const textarea = await openDialog();
    fireEvent.change(textarea, { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('new-task-send'));

    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    expect(server.calls.some((c) => c.url.endsWith('/auto-yes'))).toBe(false);
  });

  it('never re-arms or extends an ON destination (negative control)', async () => {
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'claude' });
    const textarea = await openDialog();
    expect(screen.queryByTestId('new-task-auto-yes')).toBeNull();
    fireEvent.change(textarea, { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('new-task-send'));

    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    expect(server.calls.some((c) => c.url.endsWith('/auto-yes'))).toBe(false);
  });
});
