/**
 * Spinner Component
 * Rotating loading indicator (Issue #1118).
 *
 * Consolidates the hand-written inline SVG / border-trick spinners that were
 * duplicated across screens. Use Skeleton for content-shaped placeholders and
 * Spinner for inline/button "busy" states where a skeleton does not fit.
 */

import React from 'react';
import { cn } from '@/lib/utils/cn';

export type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type SpinnerVariant = 'current' | 'accent' | 'muted';

const sizeClasses: Record<SpinnerSize, string> = {
  xs: 'h-3 w-3',
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
  lg: 'h-6 w-6',
  xl: 'h-8 w-8',
};

const variantClasses: Record<SpinnerVariant, string> = {
  // Follows the parent's text color (e.g. white inside a primary Button)
  current: '',
  accent: 'text-accent-600 dark:text-accent-400',
  muted: 'text-muted-foreground',
};

export interface SpinnerProps extends React.SVGAttributes<SVGSVGElement> {
  size?: SpinnerSize;
  variant?: SpinnerVariant;
}

/**
 * Spinner loading indicator
 *
 * Decorative by default (aria-hidden). When the spinner is the only loading
 * cue, pass `role="status"` and an `aria-label` (and reset aria-hidden).
 *
 * @example
 * ```tsx
 * <Spinner size="sm" className="mr-2" />
 * <Spinner size="xl" variant="accent" />
 * ```
 */
export function Spinner({
  size = 'md',
  variant = 'current',
  className,
  ...props
}: SpinnerProps) {
  return (
    <svg
      className={cn('animate-spin', sizeClasses[size], variantClasses[variant], className)}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
      {...props}
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}
