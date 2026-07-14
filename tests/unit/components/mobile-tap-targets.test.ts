/**
 * Mobile tap-target guard (Issue #1127)
 *
 * The two densely-packed tab rows called out in the issue — the mobile
 * agent-instance tabs (WorktreeDetailRefactored) and the History sub-tabs
 * (WorktreeDetailMobile) — live inside heavy containers that are impractical to
 * render in isolation, so their ≥44px hit-area styling is asserted at the source
 * level (same approach as motion-foundation.test.ts). MobileTabBar's equivalent
 * styling is covered by a render test in MobileTabBar.test.tsx.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const root = process.cwd();

function read(relative: string): string {
  return readFileSync(path.join(root, relative), 'utf8');
}

describe('Mobile tap targets ≥44px (Issue #1127)', () => {
  it('agent-instance tabs guarantee a ≥44px tap target', () => {
    const src = read('src/components/worktree/WorktreeDetailRefactored.tsx');
    // The instance tab keeps its text-xs visual but gains a 44px hit area.
    expect(src).toContain('whitespace-nowrap min-h-[44px] px-1.5 py-1 font-medium text-xs');
    expect(src).toContain('touch-manipulation');
  });

  it('History sub-tabs guarantee a ≥44px tap target', () => {
    const src = read('src/components/worktree/WorktreeDetailMobile.tsx');
    // Both Message and Git sub-tabs share the same 44px hit-area styling.
    const matches = src.match(
      /flex-1 min-h-\[44px\] px-3 py-1\.5 text-xs font-medium transition-colors touch-manipulation/g
    );
    expect(matches).not.toBeNull();
    expect(matches?.length).toBe(2);
  });
});
