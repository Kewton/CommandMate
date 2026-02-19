/**
 * Tests for prompt-key utility
 * Issue #306: Shared prompt key generation for deduplication
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { generatePromptKey } from '@/lib/prompt-key';

describe('generatePromptKey', () => {
  it('should generate key from type and question', () => {
    const key = generatePromptKey({ type: 'yes_no', question: 'Continue?' });
    expect(key).toBe('yes_no:Continue?');
  });

  it('should generate different keys for different prompts', () => {
    const key1 = generatePromptKey({ type: 'yes_no', question: 'Continue?' });
    const key2 = generatePromptKey({ type: 'multiple_choice', question: 'Select option' });
    expect(key1).not.toBe(key2);
  });

  it('should generate different keys when only type differs', () => {
    const key1 = generatePromptKey({ type: 'yes_no', question: 'Continue?' });
    const key2 = generatePromptKey({ type: 'multiple_choice', question: 'Continue?' });
    expect(key1).not.toBe(key2);
  });

  it('should generate different keys when only question differs', () => {
    const key1 = generatePromptKey({ type: 'yes_no', question: 'Continue?' });
    const key2 = generatePromptKey({ type: 'yes_no', question: 'Are you sure?' });
    expect(key1).not.toBe(key2);
  });

  it('should handle empty strings', () => {
    const key = generatePromptKey({ type: '', question: '' });
    expect(key).toBe(':');
  });
});
