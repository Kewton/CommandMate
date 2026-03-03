/**
 * Dynamic Import Pattern Verification Tests
 *
 * Verifies that key components use next/dynamic with ssr: false
 * to prevent SSR errors from browser-only libraries (xterm.js, highlight.js).
 *
 * Issue #410: xterm.js and highlight.js dynamic import optimization
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../../../src');

/**
 * Read a source file once and reuse content across all tests in the describe block.
 * Returns file content or throws if file does not exist.
 */
function readSourceFile(relativePath: string): string {
  const filePath = path.join(SRC_ROOT, relativePath);
  return fs.readFileSync(filePath, 'utf-8');
}

describe('Dynamic Import Patterns', () => {
  describe('TerminalComponent in terminal/page.tsx', () => {
    const filePath = path.join(SRC_ROOT, 'app/worktrees/[id]/terminal/page.tsx');
    let content: string;

    beforeAll(() => {
      content = readSourceFile('app/worktrees/[id]/terminal/page.tsx');
    });

    it('should exist as a file', () => {
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('should import next/dynamic', () => {
      expect(content).toContain("import dynamic from 'next/dynamic'");
    });

    it('should NOT have static import of TerminalComponent', () => {
      expect(content).not.toMatch(/import\s*\{[^}]*TerminalComponent[^}]*\}\s*from/);
    });

    it('should use dynamic import with ssr: false for TerminalComponent', () => {
      // Verify the dynamic() call pattern
      expect(content).toContain("import('@/components/Terminal')");
      expect(content).toContain('ssr: false');
      expect(content).toContain('mod.TerminalComponent');
    });

    it('should have a loading component with bg-gray-900 theme', () => {
      expect(content).toContain('bg-gray-900');
      expect(content).toContain('loading');
    });

    it('should import Loader2 from lucide-react', () => {
      expect(content).toContain('Loader2');
      expect(content).toContain('lucide-react');
    });
  });

  describe('MarkdownEditor in WorktreeDetailRefactored.tsx', () => {
    const filePath = path.join(SRC_ROOT, 'components/worktree/WorktreeDetailRefactored.tsx');
    let content: string;

    beforeAll(() => {
      content = readSourceFile('components/worktree/WorktreeDetailRefactored.tsx');
    });

    it('should exist as a file', () => {
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('should import next/dynamic', () => {
      expect(content).toContain("import dynamic from 'next/dynamic'");
    });

    it('should NOT have static import of MarkdownEditor', () => {
      expect(content).not.toMatch(/import\s*\{[^}]*MarkdownEditor[^}]*\}\s*from/);
    });

    it('should use dynamic import with ssr: false for MarkdownEditor', () => {
      // Verify the dynamic() call pattern
      expect(content).toContain("import('@/components/worktree/MarkdownEditor')");
      expect(content).toContain('ssr: false');
      expect(content).toContain('mod.MarkdownEditor');
    });

    it('should have a loading component with bg-white theme', () => {
      expect(content).toContain('bg-white');
      expect(content).toContain('loading');
    });

    it('should import Loader2 from lucide-react', () => {
      expect(content).toContain('Loader2');
      expect(content).toContain('lucide-react');
    });
  });

  describe('Consistent pattern with MermaidCodeBlock reference implementation', () => {
    let mermaidContent: string;
    let terminalContent: string;
    let wdrContent: string;

    beforeAll(() => {
      mermaidContent = readSourceFile('components/worktree/MermaidCodeBlock.tsx');
      terminalContent = readSourceFile('app/worktrees/[id]/terminal/page.tsx');
      wdrContent = readSourceFile('components/worktree/WorktreeDetailRefactored.tsx');
    });

    it('should follow the same .then((mod) => ({ default: mod.Xxx })) pattern', () => {
      // Verify MermaidCodeBlock uses the same pattern as reference
      expect(mermaidContent).toContain("import dynamic from 'next/dynamic'");
      expect(mermaidContent).toContain('ssr: false');
      expect(mermaidContent).toContain('default: mod.MermaidDiagram');

      // Terminal page should use same pattern
      expect(terminalContent).toContain('default: mod.TerminalComponent');

      // WorktreeDetailRefactored should use same pattern
      expect(wdrContent).toContain('default: mod.MarkdownEditor');
    });
  });
});
