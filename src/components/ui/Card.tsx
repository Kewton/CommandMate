/**
 * Card Component
 * Reusable card container with optional hover effect
 */

import React from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils/cn';

/*
 * [Issue #1049] Base uses semantic surface/border tokens so the depth-token
 * revision propagates without per-card edits. `variant` adds depth:
 *  - elevated: subtle top-lit gradient + stronger shadow (focal panels)
 *  - interactive: accent hairline + slight lift on hover (clickable cards)
 */
const cardVariants = cva(
  'bg-surface text-surface-foreground rounded-lg border border-border shadow-sm',
  {
    variants: {
      variant: {
        default: '',
        elevated: 'bg-gradient-to-b from-surface to-surface-2 shadow-md',
        interactive:
          'cursor-pointer transition-all duration-200 ' +
          'hover:border-accent-500 hover:shadow-md motion-safe:hover:-translate-y-0.5 ' +
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
          'focus-visible:border-accent-500 focus-visible:shadow-md motion-safe:focus-visible:-translate-y-0.5',
      },
      hover: {
        true: 'transition-shadow duration-200 hover:shadow-md',
        false: '',
      },
      // [Issue #1050] Interactive cards (clickable shortcuts, links) get a
      // hover lift + active press. Kept separate from `hover` (shadow-only) so
      // non-interactive cards stay flat. The translate is gated behind
      // motion-safe so it is suppressed under prefers-reduced-motion (the
      // globals.css reset neutralizes duration/delay, not transform).
      interactive: {
        true: 'cursor-pointer transition-all duration-200 hover:shadow-lg active:shadow-md motion-safe:hover:-translate-y-0.5 motion-safe:active:translate-y-0',
        false: '',
      },
      padding: {
        none: '',
        sm: 'p-3',
        md: 'p-4',
        lg: 'p-6',
      },
    },
    defaultVariants: {
      variant: 'default',
      hover: false,
      interactive: false,
      padding: 'md',
    },
  }
);

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'elevated' | 'interactive';
  hover?: boolean;
  interactive?: boolean;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  children: React.ReactNode;
}

/**
 * Card component for containing content
 *
 * @example
 * ```tsx
 * <Card variant="elevated" padding="md">
 *   <h3>Card Title</h3>
 *   <p>Card content</p>
 * </Card>
 * ```
 */
export function Card({
  variant = 'default',
  hover = false,
  interactive = false,
  padding = 'md',
  className = '',
  children,
  ...props
}: CardProps) {
  return (
    <div className={cn(cardVariants({ variant, hover, interactive, padding }), className)} {...props}>
      {children}
    </div>
  );
}

/**
 * CardHeader component for card titles
 */
export interface CardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function CardHeader({ className = '', children, ...props }: CardHeaderProps) {
  return (
    <div className={cn('mb-3', className)} {...props}>
      {children}
    </div>
  );
}

/**
 * CardTitle component
 */
export interface CardTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  children: React.ReactNode;
}

export function CardTitle({ className = '', children, ...props }: CardTitleProps) {
  return (
    <h3 className={cn('text-lg font-semibold text-surface-foreground', className)} {...props}>
      {children}
    </h3>
  );
}

/**
 * CardContent component for card body
 */
export interface CardContentProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function CardContent({ className = '', children, ...props }: CardContentProps) {
  return (
    <div className={cn(className)} {...props}>
      {children}
    </div>
  );
}

/**
 * CardFooter component for card actions
 */
export interface CardFooterProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function CardFooter({ className = '', children, ...props }: CardFooterProps) {
  return (
    <div className={cn('mt-4 pt-4 border-t border-border', className)} {...props}>
      {children}
    </div>
  );
}
