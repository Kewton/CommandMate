/**
 * Tests for SlashCommandList component
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SlashCommandList } from '@/components/worktree/SlashCommandList';
import { STANDARD_COMMANDS } from '@/lib/standard-commands';
import type { SlashCommandGroup } from '@/types/slash-commands';

// Issue #1276: the empty state is dictionary-driven now. The global mock would
// echo `worktree.slashCommands.empty`, which the /no commands/i assertion below
// could never match — back it with the real dictionary so the key must resolve.
// Issue #1306: descriptions resolve here too, so the locale is switchable to
// prove the rendered text actually follows the dictionary.
const locale = vi.hoisted(() => ({ current: 'en' }));

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => locale.current);
});

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

  beforeEach(() => {
    locale.current = 'en';
    vi.clearAllMocks();
  });

  afterEach(() => {
    locale.current = 'en';
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
      expect(screen.getByText('$github-insights')).toBeInTheDocument();
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

  // Issue #1306: built-in command descriptions moved into the dictionary and
  // are resolved here at render time. These use the real STANDARD_COMMANDS
  // definitions, so a broken key surfaces as a failing render, not a green test.
  describe('Built-in command descriptions (Issue #1306)', () => {
    const clearCommand = STANDARD_COMMANDS.find((cmd) => cmd.name === 'clear')!;
    const standardGroups: SlashCommandGroup[] = [
      {
        category: 'standard-session',
        label: 'Standard (Session)',
        commands: [clearCommand],
      },
    ];

    it('should render the translated description for a descriptionKey command', () => {
      render(<SlashCommandList groups={standardGroups} onSelect={mockOnSelect} />);

      expect(screen.getByText('Clear conversation history')).toBeInTheDocument();
    });

    it('should never leak the raw descriptionKey into the DOM', () => {
      render(<SlashCommandList groups={standardGroups} onSelect={mockOnSelect} />);

      expect(document.body.textContent).not.toContain('slashCommands.descriptions');
    });

    it('should follow the active locale', () => {
      locale.current = 'ja';
      render(<SlashCommandList groups={standardGroups} onSelect={mockOnSelect} />);

      expect(screen.getByText('会話履歴をクリア')).toBeInTheDocument();
      expect(screen.queryByText('Clear conversation history')).not.toBeInTheDocument();
    });

    it('should still render literal descriptions from user-authored commands', () => {
      // Commands loaded from .md frontmatter are not translatable and keep
      // their literal text alongside key-based built-ins in the same list.
      const mixed: SlashCommandGroup[] = [
        {
          category: 'standard-session',
          label: 'Standard (Session)',
          commands: [
            clearCommand,
            {
              name: 'my-command',
              description: 'A user authored command',
              category: 'standard-session',
              filePath: '.claude/commands/my-command.md',
            },
          ],
        },
      ];

      render(<SlashCommandList groups={mixed} onSelect={mockOnSelect} />);

      expect(screen.getByText('Clear conversation history')).toBeInTheDocument();
      expect(screen.getByText('A user authored command')).toBeInTheDocument();
    });
  });
});
