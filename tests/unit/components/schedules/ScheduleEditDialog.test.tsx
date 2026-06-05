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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
});
