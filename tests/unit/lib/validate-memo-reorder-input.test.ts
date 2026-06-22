/**
 * Unit tests for validateMemoReorderInput (Issue #944)
 *
 * The PATCH /api/worktrees/:id/memos handler delegates domain validation to this
 * pure helper because reorderMemos itself performs no validation (callers are
 * responsible). Covers: valid reorder, count mismatch, other-worktree IDs,
 * nonexistent IDs, duplicates, non-array input, and non-string elements.
 */

import { describe, it, expect } from 'vitest';
import { validateMemoReorderInput } from '@/lib/memo-reorder-validator';
import type { WorktreeMemo } from '@/types/models';

/** Build a minimal WorktreeMemo for the given id. */
function memo(id: string, position: number): WorktreeMemo {
  return {
    id,
    worktreeId: 'worktree-1',
    title: `Memo ${id}`,
    content: '',
    position,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-02'),
  };
}

describe('validateMemoReorderInput', () => {
  const existing: WorktreeMemo[] = [memo('a', 0), memo('b', 1), memo('c', 2)];

  it('accepts a valid full reorder (same id set, different order)', () => {
    const result = validateMemoReorderInput(['c', 'a', 'b'], existing);
    expect(result.valid).toBe(true);
  });

  it('accepts the identical order', () => {
    const result = validateMemoReorderInput(['a', 'b', 'c'], existing);
    expect(result.valid).toBe(true);
  });

  it('rejects when memoIds is not an array', () => {
    const result = validateMemoReorderInput('a,b,c' as unknown as string[], existing);
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects when an element is not a string', () => {
    const result = validateMemoReorderInput(['a', 2 as unknown as string, 'c'], existing);
    expect(result.valid).toBe(false);
  });

  it('rejects when the count does not match the existing memo count', () => {
    const result = validateMemoReorderInput(['a', 'b'], existing);
    expect(result.valid).toBe(false);
  });

  it('rejects duplicate ids', () => {
    const result = validateMemoReorderInput(['a', 'a', 'b'], existing);
    expect(result.valid).toBe(false);
  });

  it('rejects an id that does not belong to the worktree (other worktree / nonexistent)', () => {
    const result = validateMemoReorderInput(['a', 'b', 'z'], existing);
    expect(result.valid).toBe(false);
  });

  it('rejects when an existing id is missing even if count matches via a foreign id', () => {
    // count matches (3) but 'c' replaced by foreign 'x'
    const result = validateMemoReorderInput(['a', 'b', 'x'], existing);
    expect(result.valid).toBe(false);
  });
});
