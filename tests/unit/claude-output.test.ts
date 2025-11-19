import { describe, it, expect } from 'vitest';
import { parseClaudeOutput } from '@/lib/claude-output';

describe('parseClaudeOutput', () => {
  it('extracts log filename, request id, and summary', () => {
    const output = `
───────────────────────────────────────────────────────────────
📄 Session log: /home/user/.claude/logs/2025-01-17_10-30-45_abc123.jsonl
Request ID: abc123
Summary: Implemented all requested changes
───────────────────────────────────────────────────────────────
`; // Keep ASCII separators for snapshot stability

    const result = parseClaudeOutput(output);

    expect(result.content).toBe(output);
    expect(result.logFileName).toBe('2025-01-17_10-30-45_abc123.jsonl');
    expect(result.requestId).toBe('abc123');
    expect(result.summary).toBe('Implemented all requested changes');
  });

  it('handles output without metadata gracefully', () => {
    const output = 'Plain response without any metadata lines';
    const result = parseClaudeOutput(output);

    expect(result.summary).toBeUndefined();
    expect(result.logFileName).toBeUndefined();
    expect(result.requestId).toBeUndefined();
  });
});