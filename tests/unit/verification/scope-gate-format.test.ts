/**
 * Unit tests for the `log_tail` formatting half of the `scope` gate, split out
 * of scope-gate.ts (Issue #3647).
 *
 * The full report is pinned in scope-gate.test.ts through `evaluateScope`; this
 * file pins each moved formatter on its own, and that the constants re-exported
 * from scope-gate are the same bindings.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_REPORTED_VIOLATIONS,
  SCOPE_PATTERN_ARROW,
  formatAdmitted,
  formatAgentStateExcluded,
  formatDecidedPath,
  formatOrchestratorExcluded,
  formatPatterns,
} from '@/lib/verification/scope-gate-format';
import * as scopeGate from '@/lib/verification/scope-gate';

describe('scope-gate-format exports', () => {
  it('keeps the report constants', () => {
    expect(MAX_REPORTED_VIOLATIONS).toBe(100);
    expect(SCOPE_PATTERN_ARROW).toBe('  ← ');
  });

  it('is re-exported from scope-gate as the same bindings', () => {
    expect(scopeGate.MAX_REPORTED_VIOLATIONS).toBe(MAX_REPORTED_VIOLATIONS);
    expect(scopeGate.SCOPE_PATTERN_ARROW).toBe(SCOPE_PATTERN_ARROW);
  });
});

describe('formatPatterns', () => {
  it('joins declared patterns and names an empty list', () => {
    expect(formatPatterns(['a', 'b/**'])).toBe('a, b/**');
    expect(formatPatterns([])).toBe('(none)');
  });
});

describe('formatDecidedPath', () => {
  it('appends the deciding pattern after the arrow', () => {
    expect(formatDecidedPath('+', 'src/a.ts', 'src/**')).toBe(
      `  + src/a.ts${SCOPE_PATTERN_ARROW}src/**`
    );
  });

  it('omits the arrow when no pattern decided the path', () => {
    expect(formatDecidedPath('-', 'src/a.ts', null)).toBe('  - src/a.ts');
  });
});

describe('formatAdmitted', () => {
  it('returns nothing for an empty list', () => {
    expect(formatAdmitted([])).toEqual([]);
  });

  it('lists each admission under the header', () => {
    expect(formatAdmitted([{ path: 'src/a.ts', pattern: 'src/**' }])).toEqual([
      'admitted:',
      `  + src/a.ts${SCOPE_PATTERN_ARROW}src/**`,
    ]);
  });

  it('caps the listing and states the remainder', () => {
    const admitted = Array.from({ length: MAX_REPORTED_VIOLATIONS + 3 }, (_, i) => ({
      path: `f${i}.ts`,
      pattern: '**',
    }));
    const lines = formatAdmitted(admitted);
    expect(lines).toHaveLength(MAX_REPORTED_VIOLATIONS + 2);
    expect(lines[lines.length - 1]).toBe('  ... (+3 more)');
  });
});

describe('formatAgentStateExcluded', () => {
  it('returns nothing for an empty list', () => {
    expect(formatAgentStateExcluded([])).toEqual([]);
  });

  it('lists excluded paths and caps them', () => {
    expect(formatAgentStateExcluded(['.agents/state.json'])).toEqual([
      'excluded (agent-managed state files, not counted as change):',
      '  ~ .agents/state.json',
    ]);
    const many = Array.from({ length: MAX_REPORTED_VIOLATIONS + 1 }, (_, i) => `s${i}`);
    const lines = formatAgentStateExcluded(many);
    expect(lines).toHaveLength(MAX_REPORTED_VIOLATIONS + 2);
    expect(lines[lines.length - 1]).toBe('  ... (+1 more)');
  });
});

describe('formatOrchestratorExcluded', () => {
  it('returns nothing for an empty list', () => {
    expect(formatOrchestratorExcluded([])).toEqual([]);
  });

  it('lists every orchestrator-only path without a cap', () => {
    expect(formatOrchestratorExcluded(['docs/module-reference.md'])).toEqual([
      'excluded (changed only by orchestrator commits, not counted as change):',
      '  ~ docs/module-reference.md',
    ]);
    const many = Array.from({ length: MAX_REPORTED_VIOLATIONS + 1 }, (_, i) => `o${i}`);
    expect(formatOrchestratorExcluded(many)).toHaveLength(MAX_REPORTED_VIOLATIONS + 2);
  });
});
