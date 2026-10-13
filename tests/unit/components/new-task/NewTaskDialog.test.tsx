/**
 * The New task dialog (Issue #3511).
 *
 * Rendered the way AppShell mounts it — `NewTaskProvider` + `NewTaskDialogHost`
 * — and opened with the real chord. The network is the browser's `fetch`: the
 * list is a `GET /api/worktrees` payload, and the send answers carry the
 * statuses and `code`s the real route produces (pinned against the route in
 * `tests/unit/lib/new-task/send-new-task-route-contract.test.ts`).
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
import { KeyboardShortcutsOverlay } from '@/components/common/KeyboardShortcutsOverlay';
import { KeyboardShortcutsProvider } from '@/contexts/KeyboardShortcutsContext';
import { readRecentTargets, pushRecentTarget } from '@/lib/new-task/recent-targets';
import { SEND_RESPONSE_CODES } from '@/lib/new-task/send-new-task';
import { PromptPanel } from '@/components/worktree/PromptPanel';
import { API_MUTATION_TIMEOUT_MS } from '@/config/api-timeout-config';
import type { YesNoPromptData } from '@/types/models';
import {
  buildRepositories,
  buildWorktrees,
  jsonResponse,
} from '../../lib/new-task/new-task-fixtures';

type Answer = { status: number; body: unknown };
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

function sendCalls() {
  return server.calls.filter((c) => c.url.endsWith('/send'));
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

describe('[#3511] NewTaskDialog — opening and the starting destination', () => {
  it('is not mounted, and fetches nothing, until opened (negative control)', () => {
    renderShell();
    expect(screen.queryByTestId('new-task-dialog')).toBeNull();
    expect(server.calls).toEqual([]);
  });

  it('opens from openNewTask() as well as from the chord', async () => {
    renderShell();
    fireEvent.click(screen.getByTestId('open-new-task'));
    expect(await screen.findByTestId('new-task-message')).toBeInTheDocument();
  });

  it('starts on the worktree and agent the screen reports', async () => {
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'codex-2' });
    await openDialog();

    expect(screen.getByTestId('new-task-repository')).toHaveValue('/repo/alpha');
    expect(screen.getByTestId('new-task-branch')).toHaveValue('wt-a-main');
    expect(screen.getByTestId('new-task-agent')).toHaveValue('codex-2');
  });

  it('starts on the last destination on a list screen', async () => {
    pushRecentTarget({ worktreeId: 'wt-a-feat', instanceId: 'claude' });
    pushRecentTarget({ worktreeId: 'wt-b-main', instanceId: 'gemini' });
    renderShell();
    await openDialog();

    expect(screen.getByTestId('new-task-branch')).toHaveValue('wt-b-main');
    expect(screen.getByTestId('new-task-agent')).toHaveValue('gemini');
    const recents = screen.getAllByTestId('new-task-recent');
    expect(recents.map((b) => b.textContent)).toEqual(['beta / main / Gemini', 'Alpha / feature/x / Claude']);

    fireEvent.click(recents[1]);
    expect(screen.getByTestId('new-task-branch')).toHaveValue('wt-a-feat');
    expect(screen.getByTestId('new-task-agent')).toHaveValue('claude');
  });

  it('moves through repository → branch → agent', async () => {
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'claude' });
    await openDialog();

    fireEvent.change(screen.getByTestId('new-task-repository'), { target: { value: '/repo/beta' } });
    expect(screen.getByTestId('new-task-branch')).toHaveValue('wt-b-main');
    expect(screen.getByTestId('new-task-agent')).toHaveValue('copilot');

    fireEvent.change(screen.getByTestId('new-task-agent'), { target: { value: 'gemini' } });
    expect(screen.getByTestId('new-task-agent')).toHaveValue('gemini');
  });
});

describe('[#3511] NewTaskDialog — what it tells the user before sending', () => {
  it('says a stopped agent will be started', async () => {
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'codex-2' });
    await openDialog();
    expect(screen.getByTestId('new-task-will-start')).toHaveTextContent('common.newTask.willStart');
  });

  it('says nothing about starting a running agent (negative control)', async () => {
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'claude' });
    await openDialog();
    expect(screen.queryByTestId('new-task-will-start')).toBeNull();
  });

  it('shows an armed Auto-Yes with its time left and offers no change', async () => {
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'claude' });
    await openDialog();
    expect(screen.getByTestId('new-task-auto-yes-active')).toHaveTextContent('common.newTask.autoYesActive');
    expect(screen.queryByTestId('new-task-auto-yes')).toBeNull();
  });

  it('leaves an unarmed Auto-Yes off by default', async () => {
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'codex-2' });
    await openDialog();
    expect(screen.getByTestId('new-task-auto-yes')).toHaveValue('');
    expect(screen.queryByTestId('new-task-auto-yes-risk')).toBeNull();
  });

  it.each([
    ['wt-a-main', 'claude', true, 'common.newTask.modelUnavailable.running'],
    ['wt-b-main', 'gemini', true, 'common.newTask.modelUnavailable.unsupported'],
    ['wt-a-feat', 'claude', false, 'common.newTask.modelHintLaunch'],
    ['wt-b-main', 'copilot', false, 'common.newTask.modelHintSwitch'],
  ])('model on %s/%s: disabled=%s, note %s', async (worktreeId, instanceId, disabled, note) => {
    renderShell({ worktreeId, instanceId });
    await openDialog();
    if (disabled) expect(screen.getByTestId('new-task-model')).toBeDisabled();
    else expect(screen.getByTestId('new-task-model')).toBeEnabled();
    expect(screen.getByTestId('new-task-model-note')).toHaveTextContent(note);
  });
});

describe('[#3511] NewTaskDialog — sending', () => {
  it('sends with Mod+Enter, opens the branch on the sent instance, records it and toasts a way back', async () => {
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'codex-2' });
    const textarea = await openDialog();
    fireEvent.change(textarea, { target: { value: 'Review the diff' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/worktrees/wt-a-main?instance=codex-2'));
    expect(sendCalls()).toEqual([
      {
        url: '/api/worktrees/wt-a-main/send',
        method: 'POST',
        body: { content: 'Review the diff', cliToolId: 'codex', instanceId: 'codex-2' },
      },
    ]);
    expect(screen.queryByTestId('new-task-dialog')).toBeNull();
    expect(readRecentTargets()[0]).toEqual({ worktreeId: 'wt-a-main', instanceId: 'codex-2' });

    const toast = await screen.findByTestId('toast-action-button');
    expect(toast).toHaveTextContent('common.newTask.sentToast');
    fireEvent.click(toast);
    expect(nav.push).toHaveBeenLastCalledWith(`${window.location.pathname}${window.location.search}`);
  });

  it('does not send on Enter alone, nor with an empty request (negative control)', async () => {
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'codex-2' });
    const textarea = await openDialog();

    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    expect(screen.getByTestId('new-task-send')).toBeDisabled();

    fireEvent.change(textarea, { target: { value: 'line one' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(sendCalls()).toEqual([]);
    expect(screen.getByTestId('new-task-dialog')).toBeInTheDocument();
  });

  it('arms the picked Auto-Yes before sending', async () => {
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'codex-2' });
    const textarea = await openDialog();
    fireEvent.change(screen.getByTestId('new-task-auto-yes'), { target: { value: '10800000' } });
    expect(screen.getByTestId('new-task-auto-yes-risk')).toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('new-task-send'));

    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    const posts = server.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.url)).toEqual(['/api/worktrees/wt-a-main/auto-yes', '/api/worktrees/wt-a-main/send']);
    expect(posts[0].body).toEqual({ enabled: true, cliToolId: 'codex', instanceId: 'codex-2', duration: 10800000 });
  });

  it('never re-arms an Auto-Yes that is already on', async () => {
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'claude' });
    const textarea = await openDialog();
    fireEvent.change(textarea, { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('new-task-send'));

    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    expect(server.calls.some((c) => c.url.endsWith('/auto-yes'))).toBe(false);
  });

  it('sends a model only where the route takes one', async () => {
    renderShell({ worktreeId: 'wt-a-feat', instanceId: 'claude' });
    const textarea = await openDialog();
    fireEvent.change(screen.getByTestId('new-task-model'), { target: { value: 'sonnet' } });
    fireEvent.change(textarea, { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('new-task-send'));

    await waitFor(() => expect(sendCalls()).toHaveLength(1));
    expect(sendCalls()[0].body).toEqual({ content: 'go', cliToolId: 'claude', instanceId: 'claude', model: 'sonnet' });
  });

  const failures: Array<[string, Answer, string, string | null]> = [
    [
      '409 prompt waiting',
      { status: 409, body: { error: 'A prompt is waiting; answer it with respond', code: SEND_RESPONSE_CODES.promptWaiting } },
      'prompt_waiting',
      'A prompt is waiting; answer it with respond',
    ],
    [
      '400 model refused',
      { status: 400, body: { error: 'Invalid model name: Model name contains invalid characters' } },
      'model_rejected',
      'Invalid model name: Model name contains invalid characters',
    ],
    [
      '503 still starting',
      { status: 503, body: { error: 'Codex CLI is still starting', code: SEND_RESPONSE_CODES.sessionStarting } },
      'starting',
      'Codex CLI is still starting',
    ],
    ['500 failure', { status: 500, body: { error: 'Failed to send message' } }, 'failed', 'Failed to send message'],
  ];

  it.each(failures)('keeps the dialog and the request open on %s, and says why', async (_name, answer, kind, detail) => {
    server.send = answer;
    renderShell({ worktreeId: 'wt-a-feat', instanceId: 'claude' });
    const textarea = await openDialog();
    if (kind === 'model_rejected') {
      fireEvent.change(screen.getByTestId('new-task-model'), { target: { value: 'sonnet!' } });
    }
    fireEvent.change(textarea, { target: { value: 'keep me' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    const error = await screen.findByTestId('new-task-error');
    expect(error).toHaveAttribute('data-kind', kind);
    expect(error).toHaveTextContent(`common.newTask.errors.${kind}`);
    expect(screen.getByTestId('new-task-error-detail')).toHaveTextContent(detail ?? '');
    expect(screen.getByTestId('new-task-message')).toHaveValue('keep me');
    expect(nav.push).not.toHaveBeenCalled();
    expect(readRecentTargets()).toEqual([]);
    // Sending again is possible once the reason is dealt with.
    expect(screen.getByTestId('new-task-send')).toBeEnabled();
  });

  it('keeps the dialog open when the request gets no reply', async () => {
    renderShell({ worktreeId: 'wt-a-feat', instanceId: 'claude' });
    const textarea = await openDialog();
    vi.mocked(fetch).mockImplementationOnce(async () => {
      throw new TypeError('Failed to fetch');
    });
    fireEvent.change(textarea, { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('new-task-send'));

    const error = await screen.findByTestId('new-task-error');
    expect(error).toHaveAttribute('data-kind', 'failed');
    expect(screen.getByTestId('new-task-dialog')).toBeInTheDocument();
  });
});

describe('[#3511] NewTaskDialog — cannot be closed while a send is in flight', () => {
  function gateSend() {
    let release: () => void = () => {};
    server.sendGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => release();
  }

  it('stays through ×, Esc, a backdrop click and closeNewTask(), then finishes the send', async () => {
    const release = gateSend();
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'codex-2' });
    const textarea = await openDialog();
    fireEvent.change(textarea, { target: { value: 'long running' } });
    fireEvent.click(screen.getByTestId('new-task-send'));
    await waitFor(() => expect(sendCalls()).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    const backdrop = screen.getByTestId('modal-backdrop-surface');
    fireEvent.mouseDown(backdrop);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);
    fireEvent.click(screen.getByTestId('external-close'));
    expect(screen.getByTestId('new-task-dialog')).toBeInTheDocument();

    await act(async () => {
      release();
    });
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/worktrees/wt-a-main?instance=codex-2'));
    expect(screen.queryByTestId('new-task-dialog')).toBeNull();
    expect(readRecentTargets()[0]).toEqual({ worktreeId: 'wt-a-main', instanceId: 'codex-2' });
    expect(await screen.findByTestId('toast-action-button')).toHaveTextContent('common.newTask.sentToast');
  });

  it('closes on × when nothing is being sent (negative control)', async () => {
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'codex-2' });
    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    expect(screen.queryByTestId('new-task-dialog')).toBeNull();
  });

  it('closes on closeNewTask() again after a failed send', async () => {
    server.send = { status: 500, body: { error: 'Failed to send message' } };
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'codex-2' });
    const textarea = await openDialog();
    fireEvent.change(textarea, { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('new-task-send'));
    await screen.findByTestId('new-task-error');
    fireEvent.click(screen.getByTestId('external-close'));
    expect(screen.queryByTestId('new-task-dialog')).toBeNull();
  });
});

describe('[#3511] NewTaskDialog — Auto-Yes shown as the server holds it', () => {
  it('after an arm whose send failed, shows it on and does not arm again on resend', async () => {
    server.send = { status: 409, body: { error: 'prompt up', code: SEND_RESPONSE_CODES.promptWaiting } };
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'codex-2' });
    const textarea = await openDialog();
    fireEvent.change(screen.getByTestId('new-task-auto-yes'), { target: { value: '3600000' } });
    fireEvent.change(textarea, { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('new-task-send'));

    await screen.findByTestId('new-task-error');
    expect(screen.getByTestId('new-task-auto-yes-active')).toHaveTextContent('common.newTask.autoYesActive');
    expect(screen.queryByTestId('new-task-auto-yes')).toBeNull();

    server.send = { status: 201, body: { id: 'm1' } };
    fireEvent.click(screen.getByTestId('new-task-send'));
    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    expect(server.calls.filter((c) => c.url.endsWith('/auto-yes'))).toHaveLength(1);
    expect(sendCalls()).toHaveLength(2);
  });

  function withClaudeAutoYesExpiringAt(expiresAt: number) {
    const worktrees = buildWorktrees();
    worktrees[0].autoYesByInstance = { claude: { enabled: true, expiresAt } };
    server.worktrees = worktrees;
  }

  it('treats an expired Auto-Yes as off and offers arming again', async () => {
    withClaudeAutoYesExpiringAt(Date.now() - 1000);
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'claude' });
    await openDialog();
    expect(screen.queryByTestId('new-task-auto-yes-active')).toBeNull();
    expect(screen.getByTestId('new-task-auto-yes')).toHaveValue('');
  });

  it('flips to off when the countdown reaches zero while open', async () => {
    withClaudeAutoYesExpiringAt(Date.now() + 1200);
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'claude' });
    await openDialog();
    expect(screen.getByTestId('new-task-auto-yes-active')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('new-task-auto-yes')).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.queryByTestId('new-task-auto-yes-active')).toBeNull();
  });
});

describe('[#3511] NewTaskDialog — never opens over another modal', () => {
  it('ignores the chord and openNewTask() while the ? help is open', async () => {
    renderShell();
    fireEvent.keyDown(window, { key: '?' });
    expect(await screen.findByTestId('keyboard-shortcuts-overlay')).toBeInTheDocument();

    pressOpenChord();
    fireEvent.click(screen.getByTestId('open-new-task'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('new-task-dialog')).toBeNull();
    expect(server.calls).toEqual([]);
  });

  it('opens once the help has closed (negative control)', async () => {
    renderShell();
    fireEvent.keyDown(window, { key: '?' });
    await screen.findByTestId('keyboard-shortcuts-overlay');
    fireEvent.keyDown(document, { key: 'Escape' });
    // The panel plays its exit animation as data-state="closed"; that does not block.
    pressOpenChord();
    expect(await screen.findByTestId('new-task-message')).toBeInTheDocument();
  });
});

describe('[#3511] NewTaskDialog — only a real modal holds it back', () => {
  const YES_NO: YesNoPromptData = {
    type: 'yes_no',
    question: 'Continue?',
    options: ['yes', 'no'],
    status: 'pending',
  };
  // The panel the terminal pane renders inline: role="dialog" aria-modal, no focus trap.
  const inlinePromptPanel = (
    <PromptPanel promptData={YES_NO} messageId="p1" visible answering={false} onRespond={async () => {}} />
  );

  it('opens by the chord and by openNewTask() while an inline PromptPanel is on screen', async () => {
    renderShell(undefined, inlinePromptPanel);
    expect(screen.getByTestId('prompt-panel')).toHaveAttribute('aria-modal', 'true');

    expect(await openDialog()).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('new-task-cancel'));
    expect(screen.queryByTestId('new-task-dialog')).toBeNull();

    fireEvent.click(screen.getByTestId('open-new-task'));
    expect(await screen.findByTestId('new-task-message')).toBeInTheDocument();
  });

  it('opens while the only modal-looking element sits in a display:none split', async () => {
    // TerminalSplitContainer hides a split behind a maximized one with
    // `display: none` and keeps it mounted.
    renderShell(
      undefined,
      <div data-testid="hidden-split" style={{ display: 'none' }}>
        {inlinePromptPanel}
      </div>,
    );
    expect(screen.getByTestId('hidden-split')).toContainElement(screen.getByTestId('prompt-panel'));

    fireEvent.click(screen.getByTestId('open-new-task'));
    expect(await screen.findByTestId('new-task-message')).toBeInTheDocument();
  });
});

describe('[#3511] NewTaskDialog — the close lock always ends', () => {
  it('fails the send once a body that never finishes passes the transport timeout, and can close again', async () => {
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'codex-2' });
    const textarea = await openDialog();
    fireEvent.change(screen.getByTestId('new-task-auto-yes'), { target: { value: '3600000' } });
    fireEvent.change(textarea, { target: { value: 'go' } });

    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementationOnce(async (url) => {
      server.calls.push({ url: String(url), method: 'POST', body: undefined });
      // Headers say 200; the JSON body never arrives.
      return {
        ok: true,
        status: 200,
        redirected: false,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => new Promise(() => {}),
        text: () => new Promise(() => {}),
      } as unknown as Response;
    });
    fireEvent.click(screen.getByTestId('new-task-send'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(API_MUTATION_TIMEOUT_MS - 1);
    });
    expect(server.calls.filter((c) => c.url.endsWith('/auto-yes'))).toHaveLength(1);
    fireEvent.click(screen.getByTestId('external-close'));
    expect(screen.getByTestId('new-task-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('new-task-error')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByTestId('new-task-error')).toHaveAttribute('data-kind', 'failed');
    expect(screen.getByTestId('new-task-error-detail')).toHaveTextContent(`Request timed out after ${API_MUTATION_TIMEOUT_MS}ms`);
    expect(sendCalls()).toEqual([]);
    // Issue #3563: the expiry is unknown (the timeout is not the server's enabling
    // time), so no countdown is shown and the choice stays: a resend arms again.
    expect(screen.queryByTestId('new-task-auto-yes-active')).toBeNull();
    expect(screen.getByTestId('new-task-auto-yes')).toHaveValue('3600000');
    // Never asserted off: the unknown notice shows and "keep (off)" wording is gone.
    expect(screen.getByTestId('new-task-auto-yes-unknown')).toBeInTheDocument();
    expect(screen.getByTestId('new-task-auto-yes')).toHaveTextContent('newTask.autoYesKeepUnknown');
    expect(screen.getByTestId('new-task-auto-yes').textContent).not.toMatch(/autoYesKeep(?!Unknown)/);
    fireEvent.click(screen.getByTestId('new-task-send'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(server.calls.filter((c) => c.url.endsWith('/auto-yes'))).toHaveLength(2);
    expect(sendCalls()).toHaveLength(1);
    expect(screen.queryByTestId('new-task-dialog')).toBeNull();
  });

  it('keeps the plain "Leave off" wording for a target whose state is known off (negative control, #3563)', async () => {
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'codex-2' });
    await openDialog();
    expect(screen.getByTestId('new-task-auto-yes').textContent).toMatch(/autoYesKeep(?!Unknown)/);
    expect(screen.queryByTestId('new-task-auto-yes-unknown')).toBeNull();
  });

  it('sends and closes as before when the bodies arrive (negative control)', async () => {
    renderShell({ worktreeId: 'wt-a-main', instanceId: 'codex-2' });
    const textarea = await openDialog();
    fireEvent.change(screen.getByTestId('new-task-auto-yes'), { target: { value: '3600000' } });
    fireEvent.change(textarea, { target: { value: 'go' } });
    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('new-task-send'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(sendCalls()).toHaveLength(1);
    expect(nav.push).toHaveBeenCalledWith('/worktrees/wt-a-main?instance=codex-2');
    expect(screen.queryByTestId('new-task-dialog')).toBeNull();
  });
});

describe('[#3511] the ? help never stacks with New task', () => {
  it('does not open the help on ? while New task is open, even off the text fields', async () => {
    renderShell();
    await openDialog();
    const cancel = screen.getByTestId('new-task-cancel');
    cancel.focus();
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: '?' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('keyboard-shortcuts-overlay')).toBeNull();
  });

  it('opens the help on ? once New task is closed (negative control)', async () => {
    renderShell();
    await openDialog();
    fireEvent.click(screen.getByTestId('new-task-cancel'));
    expect(screen.queryByTestId('new-task-dialog')).toBeNull();
    fireEvent.keyDown(document.body, { key: '?' });
    expect(await screen.findByTestId('keyboard-shortcuts-overlay')).toBeInTheDocument();
  });
});
