/**
 * Input Component
 * Native <input> element styled with semantic design tokens (Issue #1046).
 * Mirrors the legacy `.input` utility as its default look.
 */

import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils/cn';

const inputVariants = cva(
  'flex w-full rounded-md border border-input bg-surface dark:bg-surface-2 text-surface-foreground shadow-sm ' +
    'placeholder:text-muted-foreground ' +
    'focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring ' +
    'disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      inputSize: {
        sm: 'h-8 px-2.5 py-1 text-sm',
        md: 'px-3 py-2 text-sm',
        lg: 'px-4 py-2.5 text-base',
      },
    },
    defaultVariants: {
      inputSize: 'md',
    },
  }
);

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'>,
    VariantProps<typeof inputVariants> {}

/**
 * Input component
 *
 * @example
 * ```tsx
 * <Input placeholder="Search..." value={value} onChange={onChange} />
 * ```
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, inputSize, type = 'text', ...props }, ref) => {
    return (
      <input
        ref={ref}
        type={type}
        className={cn(inputVariants({ inputSize }), className)}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

export { inputVariants };
