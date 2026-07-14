/**
 * WorktreeDetailRefactored Mobile Keyboard Layout Tests
 * Issue #1166: Android Chrome composer flies off-screen when the keyboard opens.
 *
 * Root-cause fix (案B): stop lifting a `position: fixed` composer with a JS
 * `translateY`, and instead size the mobile shell to `visualViewport.height`
 * with the composer + tab bar as in-flow flex children docked above the
 * keyboard (the proven FullScreenModal pattern).
 *
 * Approach: source-level verification. WorktreeDetailRefactored is a large
 * component with many contexts/hooks that make full rendering impractical, so —
 * mirroring WorktreeDetailRefactored-mobile-overflow.test.tsx (Issue #548) — we
 * assert on the source to lock in the structural contract of the fix.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('WorktreeDetailRefactored mobile keyboard layout (Issue #1166)', () => {
  const source = fs.readFileSync(
    path.resolve(
      __dirname,
      '../../../../src/components/worktree/WorktreeDetailRefactored.tsx',
    ),
    'utf-8',
  );

  it('sizes the mobile shell to the visible viewport height (visualViewport)', () => {
    expect(source).toContain('useVirtualKeyboard');
    expect(source).toContain('viewportHeight');
    // The shell height follows visualViewport.height, falling back until measured.
    expect(source).toMatch(/height:\s*viewportHeight\s*!=\s*null\s*\?/);
  });

  it('removes the fixed message-input bar and its bottom-offset constants', () => {
    expect(source).not.toContain('MOBILE_MESSAGE_INPUT_BOTTOM');
    expect(source).not.toContain('MOBILE_CONTENT_BOTTOM_PADDING');
    // The composer wrapper is no longer position:fixed.
    expect(source).not.toContain('fixed left-0 right-0');
  });

  it('drops the composer translateY hack (keyboardAware no longer passed)', () => {
    expect(source).not.toContain('keyboardAware');
  });

  it('lays the tab bar out in normal flow via the inFlow variant', () => {
    expect(source).toMatch(/<MobileTabBar[\s\S]*?inFlow[\s\S]*?\/>/);
  });

  it('keeps the scrollable content as the single flex-1 min-h-0 scroller', () => {
    // The content <main> absorbs the remaining space and scrolls internally so
    // the header/tabs/composer/tab bar keep their size when the shell shrinks.
    expect(source).toMatch(/className="flex-1 min-h-0 overflow-y-auto"/);
  });
});
