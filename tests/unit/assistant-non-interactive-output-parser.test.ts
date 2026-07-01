/**
 * Tests for non-interactive assistant output parsers.
 * Issue #990 (Phase C): Antigravity (`agy -p`) plain-text output parsing.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  parseAntigravityPlainOutput,
  parseClaudeStructuredOutput,
} from '@/lib/assistant/non-interactive-output-parser';

describe('parseAntigravityPlainOutput', () => {
  it('returns the trimmed plain-text stdout as the final message', () => {
    const result = parseAntigravityPlainOutput('PONG\n');
    expect(result.finalMessage).toBe('PONG');
    expect(result.resumeSessionId).toBeNull();
  });

  it('preserves multi-line response bodies (only outer whitespace trimmed)', () => {
    const result = parseAntigravityPlainOutput('  line 1\nline 2\n\n');
    expect(result.finalMessage).toBe('line 1\nline 2');
    expect(result.resumeSessionId).toBeNull();
  });

  it('defensively strips ANSI control sequences', () => {
    const result = parseAntigravityPlainOutput('[32mhello[0m');
    expect(result.finalMessage).toBe('hello');
  });

  it('returns null finalMessage for empty or whitespace-only output', () => {
    expect(parseAntigravityPlainOutput('').finalMessage).toBeNull();
    expect(parseAntigravityPlainOutput('   \n  ').finalMessage).toBeNull();
  });

  it('never returns a resume session id (print mode is stateless)', () => {
    const result = parseAntigravityPlainOutput('some response text');
    expect(result.resumeSessionId).toBeNull();
  });

  it('does not attempt JSON parsing (plain text with braces is passed through)', () => {
    const result = parseAntigravityPlainOutput('{not valid json but plain text}');
    expect(result.finalMessage).toBe('{not valid json but plain text}');
  });
});

describe('parseClaudeStructuredOutput (regression: JSON path unaffected)', () => {
  it('extracts the final message from a structured JSON line', () => {
    const result = parseClaudeStructuredOutput('{"result":"claude answer"}');
    expect(result.finalMessage).toBe('claude answer');
  });
});
