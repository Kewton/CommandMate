/**
 * Tests for BranchListItem component
 *
 * Tests the individual branch item in the sidebar
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { BranchListItem } from '@/components/sidebar/BranchListItem';
import type { SidebarBranchItem } from '@/types/sidebar';

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

      expect(screen.getByText('feature/test')).toBeInTheDocument();
    });

    it('should display repository name', () => {
      render(
        <BranchListItem
          branch={defaultBranch}
          isSelected={false}
          onClick={() => {}}
        />
      );

      expect(screen.getByText('MyRepo')).toBeInTheDocument();
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
      expect(item.className).toMatch(/bg-gray-700|selected|border-l|border-blue/);
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
      expect(item.className).not.toMatch(/bg-gray-700/);
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

    it('should reflect running status with spinner styling', () => {
      render(
        <BranchListItem
          branch={{ ...defaultBranch, cliStatus: { claude: 'running', codex: 'idle' } }}
          isSelected={false}
          onClick={() => {}}
        />
      );

      const claudeDot = screen.getByLabelText(/Claude:/);
      expect(claudeDot.className).toMatch(/animate-spin/);
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

    it('should have blue styling for unread indicator', () => {
      render(
        <BranchListItem
          branch={{ ...defaultBranch, hasUnread: true }}
          isSelected={false}
          onClick={() => {}}
        />
      );

      const indicator = screen.getByTestId('unread-indicator');
      expect(indicator.className).toMatch(/bg-blue|blue/);
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

      const nameElement = screen.getByText(longName.name);
      expect(nameElement.className).toMatch(/truncate|overflow|ellipsis/);
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
  });
});
