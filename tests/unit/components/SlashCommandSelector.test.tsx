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

/**
 * [Issue #1365] The desktop dropdown is 320px wide and opens upward from the
 * message input (`bottom: 100%`), so a tall command list can run past the top
 * of the viewport and a right-aligned input can push it past the right edge.
 * Once open it is measured and nudged back with a transform. The mobile bottom
 * sheet is `fixed` and always on screen, so it must stay untouched.
 */
describe('SlashCommandSelector viewport clamping (Issue #1365)', () => {
  const groups: SlashCommandGroup[] = [
    {
      category: 'planning',
      label: 'Planning',
      commands: [
        {
          name: 'work-plan',
          description: 'Plan the work',
          category: 'planning',
          filePath: '.claude/commands/work-plan.md',
        },
      ],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeRect(overrides: Partial<DOMRect>): DOMRect {
    return {
      top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0,
      ...overrides,
      toJSON: () => ({}),
    } as DOMRect;
  }

  /** Only the dropdown reports a box; everything else is zeroed. */
  function dropdownRect(rect: Partial<DOMRect>): void {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      return this.getAttribute('data-testid') === 'slash-command-dropdown'
        ? makeRect(rect)
        : makeRect({});
    });
  }

  function renderDropdown(isMobile = false) {
    return render(
      <SlashCommandSelector
        isOpen
        groups={groups}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        isMobile={isMobile}
      />
    );
  }

  it('does not shift a dropdown that already fits on screen', () => {
    dropdownRect({ top: 200, left: 40, width: 320, height: 380 });
    renderDropdown();

    expect(screen.getByTestId('slash-command-dropdown').style.transform).toBe('');
  });

  it('pushes a dropdown that opens past the top of the viewport back down', () => {
    // The list is taller than the space above the input: top -30 => nudged to 8.
    dropdownRect({ top: -30, left: 40, width: 320, height: 380 });
    renderDropdown();

    expect(screen.getByTestId('slash-command-dropdown').style.transform).toBe(
      'translate(0px, 38px)'
    );
  });

  it('pulls a dropdown anchored near the right edge back into view', () => {
    // 760 + 320 + 8 - 1024 = 64 over the right edge.
    dropdownRect({ top: 200, left: 760, width: 320, height: 380 });
    renderDropdown();

    expect(screen.getByTestId('slash-command-dropdown').style.transform).toBe(
      'translate(-64px, 0px)'
    );
  });

  it('leaves the mobile bottom sheet alone', () => {
    dropdownRect({ top: -30, left: 760, width: 320, height: 380 });
    renderDropdown(true);

    expect(screen.queryByTestId('slash-command-dropdown')).not.toBeInTheDocument();
    expect(screen.getByTestId('slash-command-bottom-sheet').style.transform).toBe('');
  });
});

// Issue #1476: catalog staleness hint
describe('SlashCommandSelector — catalog staleness hint', () => {
  const mockOnSelect = vi.fn();
  const mockOnClose = vi.fn();
  const mockGroups: SlashCommandGroup[] = [
    {
      category: 'standard-util',
      label: 'Standard (Utility)',
      commands: [
        { name: 'help', description: 'Show help', category: 'standard-util', filePath: '', source: 'standard' },
      ],
    },
  ];

  beforeEach(() => {
    locale.current = 'en';
    vi.clearAllMocks();
  });

  it('does not render the stale note by default', () => {
    render(
      <SlashCommandSelector isOpen groups={mockGroups} onSelect={mockOnSelect} onClose={mockOnClose} />
    );
    expect(screen.queryByTestId('slash-command-stale-note')).not.toBeInTheDocument();
  });

  it('renders the stale note in the desktop dropdown when isCatalogStale', () => {
    render(
      <SlashCommandSelector isOpen groups={mockGroups} onSelect={mockOnSelect} onClose={mockOnClose} isCatalogStale />
    );
    const note = screen.getByTestId('slash-command-stale-note');
    expect(note).toBeInTheDocument();
    expect(note.textContent).toMatch(/~\/\.commandmate\/slash-commands\//);
  });

  it('renders the stale note in the mobile bottom sheet when isCatalogStale', () => {
    render(
      <SlashCommandSelector isOpen groups={mockGroups} onSelect={mockOnSelect} onClose={mockOnClose} isMobile isCatalogStale />
    );
    expect(screen.getByTestId('slash-command-stale-note')).toBeInTheDocument();
  });
});
