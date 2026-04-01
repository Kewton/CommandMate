/**
 * Unit tests for deep-link-validator
 * Issue #600: UX refresh - isDeepLinkPane() and normalizeDeepLinkPane()
 */

import { describe, it, expect } from 'vitest';
import {
  isDeepLinkPane,
  normalizeDeepLinkPane,
  VALID_PANES,
} from '@/lib/deep-link-validator';

describe('VALID_PANES', () => {
  it('should contain exactly 9 valid pane values', () => {
    expect(VALID_PANES.size).toBe(9);
  });

  it('should contain all expected pane values', () => {
    const expected = ['terminal', 'history', 'git', 'files', 'notes', 'logs', 'agent', 'timer', 'info'];
    for (const pane of expected) {
      expect(VALID_PANES.has(pane as never)).toBe(true);
    }
  });
});

describe('isDeepLinkPane()', () => {
  it('should return true for all valid pane values', () => {
    const validPanes = ['terminal', 'history', 'git', 'files', 'notes', 'logs', 'agent', 'timer', 'info'];
    for (const pane of validPanes) {
      expect(isDeepLinkPane(pane)).toBe(true);
    }
  });

  it('should return false for invalid pane values', () => {
    expect(isDeepLinkPane('invalid')).toBe(false);
    expect(isDeepLinkPane('')).toBe(false);
    expect(isDeepLinkPane('Terminal')).toBe(false);
    expect(isDeepLinkPane('HISTORY')).toBe(false);
  });

  it('should return false for XSS attempt values', () => {
    expect(isDeepLinkPane('<script>alert(1)</script>')).toBe(false);
    expect(isDeepLinkPane('javascript:alert(1)')).toBe(false);
    expect(isDeepLinkPane('terminal" onclick="alert(1)')).toBe(false);
  });

  it('should return false for values with whitespace', () => {
    expect(isDeepLinkPane(' terminal')).toBe(false);
    expect(isDeepLinkPane('terminal ')).toBe(false);
    expect(isDeepLinkPane(' ')).toBe(false);
  });
});

describe('normalizeDeepLinkPane()', () => {
  it('should return the value when it is a valid pane', () => {
    expect(normalizeDeepLinkPane('terminal')).toBe('terminal');
    expect(normalizeDeepLinkPane('history')).toBe('history');
    expect(normalizeDeepLinkPane('git')).toBe('git');
    expect(normalizeDeepLinkPane('files')).toBe('files');
    expect(normalizeDeepLinkPane('notes')).toBe('notes');
    expect(normalizeDeepLinkPane('logs')).toBe('logs');
    expect(normalizeDeepLinkPane('agent')).toBe('agent');
    expect(normalizeDeepLinkPane('timer')).toBe('timer');
    expect(normalizeDeepLinkPane('info')).toBe('info');
  });

  it('should fall back to "terminal" for invalid values', () => {
    expect(normalizeDeepLinkPane('invalid')).toBe('terminal');
    expect(normalizeDeepLinkPane('')).toBe('terminal');
    expect(normalizeDeepLinkPane('unknown')).toBe('terminal');
  });

  it('should fall back to "terminal" for null', () => {
    expect(normalizeDeepLinkPane(null)).toBe('terminal');
  });

  it('should fall back to "terminal" for undefined', () => {
    expect(normalizeDeepLinkPane(undefined)).toBe('terminal');
  });

  it('should fall back to "terminal" for XSS attempts', () => {
    expect(normalizeDeepLinkPane('<script>alert(1)</script>')).toBe('terminal');
  });
});
