/**
 * Tests for StatusDot primitive (Issue #1051)
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusDot } from '@/components/ui/StatusDot';
import type { StatusDotStatus } from '@/components/ui/StatusDot';

// Issue #1273: the default labels now resolve through `common.status.*`. The
// global mock in tests/setup.ts would echo the key back, so the English
// assertions below would pass against a dictionary that never had the entry —
// back the component with the real dictionary instead.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

describe('StatusDot', () => {
  describe('Rendering', () => {
    it('renders a span with the base dot classes', () => {
      render(<StatusDot status="idle" data-testid="dot" />);
      const dot = screen.getByTestId('dot');
      expect(dot.tagName.toLowerCase()).toBe('span');
      expect(dot.className).toContain('rounded-full');
      expect(dot.className).toContain('inline-block');
    });

    it('renders the four primary states (running/waiting/idle/error)', () => {
      const states: StatusDotStatus[] = ['running', 'waiting', 'idle', 'error'];
      states.forEach((status) => {
        const { unmount } = render(<StatusDot status={status} data-testid="dot" />);
        expect(screen.getByTestId('dot')).toBeInTheDocument();
        unmount();
      });
    });
  });

  describe('Status colors', () => {
    it.each([
      ['idle', 'bg-muted-foreground'],
      ['ready', 'bg-success'],
      ['running', 'bg-success'],
      ['generating', 'bg-success'],
      ['waiting', 'bg-warning'],
      ['error', 'bg-danger'],
    ] as const)('applies the %s color class', (status, expected) => {
      render(<StatusDot status={status} data-testid="dot" />);
      expect(screen.getByTestId('dot').className).toContain(expected);
    });
  });

  describe('Motion', () => {
    it('applies the pulsing glow animation for running', () => {
      render(<StatusDot status="running" data-testid="dot" />);
      const cls = screen.getByTestId('dot').className;
      // currentColor-based glow needs text color to match the dot color
      expect(cls).toContain('animate-status-glow');
      expect(cls).toContain('text-success');
    });

    it('applies the pulsing glow animation for generating', () => {
      render(<StatusDot status="generating" data-testid="dot" />);
      expect(screen.getByTestId('dot').className).toContain('animate-status-glow');
    });

    it('applies the weak blink animation for waiting', () => {
      render(<StatusDot status="waiting" data-testid="dot" />);
      expect(screen.getByTestId('dot').className).toContain('animate-status-blink');
    });

    it.each(['idle', 'ready', 'error'] as const)(
      'does not animate the static %s state',
      (status) => {
        render(<StatusDot status={status} data-testid="dot" />);
        const cls = screen.getByTestId('dot').className;
        expect(cls).not.toContain('animate-status-glow');
        expect(cls).not.toContain('animate-status-blink');
      }
    );
  });

  describe('Reduced-motion differentiation', () => {
    // The pulsing glow can be frozen by prefers-reduced-motion, so running must
    // stay distinct from the static green `ready` dot via a motion-independent
    // ring halo (persists even when the animation is neutralized).
    it.each(['running', 'generating'] as const)(
      'gives %s a static ring halo independent of motion',
      (status) => {
        render(<StatusDot status={status} data-testid="dot" />);
        const cls = screen.getByTestId('dot').className;
        expect(cls).toContain('ring-2');
        expect(cls).toContain('ring-success');
      }
    );

    it('does not give the static ready dot a ring (stays distinct from running)', () => {
      render(<StatusDot status="ready" data-testid="dot" />);
      const cls = screen.getByTestId('dot').className;
      expect(cls).toContain('bg-success');
      expect(cls).not.toContain('ring-2');
    });
  });

  describe('Unknown state fallback (edge case)', () => {
    it('falls back to a gray dot for an unknown state', () => {
      render(<StatusDot status={'bogus' as StatusDotStatus} data-testid="dot" />);
      const cls = screen.getByTestId('dot').className;
      expect(cls).toContain('bg-muted-foreground');
      expect(cls).not.toContain('animate-status-glow');
      expect(cls).not.toContain('animate-status-blink');
    });

    it('uses the "Unknown" label for an unknown state', () => {
      render(<StatusDot status={'bogus' as StatusDotStatus} data-testid="dot" />);
      expect(screen.getByTestId('dot').getAttribute('aria-label')).toBe('Unknown');
    });
  });

  describe('Sizing', () => {
    it('defaults to the md size', () => {
      render(<StatusDot status="idle" data-testid="dot" />);
      expect(screen.getByTestId('dot').className).toContain('w-2.5');
    });

    it.each([
      ['sm', 'w-2'],
      ['md', 'w-2.5'],
      ['lg', 'w-3'],
    ] as const)('applies the %s size', (size, expected) => {
      render(<StatusDot status="idle" size={size} data-testid="dot" />);
      expect(screen.getByTestId('dot').className).toContain(expected);
    });
  });

  describe('Accessibility', () => {
    it('uses the default label for title and aria-label', () => {
      render(<StatusDot status="waiting" data-testid="dot" />);
      const dot = screen.getByTestId('dot');
      expect(dot.getAttribute('title')).toBe('Waiting for response');
      expect(dot.getAttribute('aria-label')).toBe('Waiting for response');
    });

    it('overrides the label when one is provided', () => {
      render(
        <StatusDot status="running" label="Claude: running, Codex: idle" data-testid="dot" />
      );
      const dot = screen.getByTestId('dot');
      expect(dot.getAttribute('title')).toBe('Claude: running, Codex: idle');
      expect(dot.getAttribute('aria-label')).toBe('Claude: running, Codex: idle');
    });
  });

  describe('Custom className', () => {
    it('merges a custom className with the dot classes', () => {
      render(<StatusDot status="idle" className="ml-2" data-testid="dot" />);
      const cls = screen.getByTestId('dot').className;
      expect(cls).toContain('ml-2');
      expect(cls).toContain('rounded-full');
    });
  });
});
