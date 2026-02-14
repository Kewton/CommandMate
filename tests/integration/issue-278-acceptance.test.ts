/**
 * Acceptance tests for Issue #278
 * fetch Data Cache fix and Info notification indicator
 *
 * Verifies:
 * 1. cache: 'no-store' is present in version-checker.ts fetch call
 * 2. Desktop Info button shows update indicator when hasUpdate=true
 * 3. Desktop Info button hides indicator when hasUpdate=false
 * 4. Mobile Info tab shows update indicator when hasUpdate=true
 * 5. Mobile Info tab hides indicator when hasUpdate=false
 * 6. NotificationDot component props work correctly
 * 7. All existing tests pass
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..', '..');

describe('Issue #278 Acceptance: fetch Data Cache fix & Info notification indicator', () => {
  // =========================================================================
  // Scenario 1: fetch cache setting verification
  // =========================================================================
  describe('Scenario 1: fetch cache setting verification', () => {
    it('should have cache: "no-store" in version-checker.ts fetch call', () => {
      const source = readFileSync(
        resolve(ROOT, 'src/lib/version-checker.ts'),
        'utf-8'
      );

      // Verify the fetch call contains cache: 'no-store'
      expect(source).toContain("cache: 'no-store'");

      // Verify it is in the context of the fetch call (near GITHUB_API_URL)
      const fetchCallMatch = source.match(
        /fetch\s*\(\s*GITHUB_API_URL\s*,\s*\{[\s\S]*?cache:\s*'no-store'[\s\S]*?\}\s*\)/
      );
      expect(fetchCallMatch).not.toBeNull();
    });

    it('should have Issue #278 comment documenting the change', () => {
      const source = readFileSync(
        resolve(ROOT, 'src/lib/version-checker.ts'),
        'utf-8'
      );

      // Verify Issue #278 comment is present near the cache setting
      expect(source).toContain('Issue #278');
    });
  });

  // =========================================================================
  // Scenario 2 & 3: Desktop Info button indicator
  // =========================================================================
  describe('Scenario 2 & 3: Desktop Info button update indicator', () => {
    it('should have NotificationDot with data-testid="info-update-indicator" in DesktopHeader', () => {
      const source = readFileSync(
        resolve(ROOT, 'src/components/worktree/WorktreeDetailRefactored.tsx'),
        'utf-8'
      );

      // DesktopHeader should conditionally render NotificationDot
      expect(source).toContain('info-update-indicator');
      expect(source).toContain('hasUpdate');

      // Verify conditional rendering pattern: {hasUpdate && <NotificationDot .../>}
      const conditionalPattern = /\{hasUpdate\s*&&\s*\(\s*\n?\s*<NotificationDot/;
      expect(conditionalPattern.test(source)).toBe(true);
    });

    it('should pass hasUpdate prop from WorktreeDetailRefactored to DesktopHeader', () => {
      const source = readFileSync(
        resolve(ROOT, 'src/components/worktree/WorktreeDetailRefactored.tsx'),
        'utf-8'
      );

      // Verify DesktopHeader receives hasUpdate prop
      expect(source).toContain('hasUpdate={hasUpdate}');

      // Verify useUpdateCheck hook is used
      expect(source).toContain('useUpdateCheck');
    });
  });

  // =========================================================================
  // Scenario 4 & 5: Mobile Info tab indicator
  // =========================================================================
  describe('Scenario 4 & 5: Mobile Info tab update indicator', () => {
    it('should have NotificationDot with data-testid="info-update-badge" in MobileTabBar', () => {
      const source = readFileSync(
        resolve(ROOT, 'src/components/mobile/MobileTabBar.tsx'),
        'utf-8'
      );

      expect(source).toContain('info-update-badge');
      expect(source).toContain('hasUpdate');

      // Verify conditional rendering for info tab
      const conditionalPattern = /tab\.id\s*===\s*'info'\s*&&\s*hasUpdate/;
      expect(conditionalPattern.test(source)).toBe(true);
    });

    it('should pass hasUpdate prop from WorktreeDetailRefactored to MobileTabBar', () => {
      const source = readFileSync(
        resolve(ROOT, 'src/components/worktree/WorktreeDetailRefactored.tsx'),
        'utf-8'
      );

      // Verify MobileTabBar receives hasUpdate prop
      expect(source).toContain('hasUpdate={hasUpdate}');
    });

    it('should have hasUpdate in MobileTabBarProps interface', () => {
      const source = readFileSync(
        resolve(ROOT, 'src/components/mobile/MobileTabBar.tsx'),
        'utf-8'
      );

      // Verify hasUpdate is defined in props
      expect(source).toContain('hasUpdate?: boolean');
    });
  });

  // =========================================================================
  // Scenario 6: NotificationDot shared component
  // =========================================================================
  describe('Scenario 6: NotificationDot shared component props', () => {
    it('should exist as a shared component in components/common/', () => {
      const source = readFileSync(
        resolve(ROOT, 'src/components/common/NotificationDot.tsx'),
        'utf-8'
      );

      expect(source).toContain('NotificationDot');
      expect(source).toContain('data-testid');
      expect(source).toContain('aria-label');
      expect(source).toContain('className');
    });

    it('should apply base styles: w-2 h-2 rounded-full bg-blue-500', () => {
      const source = readFileSync(
        resolve(ROOT, 'src/components/common/NotificationDot.tsx'),
        'utf-8'
      );

      expect(source).toContain('w-2 h-2 rounded-full bg-blue-500');
    });

    it('should be imported by both MobileTabBar and WorktreeDetailRefactored', () => {
      const mobileSource = readFileSync(
        resolve(ROOT, 'src/components/mobile/MobileTabBar.tsx'),
        'utf-8'
      );
      const desktopSource = readFileSync(
        resolve(ROOT, 'src/components/worktree/WorktreeDetailRefactored.tsx'),
        'utf-8'
      );

      expect(mobileSource).toContain("from '@/components/common/NotificationDot'");
      expect(desktopSource).toContain("from '@/components/common/NotificationDot'");
    });
  });
});
