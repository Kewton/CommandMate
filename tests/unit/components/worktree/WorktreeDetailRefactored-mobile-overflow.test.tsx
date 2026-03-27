/**
 * WorktreeDetailRefactored Mobile Overflow Tests
 * Issue #548: Mobile file list scroll fix
 *
 * Verifies that the mobile layout main container has correct CSS classes
 * for enabling vertical scrolling of file tree content.
 *
 * Since WorktreeDetailRefactored is a complex component with many dependencies,
 * we verify the source code contains the correct className for the mobile
 * main container element. This is a practical approach for CSS-only fixes.
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

  // Find the mobile main container className
  // The pattern is: <main followed by className="..." in the mobile layout section
  // The mobile layout is after the second `if (!isMobile)` desktop block (render section)
  const parts = source.split('if (!isMobile)');
  // parts[0] = before first occurrence, parts[1] = after first (useEffect), parts[2] = after second (render)
  const mobileSection = parts[2];

  // Extract the className of the <main element in the mobile section
  const mainClassNameMatch = mobileSection?.match(
    /<main\s+className="([^"]+)"/
  );
  const mainClassName = mainClassNameMatch?.[1] ?? '';

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
