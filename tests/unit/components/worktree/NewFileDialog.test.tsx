/**
 * NewFileDialog Unit Tests (Issue #646)
 *
 * Tests for resolveFileName helper function (3 patterns)
 * and basic component rendering.
 */

import { describe, it, expect } from 'vitest';
import { resolveFileName } from '@/components/worktree/NewFileDialog';

describe('resolveFileName', () => {
  describe('(a) file name has an EDITABLE_EXTENSIONS extension', () => {
    it('should return .md file name as-is', () => {
      expect(resolveFileName('readme.md', '.yaml')).toBe('readme.md');
    });

    it('should return .yaml file name as-is', () => {
      expect(resolveFileName('config.yaml', '.md')).toBe('config.yaml');
    });

    it('should return .yml file name as-is', () => {
      expect(resolveFileName('data.yml', '.html')).toBe('data.yml');
    });

    it('should return .html file name as-is', () => {
      expect(resolveFileName('page.html', '.md')).toBe('page.html');
    });

    it('should return .htm file name as-is', () => {
      expect(resolveFileName('index.htm', '.md')).toBe('index.htm');
    });

    it('should be case-insensitive for extension matching', () => {
      expect(resolveFileName('readme.MD', '.yaml')).toBe('readme.MD');
    });
  });

  describe('(b) file name has no extension', () => {
    it('should append selected extension when no dot present', () => {
      expect(resolveFileName('document', '.md')).toBe('document.md');
    });

    it('should append selected extension for .yaml', () => {
      expect(resolveFileName('config', '.yaml')).toBe('config.yaml');
    });

    it('should append selected extension for .yml', () => {
      expect(resolveFileName('data', '.yml')).toBe('data.yml');
    });

    it('should append selected extension for .html', () => {
      expect(resolveFileName('page', '.html')).toBe('page.html');
    });

    it('should handle dotfiles (first character is dot) by appending extension', () => {
      expect(resolveFileName('.gitignore', '.md')).toBe('.gitignore.md');
    });
  });

  describe('(c) file name has a non-editable extension', () => {
    it('should return file name as-is for .js extension', () => {
      expect(resolveFileName('script.js', '.md')).toBe('script.js');
    });

    it('should return file name as-is for .ts extension', () => {
      expect(resolveFileName('module.ts', '.yaml')).toBe('module.ts');
    });

    it('should return file name as-is for .json extension', () => {
      expect(resolveFileName('config.json', '.yaml')).toBe('config.json');
    });

    it('should return file name as-is for .txt extension', () => {
      expect(resolveFileName('notes.txt', '.md')).toBe('notes.txt');
    });
  });

  describe('edge cases', () => {
    it('should return empty string for empty input', () => {
      expect(resolveFileName('', '.md')).toBe('');
    });

    it('should return empty string for whitespace-only input', () => {
      expect(resolveFileName('   ', '.md')).toBe('');
    });

    it('should trim whitespace from file name', () => {
      expect(resolveFileName('  document  ', '.md')).toBe('document.md');
    });

    it('should handle file names with multiple dots', () => {
      expect(resolveFileName('my.config.yaml', '.md')).toBe('my.config.yaml');
    });

    it('should handle file names with path-like dots but no extension', () => {
      expect(resolveFileName('v1.0.0', '.md')).toBe('v1.0.0');
    });
  });
});
