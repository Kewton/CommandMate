/**
 * Tests for SlashCommandList component
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SlashCommandList } from '@/components/worktree/SlashCommandList';
import type { SlashCommandGroup } from '@/types/slash-commands';

describe('SlashCommandList', () => {
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
        {
          name: 'issue-create',
          description: 'Issue作成',
          category: 'planning',
          filePath: '.claude/commands/issue-create.md',
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
          invocation: 'codex-prompt',
          description: 'Codex custom prompt',
          category: 'development',
          filePath: '.codex/prompts/github-insights.md',
          source: 'codex-skill',
          cliTools: ['codex'],
        },
      ],
    },
  ];

  const mockOnSelect = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should render category labels', () => {
      render(<SlashCommandList groups={mockGroups} onSelect={mockOnSelect} />);

      expect(screen.getByText('Planning')).toBeInTheDocument();
      expect(screen.getByText('Development')).toBeInTheDocument();
    });

    it('should render command names with slash prefix', () => {
      render(<SlashCommandList groups={mockGroups} onSelect={mockOnSelect} />);

      expect(screen.getByText('/work-plan')).toBeInTheDocument();
      expect(screen.getByText('/issue-create')).toBeInTheDocument();
      expect(screen.getByText('/tdd-impl')).toBeInTheDocument();
      expect(screen.getByText('/prompts:github-insights')).toBeInTheDocument();
    });

    it('should render command descriptions', () => {
      render(<SlashCommandList groups={mockGroups} onSelect={mockOnSelect} />);

      expect(screen.getByText('Issue単位の具体的な作業計画立案')).toBeInTheDocument();
      expect(screen.getByText('テスト駆動開発で高品質コードを実装')).toBeInTheDocument();
    });

    it('should render Codex badge for codex-only commands', () => {
      render(<SlashCommandList groups={mockGroups} onSelect={mockOnSelect} />);

      expect(screen.getByText('Codex')).toBeInTheDocument();
    });

    it('should render empty state when no groups', () => {
      render(<SlashCommandList groups={[]} onSelect={mockOnSelect} />);

      expect(screen.getByText(/no commands/i)).toBeInTheDocument();
    });
  });

  describe('Selection', () => {
    it('should call onSelect when command is clicked', () => {
      render(<SlashCommandList groups={mockGroups} onSelect={mockOnSelect} />);

      const command = screen.getByText('/work-plan');
      fireEvent.click(command);

      expect(mockOnSelect).toHaveBeenCalledTimes(1);
      expect(mockOnSelect).toHaveBeenCalledWith(mockGroups[0].commands[0]);
    });
  });

  describe('Highlighted index', () => {
    it('should highlight item at highlightedIndex', () => {
      render(
        <SlashCommandList
          groups={mockGroups}
          onSelect={mockOnSelect}
          highlightedIndex={0}
        />
      );

      // First command should be highlighted
      const workPlanItem = screen.getByText('/work-plan').closest('[data-command-item]');
      expect(workPlanItem).toHaveAttribute('data-highlighted', 'true');
    });

    it('should not highlight any item when highlightedIndex is -1', () => {
      render(
        <SlashCommandList
          groups={mockGroups}
          onSelect={mockOnSelect}
          highlightedIndex={-1}
        />
      );

      // No items should be highlighted
      const highlightedItems = document.querySelectorAll('[data-highlighted="true"]');
      expect(highlightedItems).toHaveLength(0);
    });
  });
});
