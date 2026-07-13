/**
 * Kbd (Issue #1077)
 *
 * A small keyboard-key badge for rendering shortcut hints (e.g. ⌘, K, esc).
 * Semantic-token based so it follows the theme; reused by the command palette
 * footer / header pill and the chat composer hint (Issue #1080).
 */

import React from 'react';
import { cn } from '@/lib/utils/cn';

export interface KbdProps extends React.HTMLAttributes<HTMLElement> {
  children: React.ReactNode;
}

/**
 * Inline keyboard-key badge.
 *
 * @example
 * ```tsx
 * <Kbd>⌘</Kbd><Kbd>K</Kbd>
 * ```
 */
export function Kbd({ className, children, ...rest }: KbdProps) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-sm border border-border bg-surface px-1',
        'font-mono text-[10px] font-medium leading-none text-muted-foreground',
        className
      )}
      {...rest}
    >
      {children}
    </kbd>
  );
}

export default Kbd;
