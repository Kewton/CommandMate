/**
 * Tests for NotificationDot shared component
 * Issue #278: MF-001 - DRY principle for dot badge UI pattern
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { NotificationDot } from '@/components/common/NotificationDot';

describe('NotificationDot', () => {
  describe('Rendering', () => {
    it('should render a span element', () => {
      render(<NotificationDot data-testid="test-dot" />);
      const dot = screen.getByTestId('test-dot');
      expect(dot).toBeInTheDocument();
      expect(dot.tagName).toBe('SPAN');
    });

    it('should apply base styles: w-2 h-2 rounded-full bg-blue-500', () => {
      render(<NotificationDot data-testid="test-dot" />);
      const dot = screen.getByTestId('test-dot');
      expect(dot.className).toContain('w-2');
      expect(dot.className).toContain('h-2');
      expect(dot.className).toContain('rounded-full');
      expect(dot.className).toContain('bg-blue-500');
    });
  });

  describe('Props', () => {
    it('should support data-testid prop', () => {
      render(<NotificationDot data-testid="custom-test-id" />);
      expect(screen.getByTestId('custom-test-id')).toBeInTheDocument();
    });

    it('should support aria-label prop', () => {
      render(<NotificationDot data-testid="test-dot" aria-label="Update available" />);
      const dot = screen.getByTestId('test-dot');
      expect(dot).toHaveAttribute('aria-label', 'Update available');
    });

    it('should apply additional className for position adjustment', () => {
      render(<NotificationDot data-testid="test-dot" className="absolute top-0 right-0" />);
      const dot = screen.getByTestId('test-dot');
      expect(dot.className).toContain('absolute');
      expect(dot.className).toContain('top-0');
      expect(dot.className).toContain('right-0');
    });

    it('should merge additional className with base styles', () => {
      render(<NotificationDot data-testid="test-dot" className="absolute top-1 right-1" />);
      const dot = screen.getByTestId('test-dot');
      // Should contain both base styles and additional className
      expect(dot.className).toContain('w-2');
      expect(dot.className).toContain('h-2');
      expect(dot.className).toContain('rounded-full');
      expect(dot.className).toContain('bg-blue-500');
      expect(dot.className).toContain('absolute');
      expect(dot.className).toContain('top-1');
      expect(dot.className).toContain('right-1');
    });

    it('should handle empty className prop', () => {
      render(<NotificationDot data-testid="test-dot" className="" />);
      const dot = screen.getByTestId('test-dot');
      expect(dot.className).toContain('w-2');
      expect(dot.className).toContain('bg-blue-500');
      // Should not have trailing spaces
      expect(dot.className).toBe(dot.className.trim());
    });

    it('should handle undefined className prop (default)', () => {
      render(<NotificationDot data-testid="test-dot" />);
      const dot = screen.getByTestId('test-dot');
      expect(dot.className).toContain('w-2');
      expect(dot.className).toBe(dot.className.trim());
    });

    it('should render without any props', () => {
      const { container } = render(<NotificationDot />);
      const dot = container.querySelector('span');
      expect(dot).not.toBeNull();
      expect(dot!.className).toContain('w-2');
      expect(dot!.className).toContain('bg-blue-500');
    });
  });

  describe('Accessibility', () => {
    it('should support aria-label for screen readers', () => {
      render(<NotificationDot aria-label="Has unread messages" data-testid="test-dot" />);
      const dot = screen.getByTestId('test-dot');
      expect(dot.getAttribute('aria-label')).toBe('Has unread messages');
    });

    it('should not have aria-label when not provided', () => {
      render(<NotificationDot data-testid="test-dot" />);
      const dot = screen.getByTestId('test-dot');
      expect(dot.getAttribute('aria-label')).toBeNull();
    });
  });

  describe('Security [SEC-SF-001]', () => {
    it('should only accept string className (className injection note: hardcoded values only)', () => {
      // This test documents the security constraint: className should only receive
      // hardcoded string values, never user input.
      // The prop type enforces string, and JSDoc warns against user input.
      render(<NotificationDot data-testid="test-dot" className="absolute top-0 right-0" />);
      const dot = screen.getByTestId('test-dot');
      expect(dot.className).toContain('absolute');
    });
  });
});
