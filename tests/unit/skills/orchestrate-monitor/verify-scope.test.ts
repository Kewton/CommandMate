import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.join(
  process.cwd(),
  '.claude/skills/orchestrate-monitor/scripts/verify-scope.sh',
);
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

function scope(file: string): string {
  return execFileSync('bash', [SCRIPT, '--file', path.join(FIXTURES, file)], {
    encoding: 'utf8',
  }).trim();
}

describe('verify-scope guard is false-positive-safe', () => {
  // Regression #2 (named in Issue #1512): the verification guard's own false
  // positive. A grep that counts a forbidden pattern occurring in explanatory
  // prose/comments — or that uses `grep -c ... || echo 0` — reports a
  // violation where there is none. A file whose only bare `npx commandmate`
  // mention is inside comments, with every real invocation pinned to @latest,
  // must be CLEAN.
  it('does NOT flag a bare pattern that only appears in comments/prose', () => {
    expect(scope('scope-clean.txt')).toBe('CLEAN');
  });

  it('flags a real bare invocation on a non-comment line', () => {
    expect(scope('scope-violation.txt')).toBe('VIOLATIONS:1');
  });
});
