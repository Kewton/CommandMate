/**
 * EnvManagerPane (Issue #1968).
 *
 * Pins the acceptance criteria that are only observable in the rendered tree:
 *   - values are MASKED by default and revealed one at a time (👁️)
 *   - both a Key-Value and a Raw representation exist, and both can be saved
 *   - a template's missing keys are offered as suggestions
 *   - bad syntax / control characters surface as a validation error and block
 *     the save
 *   - nothing is hover-gated, so a touch device can reach every control
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { EnvManagerPane } from '@/components/worktree/EnvManagerPane';
import { ENV_MASK } from '@/lib/env-manager/env-masking';
import { parseEnvContent } from '@/lib/env-manager/env-parser';
import {
  fetchEnvSnapshot,
  saveEnvFile,
  type EnvManagerSnapshot,
} from '@/lib/env-manager/env-api-client';
import type { EnvFileDetail } from '@/lib/env-manager/types';

vi.mock('@/lib/env-manager/env-api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env-manager/env-api-client')>();
  return {
    ...actual,
    fetchEnvSnapshot: vi.fn(),
    saveEnvFile: vi.fn(),
  };
});

const mockedFetch = vi.mocked(fetchEnvSnapshot);
const mockedSave = vi.mocked(saveEnvFile);

const RAW = ['# Database', 'DB_HOST=localhost', '', 'API_KEY=super-secret-value', ''].join('\n');

function detailOf(
  content: string,
  overrides: Partial<EnvFileDetail> = {},
): EnvFileDetail {
  const parsed = parseEnvContent(content);
  return {
    name: '.env',
    exists: true,
    content,
    entries: parsed.entries,
    issues: parsed.issues,
    suggestions: [],
    ...overrides,
  };
}

function snapshot(detail: EnvFileDetail | null): EnvManagerSnapshot {
  return {
    files: [
      { name: '.env', exists: true, size: RAW.length, mtime: null, isExample: false },
      { name: '.env.local', exists: false, size: 0, mtime: null, isExample: false },
      { name: '.env.example', exists: true, size: 10, mtime: null, isExample: true },
    ],
    selected: detail,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetch.mockResolvedValue(snapshot(detailOf(RAW)));
  mockedSave.mockResolvedValue({
    file: { name: '.env', exists: true, size: 1, mtime: null, isExample: false },
    issues: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Wait for the first load to settle and return the Key-Value rows. */
async function loadedRows(): Promise<HTMLElement[]> {
  await screen.findByTestId('env-kv-view');
  return screen.getAllByTestId('env-row');
}

describe('EnvManagerPane', () => {
  it('loads the selected file for the worktree it is scoped to', async () => {
    render(<EnvManagerPane worktreeId="wt-1" />);
    await screen.findByTestId('env-kv-view');
    expect(mockedFetch).toHaveBeenCalledWith('wt-1', '.env');
  });

  it('names itself and states that values are hidden by default', async () => {
    render(<EnvManagerPane worktreeId="wt-1" />);
    await screen.findByTestId('env-kv-view');
    expect(screen.getByRole('region', { name: 'worktree.envManager.title' })).toBeInTheDocument();
    expect(screen.getByTestId('env-description')).toHaveTextContent(
      'worktree.envManager.description',
    );
  });

  describe('masking', () => {
    it('masks every value by default', async () => {
      render(<EnvManagerPane worktreeId="wt-1" />);
      const rows = await loadedRows();

      for (const row of rows) {
        const value = within(row).getByTestId('env-row-value') as HTMLInputElement;
        expect(value).toHaveValue(ENV_MASK);
        expect(value).toHaveAttribute('data-masked', 'true');
      }
      // The keys stay readable — masking hides secrets, not structure.
      expect(
        rows.map((row) => (within(row).getByTestId('env-row-key') as HTMLInputElement).value),
      ).toEqual(['DB_HOST', 'API_KEY']);
    });

    it('never paints a real value before the user asks', async () => {
      const { container } = render(<EnvManagerPane worktreeId="wt-1" />);
      await loadedRows();
      expect(container.innerHTML).not.toContain('super-secret-value');
      expect(container.innerHTML).not.toContain('localhost');
    });

    it('a masked value is read-only, so it cannot be typed over unseen', async () => {
      render(<EnvManagerPane worktreeId="wt-1" />);
      const rows = await loadedRows();
      expect(within(rows[1]).getByTestId('env-row-value')).toHaveAttribute('readonly');
    });

    it('reveals one value at a time with the eye toggle', async () => {
      render(<EnvManagerPane worktreeId="wt-1" />);
      const rows = await loadedRows();

      fireEvent.click(within(rows[1]).getByTestId('env-row-reveal'));

      const revealed = within(rows[1]).getByTestId('env-row-value') as HTMLInputElement;
      expect(revealed).toHaveValue('super-secret-value');
      expect(revealed).toHaveAttribute('data-masked', 'false');
      expect(revealed).not.toHaveAttribute('readonly');
      // The other row is untouched.
      expect(within(rows[0]).getByTestId('env-row-value')).toHaveValue(ENV_MASK);
    });

    it('hides the value again on a second click', async () => {
      render(<EnvManagerPane worktreeId="wt-1" />);
      const rows = await loadedRows();
      const toggle = within(rows[1]).getByTestId('env-row-reveal');

      fireEvent.click(toggle);
      expect(within(rows[1]).getByTestId('env-row-value')).toHaveValue('super-secret-value');
      fireEvent.click(toggle);
      expect(within(rows[1]).getByTestId('env-row-value')).toHaveValue(ENV_MASK);
    });

    it('reveals and re-hides every row with the header control', async () => {
      render(<EnvManagerPane worktreeId="wt-1" />);
      const rows = await loadedRows();

      fireEvent.click(screen.getByTestId('env-toggle-all'));
      expect(within(rows[0]).getByTestId('env-row-value')).toHaveValue('localhost');
      expect(within(rows[1]).getByTestId('env-row-value')).toHaveValue('super-secret-value');

      fireEvent.click(screen.getByTestId('env-toggle-all'));
      expect(within(rows[0]).getByTestId('env-row-value')).toHaveValue(ENV_MASK);
    });
  });

  describe('Raw view', () => {
    it('masks the values in the raw text by default', async () => {
      render(<EnvManagerPane worktreeId="wt-1" />);
      await loadedRows();
      fireEvent.click(screen.getByTestId('env-mode-raw'));

      const masked = (await screen.findByTestId('env-raw-masked')) as HTMLTextAreaElement;
      expect(masked.value).toContain(`API_KEY=${ENV_MASK}`);
      expect(masked.value).not.toContain('super-secret-value');
      // Comments survive masking — the Raw view is still the whole file.
      expect(masked.value).toContain('# Database');
      expect(masked).toHaveAttribute('readonly');
      expect(screen.queryByTestId('env-raw-editor')).not.toBeInTheDocument();
    });

    it('becomes an editable textarea once values are revealed', async () => {
      render(<EnvManagerPane worktreeId="wt-1" />);
      await loadedRows();
      fireEvent.click(screen.getByTestId('env-mode-raw'));
      fireEvent.click(screen.getByTestId('env-toggle-all'));

      const editor = (await screen.findByTestId('env-raw-editor')) as HTMLTextAreaElement;
      expect(editor.value).toBe(RAW);
      expect(editor).not.toHaveAttribute('readonly');
    });

    it('carries a Key-Value edit into the Raw view', async () => {
      render(<EnvManagerPane worktreeId="wt-1" />);
      const rows = await loadedRows();
      fireEvent.click(within(rows[1]).getByTestId('env-row-reveal'));
      fireEvent.change(within(rows[1]).getByTestId('env-row-value'), {
        target: { value: 'rotated' },
      });

      fireEvent.click(screen.getByTestId('env-mode-raw'));
      fireEvent.click(screen.getByTestId('env-toggle-all'));

      const editor = (await screen.findByTestId('env-raw-editor')) as HTMLTextAreaElement;
      expect(editor.value).toContain('API_KEY=rotated');
      expect(editor.value).toContain('# Database');
    });

    it('carries a Raw edit back into the Key-Value view', async () => {
      render(<EnvManagerPane worktreeId="wt-1" />);
      await loadedRows();
      fireEvent.click(screen.getByTestId('env-mode-raw'));
      fireEvent.click(screen.getByTestId('env-toggle-all'));
      fireEvent.change(await screen.findByTestId('env-raw-editor'), {
        target: { value: 'ONLY_ONE=here\n' },
      });
      fireEvent.click(screen.getByTestId('env-mode-kv'));

      const rows = await loadedRows();
      expect(rows).toHaveLength(1);
      expect(within(rows[0]).getByTestId('env-row-key')).toHaveValue('ONLY_ONE');
    });
  });

  describe('saving', () => {
    it('is disabled until something changes', async () => {
      render(<EnvManagerPane worktreeId="wt-1" />);
      await loadedRows();
      expect(screen.getByTestId('env-save')).toBeDisabled();
    });

    it('writes back the edited file, keeping the comments', async () => {
      render(<EnvManagerPane worktreeId="wt-1" />);
      const rows = await loadedRows();
      fireEvent.click(within(rows[1]).getByTestId('env-row-reveal'));
      fireEvent.change(within(rows[1]).getByTestId('env-row-value'), {
        target: { value: 'rotated-secret' },
      });

      fireEvent.click(screen.getByTestId('env-save'));

      await waitFor(() => expect(mockedSave).toHaveBeenCalledTimes(1));
      const [worktreeId, file, content] = mockedSave.mock.calls[0];
      expect(worktreeId).toBe('wt-1');
      expect(file).toBe('.env');
      expect(content).toContain('# Database');
      expect(content).toContain('API_KEY=rotated-secret');
      expect(content).not.toContain('super-secret-value');
    });

    it('adds and removes rows', async () => {
      render(<EnvManagerPane worktreeId="wt-1" />);
      const rows = await loadedRows();

      fireEvent.click(within(rows[0]).getByTestId('env-row-remove'));
      fireEvent.click(screen.getByTestId('env-add-row'));

      const after = screen.getAllByTestId('env-row');
      expect(after).toHaveLength(2);
      fireEvent.change(within(after[1]).getByTestId('env-row-key'), {
        target: { value: 'BRAND_NEW' },
      });
      fireEvent.click(within(after[1]).getByTestId('env-row-reveal'));
      fireEvent.change(within(after[1]).getByTestId('env-row-value'), {
        target: { value: 'value' },
      });

      fireEvent.click(screen.getByTestId('env-save'));
      await waitFor(() => expect(mockedSave).toHaveBeenCalledTimes(1));
      const content = mockedSave.mock.calls[0][2];
      expect(content).not.toContain('DB_HOST');
      expect(content).toContain('BRAND_NEW=value');
    });
  });

  describe('validation', () => {
    it('reports a syntax error and refuses to save', async () => {
      render(<EnvManagerPane worktreeId="wt-1" />);
      await loadedRows();
      fireEvent.click(screen.getByTestId('env-mode-raw'));
      fireEvent.click(screen.getByTestId('env-toggle-all'));
      fireEvent.change(await screen.findByTestId('env-raw-editor'), {
        target: { value: 'A=1\nthis is not an assignment\n' },
      });

      expect(await screen.findByTestId('env-errors')).toHaveTextContent(
        'worktree.envManager.issues.invalidSyntax',
      );
      expect(screen.getByTestId('env-save')).toBeDisabled();
      expect(mockedSave).not.toHaveBeenCalled();
    });

    it('reports a dangerous control character', async () => {
      render(<EnvManagerPane worktreeId="wt-1" />);
      await loadedRows();
      fireEvent.click(screen.getByTestId('env-mode-raw'));
      fireEvent.click(screen.getByTestId('env-toggle-all'));
      fireEvent.change(await screen.findByTestId('env-raw-editor'), {
        target: { value: 'A=bad\x1B[31mvalue\n' },
      });

      expect(await screen.findByTestId('env-errors')).toHaveTextContent(
        'worktree.envManager.issues.controlCharacter',
      );
      expect(screen.getByTestId('env-save')).toBeDisabled();
    });

    it('reports an invalid variable name typed into a row', async () => {
      render(<EnvManagerPane worktreeId="wt-1" />);
      const rows = await loadedRows();
      fireEvent.change(within(rows[0]).getByTestId('env-row-key'), {
        target: { value: '9BAD' },
      });

      expect(await screen.findByTestId('env-errors')).toHaveTextContent(
        'worktree.envManager.issues.invalidKey',
      );
      expect(screen.getByTestId('env-save')).toBeDisabled();
    });

    it('shows a duplicate key as a warning that still allows the save', async () => {
      mockedFetch.mockResolvedValue(snapshot(detailOf('A=1\nA=2\n')));
      render(<EnvManagerPane worktreeId="wt-1" />);
      const rows = await loadedRows();

      expect(screen.getByTestId('env-warnings')).toHaveTextContent(
        'worktree.envManager.issues.duplicateKey',
      );
      expect(screen.queryByTestId('env-errors')).not.toBeInTheDocument();

      fireEvent.click(within(rows[0]).getByTestId('env-row-remove'));
      expect(screen.getByTestId('env-save')).not.toBeDisabled();
    });
  });

  describe('template suggestions', () => {
    it('offers keys a template defines but this file does not', async () => {
      mockedFetch.mockResolvedValue(
        snapshot(
          detailOf('DB_HOST=localhost\n', {
            suggestions: [{ key: 'API_KEY', source: '.env.example', value: 'your-key-here' }],
          }),
        ),
      );
      render(<EnvManagerPane worktreeId="wt-1" />);

      const suggestion = await screen.findByTestId('env-suggestion-API_KEY');
      expect(suggestion).toHaveTextContent('API_KEY');
      expect(suggestion).toHaveTextContent('.env.example');

      fireEvent.click(suggestion);

      const rows = screen.getAllByTestId('env-row');
      expect(rows).toHaveLength(2);
      expect(within(rows[1]).getByTestId('env-row-key')).toHaveValue('API_KEY');
    });

    it('renders no suggestion block when there is nothing to suggest', async () => {
      render(<EnvManagerPane worktreeId="wt-1" />);
      await loadedRows();
      expect(screen.queryByTestId('env-suggestions')).not.toBeInTheDocument();
    });
  });

  describe('file picker', () => {
    it('lists the allow-listed files and marks the ones that do not exist', async () => {
      render(<EnvManagerPane worktreeId="wt-1" />);
      await loadedRows();
      expect(screen.getByTestId('env-file-.env')).toBeInTheDocument();
      expect(screen.getByTestId('env-file-.env.local')).toHaveTextContent(
        'worktree.envManager.notCreated',
      );
      expect(screen.getByTestId('env-file-.env.example')).toHaveTextContent(
        'worktree.envManager.templateBadge',
      );
    });

    it('reloads for the file the user picks', async () => {
      render(<EnvManagerPane worktreeId="wt-1" />);
      await loadedRows();
      fireEvent.click(screen.getByTestId('env-file-.env.local'));
      await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith('wt-1', '.env.local'));
    });

    it('re-masks after switching files', async () => {
      render(<EnvManagerPane worktreeId="wt-1" />);
      const rows = await loadedRows();
      fireEvent.click(within(rows[1]).getByTestId('env-row-reveal'));
      expect(within(rows[1]).getByTestId('env-row-value')).toHaveValue('super-secret-value');

      fireEvent.click(screen.getByTestId('env-file-.env.local'));

      await waitFor(() => {
        const after = screen.getAllByTestId('env-row');
        expect(within(after[1]).getByTestId('env-row-value')).toHaveValue(ENV_MASK);
      });
    });
  });

  describe('touch reachability (no hover-only UI)', () => {
    it('keeps the row actions visible without hover', async () => {
      render(<EnvManagerPane worktreeId="wt-1" />);
      const rows = await loadedRows();

      for (const testId of ['env-row-reveal', 'env-row-remove']) {
        const button = within(rows[0]).getByTestId(testId);
        // Never hidden to begin with...
        expect(button.className).not.toMatch(/(^|\s)opacity-0(\s|$)/);
        // ...and explicitly restored to full strength where hover does not exist.
        expect(button.className).toContain('[@media(hover:none)]:opacity-100');
      }
    });
  });

  describe('empty and error states', () => {
    it('tells the user the file does not exist yet', async () => {
      mockedFetch.mockResolvedValue(
        snapshot(detailOf('', { exists: false, name: '.env' })),
      );
      render(<EnvManagerPane worktreeId="wt-1" />);
      expect(await screen.findByTestId('env-not-created')).toBeInTheDocument();
      expect(screen.getByTestId('env-empty')).toBeInTheDocument();
    });

    it('surfaces a load failure', async () => {
      mockedFetch.mockRejectedValue(new Error('boom'));
      render(<EnvManagerPane worktreeId="wt-1" />);
      expect(await screen.findByTestId('env-error')).toBeInTheDocument();
    });
  });
});
