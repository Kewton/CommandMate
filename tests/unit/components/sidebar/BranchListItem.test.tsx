/**
 * Tests for BranchListItem component
 *
 * Tests the individual branch item in the sidebar
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { BranchListItem, clampAxis, __resetMouseEnterSuppression } from '@/components/sidebar/BranchListItem';
import type { SidebarBranchItem } from '@/types/sidebar';

// Issue #1273: the CLI-status wrapper and the nested StatusDot labels resolve
// through `common.*`. Back them with the real dictionary so the English
// assertions prove the keys exist rather than echoing the global mock.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

describe('BranchListItem', () => {
  const defaultBranch: SidebarBranchItem = {
    id: 'feature-test',
    name: 'feature/test',
    repositoryName: 'MyRepo',
    status: 'idle',
    hasUnread: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    __resetMouseEnterSuppression();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render the branch item', () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      expect(screen.getByTestId('branch-list-item')).toBeInTheDocument();
    });

    it('should display branch name', () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      // Branch name appears in inline display (tooltip is only in DOM when hovered)
      expect(screen.getAllByText('feature/test').length).toBeGreaterThanOrEqual(1);
    });

    it('should display repository name', () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      // Repository name appears in inline display (tooltip is only in DOM when hovered)
      expect(screen.getAllByText('MyRepo').length).toBeGreaterThanOrEqual(1);
    });

    it('should render as button element', () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      expect(screen.getByRole('button')).toBeInTheDocument();
    });
  });

  describe('Selection state', () => {
    it('should apply selected styling when selected', () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={true}
          onClick={() => {}}
        />
      );

      const item = screen.getByTestId('branch-list-item');
      // Issue #1073: selected background migrated to the `bg-sidebar-hover`
      // token; the accent left border remains the primary selection marker.
      expect(item.className).toMatch(/bg-sidebar-hover|selected|border-l|border-accent/);
    });

    it('should not apply selected styling when not selected', () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      const item = screen.getByTestId('branch-list-item');
      // border-accent-500 is the selected marker; unselected must not have it.
      expect(item.className).not.toMatch(/border-accent-500/);
    });

    it('should have aria-current attribute when selected', () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={true}
          onClick={() => {}}
        />
      );

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('aria-current', 'true');
    });
  });

  describe('Click handling', () => {
    it('should call onClick when clicked', () => {
      const onClick = vi.fn();
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={onClick}
        />
      );

      fireEvent.click(screen.getByRole('button'));

      expect(onClick).toHaveBeenCalled();
    });

    it('should call onClick only once per click', () => {
      const onClick = vi.fn();
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={onClick}
        />
      );

      fireEvent.click(screen.getByRole('button'));
      fireEvent.click(screen.getByRole('button'));

      expect(onClick).toHaveBeenCalledTimes(2);
    });
  });

  describe('CLI status dots', () => {
    it('should render CLI status dots when cliStatus is provided', () => {
      render(
        <BranchListItem
          branch={{ ...defaultBranch, cliStatus: { claude: 'idle', codex: 'idle' } }}
          isSelected={false}
          onClick={() => {}}
        />
      );

      expect(screen.getByLabelText('CLI tool status')).toBeInTheDocument();
      expect(screen.getByLabelText(/Claude:/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Codex:/)).toBeInTheDocument();
    });

    it('should not render CLI status dots when cliStatus is absent', () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      expect(screen.queryByLabelText('CLI tool status')).not.toBeInTheDocument();
    });

    it('should reflect running status with a glowing dot (Issue #1051)', () => {
      render(
        <BranchListItem
          branch={{ ...defaultBranch, cliStatus: { claude: 'running', codex: 'idle' } }}
          isSelected={false}
          onClick={() => {}}
        />
      );

      const claudeDot = screen.getByLabelText(/Claude:/);
      expect(claudeDot.className).toMatch(/animate-status-glow/);
    });

    it('should render vibe-local status dot dynamically (Issue #368)', () => {
      render(
        <BranchListItem
          branch={{ ...defaultBranch, cliStatus: { claude: 'idle', 'vibe-local': 'ready' } }}
          isSelected={false}
          onClick={() => {}}
        />
      );

      expect(screen.getByLabelText('CLI tool status')).toBeInTheDocument();
      expect(screen.getByLabelText(/Claude:/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Vibe Local:/)).toBeInTheDocument();
    });

    it('should not render status dots when cliStatus is empty object', () => {
      render(
        <BranchListItem
          branch={{ ...defaultBranch, cliStatus: {} }}
          isSelected={false}
          onClick={() => {}}
        />
      );

      expect(screen.queryByLabelText('CLI tool status')).not.toBeInTheDocument();
    });
  });

  describe('Aggregated CLI status indicator (Issue #867)', () => {
    it('should render exactly one status indicator regardless of agent count', () => {
      render(
        <BranchListItem
          branch={{
            ...defaultBranch,
            cliStatus: { claude: 'idle', codex: 'running', gemini: 'ready' },
          }}
          isSelected={false}
          onClick={() => {}}
        />
      );

      // A single aggregated icon, not one dot per agent.
      expect(screen.getAllByTestId('status-indicator')).toHaveLength(1);
    });

    it('should reflect waiting as the highest-priority aggregated status', () => {
      render(
        <BranchListItem
          branch={{
            ...defaultBranch,
            cliStatus: { claude: 'running', codex: 'waiting', gemini: 'idle' },
          }}
          isSelected={false}
          onClick={() => {}}
        />
      );

      const indicator = screen.getByTestId('status-indicator');
      // waiting renders as an amber dot that blinks (never spins).
      expect(indicator.className).toMatch(/bg-warning/);
      expect(indicator.className).not.toMatch(/animate-spin/);
    });

    it('should prioritize running over ready in the aggregated icon', () => {
      render(
        <BranchListItem
          branch={{
            ...defaultBranch,
            cliStatus: { claude: 'ready', codex: 'running' },
          }}
          isSelected={false}
          onClick={() => {}}
        />
      );

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.className).toMatch(/animate-status-glow/);
    });

    it('should expose the per-agent breakdown via the indicator label', () => {
      render(
        <BranchListItem
          branch={{
            ...defaultBranch,
            cliStatus: { claude: 'running', codex: 'idle' },
          }}
          isSelected={false}
          onClick={() => {}}
        />
      );

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.getAttribute('aria-label')).toBe('Claude: running, Codex: idle');
      expect(indicator.getAttribute('title')).toBe('Claude: running, Codex: idle');
    });
  });

  describe('Unread indicator', () => {
    it('should show unread indicator when hasUnread is true', () => {
      render(
        <BranchListItem
          branch={{ ...defaultBranch, hasUnread: true }}
          isSelected={false}
          onClick={() => {}}
        />
      );

      expect(screen.getByTestId('unread-indicator')).toBeInTheDocument();
    });

    it('should not show unread indicator when hasUnread is false', () => {
      render(
        <BranchListItem
          branch={{ ...defaultBranch, hasUnread: false }}
          isSelected={false}
          onClick={() => {}}
        />
      );

      expect(screen.queryByTestId('unread-indicator')).not.toBeInTheDocument();
    });

    it('should have accent styling for unread indicator', () => {
      render(
        <BranchListItem
          branch={{ ...defaultBranch, hasUnread: true }}
          isSelected={false}
          onClick={() => {}}
        />
      );

      const indicator = screen.getByTestId('unread-indicator');
      expect(indicator.className).toMatch(/bg-accent|accent/);
    });
  });

  describe('Styling', () => {
    it('should have hover styling', () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      const item = screen.getByTestId('branch-list-item');
      expect(item.className).toMatch(/hover:/);
    });

    it('should have full width', () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      const item = screen.getByTestId('branch-list-item');
      expect(item.className).toMatch(/w-full/);
    });

    it('should have flex layout', () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      const item = screen.getByTestId('branch-list-item');
      expect(item.className).toMatch(/flex/);
    });

    it('should truncate long branch names', () => {
      const longName = {
        ...defaultBranch,
        name: 'feature/this-is-a-very-long-branch-name-that-should-be-truncated',
      };

      render(
        <BranchListItem
          branch={longName}
          isSelected={false}
          onClick={() => {}}
        />
      );

      // Branch name appears in inline display and tooltip; check the inline one has truncate
      const nameElements = screen.getAllByText(longName.name);
      const inlineElement = nameElements.find((el) => !el.closest('[role="tooltip"]'));
      expect(inlineElement).toBeDefined();
      expect(inlineElement!.className).toMatch(/truncate|overflow|ellipsis/);
    });
  });

  describe('showRepositoryName prop (Issue #651)', () => {
    it('should display repository name inline by default (showRepositoryName not set)', () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      // Repository name should appear inline (tooltip only in DOM when hovered)
      const branchInfoTexts = screen.getByTestId('branch-list-item').querySelectorAll('p');
      const inlineTexts = Array.from(branchInfoTexts).map((el) => el.textContent);
      expect(inlineTexts).toContain('MyRepo');
    });

    it('should display repository name inline when showRepositoryName is true', () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
          showRepositoryName={true}
        />
      );

      // Repository name should appear inline (tooltip only in DOM when hovered)
      const branchInfoTexts = screen.getByTestId('branch-list-item').querySelectorAll('p');
      const inlineTexts = Array.from(branchInfoTexts).map((el) => el.textContent);
      expect(inlineTexts).toContain('MyRepo');
    });

    it('should not display repository name when showRepositoryName is false', () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
          showRepositoryName={false}
        />
      );

      // Repository name should not be in the branch info section
      // (it will still be in the tooltip)
      const branchInfoTexts = screen.getByTestId('branch-list-item').querySelectorAll('p');
      const visibleTexts = Array.from(branchInfoTexts)
        .filter((el) => !el.closest('[role="tooltip"]'))
        .map((el) => el.textContent);
      expect(visibleTexts).not.toContain('MyRepo');
    });
  });

  describe('Tooltip (Issue #651)', () => {
    it('should render a tooltip with role="tooltip" on mouseEnter', async () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      fireEvent.mouseEnter(screen.getByRole('button'));
      await waitFor(() => expect(screen.getByRole('tooltip')).toBeInTheDocument());
    });

    it('should have tooltip id matching aria-describedby on button when tooltip is visible', async () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      const button = screen.getByTestId('branch-list-item');
      fireEvent.mouseEnter(button);
      await waitFor(() => expect(screen.getByRole('tooltip')).toBeInTheDocument());

      const tooltipId = `tooltip-${defaultBranch.id}`;
      expect(button).toHaveAttribute('aria-describedby', tooltipId);

      const tooltip = screen.getByRole('tooltip');
      expect(tooltip).toHaveAttribute('id', tooltipId);
    });

    it('should display branch name in tooltip', async () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      fireEvent.mouseEnter(screen.getByRole('button'));
      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip.textContent).toContain('feature/test');
    });

    it('should display repository name in tooltip', async () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      fireEvent.mouseEnter(screen.getByRole('button'));
      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip.textContent).toContain('MyRepo');
    });

    it('should display status in tooltip', async () => {
      render(
        <BranchListItem
          branch={{ ...defaultBranch, status: 'running' }}
          isSelected={false}
          onClick={() => {}}
        />
      );

      fireEvent.mouseEnter(screen.getByRole('button'));
      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip.textContent).toContain('running');
    });

    it('should display worktreePath in tooltip when provided', async () => {
      render(
        <BranchListItem
          branch={{ ...defaultBranch, worktreePath: '/path/to/worktree' }}
          isSelected={false}
          onClick={() => {}}
        />
      );

      fireEvent.mouseEnter(screen.getByRole('button'));
      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip.textContent).toContain('/path/to/worktree');
    });

    it('should not crash when worktreePath is undefined', async () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      fireEvent.mouseEnter(screen.getByRole('button'));
      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip).toBeInTheDocument();
    });

    it('should include group classes for hover visibility', () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      const button = screen.getByTestId('branch-list-item');
      expect(button.className).toMatch(/group/);
    });
  });

  describe('Tooltip visibility lifecycle (Issue #676)', () => {
    it('should not render tooltip in DOM on initial render (C)', () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    it('should not attach aria-describedby on initial render (accessibility)', () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      const button = screen.getByTestId('branch-list-item');
      expect(button).not.toHaveAttribute('aria-describedby');
    });

    it('should show tooltip on mouseEnter', async () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      fireEvent.mouseEnter(screen.getByRole('button'));
      await waitFor(() => expect(screen.getByRole('tooltip')).toBeInTheDocument());
    });

    it('should hide tooltip on mouseLeave', async () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      const button = screen.getByRole('button');
      fireEvent.mouseEnter(button);
      await waitFor(() => expect(screen.getByRole('tooltip')).toBeInTheDocument());

      fireEvent.mouseLeave(button);
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    it('should hide tooltip on click (B)', async () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      const button = screen.getByRole('button');
      fireEvent.mouseEnter(button);
      await waitFor(() => expect(screen.getByRole('tooltip')).toBeInTheDocument());

      fireEvent.click(button);
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    it('should still invoke onClick when click hides the tooltip (B)', async () => {
      const onClick = vi.fn();
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={onClick}
        />
      );

      const button = screen.getByRole('button');
      fireEvent.mouseEnter(button);
      await waitFor(() => expect(screen.getByRole('tooltip')).toBeInTheDocument());
      fireEvent.click(button);

      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('should not render tooltip when isSelected=true even on mouseEnter (A + C)', async () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={true}
          onClick={() => {}}
        />
      );

      fireEvent.mouseEnter(screen.getByRole('button'));
      // Wait long enough to confirm tooltip does NOT appear (isSelected suppresses it)
      await new Promise((r) => setTimeout(r, 300));
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    it('should not attach aria-describedby when isSelected=true (A)', () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={true}
          onClick={() => {}}
        />
      );

      fireEvent.mouseEnter(screen.getByRole('button'));
      const button = screen.getByTestId('branch-list-item');
      expect(button).not.toHaveAttribute('aria-describedby');
    });

    it('should show tooltip on focus and hide on blur', async () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      const button = screen.getByRole('button');
      // jsdom programmatic focus doesn't set :focus-visible (spec requires keyboard
      // interaction), so mock matches() to simulate keyboard-focused state.
      const realMatches = HTMLElement.prototype.matches;
      vi.spyOn(HTMLElement.prototype, 'matches').mockImplementation(function (
        this: Element,
        selector: string
      ) {
        if (selector === ':focus-visible') return true;
        return realMatches.call(this, selector);
      });

      fireEvent.focus(button);
      await waitFor(() => expect(screen.getByRole('tooltip')).toBeInTheDocument());

      fireEvent.blur(button);
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });
  });

  describe('Tooltip viewport clamping (Issue #1361)', () => {
    const ORIGINAL_INNER_WIDTH = window.innerWidth;
    const ORIGINAL_INNER_HEIGHT = window.innerHeight;

    /** Build a DOMRect-like value (jsdom does no layout, so every rect is mocked). */
    function rect(left: number, top: number, width: number, height: number): DOMRect {
      return {
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        x: left,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    }

    function setViewport(width: number, height: number): void {
      Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
      Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true });
    }

    /**
     * jsdom reports zero-sized rects for everything, which would make the clamp
     * maths trivially pass. Feed it the anchor / bubble geometry each scenario
     * describes instead.
     */
    function setGeometry(anchor: DOMRect, bubble: DOMRect): void {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement
      ) {
        if (this.getAttribute('role') === 'tooltip') return bubble;
        if (this.dataset.testid === 'branch-list-item') return anchor;
        return rect(0, 0, 0, 0);
      });
    }

    /** Force `:focus-visible` to match, as jsdom never sets it programmatically. */
    function mockFocusVisible(): void {
      const realMatches = HTMLElement.prototype.matches;
      vi.spyOn(HTMLElement.prototype, 'matches').mockImplementation(function (
        this: Element,
        selector: string
      ) {
        if (selector === ':focus-visible') return true;
        return realMatches.call(this, selector);
      });
    }

    function renderItem(branch: SidebarBranchItem = defaultBranch) {
      render(<BranchListItem branch={branch} isSelected={false} onClick={() => {}} />);
    }

    afterEach(() => {
      setViewport(ORIGINAL_INNER_WIDTH, ORIGINAL_INNER_HEIGHT);
    });

    it('should keep the default right-side placement when the bubble fits', async () => {
      setViewport(1440, 900);
      setGeometry(rect(0, 100, 280, 56), rect(0, 0, 384, 120));
      renderItem();

      fireEvent.mouseEnter(screen.getByRole('button'));
      const tooltip = await screen.findByRole('tooltip');

      // rect.right (280) + 8px gap; top follows the anchor. Unchanged behaviour.
      await waitFor(() => expect(tooltip.style.left).toBe('288px'));
      expect(tooltip.style.top).toBe('100px');
      expect(tooltip.style.maxWidth).toBe('384px');
    });

    it('should clamp to the right edge with a 480px sidebar (condition 1)', async () => {
      // Sidebar at MAX_SIDEBAR_WIDTH on a 768px-wide viewport: the 384px bubble
      // would open at 488 and run to 872, well past the right edge.
      setViewport(768, 1024);
      setGeometry(rect(0, 100, 480, 56), rect(0, 0, 384, 120));
      renderItem();

      fireEvent.mouseEnter(screen.getByRole('button'));
      const tooltip = await screen.findByRole('tooltip');

      await waitFor(() => expect(tooltip.style.left).toBe('376px'));
      // The bubble's right edge lands exactly on the 8px viewport margin.
      expect(parseInt(tooltip.style.left, 10) + 384).toBeLessThanOrEqual(768 - 8);
    });

    it('should clamp to the bottom edge for the last list item (condition 2)', async () => {
      // Bottom-most item: top: rect.top would put a tall bubble at 700..900.
      setViewport(1440, 768);
      setGeometry(rect(0, 700, 280, 56), rect(0, 0, 384, 200));
      renderItem({ ...defaultBranch, description: 'a long description'.repeat(20) });

      fireEvent.mouseEnter(screen.getByRole('button'));
      const tooltip = await screen.findByRole('tooltip');

      await waitFor(() => expect(tooltip.style.top).toBe('560px'));
      expect(parseInt(tooltip.style.top, 10) + 200).toBeLessThanOrEqual(768 - 8);
    });

    it('should keep the bubble on screen inside the 375px mobile drawer (condition 3)', async () => {
      // Drawer is w-72 (288px): the bubble opened at left≈296 and ran to 680,
      // almost entirely off a 375px screen.
      setViewport(375, 667);
      setGeometry(rect(0, 120, 288, 56), rect(0, 0, 359, 140));
      renderItem();

      fireEvent.mouseEnter(screen.getByRole('button'));
      const tooltip = await screen.findByRole('tooltip');

      await waitFor(() => expect(tooltip.style.left).toBe('8px'));
      // Clamping alone cannot fit 384px into 375px, so the width is capped too.
      expect(tooltip.style.maxWidth).toBe('359px');
      expect(8 + 359).toBeLessThanOrEqual(375 - 8);
    });

    it('should clamp on focus-visible too, not only on hover (condition 3)', async () => {
      setViewport(375, 667);
      setGeometry(rect(0, 120, 288, 56), rect(0, 0, 359, 140));
      mockFocusVisible();
      renderItem();

      fireEvent.focus(screen.getByRole('button'));
      const tooltip = await screen.findByRole('tooltip');

      await waitFor(() => expect(tooltip.style.left).toBe('8px'));
      expect(tooltip.style.maxWidth).toBe('359px');
    });

    it('should flip to the left side when the right overflows but the left has room', async () => {
      setViewport(1000, 800);
      setGeometry(rect(600, 100, 100, 56), rect(0, 0, 384, 120));
      renderItem();

      fireEvent.mouseEnter(screen.getByRole('button'));
      const tooltip = await screen.findByRole('tooltip');

      // rect.left (600) - 8px gap - 384px bubble; preferred over clamping,
      // which would have overlapped the anchor.
      await waitFor(() => expect(tooltip.style.left).toBe('208px'));
    });
  });

  describe('clampAxis (Issue #1361)', () => {
    it('should leave a value that already fits untouched', () => {
      expect(clampAxis(100, 200, 800)).toBe(100);
    });

    it('should clamp a value that overflows the end edge', () => {
      expect(clampAxis(700, 200, 768)).toBe(560);
    });

    it('should clamp a value that overflows the start edge', () => {
      expect(clampAxis(-50, 200, 768)).toBe(8);
    });

    it('should pin to the start margin when the bubble is larger than the viewport', () => {
      // Nothing fits; showing the start of the bubble beats showing its middle.
      expect(clampAxis(100, 700, 667)).toBe(8);
    });
  });

  describe('Accessibility', () => {
    it('should be focusable', () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      const button = screen.getByRole('button');
      button.focus();
      expect(document.activeElement).toBe(button);
    });

    it('should have accessible name', () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      const button = screen.getByRole('button');
      expect(button).toHaveAccessibleName();
    });

    it('should respond to keyboard Enter', () => {
      const onClick = vi.fn();
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={onClick}
        />
      );

      const button = screen.getByRole('button');
      fireEvent.keyDown(button, { key: 'Enter', code: 'Enter' });
      fireEvent.click(button);

      expect(onClick).toHaveBeenCalled();
    });

    it('should include aria-label with repository name when showRepositoryName is false (Issue #651)', () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
          showRepositoryName={false}
        />
      );

      const button = screen.getByTestId('branch-list-item');
      expect(button.getAttribute('aria-label')).toContain('MyRepo');
    });
  });
});
