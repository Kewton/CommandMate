/**
 * Button Component
 * Reusable button with multiple variants and sizes
 */

import React from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

const buttonVariants = cva(
  // [Issue #1050] transition-all (was transition-colors) so the hover lift /
  // active press below animate smoothly. Reduced-motion handled in globals.css.
  // focus-visible + ring-offset-background: keyboard-only ring, and the offset
  // color is tied to the page background so dark mode no longer paints the
  // default white halo (Tabs/Switch are the reference).
  'inline-flex items-center justify-center px-4 py-2 rounded-md font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background',
  {
    variants: {
      variant: {
        primary:
          'bg-accent-600 dark:bg-accent-500 text-white hover:bg-accent-700 dark:hover:bg-accent-600',
        secondary:
          'bg-muted text-foreground hover:bg-muted/80',
        danger: 'bg-danger text-white hover:bg-danger/90',
        ghost:
          'bg-transparent text-foreground hover:bg-muted',
      },
      size: {
        sm: 'px-3 py-1.5 text-sm',
        md: '',
        lg: 'px-6 py-3 text-lg',
      },
      fullWidth: {
        true: 'w-full',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
      fullWidth: false,
    },
  }
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
  children: React.ReactNode;
}

/**
 * Button component with variants and sizes
 *
 * @example
 * ```tsx
 * <Button variant="primary" size="md" onClick={handleClick}>
 *   Click me
 * </Button>
 * ```
 */
export function Button({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  loading = false,
  disabled,
  className = '',
  children,
  ...props
}: ButtonProps) {
  const isDisabled = disabled || loading;

  const classes = cn(
    buttonVariants({ variant, size, fullWidth }),
    // [Issue #1050] Unified hover lift + active press. Skipped when disabled so
    // inert buttons don't move on hover. Gated behind motion-safe so the
    // transform is suppressed under prefers-reduced-motion (the globals.css
    // reset only neutralizes duration/delay, not transform).
    !isDisabled && 'motion-safe:hover:-translate-y-0.5 motion-safe:active:translate-y-0',
    isDisabled && 'opacity-50 cursor-not-allowed',
    className
  );

  return (
    <button
      className={classes}
      disabled={isDisabled}
      {...props}
    >
      {loading && (
        <svg
          className="animate-spin -ml-1 mr-2 h-4 w-4"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
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
      )}
      {children}
    </button>
  );
}
