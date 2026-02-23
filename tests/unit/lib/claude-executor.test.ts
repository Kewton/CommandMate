/**
 * Tests for claude-executor.ts
 * Issue #294: Claude CLI executor for scheduled executions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  truncateOutput,
  buildCliArgs,
  executeClaudeCommand,
  MAX_OUTPUT_SIZE,
  MAX_STORED_OUTPUT_SIZE,
  EXECUTION_TIMEOUT_MS,
  MAX_MESSAGE_LENGTH,
  ALLOWED_CLI_TOOLS,
  getActiveProcesses,
} from '../../../src/lib/claude-executor';
import { SENSITIVE_ENV_KEYS } from '../../../src/lib/env-sanitizer';

describe('claude-executor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Clear active processes
    globalThis.__scheduleActiveProcesses = undefined;
  });

  afterEach(() => {
    globalThis.__scheduleActiveProcesses = undefined;
  });

  describe('constants', () => {
    it('should have MAX_OUTPUT_SIZE = 1MB', () => {
      expect(MAX_OUTPUT_SIZE).toBe(1 * 1024 * 1024);
    });

    it('should have MAX_STORED_OUTPUT_SIZE = 100KB', () => {
      expect(MAX_STORED_OUTPUT_SIZE).toBe(100 * 1024);
    });

    it('should have EXECUTION_TIMEOUT_MS = 5 minutes', () => {
      expect(EXECUTION_TIMEOUT_MS).toBe(5 * 60 * 1000);
    });

    it('should have MAX_MESSAGE_LENGTH = 10000', () => {
      expect(MAX_MESSAGE_LENGTH).toBe(10000);
    });
  });

  describe('truncateOutput', () => {
    it('should not truncate output within limits', () => {
      const output = 'Hello, world!';
      expect(truncateOutput(output)).toBe(output);
    });

    it('should truncate output exceeding MAX_STORED_OUTPUT_SIZE', () => {
      const largeOutput = 'x'.repeat(MAX_STORED_OUTPUT_SIZE + 1000);
      const result = truncateOutput(largeOutput);
      expect(result).toContain('--- Output truncated');
      expect(Buffer.byteLength(result, 'utf-8')).toBeLessThan(
        MAX_STORED_OUTPUT_SIZE + 100 // truncation notice overhead
      );
    });

    it('should handle empty string', () => {
      expect(truncateOutput('')).toBe('');
    });

    it('should preserve output at exactly MAX_STORED_OUTPUT_SIZE', () => {
      // Use ASCII to ensure 1 byte per char
      const exactOutput = 'a'.repeat(MAX_STORED_OUTPUT_SIZE);
      expect(truncateOutput(exactOutput)).toBe(exactOutput);
    });

    it('should handle multi-byte characters correctly', () => {
      // Japanese characters are 3 bytes each in UTF-8
      // Create a string that exceeds MAX_STORED_OUTPUT_SIZE in bytes
      const japaneseChar = '\u3042'; // hiragana 'a' = 3 bytes
      const charCount = Math.ceil(MAX_STORED_OUTPUT_SIZE / 3) + 100;
      const multiByteOutput = japaneseChar.repeat(charCount);
      const result = truncateOutput(multiByteOutput);
      expect(result).toContain('--- Output truncated');
    });

    it('should include truncation notice with size limit info', () => {
      const largeOutput = 'x'.repeat(MAX_STORED_OUTPUT_SIZE + 500);
      const result = truncateOutput(largeOutput);
      expect(result).toContain('100KB');
    });
  });

  describe('getActiveProcesses', () => {
    it('should return a Map', () => {
      const processes = getActiveProcesses();
      expect(processes).toBeInstanceOf(Map);
    });

    it('should return the same instance on subsequent calls', () => {
      const first = getActiveProcesses();
      const second = getActiveProcesses();
      expect(first).toBe(second);
    });

    it('should persist across calls (globalThis)', () => {
      const processes = getActiveProcesses();
      processes.set(12345, {} as import('child_process').ChildProcess);

      const processes2 = getActiveProcesses();
      expect(processes2.has(12345)).toBe(true);
    });
  });

  describe('buildCliArgs', () => {
    it('should build claude args with -p, --output-format, --permission-mode', () => {
      const args = buildCliArgs('hello', 'claude');
      expect(args).toEqual(['-p', 'hello', '--output-format', 'text', '--permission-mode', 'acceptEdits']);
    });

    it('should build codex args with exec and --sandbox', () => {
      const args = buildCliArgs('hello', 'codex');
      expect(args).toEqual(['exec', 'hello', '--sandbox', 'workspace-write']);
    });

    it('should build fallback args with -p for unknown tools', () => {
      const args = buildCliArgs('hello', 'gemini');
      expect(args).toEqual(['-p', 'hello']);
    });
  });

  describe('ALLOWED_CLI_TOOLS', () => {
    it('should contain claude and codex', () => {
      expect(ALLOWED_CLI_TOOLS.has('claude')).toBe(true);
      expect(ALLOWED_CLI_TOOLS.has('codex')).toBe(true);
    });

    it('should not contain arbitrary tools', () => {
      expect(ALLOWED_CLI_TOOLS.has('bash')).toBe(false);
      expect(ALLOWED_CLI_TOOLS.has('sh')).toBe(false);
    });
  });

  describe('executeClaudeCommand - cliToolId validation', () => {
    it('should reject invalid cliToolId without executing', async () => {
      const result = await executeClaudeCommand('hello', '/tmp', 'bash');
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Invalid CLI tool');
    });
  });

  describe('SENSITIVE_ENV_KEYS exclusion', () => {
    it('should use env-sanitizer to exclude sensitive keys', () => {
      // This test verifies the SENSITIVE_ENV_KEYS constant is properly defined
      // The actual env sanitization is tested in env-sanitizer.test.ts
      expect(SENSITIVE_ENV_KEYS).toContain('CLAUDECODE');
      expect(SENSITIVE_ENV_KEYS).toContain('CM_AUTH_TOKEN_HASH');
      expect(SENSITIVE_ENV_KEYS).toContain('CM_DB_PATH');
    });
  });
});
