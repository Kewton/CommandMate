/**
 * NewFileDialog Unit Tests (Issue #646)
 *
 * Tests for resolveFileName helper function (3 patterns)
 * and basic component rendering.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NewFileDialog, resolveFileName } from '@/components/worktree/NewFileDialog';
import { EDITABLE_EXTENSIONS } from '@/config/editable-extensions';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

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

    it('should return .txt file name as-is - Issue #2506', () => {
      expect(resolveFileName('notes.txt', '.md')).toBe('notes.txt');
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

/**
 * The dropdown is rendered straight from `EDITABLE_EXTENSIONS`, so the
 * acceptance criterion "the new-file dialog offers .txt" is really a statement
 * about that array reaching the DOM in full. Asserting the whole list (rather
 * than only `.txt`) is what keeps the offer and the API's write allow-list from
 * drifting apart: an option the dialog shows but PUT refuses would create a
 * file the user cannot then save.
 */
describe('NewFileDialog extension dropdown', () => {
  function renderDialog() {
    return render(
      <NewFileDialog isOpen parentPath="docs" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
  }

  function optionValues(): string[] {
    return Array.from(
      screen.getByTestId('new-file-ext-select').querySelectorAll('option'),
    ).map((option) => option.value);
  }

  it('offers .txt - Issue #2506', () => {
    renderDialog();

    expect(optionValues()).toContain('.txt');
  });

  it('offers every editable extension, in list order', () => {
    renderDialog();

    expect(optionValues()).toEqual([...EDITABLE_EXTENSIONS]);
  });

  it('still defaults to .md', () => {
    // `.txt` was appended rather than inserted precisely so this stays true.
    renderDialog();

    expect((screen.getByTestId('new-file-ext-select') as HTMLSelectElement).value).toBe('.md');
  });
});
