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
      expect(indicator.className).toMatch(/bg-gray-500|gray/);
    });

    it('should have green color for running status', () => {
      render(<BranchStatusIndicator status="running" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.className).toMatch(/bg-green-500|green/);
    });

    it('should have yellow color for waiting status', () => {
      render(<BranchStatusIndicator status="waiting" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.className).toMatch(/bg-yellow-500|yellow|amber/);
    });

    it('should have blue color for generating status', () => {
      render(<BranchStatusIndicator status="generating" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.className).toMatch(/bg-blue-500|blue/);
    });
  });

  describe('Animation', () => {
    it('should not animate for idle status', () => {
      render(<BranchStatusIndicator status="idle" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.className).not.toMatch(/animate-pulse/);
    });

    it('should animate for running status', () => {
      render(<BranchStatusIndicator status="running" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.className).toMatch(/animate-pulse/);
    });

    it('should animate for waiting status', () => {
      render(<BranchStatusIndicator status="waiting" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.className).toMatch(/animate-pulse/);
    });

    it('should animate for generating status', () => {
      render(<BranchStatusIndicator status="generating" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.className).toMatch(/animate-pulse/);
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

    it('should display "Waiting" label for waiting status', () => {
      render(<BranchStatusIndicator status="waiting" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.getAttribute('title')).toBe('Waiting');
      expect(indicator.getAttribute('aria-label')).toBe('Waiting');
    });

    it('should display "Generating" label for generating status', () => {
      render(<BranchStatusIndicator status="generating" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator.getAttribute('title')).toBe('Generating');
      expect(indicator.getAttribute('aria-label')).toBe('Generating');
    });
  });

  describe('All status types', () => {
    const statusTypes: BranchStatus[] = ['idle', 'running', 'waiting', 'generating'];

    statusTypes.forEach((status) => {
      it(`should render correctly for ${status} status`, () => {
        render(<BranchStatusIndicator status={status} />);

        const indicator = screen.getByTestId('status-indicator');
        expect(indicator).toBeInTheDocument();
        expect(indicator.className).toMatch(/bg-/);
      });
    });
  });
});
