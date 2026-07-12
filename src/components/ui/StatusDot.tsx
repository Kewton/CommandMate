/**
 * StatusDot Component (Issue #1051)
 *
 * A small colored status dot with "living" motion for active states:
 * - running / generating: green dot with a pulsing box-shadow glow + a static
 *   ring halo (so it stays distinct from `ready` even when motion is frozen)
 * - waiting: amber dot with a weak blink
 * - ready: static green dot
 * - idle: static gray dot
 * - error: static red dot
 * - unknown state: static gray fallback
 *
 * Colors/semantics stay aligned with @/config/status-colors and
 * docs/features/sidebar-status-indicator.md (running=green, waiting=amber,
 * error=red). Animations are infinite CSS classes (see tailwind.config.js), so
 * polling re-renders never restart them. OS "reduce motion" is honored globally
 * in globals.css, which freezes the animation to a static dot.
 */

import React from 'react';
import { cn } from '@/lib/utils/cn';

export type StatusDotStatus =
  | 'idle'
  | 'ready'
  | 'running'
  | 'waiting'
  | 'generating'
  | 'error';

export type StatusDotSize = 'sm' | 'md' | 'lg';

interface StatusDotVisual {
  /** Color utility classes. Glow states also set `text-*` so the box-shadow
   * (which uses `currentColor`) matches the dot color. */
  colorClass: string;
  /** Optional infinite animation utility. */
  animationClass?: string;
  /** Default accessible label. */
  label: string;
}

const STATUS_DOT_CONFIG: Record<StatusDotStatus, StatusDotVisual> = {
  idle: { colorClass: 'bg-muted-foreground', label: 'Idle' },
  ready: { colorClass: 'bg-success', label: 'Ready' },
  // running/generating add a static `ring` as a MOTION-INDEPENDENT
  // differentiator: the pulsing glow (animate-status-glow) sets box-shadow
  // directly and overrides the ring while animating, but when the pulse is
  // frozen by prefers-reduced-motion the ring box-shadow remains — so a
  // "running" dot keeps a green halo that the static green `ready` dot never
  // has, and the two are never pixel-identical.
  running: {
    colorClass: 'bg-success text-success ring-2 ring-success/40',
    animationClass: 'animate-status-glow',
    label: 'Running',
  },
  generating: {
    colorClass: 'bg-success text-success ring-2 ring-success/40',
    animationClass: 'animate-status-glow',
    label: 'Generating',
  },
  waiting: {
    colorClass: 'bg-warning',
    animationClass: 'animate-status-blink',
    label: 'Waiting for response',
  },
  error: { colorClass: 'bg-danger', label: 'Error' },
};

/** Fallback for unrecognized state values (edge case: unknown status → gray). */
const FALLBACK_VISUAL: StatusDotVisual = {
  colorClass: 'bg-muted-foreground',
  label: 'Unknown',
};

const SIZE_CLASSES: Record<StatusDotSize, string> = {
  sm: 'w-2 h-2',
  md: 'w-2.5 h-2.5',
  lg: 'w-3 h-3',
};

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Current status. Unrecognized values fall back to a gray dot. */
  status: StatusDotStatus;
  /** Dot size. Defaults to `md`. */
  size?: StatusDotSize;
  /** Accessible label override for `title` / `aria-label`. Falls back to the
   * status's default label when omitted. */
  label?: string;
}

/**
 * StatusDot renders a colored status dot with motion for active states.
 *
 * @example
 * ```tsx
 * <StatusDot status="running" size="lg" />
 * <StatusDot status="waiting" label="Claude: waiting, Codex: idle" />
 * ```
 */
export function StatusDot({
  status,
  size = 'md',
  label,
  className,
  ...rest
}: StatusDotProps) {
  const visual = STATUS_DOT_CONFIG[status] ?? FALLBACK_VISUAL;
  const accessibleLabel = label ?? visual.label;

  return (
    <span
      className={cn(
        'inline-block flex-shrink-0 rounded-full',
        SIZE_CLASSES[size],
        visual.colorClass,
        visual.animationClass,
        className
      )}
      title={accessibleLabel}
      aria-label={accessibleLabel}
      {...rest}
    />
  );
}
