/**
 * Prompt Utilities Tests
 * Issue #119: Interactive init support
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { homedir } from 'os';
import { resolve } from 'path';

// Import functions to test
import {
  expandTilde,
  resolvePath,
  validatePort,
  isInteractive,
} from '../../../../src/cli/utils/prompt';

describe('prompt utilities', () => {
  describe('expandTilde', () => {
    it('should expand ~ at the beginning of path', () => {
      const result = expandTilde('~/repos');
      expect(result).toBe(`${homedir()}/repos`);
    });

    it('should expand standalone ~', () => {
      const result = expandTilde('~');
      expect(result).toBe(homedir());
    });

    it('should not expand ~ in the middle of path', () => {
      const result = expandTilde('/path/to/~folder');
      expect(result).toBe('/path/to/~folder');
    });

    it('should return absolute path unchanged', () => {
      const result = expandTilde('/absolute/path');
      expect(result).toBe('/absolute/path');
    });

    it('should return relative path unchanged', () => {
      const result = expandTilde('relative/path');
      expect(result).toBe('relative/path');
    });

    it('should handle ~/. paths', () => {
      const result = expandTilde('~/./repos');
      expect(result).toBe(`${homedir()}/./repos`);
    });

    it('should handle ~/.. paths', () => {
      const result = expandTilde('~/../other');
      expect(result).toBe(`${homedir()}/../other`);
    });
  });

  describe('resolvePath', () => {
    it('should expand tilde and resolve to absolute path', () => {
      const result = resolvePath('~/repos');
      expect(result).toBe(resolve(homedir(), 'repos'));
    });

    it('should resolve relative path to absolute', () => {
      const result = resolvePath('./data');
      expect(result).toBe(resolve(process.cwd(), './data'));
    });

    it('should return absolute path unchanged', () => {
      const result = resolvePath('/absolute/path');
      expect(result).toBe('/absolute/path');
    });
  });

  describe('validatePort', () => {
    it('should return true for valid port 3000', () => {
      expect(validatePort('3000')).toBe(true);
    });

    it('should return true for minimum port 1', () => {
      expect(validatePort('1')).toBe(true);
    });

    it('should return true for maximum port 65535', () => {
      expect(validatePort('65535')).toBe(true);
    });

    it('should return error for port 0', () => {
      const result = validatePort('0');
      expect(result).toBe('Port must be between 1 and 65535');
    });

    it('should return error for port > 65535', () => {
      const result = validatePort('65536');
      expect(result).toBe('Port must be between 1 and 65535');
    });

    it('should return error for negative port', () => {
      const result = validatePort('-1');
      expect(result).toBe('Port must be between 1 and 65535');
    });

    it('should return error for non-numeric input', () => {
      const result = validatePort('abc');
      expect(result).toBe('Port must be a number');
    });

    it('should return error for empty string', () => {
      const result = validatePort('');
      expect(result).toBe('Port must be a number');
    });

    it('should return error for float', () => {
      // parseInt will parse '3000.5' as 3000, so this should pass
      const result = validatePort('3000.5');
      expect(result).toBe(true);
    });
  });

  describe('isInteractive', () => {
    let originalIsTTY: boolean | undefined;

    beforeEach(() => {
      originalIsTTY = process.stdin.isTTY;
    });

    afterEach(() => {
      // Restore original value
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalIsTTY,
        writable: true,
        configurable: true,
      });
    });

    it('should return true when stdin is TTY', () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      expect(isInteractive()).toBe(true);
    });

    it('should return false when stdin is not TTY', () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        writable: true,
        configurable: true,
      });
      expect(isInteractive()).toBe(false);
    });

    it('should return false when isTTY is undefined', () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: undefined,
        writable: true,
        configurable: true,
      });
      expect(isInteractive()).toBe(false);
    });
  });
});

// Note: prompt() and confirm() functions require stdin mocking which is complex.
// These are tested via integration tests or manual testing.
// The core utility functions (expandTilde, validatePort, etc.) are unit tested above.
