/**
 * Tests for SlashCommandSelector component
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SlashCommandSelector } from '@/components/worktree/SlashCommandSelector';
import { STANDARD_COMMANDS } from '@/lib/standard-commands';
import type { SlashCommandGroup } from '@/types/slash-commands';

// Issue #1306: search matches against the *translated* description, so the
// global key-echoing mock would make the filter assertions meaningless. Back
// the translator with the real dictionary.
const locale = vi.hoisted(() => ({ current: 'en' }));

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => locale.current);
});

describe('SlashCommandSelector', () => {
  const mockGroups: SlashCommandGroup[] = [
    {
      category: 'planning',
      label: 'Planning',
      commands: [
        {
          name: 'work-plan',
          description: 'Issue単位の具体的な作業計画立案',
          category: 'planning',
          model: 'opus',
          filePath: '.claude/commands/work-plan.md',
        },
      ],
    },
    {
      category: 'development',
      label: 'Development',
      commands: [
        {
          name: 'tdd-impl',
          description: 'テスト駆動開発で高品質コードを実装',
          category: 'development',
          model: 'opus',
          filePath: '.claude/commands/tdd-impl.md',
        },
        {
          name: 'github-insights',
          description: 'Codex skill',
          category: 'development',
          filePath: '.codex/skills/github-insights/SKILL.md',
          source: 'codex-skill',
          cliTools: ['codex'],
        },
      ],
    },
  ];

  const mockOnSelect = vi.fn();
  const mockOnClose = vi.fn();

  beforeEach(() => {
    locale.current = 'en';
    vi.clearAllMocks();
  });

  afterEach(() => {
    locale.current = 'en';
    vi.clearAllMocks();
  });

  describe('Visibility', () => {
    it('should not render when isOpen is false', () => {
      render(
        <SlashCommandSelector
          isOpen={false}
          groups={mockGroups}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      expect(screen.queryByText('Planning')).not.toBeInTheDocument();
    });

    it('should render when isOpen is true', () => {
      render(
        <SlashCommandSelector
          isOpen={true}
          groups={mockGroups}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByText('Planning')).toBeInTheDocument();
    });
  });

  describe('Desktop mode (dropdown)', () => {
    it('should render as dropdown when isMobile is false', () => {
      render(
        <SlashCommandSelector
          isOpen={true}
          groups={mockGroups}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
          isMobile={false}
        />
      );

      // Should have dropdown styling
      const container = screen.getByRole('listbox');
      expect(container).toBeInTheDocument();
    });

    it('should have search input', () => {
      render(
        <SlashCommandSelector
          isOpen={true}
          groups={mockGroups}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
          isMobile={false}
        />
      );

      expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
    });
  });

  describe('Mobile mode (bottom sheet)', () => {
    it('should render as bottom sheet when isMobile is true', () => {
      render(
        <SlashCommandSelector
          isOpen={true}
          groups={mockGroups}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
          isMobile={true}
        />
      );

      // Should have bottom sheet styling
      const container = screen.getByTestId('slash-command-bottom-sheet');
      expect(container).toBeInTheDocument();
    });

    it('should have close button on mobile', () => {
      render(
        <SlashCommandSelector
          isOpen={true}
          groups={mockGroups}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
          isMobile={true}
        />
      );

      const closeButton = screen.getByLabelText(/close/i);
      expect(closeButton).toBeInTheDocument();
    });
  });

  describe('Selection', () => {
    it('should call onSelect when a command is clicked', () => {
      render(
        <SlashCommandSelector
          isOpen={true}
          groups={mockGroups}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const command = screen.getByText('/work-plan');
      fireEvent.click(command);

      expect(mockOnSelect).toHaveBeenCalledTimes(1);
      expect(mockOnSelect).toHaveBeenCalledWith(mockGroups[0].commands[0]);
    });

    it('should call onClose after selection', () => {
      render(
        <SlashCommandSelector
          isOpen={true}
          groups={mockGroups}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const command = screen.getByText('/work-plan');
      fireEvent.click(command);

      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('Filtering', () => {
    it('should filter commands based on search input', async () => {
      render(
        <SlashCommandSelector
          isOpen={true}
          groups={mockGroups}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const searchInput = screen.getByPlaceholderText(/search/i);
      fireEvent.change(searchInput, { target: { value: 'work' } });

      await waitFor(() => {
        expect(screen.getByText('/work-plan')).toBeInTheDocument();
        expect(screen.queryByText('/tdd-impl')).not.toBeInTheDocument();
        expect(screen.queryByText('$github-insights')).not.toBeInTheDocument();
      });
    });
  });

  describe('Keyboard navigation', () => {
    it('should close on Escape key', () => {
      render(
        <SlashCommandSelector
          isOpen={true}
          groups={mockGroups}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      fireEvent.keyDown(document, { key: 'Escape' });

      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it('should not intercept Enter key when isOpen is false (Issue #288)', () => {
      render(
        <SlashCommandSelector
          isOpen={false}
          groups={mockGroups}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      fireEvent.keyDown(document, { key: 'Enter' });

      // onSelect should NOT be called because the listener is not registered when closed
      expect(mockOnSelect).not.toHaveBeenCalled();
    });

    it('should select command on Enter key when isOpen is true', () => {
      render(
        <SlashCommandSelector
          isOpen={true}
          groups={mockGroups}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      fireEvent.keyDown(document, { key: 'Enter' });

      // First command should be selected (highlightedIndex defaults to 0)
      expect(mockOnSelect).toHaveBeenCalledWith(mockGroups[0].commands[0]);
    });
  });

  describe('Free input mode (Issue #56)', () => {
    const mockOnFreeInput = vi.fn();

    beforeEach(() => {
      mockOnFreeInput.mockClear();
    });

    it('should render free input button when onFreeInput is provided', () => {
      render(
        <SlashCommandSelector
          isOpen={true}
          groups={mockGroups}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
          onFreeInput={mockOnFreeInput}
        />
      );

      expect(screen.getByTestId('free-input-button')).toBeInTheDocument();
    });

    it('should not render free input button when onFreeInput is not provided', () => {
      render(
        <SlashCommandSelector
          isOpen={true}
          groups={mockGroups}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      expect(screen.queryByTestId('free-input-button')).not.toBeInTheDocument();
    });

    it('should call onFreeInput when free input button is clicked', () => {
      render(
        <SlashCommandSelector
          isOpen={true}
          groups={mockGroups}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
          onFreeInput={mockOnFreeInput}
        />
      );

      const freeInputButton = screen.getByTestId('free-input-button');
      fireEvent.click(freeInputButton);

      expect(mockOnFreeInput).toHaveBeenCalledTimes(1);
    });

    it('should render free input button on mobile', () => {
      render(
        <SlashCommandSelector
          isOpen={true}
          groups={mockGroups}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
          onFreeInput={mockOnFreeInput}
          isMobile={true}
        />
      );

      expect(screen.getByTestId('free-input-button')).toBeInTheDocument();
    });

    it('should render free input button on desktop', () => {
      render(
        <SlashCommandSelector
          isOpen={true}
          groups={mockGroups}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
          onFreeInput={mockOnFreeInput}
          isMobile={false}
        />
      );

      expect(screen.getByTestId('free-input-button')).toBeInTheDocument();
    });
  });

  // Issue #1306: built-in descriptions became keys. Search resolves them before
  // matching, otherwise these commands would silently stop being findable by
  // their description text. /doctor is the probe: its name shares no substring
  // with "Check installation health", so it can only match via the description.
  describe('Filtering built-in commands by translated description (Issue #1306)', () => {
    const doctor = STANDARD_COMMANDS.find((cmd) => cmd.name === 'doctor')!;
    const clear = STANDARD_COMMANDS.find((cmd) => cmd.name === 'clear')!;
    const standardGroups: SlashCommandGroup[] = [
      {
        category: 'standard-util',
        label: 'Standard (Utility)',
        commands: [doctor, clear],
      },
    ];

    const renderSelector = () =>
      render(
        <SlashCommandSelector
          isOpen={true}
          groups={standardGroups}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

    it('should match a built-in command by its translated description', async () => {
      renderSelector();

      fireEvent.change(screen.getByPlaceholderText(/search/i), {
        target: { value: 'installation' },
      });

      await waitFor(() => {
        expect(screen.getByText('/doctor')).toBeInTheDocument();
        expect(screen.queryByText('/clear')).not.toBeInTheDocument();
      });
    });

    it('should match against the active locale rather than english', async () => {
      locale.current = 'ja';
      renderSelector();

      fireEvent.change(screen.getByPlaceholderText(/検索/), {
        target: { value: 'インストール' },
      });

      await waitFor(() => {
        expect(screen.getByText('/doctor')).toBeInTheDocument();
        expect(screen.queryByText('/clear')).not.toBeInTheDocument();
      });
    });

    it('should not expose the raw description key to search', async () => {
      renderSelector();

      fireEvent.change(screen.getByPlaceholderText(/search/i), {
        target: { value: 'slashCommands.descriptions' },
      });

      await waitFor(() => {
        expect(screen.queryByText('/doctor')).not.toBeInTheDocument();
        expect(screen.queryByText('/clear')).not.toBeInTheDocument();
      });
    });
  });
});
