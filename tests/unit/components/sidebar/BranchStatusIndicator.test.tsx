/**
 * Tests for BranchStatusIndicator component
 *
 * Tests the status indicator dot with different states
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { BranchStatusIndicator } from '@/components/sidebar/BranchStatusIndicator';
import type { BranchStatus } from '@/types/sidebar';

describe('BranchStatusIndicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render the indicator', () => {
      render(<BranchStatusIndicator status="idle" />);

      expect(screen.getByTestId('status-indicator')).toBeInTheDocument();
    });

    it('should be a span element', () => {
      render(<BranchStatusIndicator status="idle" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.tagName.toLowerCase()).toBe('span');
    });
  });

  describe('Status colors', () => {
    it('should have gray color for idle status', () => {
      render(<BranchStatusIndicator status="idle" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.className).toMatch(/bg-muted-foreground|gray/);
    });

    it('should have green (success) color for running status (Issue #1051)', () => {
      render(<BranchStatusIndicator status="running" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.className).toMatch(/bg-success/);
    });

    it('should have amber (warning) color for waiting status (Issue #1051)', () => {
      render(<BranchStatusIndicator status="waiting" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.className).toMatch(/bg-warning|yellow|amber/);
    });

    it('should have green (success) color for generating status (Issue #1051)', () => {
      render(<BranchStatusIndicator status="generating" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.className).toMatch(/bg-success/);
    });
  });

  describe('Animation', () => {
    it('should not animate for idle status (dot)', () => {
      render(<BranchStatusIndicator status="idle" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.className).not.toMatch(/animate-status/);
    });

    it('should glow/pulse for running status (Issue #1051)', () => {
      render(<BranchStatusIndicator status="running" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.className).toMatch(/animate-status-glow/);
    });

    it('should blink for waiting status (Issue #1051)', () => {
      render(<BranchStatusIndicator status="waiting" />);

      const indicator = screen.getByTestId('status-indicator');
      // Waiting blinks (weak) but never spins.
      expect(indicator.className).toMatch(/animate-status-blink/);
      expect(indicator.className).not.toMatch(/animate-spin/);
    });

    it('should glow/pulse for generating status (Issue #1051)', () => {
      render(<BranchStatusIndicator status="generating" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.className).toMatch(/animate-status-glow/);
    });
  });

  describe('Size and shape', () => {
    it('should have rounded shape', () => {
      render(<BranchStatusIndicator status="idle" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.className).toMatch(/rounded-full/);
    });

    it('should have small size (w-3 h-3)', () => {
      render(<BranchStatusIndicator status="idle" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.className).toMatch(/w-3|w-2/);
      expect(indicator.className).toMatch(/h-3|h-2/);
    });
  });

  describe('Accessibility', () => {
    it('should have title attribute with status label', () => {
      render(<BranchStatusIndicator status="running" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator).toHaveAttribute('title');
    });

    it('should have aria-label for status', () => {
      render(<BranchStatusIndicator status="running" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator).toHaveAttribute('aria-label');
    });

    it('should display "Idle" label for idle status', () => {
      render(<BranchStatusIndicator status="idle" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.getAttribute('title')).toBe('Idle');
      expect(indicator.getAttribute('aria-label')).toBe('Idle');
    });

    it('should display "Running" label for running status', () => {
      render(<BranchStatusIndicator status="running" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.getAttribute('title')).toBe('Running');
      expect(indicator.getAttribute('aria-label')).toBe('Running');
    });

    it('should display "Waiting for response" label for waiting status', () => {
      render(<BranchStatusIndicator status="waiting" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.getAttribute('title')).toBe('Waiting for response');
      expect(indicator.getAttribute('aria-label')).toBe('Waiting for response');
    });

    it('should display "Generating" label for generating status', () => {
      render(<BranchStatusIndicator status="generating" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.getAttribute('title')).toBe('Generating');
      expect(indicator.getAttribute('aria-label')).toBe('Generating');
    });

    it('should override the label when a custom label is provided (Issue #867)', () => {
      render(
        <BranchStatusIndicator status="running" label="Claude: running, Codex: idle" />
      );

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.getAttribute('title')).toBe('Claude: running, Codex: idle');
      expect(indicator.getAttribute('aria-label')).toBe('Claude: running, Codex: idle');
    });

    it('should fall back to the config label when label is omitted (Issue #867)', () => {
      render(<BranchStatusIndicator status="waiting" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.getAttribute('aria-label')).toBe('Waiting for response');
    });
  });

  describe('All status types', () => {
    const statusTypes: BranchStatus[] = ['idle', 'ready', 'running', 'waiting', 'generating'];

    statusTypes.forEach((status) => {
      it(`should render correctly for ${status} status`, () => {
        render(<BranchStatusIndicator status={status} />);

        const indicator = screen.getByTestId('status-indicator');
        expect(indicator).toBeInTheDocument();
        // Dots use bg- class, spinners use border- class
        expect(indicator.className).toMatch(/bg-|border-/);
      });
    });
  });
});
