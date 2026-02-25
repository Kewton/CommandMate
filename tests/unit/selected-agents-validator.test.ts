/**
 * Unit tests for selected-agents-validator
 * Issue #368: Agent settings tab - validator functions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseSelectedAgents,
  validateSelectedAgentsInput,
  validateAgentsPair,
  DEFAULT_SELECTED_AGENTS,
} from '@/lib/selected-agents-validator';

describe('validateAgentsPair()', () => {
  it('should return valid for a correct pair of tool IDs', () => {
    const result = validateAgentsPair(['claude', 'codex']);
    expect(result.valid).toBe(true);
    expect(result.value).toEqual(['claude', 'codex']);
  });

  it('should return valid for all valid CLI tool combinations', () => {
    const result1 = validateAgentsPair(['claude', 'gemini']);
    expect(result1.valid).toBe(true);
    expect(result1.value).toEqual(['claude', 'gemini']);

    const result2 = validateAgentsPair(['codex', 'gemini']);
    expect(result2.valid).toBe(true);
    expect(result2.value).toEqual(['codex', 'gemini']);

    const result3 = validateAgentsPair(['vibe-local', 'claude']);
    expect(result3.valid).toBe(true);
    expect(result3.value).toEqual(['vibe-local', 'claude']);
  });

  it('should return invalid for arrays with length != 2', () => {
    const result1 = validateAgentsPair([]);
    expect(result1.valid).toBe(false);
    expect(result1.error).toContain('2 elements');

    const result2 = validateAgentsPair(['claude']);
    expect(result2.valid).toBe(false);

    const result3 = validateAgentsPair(['claude', 'codex', 'gemini']);
    expect(result3.valid).toBe(false);
  });

  it('should return invalid for non-string elements', () => {
    const result = validateAgentsPair([123, 'codex']);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid CLI tool ID');
  });

  it('should return invalid for unknown tool IDs', () => {
    const result = validateAgentsPair(['claude', 'unknown']);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid CLI tool ID');
  });

  it('should return invalid for duplicate tool IDs', () => {
    const result = validateAgentsPair(['claude', 'claude']);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Duplicate');
  });
});

describe('parseSelectedAgents()', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it('should return default for null input', () => {
    const result = parseSelectedAgents(null);
    expect(result).toEqual(DEFAULT_SELECTED_AGENTS);
  });

  it('should return default for empty string input', () => {
    const result = parseSelectedAgents('');
    expect(result).toEqual(DEFAULT_SELECTED_AGENTS);
  });

  it('should parse valid JSON array', () => {
    const result = parseSelectedAgents('["claude","codex"]');
    expect(result).toEqual(['claude', 'codex']);
  });

  it('should parse valid JSON with vibe-local', () => {
    const result = parseSelectedAgents('["vibe-local","gemini"]');
    expect(result).toEqual(['vibe-local', 'gemini']);
  });

  it('should return default and warn for invalid JSON', () => {
    const result = parseSelectedAgents('not-json');
    expect(result).toEqual(DEFAULT_SELECTED_AGENTS);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[selected-agents]')
    );
  });

  it('should return default and warn for non-array JSON', () => {
    const result = parseSelectedAgents('{"key":"value"}');
    expect(result).toEqual(DEFAULT_SELECTED_AGENTS);
    expect(consoleWarnSpy).toHaveBeenCalled();
  });

  it('should return default and warn for array with wrong length', () => {
    const result = parseSelectedAgents('["claude"]');
    expect(result).toEqual(DEFAULT_SELECTED_AGENTS);
    expect(consoleWarnSpy).toHaveBeenCalled();
  });

  it('should return default and warn for invalid tool IDs', () => {
    const result = parseSelectedAgents('["claude","invalid"]');
    expect(result).toEqual(DEFAULT_SELECTED_AGENTS);
    expect(consoleWarnSpy).toHaveBeenCalled();
  });

  it('should return default and warn for duplicate tool IDs', () => {
    const result = parseSelectedAgents('["claude","claude"]');
    expect(result).toEqual(DEFAULT_SELECTED_AGENTS);
    expect(consoleWarnSpy).toHaveBeenCalled();
  });

  it('should sanitize raw value in warn log (no ANSI, no newlines, truncated)', () => {
    const maliciousRaw = '\x1b[31m' + 'a'.repeat(200) + '\n\rend';
    parseSelectedAgents(maliciousRaw);
    expect(consoleWarnSpy).toHaveBeenCalled();
    const warnMessage = consoleWarnSpy.mock.calls[0][0] as string;
    // Should not contain ANSI escape codes
    expect(warnMessage).not.toContain('\x1b[');
    // Should not contain newlines
    expect(warnMessage).not.toContain('\n');
    expect(warnMessage).not.toContain('\r');
    // Should be truncated (raw part max 100 chars)
    // The entire message should be reasonable length
    expect(warnMessage.length).toBeLessThan(300);
  });
});

describe('validateSelectedAgentsInput()', () => {
  it('should return valid for correct input', () => {
    const result = validateSelectedAgentsInput(['claude', 'codex']);
    expect(result.valid).toBe(true);
    expect(result.value).toEqual(['claude', 'codex']);
  });

  it('should return invalid for non-array input', () => {
    const result = validateSelectedAgentsInput('claude,codex');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('array of 2 elements');
  });

  it('should return invalid for null input', () => {
    const result = validateSelectedAgentsInput(null);
    expect(result.valid).toBe(false);
  });

  it('should return invalid for array with wrong length', () => {
    const result = validateSelectedAgentsInput(['claude']);
    expect(result.valid).toBe(false);
  });

  it('should return invalid for invalid tool IDs', () => {
    const result = validateSelectedAgentsInput(['claude', 'notreal']);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid CLI tool ID');
  });

  it('should return invalid for duplicate tool IDs', () => {
    const result = validateSelectedAgentsInput(['codex', 'codex']);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Duplicate');
  });

  it('should return valid for vibe-local combination', () => {
    const result = validateSelectedAgentsInput(['vibe-local', 'claude']);
    expect(result.valid).toBe(true);
    expect(result.value).toEqual(['vibe-local', 'claude']);
  });
});
