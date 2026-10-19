/**
 * Unit tests for the glob half of the `scope` gate, split out of scope-gate.ts
 * (Issue #3647).
 *
 * The glob semantics themselves are pinned in scope-gate.test.ts through the
 * re-export; this file pins the new module's own public surface, and that the
 * re-export is the same binding rather than a copy that could drift.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import type { TaskContractScope } from '@/lib/tasks/contract-parser';
import {
  ALWAYS_ALLOWED_PREFIX,
  SCOPE_EXEMPT_ALWAYS_ALLOWED,
  SCOPE_EXEMPT_CONTRACT_PATH,
  ScopeMatcher,
} from '@/lib/verification/scope-gate-glob';
import * as scopeGate from '@/lib/verification/scope-gate';

function scope(allow: string[], deny: string[] = []): TaskContractScope {
  return { allow, deny };
}

describe('scope-gate-glob exports', () => {
  it('keeps the exemption constants', () => {
    expect(ALWAYS_ALLOWED_PREFIX).toBe('.commandmate/');
    expect(SCOPE_EXEMPT_ALWAYS_ALLOWED).toBe('(exempt: .commandmate/)');
    expect(SCOPE_EXEMPT_CONTRACT_PATH).toBe('(exempt: contract path)');
  });

  it('is re-exported from scope-gate as the same bindings', () => {
    expect(scopeGate.ScopeMatcher).toBe(ScopeMatcher);
    expect(scopeGate.ALWAYS_ALLOWED_PREFIX).toBe(ALWAYS_ALLOWED_PREFIX);
    expect(scopeGate.SCOPE_EXEMPT_ALWAYS_ALLOWED).toBe(SCOPE_EXEMPT_ALWAYS_ALLOWED);
    expect(scopeGate.SCOPE_EXEMPT_CONTRACT_PATH).toBe(SCOPE_EXEMPT_CONTRACT_PATH);
  });
});

describe('ScopeMatcher (scope-gate-glob)', () => {
  it('admits a path under a directory pattern and names the pattern', () => {
    const matcher = new ScopeMatcher(scope(['src/lib']));
    expect(matcher.classify('src/lib/a.ts')).toEqual({ admitted: true, pattern: 'src/lib' });
    expect(matcher.isViolation('src/lib/a.ts')).toBe(false);
  });

  it('rejects a near-miss that no pattern names', () => {
    const matcher = new ScopeMatcher(scope(['src/lib']));
    expect(matcher.classify('src/libx/a.ts')).toEqual({ admitted: false, pattern: null });
    expect(matcher.isViolation('src/libx/a.ts')).toBe(true);
  });

  it('reports the first matching allow pattern in declaration order', () => {
    const matcher = new ScopeMatcher(scope(['src/**', 'src/lib/**']));
    expect(matcher.classify('src/lib/a.ts')).toEqual({ admitted: true, pattern: 'src/**' });
  });

  it('keeps * and ? inside one segment and ** across segments', () => {
    const matcher = new ScopeMatcher(scope(['src/*.ts', 'docs/**/*.md', 'a?.txt']));
    expect(matcher.isViolation('src/a.ts')).toBe(false);
    expect(matcher.isViolation('src/x/a.ts')).toBe(true);
    expect(matcher.isViolation('docs/a.md')).toBe(false);
    expect(matcher.isViolation('docs/x/y/a.md')).toBe(false);
    expect(matcher.isViolation('ab.txt')).toBe(false);
    expect(matcher.isViolation('a/.txt')).toBe(true);
  });

  it('treats brackets as literal and balanced braces as alternation', () => {
    const matcher = new ScopeMatcher(scope(['src/app/proxy/[...path]/route.ts', 'x/{a,b}.ts']));
    expect(matcher.isViolation('src/app/proxy/[...path]/route.ts')).toBe(false);
    expect(matcher.isViolation('src/app/proxy/p/route.ts')).toBe(true);
    expect(matcher.isViolation('x/a.ts')).toBe(false);
    expect(matcher.isViolation('x/c.ts')).toBe(true);
  });

  it('lets deny win over allow and over the exemptions', () => {
    const matcher = new ScopeMatcher(scope(['src/**'], ['src/secret.ts', '.commandmate/verify.yaml']));
    expect(matcher.classify('src/secret.ts')).toEqual({ admitted: false, pattern: 'src/secret.ts' });
    expect(matcher.classify('.commandmate/verify.yaml')).toEqual({
      admitted: false,
      pattern: '.commandmate/verify.yaml',
    });
  });

  it('exempts .commandmate/ and the contract path from allow', () => {
    const matcher = new ScopeMatcher(scope([]), 'contracts/task.yaml');
    expect(matcher.classify('.commandmate/tasks/t.yaml')).toEqual({
      admitted: true,
      pattern: SCOPE_EXEMPT_ALWAYS_ALLOWED,
    });
    expect(matcher.classify('contracts/task.yaml')).toEqual({
      admitted: true,
      pattern: SCOPE_EXEMPT_CONTRACT_PATH,
    });
    expect(matcher.isViolation('contracts/other.yaml')).toBe(true);
  });
});
