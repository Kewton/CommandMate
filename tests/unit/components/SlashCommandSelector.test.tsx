/**
 * Tests for SlashCommandSelector component
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SlashCommandSelector } from '@/components/worktree/SlashCommandSelector';
import type { SlashCommandGroup } from '@/types/slash-commands';

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
      ],
    },
  ];

  const mockOnSelect = vi.fn();
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
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
});
