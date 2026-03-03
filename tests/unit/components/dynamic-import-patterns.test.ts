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

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../../../src');

describe('Dynamic Import Patterns', () => {
  describe('TerminalComponent in terminal/page.tsx', () => {
    const filePath = path.join(SRC_ROOT, 'app/worktrees/[id]/terminal/page.tsx');
    let content: string;

    it('should exist as a file', () => {
      expect(fs.existsSync(filePath)).toBe(true);
      content = fs.readFileSync(filePath, 'utf-8');
    });

    it('should import next/dynamic', () => {
      content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain("import dynamic from 'next/dynamic'");
    });

    it('should NOT have static import of TerminalComponent', () => {
      content = fs.readFileSync(filePath, 'utf-8');
      expect(content).not.toMatch(/import\s*\{[^}]*TerminalComponent[^}]*\}\s*from/);
    });

    it('should use dynamic import with ssr: false for TerminalComponent', () => {
      content = fs.readFileSync(filePath, 'utf-8');
      // Verify the dynamic() call pattern
      expect(content).toContain("import('@/components/Terminal')");
      expect(content).toContain('ssr: false');
      expect(content).toContain('mod.TerminalComponent');
    });

    it('should have a loading component with bg-gray-900 theme', () => {
      content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('bg-gray-900');
      expect(content).toContain('loading');
    });

    it('should import Loader2 from lucide-react', () => {
      content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('Loader2');
      expect(content).toContain('lucide-react');
    });
  });

  describe('MarkdownEditor in WorktreeDetailRefactored.tsx', () => {
    const filePath = path.join(SRC_ROOT, 'components/worktree/WorktreeDetailRefactored.tsx');
    let content: string;

    it('should exist as a file', () => {
      expect(fs.existsSync(filePath)).toBe(true);
      content = fs.readFileSync(filePath, 'utf-8');
    });

    it('should import next/dynamic', () => {
      content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain("import dynamic from 'next/dynamic'");
    });

    it('should NOT have static import of MarkdownEditor', () => {
      content = fs.readFileSync(filePath, 'utf-8');
      expect(content).not.toMatch(/import\s*\{[^}]*MarkdownEditor[^}]*\}\s*from/);
    });

    it('should use dynamic import with ssr: false for MarkdownEditor', () => {
      content = fs.readFileSync(filePath, 'utf-8');
      // Verify the dynamic() call pattern
      expect(content).toContain("import('@/components/worktree/MarkdownEditor')");
      expect(content).toContain('ssr: false');
      expect(content).toContain('mod.MarkdownEditor');
    });

    it('should have a loading component with bg-white theme', () => {
      content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('bg-white');
      expect(content).toContain('loading');
    });

    it('should import Loader2 from lucide-react', () => {
      content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('Loader2');
      expect(content).toContain('lucide-react');
    });
  });

  describe('Consistent pattern with MermaidCodeBlock reference implementation', () => {
    const mermaidPath = path.join(SRC_ROOT, 'components/worktree/MermaidCodeBlock.tsx');

    it('should follow the same .then((mod) => ({ default: mod.Xxx })) pattern', () => {
      const mermaidContent = fs.readFileSync(mermaidPath, 'utf-8');

      // Verify MermaidCodeBlock uses the same pattern as reference
      expect(mermaidContent).toContain("import dynamic from 'next/dynamic'");
      expect(mermaidContent).toContain('ssr: false');
      expect(mermaidContent).toContain('default: mod.MermaidDiagram');

      // Terminal page should use same pattern
      const terminalContent = fs.readFileSync(
        path.join(SRC_ROOT, 'app/worktrees/[id]/terminal/page.tsx'),
        'utf-8'
      );
      expect(terminalContent).toContain('default: mod.TerminalComponent');

      // WorktreeDetailRefactored should use same pattern
      const wdrContent = fs.readFileSync(
        path.join(SRC_ROOT, 'components/worktree/WorktreeDetailRefactored.tsx'),
        'utf-8'
      );
      expect(wdrContent).toContain('default: mod.MarkdownEditor');
    });
  });
});
