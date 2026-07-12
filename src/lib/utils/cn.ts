/**
 * cn - className utility
 *
 * Combines clsx (conditional class composition) with tailwind-merge
 * (conflict resolution / last-wins for Tailwind utilities).
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
