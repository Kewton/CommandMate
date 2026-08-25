/**
 * ScheduleEditDialog: opencode run options (Issue #2044)
 *
 * The dialog is the only way most people will ever write
 * `opencode --agent plan --variant high`, so the fields have to exist, be gated
 * on the same Sets the CMATE.md parser gates on, and reach the API in the shape
 * `validateScheduleInput()` accepts. A field that renders but is dropped from
 * the POST body is the exact failure this suite is here to catch.
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
import { validateScheduleInput } from '@/lib/cmate-writer';
import type { ScheduleWriteInput } from '@/types/cmate';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const mockFetch = vi.fn();

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

function selectTool(tool: string) {
  fireEvent.change(screen.getByTestId('schedule-cli-tool-select'), { target: { value: tool } });
}

function fillRequiredFields() {
  fireEvent.change(screen.getByTestId('schedule-name-input'), { target: { value: 'nightly' } });
  fireEvent.change(screen.getByTestId('schedule-message-input'), { target: { value: 'go' } });
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true, writable: true });
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('opencode run option fields (Issue #2044)', () => {
  it('are hidden for claude', () => {
    renderDialog();
    expect(screen.queryByTestId('schedule-agent-input')).toBeNull();
    expect(screen.queryByTestId('schedule-variant-input')).toBeNull();
    expect(screen.queryByTestId('schedule-title-input')).toBeNull();
    expect(screen.queryByTestId('schedule-continue-toggle')).toBeNull();
  });

  it('are hidden for copilot, which has --model but no run options', () => {
    renderDialog();
    selectTool('copilot');
    expect(screen.getByTestId('schedule-model-input')).toBeDefined();
    expect(screen.queryByTestId('schedule-agent-input')).toBeNull();
  });

  it('appear for opencode, alongside the Model field', () => {
    renderDialog();
    selectTool('opencode');
    expect(screen.getByTestId('schedule-model-input')).toBeDefined();
    expect(screen.getByTestId('schedule-agent-input')).toBeDefined();
    expect(screen.getByTestId('schedule-variant-input')).toBeDefined();
    expect(screen.getByTestId('schedule-title-input')).toBeDefined();
    expect(screen.getByTestId('schedule-continue-toggle')).toBeDefined();
  });

  it('hides Permission for opencode, which has no permission flag', () => {
    renderDialog();
    selectTool('opencode');
    expect(screen.queryByTestId('schedule-permission-select')).toBeNull();
  });

  it('posts agent and variant to the CMATE.md write API', async () => {
    renderDialog();
    selectTool('opencode');
    fillRequiredFields();
    fireEvent.change(screen.getByTestId('schedule-agent-input'), { target: { value: 'plan' } });
    fireEvent.change(screen.getByTestId('schedule-variant-input'), { target: { value: 'high' } });

    fireEvent.click(screen.getByTestId('schedule-save-button'));

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const body = JSON.parse(mockFetch.mock.calls[0][1].body) as ScheduleWriteInput;
    expect(body.cliToolId).toBe('opencode');
    expect(body.agent).toBe('plan');
    expect(body.variant).toBe('high');
    // The API is about to run the same validation; assert it agrees.
    expect(validateScheduleInput({ ...body, cronExpression: body.cronExpression }).valid).toBe(true);
  });

  it('omits the run options when they are blank', async () => {
    renderDialog();
    selectTool('opencode');
    fillRequiredFields();
    fireEvent.click(screen.getByTestId('schedule-save-button'));

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const body = JSON.parse(mockFetch.mock.calls[0][1].body) as Record<string, unknown>;
    expect(body.agent).toBeUndefined();
    expect(body.variant).toBeUndefined();
    expect(body.continueSession).toBeUndefined();
    expect(body.title).toBeUndefined();
  });

  it('blocks saving an invalid agent name', async () => {
    renderDialog();
    selectTool('opencode');
    fillRequiredFields();
    fireEvent.change(screen.getByTestId('schedule-agent-input'), { target: { value: '../escape' } });

    expect(screen.getByTestId('schedule-agent-error')).toBeDefined();
    fireEvent.click(screen.getByTestId('schedule-save-button'));
    await waitFor(() => expect(mockFetch).not.toHaveBeenCalled());
  });

  it('drops run options when the tool is switched away from opencode', async () => {
    renderDialog();
    selectTool('opencode');
    fillRequiredFields();
    fireEvent.change(screen.getByTestId('schedule-agent-input'), { target: { value: 'plan' } });

    selectTool('claude');
    fireEvent.click(screen.getByTestId('schedule-save-button'));

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const body = JSON.parse(mockFetch.mock.calls[0][1].body) as Record<string, unknown>;
    expect(body.cliToolId).toBe('claude');
    expect(body.agent).toBeUndefined();
  });

  it('shows the Model field for opencode, which used to name copilot only', () => {
    renderDialog({ initialValues: { cliToolId: 'opencode', model: 'ollama/qwen3:8b' } });
    expect((screen.getByTestId('schedule-model-input') as HTMLInputElement).value)
      .toBe('ollama/qwen3:8b');
  });
});
