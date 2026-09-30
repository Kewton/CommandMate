/**
 * ScheduleEditDialog: OpenCode V2 run options (Issue #2982)
 *
 * opencode-v2 shows the same Model / Agent / Variant / Title / Continue fields
 * as v1 and posts them in the shape `validateScheduleInput()` accepts. Its
 * Variant needs a Model (`opencode2 run -m <provider/model>#<variant>`), so a
 * model-less variant is flagged and not saved.
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
import { formatCliToolColumn, validateScheduleInput } from '@/lib/cmate-writer';
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
  return render(<ScheduleEditDialog {...props} />);
}

function change(testId: string, value: string) {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

function openV2WithRequiredFields() {
  renderDialog();
  change('schedule-cli-tool-select', 'opencode-v2');
  change('schedule-name-input', 'nightly');
  change('schedule-message-input', 'go');
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

describe('opencode-v2 run option fields (Issue #2982)', () => {
  it('appear for opencode-v2, alongside the Model field', () => {
    renderDialog();
    change('schedule-cli-tool-select', 'opencode-v2');
    expect(screen.getByTestId('schedule-model-input')).toBeDefined();
    expect(screen.getByTestId('schedule-agent-input')).toBeDefined();
    expect(screen.getByTestId('schedule-variant-input')).toBeDefined();
    expect(screen.getByTestId('schedule-title-input')).toBeDefined();
    expect(screen.getByTestId('schedule-continue-toggle')).toBeDefined();
  });

  it('posts model and agent, and the writer turns them into the acceptance-criterion column', async () => {
    openV2WithRequiredFields();
    change('schedule-model-input', 'anthropic/claude-sonnet-4-5');
    change('schedule-agent-input', 'plan');
    fireEvent.click(screen.getByTestId('schedule-save-button'));

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const body = JSON.parse(mockFetch.mock.calls[0][1].body) as ScheduleWriteInput;
    expect(body).toMatchObject({ cliToolId: 'opencode-v2', model: 'anthropic/claude-sonnet-4-5', agent: 'plan' });
    expect(validateScheduleInput(body).valid).toBe(true);
    expect(formatCliToolColumn(body.cliToolId, body.model, body)).toBe(
      'opencode-v2 --model anthropic/claude-sonnet-4-5 --agent plan',
    );
  });

  it('flags a variant without a model and does not save', async () => {
    openV2WithRequiredFields();
    change('schedule-variant-input', 'high');

    expect(screen.getByTestId('schedule-variant-error').textContent).toContain('needs a Model');
    fireEvent.click(screen.getByTestId('schedule-save-button'));
    await waitFor(() => expect(mockFetch).not.toHaveBeenCalled());
  });

  it('saves a variant once a model is given', async () => {
    openV2WithRequiredFields();
    change('schedule-variant-input', 'high');
    change('schedule-model-input', 'anthropic/claude-sonnet-4-5');
    expect(screen.queryByTestId('schedule-variant-error')).toBeNull();
    fireEvent.click(screen.getByTestId('schedule-save-button'));

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const body = JSON.parse(mockFetch.mock.calls[0][1].body) as ScheduleWriteInput;
    expect(body).toMatchObject({ model: 'anthropic/claude-sonnet-4-5', variant: 'high' });
    expect(validateScheduleInput(body).valid).toBe(true);
  });

  it('keeps v1 accepting a model-less variant', () => {
    renderDialog();
    change('schedule-cli-tool-select', 'opencode');
    change('schedule-variant-input', 'high');
    expect(screen.queryByTestId('schedule-variant-error')).toBeNull();
  });
});
