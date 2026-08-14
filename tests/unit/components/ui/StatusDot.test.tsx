/**
 * Tests for StatusDot primitive (Issue #1051)
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusDot, resolveStatusDotVisual } from '@/components/ui/StatusDot';
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

    // Issue #1787: waiting used to be the WEAKEST animated state (a 1→0.45
    // opacity blink) even though it is the only one that needs a human. It now
    // owns the strongest pulse in the system.
    it('applies the strong attention pulse for waiting', () => {
      render(<StatusDot status="waiting" data-testid="dot" />);
      const cls = screen.getByTestId('dot').className;
      expect(cls).toContain('animate-status-attention');
      // currentColor-based glow needs text color to match the dot color
      expect(cls).toContain('text-warning');
      expect(cls).not.toContain('animate-status-blink');
    });

    it.each(['idle', 'ready', 'error'] as const)(
      'does not animate the static %s state',
      (status) => {
        render(<StatusDot status={status} data-testid="dot" />);
        const cls = screen.getByTestId('dot').className;
        expect(cls).not.toContain('animate-status-glow');
        expect(cls).not.toContain('animate-status-attention');
      }
    );
  });

  // ==========================================================================
  // Issue #1787: waitingKind emphasis tiers
  // ==========================================================================

  describe('waitingKind emphasis (Issue #1787)', () => {
    it('gives an app-answerable prompt the strong tier', () => {
      render(<StatusDot status="waiting" waitingKind="prompt" data-testid="dot" />);
      const cls = screen.getByTestId('dot').className;
      expect(cls).toContain('animate-status-attention');
      expect(cls).toContain('ring-4');
    });

    it.each(['menu', 'unclassified'] as const)(
      'drops a terminal-only %s wait to the medium tier',
      (kind) => {
        render(<StatusDot status="waiting" waitingKind={kind} data-testid="dot" />);
        const cls = screen.getByTestId('dot').className;
        // Same cadence as `running`, but amber and with a narrower ring, so it
        // reads as "attend to this eventually" rather than "answer this now".
        expect(cls).toContain('animate-status-glow');
        expect(cls).not.toContain('animate-status-attention');
        expect(cls).toContain('bg-warning');
        expect(cls).toContain('ring-2');
        expect(cls).not.toContain('ring-4');
      }
    );

    // A server that predates #1786 sends no waitingKind at all. The safe
    // failure mode for "needs a human" is to over-emphasize.
    it.each([
      ['absent', undefined],
      ['null', null],
    ] as const)('falls back to the strong tier when waitingKind is %s', (_name, kind) => {
      render(<StatusDot status="waiting" waitingKind={kind} data-testid="dot" />);
      const cls = screen.getByTestId('dot').className;
      expect(cls).toContain('animate-status-attention');
      expect(cls).toContain('ring-4');
    });

    it('ignores waitingKind for non-waiting statuses', () => {
      render(<StatusDot status="running" waitingKind="menu" data-testid="dot" />);
      const cls = screen.getByTestId('dot').className;
      expect(cls).toContain('bg-success');
      expect(cls).not.toContain('bg-warning');
    });

    it('resolveStatusDotVisual grades the kinds directly', () => {
      expect(resolveStatusDotVisual('waiting', 'prompt').animationClass).toBe(
        'animate-status-attention'
      );
      expect(resolveStatusDotVisual('waiting', 'menu').animationClass).toBe(
        'animate-status-glow'
      );
      expect(resolveStatusDotVisual('waiting', null).animationClass).toBe(
        'animate-status-attention'
      );
      expect(resolveStatusDotVisual('running', 'menu').animationClass).toBe(
        'animate-status-glow'
      );
    });
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

    // Issue #1787: waiting used to degrade to a plain amber disc under reduced
    // motion — no halo, nothing but hue separating "needs you" from "ready".
    // Both tiers now keep a ring that survives the animation being frozen.
    it.each([
      ['prompt', 'ring-4'],
      ['menu', 'ring-2'],
      ['unclassified', 'ring-2'],
    ] as const)('keeps a static amber ring for a %s wait', (kind, expectedRing) => {
      render(<StatusDot status="waiting" waitingKind={kind} data-testid="dot" />);
      const cls = screen.getByTestId('dot').className;
      expect(cls).toContain(expectedRing);
      expect(cls).toContain('ring-warning');
    });

    it('keeps a static amber ring for a waiting dot with no kind', () => {
      render(<StatusDot status="waiting" data-testid="dot" />);
      const cls = screen.getByTestId('dot').className;
      expect(cls).toContain('ring-4');
      expect(cls).toContain('ring-warning');
    });
  });

  describe('Unknown state fallback (edge case)', () => {
    it('falls back to a gray dot for an unknown state', () => {
      render(<StatusDot status={'bogus' as StatusDotStatus} data-testid="dot" />);
      const cls = screen.getByTestId('dot').className;
      expect(cls).toContain('bg-muted-foreground');
      expect(cls).not.toContain('animate-status-glow');
      expect(cls).not.toContain('animate-status-attention');
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
