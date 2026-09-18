/**
 * Tests for MobileHeader component
 *
 * Tests the mobile header for displaying worktree info and status
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { MobileHeader } from '@/components/mobile/MobileHeader';
import type { MobileHeaderProps } from '@/components/mobile/MobileHeader';
import {
  CommandPaletteProvider,
  useCommandPalette,
} from '@/contexts/CommandPaletteContext';

describe('MobileHeader', () => {
  const defaultProps: MobileHeaderProps = {
    worktreeName: 'feature/test-branch',
    status: 'idle',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render the header', () => {
      render(<MobileHeader {...defaultProps} />);
      expect(screen.getByTestId('mobile-header')).toBeInTheDocument();
    });

    it('should display worktree name', () => {
      render(<MobileHeader {...defaultProps} worktreeName="feature/my-feature" />);
      expect(screen.getByText(/feature\/my-feature/)).toBeInTheDocument();
    });

    it('should display short worktree names fully', () => {
      render(<MobileHeader {...defaultProps} worktreeName="main" />);
      expect(screen.getByText('main')).toBeInTheDocument();
    });
  });

  describe('Worktree Name Truncation', () => {
    it('should truncate long worktree names', () => {
      const longName = 'feature/this-is-a-very-long-branch-name-that-should-be-truncated';
      render(<MobileHeader {...defaultProps} worktreeName={longName} />);

      const nameElement = screen.getByTestId('worktree-name');
      // Should have truncation styling
      expect(nameElement.className).toMatch(/truncate|overflow|ellipsis/);
    });

    it('should have title attribute with full name for truncated names', () => {
      const longName = 'feature/this-is-a-very-long-branch-name-that-should-be-truncated';
      render(<MobileHeader {...defaultProps} worktreeName={longName} />);

      const nameElement = screen.getByTestId('worktree-name');
      expect(nameElement).toHaveAttribute('title', longName);
    });
  });

  describe('Status Indicator', () => {
    it('should show idle status indicator', () => {
      render(<MobileHeader {...defaultProps} status="idle" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator).toBeInTheDocument();
      // Issue #1078: unified StatusDot uses the semantic `muted-foreground` token.
      expect(indicator.className).toMatch(/muted|gray|neutral/);
    });

    it('should show running status indicator with animation', () => {
      render(<MobileHeader {...defaultProps} status="running" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator).toBeInTheDocument();
      // Issue #1078: StatusDot running = green glow (animate-status-glow), no spinner.
      expect(indicator.className).toMatch(/green|success|animate/);
      expect(indicator.className).not.toContain('animate-spin');
    });

    it('should show waiting status indicator', () => {
      render(<MobileHeader {...defaultProps} status="waiting" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator).toBeInTheDocument();
      // Issue #1078: StatusDot waiting = amber (`bg-warning`).
      expect(indicator.className).toMatch(/warning|yellow|amber/);
    });

    it('should show error status indicator', () => {
      render(<MobileHeader {...defaultProps} status="error" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator).toBeInTheDocument();
      // Issue #1078: StatusDot error = `bg-danger`.
      expect(indicator.className).toMatch(/danger|red|error/);
    });

    it('should have accessible status text', () => {
      render(<MobileHeader {...defaultProps} status="running" />);

      // Should have aria-label or visually hidden text
      expect(screen.getByTestId('status-indicator')).toHaveAccessibleName();
    });
  });

  describe('Home button removed (Issue #2653)', () => {
    it('should not render home/back button even when menu is present', () => {
      const { container } = render(<MobileHeader {...defaultProps} onMenuClick={vi.fn()} />);

      expect(screen.queryByRole('button', { name: /back|return/i })).toBeNull();
      expect(container.querySelector('path[d^="M3 12l2-2"]')).toBeNull();
    });
  });

  describe('Menu Button', () => {
    it('should render menu button when onMenuClick is provided', () => {
      const onMenuClick = vi.fn();
      render(<MobileHeader {...defaultProps} onMenuClick={onMenuClick} />);

      expect(screen.getByRole('button', { name: /menu/i })).toBeInTheDocument();
      expect(screen.getByTestId('mobile-header-menu-button')).toBeInTheDocument();
    });

    it('should not render menu button when onMenuClick is not provided', () => {
      render(<MobileHeader {...defaultProps} />);

      expect(screen.queryByRole('button', { name: /menu/i })).not.toBeInTheDocument();
    });

    it('should call onMenuClick when menu button is clicked', () => {
      const onMenuClick = vi.fn();
      render(<MobileHeader {...defaultProps} onMenuClick={onMenuClick} />);

      fireEvent.click(screen.getByRole('button', { name: /menu/i }));

      expect(onMenuClick).toHaveBeenCalled();
    });
  });

  describe('Menu and palette buttons', () => {
    it('should render both menu and palette buttons with menu appearing first', () => {
      const onMenuClick = vi.fn();
      render(<MobileHeader {...defaultProps} onMenuClick={onMenuClick} />);

      const menu = screen.getByTestId('mobile-header-menu-button');
      const trigger = screen.getByTestId('mobile-header-command-palette-trigger');

      expect(menu).toBeInTheDocument();
      expect(trigger).toBeInTheDocument();
      expect(menu.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    });
  });

  describe('Styling', () => {
    it('should have fixed positioning at top', () => {
      render(<MobileHeader {...defaultProps} />);

      const header = screen.getByTestId('mobile-header');
      expect(header.className).toMatch(/fixed|top/);
    });

    it('should have safe area padding', () => {
      render(<MobileHeader {...defaultProps} />);

      const header = screen.getByTestId('mobile-header');
      // Should have pt-safe or similar class for safe area
      expect(header.className).toMatch(/pt-|safe|top/);
    });

    it('should span full width', () => {
      render(<MobileHeader {...defaultProps} />);

      const header = screen.getByTestId('mobile-header');
      expect(header.className).toMatch(/w-full|inset-x-0/);
    });

    it('should have background color', () => {
      render(<MobileHeader {...defaultProps} />);

      const header = screen.getByTestId('mobile-header');
      expect(header.className).toMatch(/bg-/);
    });

    it('should have shadow or border for visual separation', () => {
      render(<MobileHeader {...defaultProps} />);

      const header = screen.getByTestId('mobile-header');
      expect(header.className).toMatch(/shadow|border/);
    });
  });

  describe('Accessibility', () => {
    it('should have banner role', () => {
      render(<MobileHeader {...defaultProps} />);

      expect(screen.getByRole('banner')).toBeInTheDocument();
    });

    it('should have heading for worktree name', () => {
      render(<MobileHeader {...defaultProps} worktreeName="test-branch" />);

      expect(screen.getByRole('heading')).toBeInTheDocument();
    });

    it('should support keyboard navigation for buttons', () => {
      const onMenuClick = vi.fn();
      render(<MobileHeader {...defaultProps} onMenuClick={onMenuClick} />);

      const menuButton = screen.getByRole('button', { name: /menu/i });
      menuButton.focus();
      fireEvent.keyDown(menuButton, { key: 'Enter', code: 'Enter' });
      fireEvent.click(menuButton);

      expect(onMenuClick).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Command palette trigger (Issue #2395)
  // ==========================================================================

  describe('Command Palette Trigger', () => {
    /** Reports the palette's shared open state, which is what the button moves. */
    function PaletteProbe() {
      const { open } = useCommandPalette();
      return <span data-testid="palette-open">{open ? 'open' : 'closed'}</span>;
    }

    it('should render a command palette trigger', () => {
      render(<MobileHeader {...defaultProps} />);

      expect(screen.getByTestId('mobile-header-command-palette-trigger')).toBeInTheDocument();
    });

    it('should render the trigger even with no other header actions', () => {
      // `/worktrees/*` is the one mobile route with no GlobalMobileNav, so this
      // header is the only chrome that can carry the palette there. It must not
      // be conditional on the menu callback.
      render(<MobileHeader {...defaultProps} />);

      expect(screen.queryByRole('button', { name: /menu/i })).not.toBeInTheDocument();
      expect(screen.getByTestId('mobile-header-command-palette-trigger')).toBeInTheDocument();
    });

    it('should open the shared palette state when tapped', () => {
      render(
        <CommandPaletteProvider>
          <PaletteProbe />
          <MobileHeader {...defaultProps} onMenuClick={vi.fn()} />
        </CommandPaletteProvider>
      );

      expect(screen.getByTestId('palette-open').textContent).toBe('closed');

      fireEvent.click(screen.getByTestId('mobile-header-command-palette-trigger'));

      // `AppShell` mounts `<CommandPalette />` off this same context on every
      // mobile route, so flipping it here is what puts the palette on screen.
      expect(screen.getByTestId('palette-open').textContent).toBe('open');
    });

    it('should not collide with the menu button', () => {
      const onMenuClick = vi.fn();
      render(<MobileHeader {...defaultProps} onMenuClick={onMenuClick} />);

      fireEvent.click(screen.getByTestId('mobile-header-command-palette-trigger'));

      expect(onMenuClick).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /menu/i })).toBeInTheDocument();
    });

    it('should label the trigger for screen readers', () => {
      render(<MobileHeader {...defaultProps} />);

      expect(screen.getByTestId('mobile-header-command-palette-trigger')).toHaveAccessibleName();
    });
  });

  describe('Layout', () => {
    it('should center worktree name', () => {
      render(<MobileHeader {...defaultProps} />);

      const nameElement = screen.getByTestId('worktree-name');
      // Should have text-center or flex centering via parent
      const hasCentering =
        nameElement.className.includes('center') ||
        nameElement.parentElement?.className.includes('center') ||
        nameElement.parentElement?.className.includes('justify-center') ||
        nameElement.className.includes('text-center');
      expect(hasCentering).toBe(true);
    });

    it('should position buttons at edges', () => {
      const onMenuClick = vi.fn();
      render(
        <MobileHeader
          {...defaultProps}
          onMenuClick={onMenuClick}
        />
      );

      const header = screen.getByTestId('mobile-header');
      // Check the inner container for flex layout
      const innerContainer = header.querySelector('div');
      expect(
        header.className.includes('flex') ||
        innerContainer?.className.includes('flex') ||
        innerContainer?.className.includes('justify-between')
      ).toBe(true);
    });
  });

  describe('Layout (Issue #2653)', () => {
    function PaletteProbe() {
      const { open } = useCommandPalette();
      return <span data-testid="palette-open">{open ? 'open' : 'closed'}</span>;
    }

    it('places menu button in left slot and command palette trigger in right slot', () => {
      const onMenuClick = vi.fn();
      render(<MobileHeader {...defaultProps} onMenuClick={onMenuClick} />);

      const row = screen.getByTestId('mobile-header').firstElementChild as HTMLElement;
      expect(row.children).toHaveLength(3);

      expect(row.children[0]).toContainElement(screen.getByTestId('mobile-header-menu-button'));
      expect(row.children[2]).not.toContainElement(screen.getByTestId('mobile-header-menu-button'));

      const rightButtons = row.children[2].querySelectorAll('button');
      expect(rightButtons).toHaveLength(1);
      expect(rightButtons[0]).toBe(screen.getByTestId('mobile-header-command-palette-trigger'));

      expect(row.children[0].className).toContain('w-10');
      expect(row.children[0].className).toContain('flex-shrink-0');
      expect(row.children[2].className).toContain('w-10');
      expect(row.children[2].className).toContain('flex-shrink-0');
    });

    it('leaves left slot empty when onMenuClick is not provided', () => {
      render(<MobileHeader {...defaultProps} />);

      const row = screen.getByTestId('mobile-header').firstElementChild as HTMLElement;
      expect(row.children[0].children).toHaveLength(0);
      expect(screen.queryByTestId('mobile-header-menu-button')).toBeNull();
    });

    it('includes -ml-2 on menu button and -mr-2 on search button', () => {
      render(<MobileHeader {...defaultProps} onMenuClick={vi.fn()} />);

      const menuButton = screen.getByTestId('mobile-header-menu-button');
      const searchButton = screen.getByTestId('mobile-header-command-palette-trigger');
      expect(menuButton.className).toContain('-ml-2');
      expect(searchButton.className).toContain('-mr-2');
    });

    it('calls onMenuClick once when menu button is clicked and keeps palette closed', () => {
      const onMenuClick = vi.fn();
      render(
        <CommandPaletteProvider>
          <PaletteProbe />
          <MobileHeader {...defaultProps} onMenuClick={onMenuClick} />
        </CommandPaletteProvider>
      );

      fireEvent.click(screen.getByTestId('mobile-header-menu-button'));
      expect(onMenuClick).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('palette-open').textContent).toBe('closed');
    });

    it('verifies MobileHeaderProps has no onBackClick with type assertion', () => {
      // @ts-expect-error onBackClick was removed (Issue #2653)
      type _MobileHeaderHasNoBack = Pick<MobileHeaderProps, 'onBackClick'>;
    });
  });
});
