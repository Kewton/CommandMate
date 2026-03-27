/**
 * WorktreeDetailRefactored Mobile Overflow Tests
 * Issue #548: Mobile file list scroll fix
 *
 * Verifies that the mobile layout main container has correct CSS classes
 * for enabling vertical scrolling of file tree content.
 *
 * Approach: Source-level verification
 * WorktreeDetailRefactored is a large component with many dependencies
 * (contexts, hooks, API calls) that make full rendering impractical for
 * a CSS-only fix. Instead, we parse the source to verify the <main>
 * element wrapping <MobileContent> has the correct className.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('WorktreeDetailRefactored mobile main container (Issue #548)', () => {
  const sourceFilePath = path.resolve(
    __dirname,
    '../../../../src/components/worktree/WorktreeDetailRefactored.tsx'
  );
  const source = fs.readFileSync(sourceFilePath, 'utf-8');

  // Locate the mobile layout section by finding the <main> element that
  // directly precedes <MobileContent. This is more resilient than splitting
  // on "if (!isMobile)" which depends on the exact number of occurrences.
  const mobileContentIndex = source.indexOf('<MobileContent');
  const sectionBeforeMobileContent = source.slice(0, mobileContentIndex);

  // Find the last <main className="..."> before <MobileContent
  const mainMatches = [
    ...sectionBeforeMobileContent.matchAll(/<main\s+className="([^"]+)"/g),
  ];
  const lastMainMatch = mainMatches.length > 0 ? mainMatches[mainMatches.length - 1] : null;
  const mainClassName = lastMainMatch?.[1] ?? '';

  it('should find the mobile <main> element wrapping MobileContent', () => {
    expect(mobileContentIndex).toBeGreaterThan(-1);
    expect(lastMainMatch).not.toBeNull();
    expect(mainClassName.length).toBeGreaterThan(0);
  });

  it('should have overflow-y-auto class for vertical scrolling', () => {
    expect(mainClassName).toContain('overflow-y-auto');
  });

  it('should NOT have overflow-hidden class', () => {
    expect(mainClassName).not.toContain('overflow-hidden');
  });

  it('should NOT have pb-32 class (dead code removed)', () => {
    expect(mainClassName).not.toContain('pb-32');
  });

  it('should have flex-1 class for flex sizing', () => {
    expect(mainClassName).toContain('flex-1');
  });
});
