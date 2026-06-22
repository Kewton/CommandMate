/**
 * Unit tests for TimerEditDialog (Issue #945)
 *
 * Focus: the 3-field flat form, PC=Modal / mobile=FullScreenModal split, the
 * register POST payload, and the session_not_running warning flow (dialog stays
 * open + warns inside, vs. close on a clean success).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import {
  TimerEditDialog,
  type TimerEditDialogProps,
} from '@/components/worktree/timers/TimerEditDialog';
import { TIMER_DELAYS } from '@/config/timer-constants';

function renderDialog(overrides: Partial<TimerEditDialogProps> = {}) {
  const props: TimerEditDialogProps = {
    isOpen: true,
    worktreeId: 'wt-1',
    onClose: vi.fn(),
    onSaved: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<TimerEditDialog {...props} />) };
}

/** Force the viewport so `useIsMobile()` resolves to mobile/desktop. */
function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
}

const instances = [
  { id: 'claude', cliTool: 'claude' as const, alias: 'Main Claude', order: 0 },
  { id: 'codex', cliTool: 'codex' as const, alias: 'My Codex', order: 1 },
];

beforeEach(() => {
  setViewportWidth(1024); // jsdom default is desktop; keep deterministic.
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setViewportWidth(1024);
});

describe('TimerEditDialog', () => {
  it('renders the three form fields when open', () => {
    renderDialog();
    expect(screen.getByTestId('timer-instance-select')).toBeDefined();
    expect(screen.getByTestId('timer-message-input')).toBeDefined();
    expect(screen.getByTestId('timer-delay-select')).toBeDefined();
    expect(screen.getByTestId('timer-register-button')).toBeDefined();
  });

  it('renders nothing when closed', () => {
    renderDialog({ isOpen: false });
    expect(screen.queryByTestId('timer-message-input')).toBeNull();
  });

  it('lists registered instance aliases in the agent selector', () => {
    renderDialog({ instances });
    const select = screen.getByTestId('timer-instance-select') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Main Claude', 'My Codex']);
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['claude', 'codex']);
  });

  it('disables Register when the message is empty', () => {
    renderDialog({ instances });
    expect((screen.getByTestId('timer-register-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables Register once a message is typed', () => {
    renderDialog({ instances });
    fireEvent.change(screen.getByTestId('timer-message-input'), { target: { value: 'hello' } });
    expect((screen.getByTestId('timer-register-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('posts to the timers endpoint with the selected instance and delay', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();
    const onClose = vi.fn();

    renderDialog({ worktreeId: 'wt-9', instances, onSaved, onClose });

    fireEvent.change(screen.getByTestId('timer-instance-select'), { target: { value: 'codex' } });
    fireEvent.change(screen.getByTestId('timer-message-input'), { target: { value: 'do it' } });
    fireEvent.click(screen.getByTestId('timer-register-button'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/worktrees/wt-9/timers');
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({
      cliToolId: 'codex',
      instanceId: 'codex',
      message: 'do it',
      delayMs: TIMER_DELAYS[0],
    });

    // Clean success → refresh list and close.
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the dialog open and shows the warning on session_not_running', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ warning: 'session_not_running' }) });
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();
    const onClose = vi.fn();

    renderDialog({ worktreeId: 'wt-9', instances, onSaved, onClose });

    fireEvent.change(screen.getByTestId('timer-message-input'), { target: { value: 'later' } });
    fireEvent.click(screen.getByTestId('timer-register-button'));

    await waitFor(() => expect(screen.getByTestId('timer-session-warning')).toBeDefined());
    // List still refreshed, but the modal stays open so the warning is visible.
    expect(onSaved).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders a full-screen modal with a sticky footer on mobile', () => {
    setViewportWidth(375);
    renderDialog({ instances });
    expect(screen.getByTestId('full-screen-modal')).toBeDefined();
    const footer = screen.getByTestId('full-screen-modal-footer');
    expect(footer.querySelector('[data-testid="timer-register-button"]')).not.toBeNull();
  });

  it('uses the new timer.titleCreate heading (not the inline-form timer.title)', () => {
    renderDialog({ instances });
    // The next-intl test mock returns the key, so the heading carries titleCreate.
    expect(screen.getByText('schedule.timer.titleCreate')).toBeDefined();
  });
});
