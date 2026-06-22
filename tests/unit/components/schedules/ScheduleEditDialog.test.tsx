/**
 * Unit tests for ScheduleEditDialog (Issue #824)
 *
 * Focus: dynamic Permission dropdown per CLI Tool, Model field visibility,
 * inline validation, and the save request payload.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import {
  ScheduleEditDialog,
  type ScheduleEditDialogProps,
} from '@/components/worktree/schedules/ScheduleEditDialog';

function renderDialog(overrides: Partial<ScheduleEditDialogProps> = {}) {
  const props: ScheduleEditDialogProps = {
    isOpen: true,
    worktreeId: 'wt-1',
    onClose: vi.fn(),
    onSaved: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<ScheduleEditDialog {...props} />) };
}

function getSelectValues(testId: string): string[] {
  const select = screen.getByTestId(testId) as HTMLSelectElement;
  return Array.from(select.options).map((o) => o.value);
}

/** Force the viewport so `useIsMobile()` resolves to mobile/desktop. */
function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
}

beforeEach(() => {
  // jsdom defaults to 1024 (desktop); keep tests deterministic.
  setViewportWidth(1024);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setViewportWidth(1024);
});

describe('ScheduleEditDialog', () => {
  it('renders the core form fields when open', () => {
    renderDialog();
    expect(screen.getByTestId('schedule-name-input')).toBeDefined();
    expect(screen.getByTestId('schedule-cron-input')).toBeDefined();
    expect(screen.getByTestId('schedule-cli-tool-select')).toBeDefined();
    expect(screen.getByTestId('schedule-message-input')).toBeDefined();
  });

  it('shows claude permission options by default', () => {
    renderDialog();
    expect(getSelectValues('schedule-permission-select')).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'dontAsk',
      'bypassPermissions',
    ]);
  });

  it('changes Permission options dynamically when CLI Tool changes to codex', () => {
    renderDialog();
    fireEvent.change(screen.getByTestId('schedule-cli-tool-select'), {
      target: { value: 'codex' },
    });
    expect(getSelectValues('schedule-permission-select')).toEqual([
      'read-only',
      'workspace-write',
      'danger-full-access',
    ]);
  });

  it('hides the Permission dropdown for tools without permission flags (gemini)', () => {
    renderDialog();
    fireEvent.change(screen.getByTestId('schedule-cli-tool-select'), {
      target: { value: 'gemini' },
    });
    expect(screen.queryByTestId('schedule-permission-select')).toBeNull();
  });

  it('hides the Permission dropdown for opencode', () => {
    renderDialog();
    fireEvent.change(screen.getByTestId('schedule-cli-tool-select'), {
      target: { value: 'opencode' },
    });
    expect(screen.queryByTestId('schedule-permission-select')).toBeNull();
  });

  it('shows the Model field only for copilot', () => {
    renderDialog();
    expect(screen.queryByTestId('schedule-model-input')).toBeNull();
    fireEvent.change(screen.getByTestId('schedule-cli-tool-select'), {
      target: { value: 'copilot' },
    });
    expect(screen.getByTestId('schedule-model-input')).toBeDefined();
    expect(getSelectValues('schedule-permission-select')).toEqual(['allow-all-tools', 'yolo']);
  });

  it('disables Save and shows an error when the name is empty', () => {
    renderDialog();
    expect(screen.getByTestId('schedule-name-error')).toBeDefined();
    expect((screen.getByTestId('schedule-save-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables Save when required fields are valid', () => {
    renderDialog({ initialValues: { name: 'task-a', message: 'hello' } });
    expect((screen.getByTestId('schedule-save-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('seeds the form from initialValues in edit mode', () => {
    renderDialog({
      originalName: 'task-a',
      initialValues: {
        name: 'task-a',
        cronExpression: '0 9 * * 1',
        message: 'do it',
        cliToolId: 'codex',
        permission: 'read-only',
        enabled: true,
      },
    });
    expect((screen.getByTestId('schedule-name-input') as HTMLInputElement).value).toBe('task-a');
    expect((screen.getByTestId('schedule-cron-input') as HTMLInputElement).value).toBe('0 9 * * 1');
    expect((screen.getByTestId('schedule-permission-select') as HTMLSelectElement).value).toBe(
      'read-only',
    );
  });

  it('posts to the cmate schedules endpoint on save', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();
    const onClose = vi.fn();

    renderDialog({
      worktreeId: 'wt-9',
      initialValues: { name: 'task-a', message: 'hello world', cronExpression: '0 9 * * *' },
      onSaved,
      onClose,
    });

    fireEvent.click(screen.getByTestId('schedule-save-button'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/worktrees/wt-9/cmate/schedules');
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body);
    expect(body.name).toBe('task-a');
    expect(body.message).toBe('hello world');
    expect(body.cliToolId).toBe('claude');

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('applies a cron preset when selected', () => {
    renderDialog({ initialValues: { name: 'task-a', message: 'hello' } });
    fireEvent.change(screen.getByTestId('schedule-cron-preset'), {
      target: { value: '0 9 * * 1' },
    });
    expect((screen.getByTestId('schedule-cron-input') as HTMLInputElement).value).toBe('0 9 * * 1');
  });

  // --- Phase 2 (Issue #825): section accordion + mobile full-screen modal ---

  describe('section accordion (Issue #825)', () => {
    it('renders the three section headers', () => {
      renderDialog();
      expect(screen.getByTestId('schedule-section-basic')).toBeDefined();
      expect(screen.getByTestId('schedule-section-advanced')).toBeDefined();
      expect(screen.getByTestId('schedule-section-message')).toBeDefined();
    });

    it('expands every section by default on desktop', () => {
      renderDialog();
      // Fields from all three sections are visible at once.
      expect(screen.getByTestId('schedule-name-input')).toBeDefined();
      expect(screen.getByTestId('schedule-cli-tool-select')).toBeDefined();
      expect(screen.getByTestId('schedule-message-input')).toBeDefined();
      ['basic', 'advanced', 'message'].forEach((id) => {
        expect(screen.getByTestId(`schedule-section-${id}`).getAttribute('aria-expanded')).toBe(
          'true',
        );
      });
    });

    it('collapses a section when its header is clicked', () => {
      renderDialog();
      expect(screen.getByTestId('schedule-message-input')).toBeDefined();
      fireEvent.click(screen.getByTestId('schedule-section-message'));
      expect(screen.queryByTestId('schedule-message-input')).toBeNull();
      expect(screen.getByTestId('schedule-section-message').getAttribute('aria-expanded')).toBe(
        'false',
      );
    });

    it('updates the advanced section summary when the CLI tool changes', () => {
      renderDialog();
      const before = screen.getByTestId('schedule-section-advanced-summary').textContent;
      fireEvent.change(screen.getByTestId('schedule-cli-tool-select'), {
        target: { value: 'codex' },
      });
      const after = screen.getByTestId('schedule-section-advanced-summary').textContent;
      // Summary reflects the selected tool's default permission (codex → workspace-write).
      expect(after).not.toBe(before);
      expect(after).toContain('workspace-write');
    });
  });

  describe('mobile full-screen modal (Issue #825)', () => {
    it('renders a full-screen modal on mobile viewports', () => {
      setViewportWidth(375);
      renderDialog();
      expect(screen.getByTestId('full-screen-modal')).toBeDefined();
    });

    it('opens only the first section by default on mobile', () => {
      setViewportWidth(375);
      renderDialog();
      // Basic section open, others collapsed.
      expect(screen.getByTestId('schedule-name-input')).toBeDefined();
      expect(screen.queryByTestId('schedule-cli-tool-select')).toBeNull();
      expect(screen.queryByTestId('schedule-message-input')).toBeNull();
      expect(screen.getByTestId('schedule-section-basic').getAttribute('aria-expanded')).toBe(
        'true',
      );
      expect(screen.getByTestId('schedule-section-message').getAttribute('aria-expanded')).toBe(
        'false',
      );
    });

    it('reveals a collapsed section when its header is tapped on mobile', () => {
      setViewportWidth(375);
      renderDialog();
      expect(screen.queryByTestId('schedule-message-input')).toBeNull();
      fireEvent.click(screen.getByTestId('schedule-section-message'));
      expect(screen.getByTestId('schedule-message-input')).toBeDefined();
    });

    it('renders a sticky footer holding the save button on mobile', () => {
      setViewportWidth(375);
      renderDialog({ initialValues: { name: 'task-a', message: 'hello' } });
      const footer = screen.getByTestId('full-screen-modal-footer');
      expect(footer).toBeDefined();
      expect(footer.querySelector('[data-testid="schedule-save-button"]')).not.toBeNull();
    });
  });

  // --- Issue #942: agent instance selector (alias-driven, UI-label only) ---

  describe('agent instance selector (Issue #942)', () => {
    const instances = [
      { id: 'claude', cliTool: 'claude' as const, alias: 'Main Claude', order: 0 },
      { id: 'claude-reviewer', cliTool: 'claude' as const, alias: 'Reviewer', order: 1 },
      { id: 'codex', cliTool: 'codex' as const, alias: 'My Codex', order: 2 },
    ];

    it('lists registered instance aliases in the agent selector', () => {
      renderDialog({ instances });
      const select = screen.getByTestId('schedule-cli-tool-select') as HTMLSelectElement;
      const labels = Array.from(select.options).map((o) => o.textContent);
      expect(labels).toEqual(['Main Claude', 'Reviewer', 'My Codex']);
      // The option values are the instance ids.
      expect(Array.from(select.options).map((o) => o.value)).toEqual([
        'claude',
        'claude-reviewer',
        'codex',
      ]);
    });

    it('persists the backing CLI tool of the selected instance on save (UI-label only)', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
      vi.stubGlobal('fetch', fetchMock);

      renderDialog({
        worktreeId: 'wt-9',
        instances,
        initialValues: { name: 'task-a', message: 'hello' },
      });

      // Pick the second instance, which is a *non-primary* claude instance.
      fireEvent.change(screen.getByTestId('schedule-cli-tool-select'), {
        target: { value: 'claude-reviewer' },
      });
      fireEvent.click(screen.getByTestId('schedule-save-button'));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // No instanceId is persisted — only the backing CLI tool.
      expect(body.cliToolId).toBe('claude');
      expect(body.instanceId).toBeUndefined();
    });

    it('selects the instance backing the seeded CLI tool in edit mode', () => {
      renderDialog({
        instances,
        originalName: 'task-a',
        initialValues: { name: 'task-a', message: 'do it', cliToolId: 'codex' },
      });
      const select = screen.getByTestId('schedule-cli-tool-select') as HTMLSelectElement;
      expect(select.value).toBe('codex');
    });
  });

  // --- Phase 4 (Issue #827): "Ask AI" buttons for cron / message drafting ---

  describe('Ask AI buttons (Issue #827)', () => {
    it('hides the Ask AI buttons when onInsertToMessage is not wired', () => {
      renderDialog();
      expect(screen.queryByTestId('schedule-cron-ask-ai')).toBeNull();
      expect(screen.queryByTestId('schedule-message-ask-ai')).toBeNull();
    });

    it('shows both Ask AI buttons when onInsertToMessage is wired', () => {
      renderDialog({ onInsertToMessage: vi.fn() });
      expect(screen.getByTestId('schedule-cron-ask-ai')).toBeDefined();
      expect(screen.getByTestId('schedule-message-ask-ai')).toBeDefined();
    });

    it('drafts a cron prompt into the composer and closes the modal', () => {
      const onInsertToMessage = vi.fn();
      const onClose = vi.fn();
      renderDialog({
        initialValues: { cronExpression: '0 9 * * *' },
        onInsertToMessage,
        onClose,
      });
      fireEvent.click(screen.getByTestId('schedule-cron-ask-ai'));
      expect(onInsertToMessage).toHaveBeenCalledTimes(1);
      // The drafted prompt echoes the current cron input (SSOT builder wiring).
      expect(onInsertToMessage.mock.calls[0][0]).toContain('0 9 * * *');
      expect(onInsertToMessage.mock.calls[0][0]).toContain('cron 式');
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('drafts a message prompt using the schedule name and closes the modal', () => {
      const onInsertToMessage = vi.fn();
      const onClose = vi.fn();
      renderDialog({
        initialValues: { name: 'daily-review' },
        onInsertToMessage,
        onClose,
      });
      fireEvent.click(screen.getByTestId('schedule-message-ask-ai'));
      expect(onInsertToMessage).toHaveBeenCalledTimes(1);
      expect(onInsertToMessage.mock.calls[0][0]).toContain('daily-review');
      expect(onInsertToMessage.mock.calls[0][0]).toContain('指示プロンプト');
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
