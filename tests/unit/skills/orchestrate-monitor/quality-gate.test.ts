import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.join(
  process.cwd(),
  '.claude/skills/orchestrate-monitor/scripts/quality-gate.sh',
);

function gate(inner: string): string {
  return execFileSync('bash', [SCRIPT, '--', 'bash', '-c', inner], {
    encoding: 'utf8',
  }).trim();
}

describe('quality-gate judges by real exit code, not by grepping output', () => {
  it('reports FAIL when the command exits non-zero despite a "passed" line', () => {
    // The exact trap: green-looking stdout, non-zero exit (vitest + Unhandled
    // Rejection). A grep summary would call this PASS.
    expect(gate('echo "Tests 100 passed"; exit 1')).toBe('FAIL:1');
  });

  it('reports PASS only when the command exits zero', () => {
    expect(gate('echo "Tests 100 passed"; exit 0')).toBe('PASS');
  });
});
