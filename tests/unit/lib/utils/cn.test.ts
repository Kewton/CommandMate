/**
 * Tests for cn() className utility (Issue #1042)
 */

import { describe, it, expect } from 'vitest';
import { cn } from '@/lib/utils/cn';

describe('cn', () => {
  it('merges conflicting tailwind classes with last-wins (tailwind-merge)', () => {
    expect(cn('p-2 p-4')).toBe('p-4');
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });

  it('keeps non-conflicting classes', () => {
    expect(cn('px-2', 'py-4')).toBe('px-2 py-4');
  });

  it('resolves conflicts across separate arguments (override wins)', () => {
    expect(cn('text-gray-700', 'text-white')).toBe('text-white');
  });

  it('drops falsy / conditional values', () => {
    expect(cn('base', false && 'hidden', undefined, null, 'shown')).toBe('base shown');
  });

  it('applies conditional classes from objects', () => {
    expect(cn('base', { active: true, disabled: false })).toBe('base active');
  });

  it('flattens array inputs', () => {
    expect(cn(['a', 'b'], 'c')).toBe('a b c');
  });

  it('returns an empty string for no meaningful input', () => {
    expect(cn('', false, undefined)).toBe('');
  });
});
