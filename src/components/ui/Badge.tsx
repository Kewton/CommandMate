/**
 * Badge Component
 * Small status indicators with different variants
 */

import React from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils/cn';

export type BadgeVariant = 'success' | 'warning' | 'error' | 'info' | 'gray';

const badgeVariants = cva(
  'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium',
  {
    variants: {
      variant: {
        success: 'bg-success-subtle text-success-foreground',
        warning: 'bg-warning-subtle text-warning-foreground',
        error: 'bg-danger-subtle text-danger-foreground',
        info: 'bg-accent-100 dark:bg-accent-900 text-accent-800 dark:text-accent-300',
        gray: 'bg-muted text-muted-foreground',
      },
    },
    defaultVariants: {
      variant: 'gray',
    },
  }
);

const dotColorStyles: Record<BadgeVariant, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-danger',
  info: 'bg-info',
  gray: 'bg-muted-foreground',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  dot?: boolean;
  children: React.ReactNode;
}

/**
 * Badge component for status indicators
 *
 * @example
 * ```tsx
 * <Badge variant="success">Active</Badge>
 * <Badge variant="error" dot>Failed</Badge>
 * ```
 */
export function Badge({
  variant = 'gray',
  dot = false,
  className = '',
  children,
  ...props
}: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot && (
        <span
          className={cn('mr-1.5 inline-block h-2 w-2 rounded-full', dotColorStyles[variant])}
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}
