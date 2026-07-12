/**
 * Skeleton Component
 * Loading placeholder with a pulse animation (Issue #1046).
 */

import React from 'react';
import { cn } from '@/lib/utils/cn';

export type SkeletonProps = React.HTMLAttributes<HTMLDivElement>;

/**
 * Skeleton loading placeholder
 *
 * @example
 * ```tsx
 * <Skeleton className="h-4 w-32" />
 * ```
 */
export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-muted', className)}
      aria-hidden="true"
      {...props}
    />
  );
}
