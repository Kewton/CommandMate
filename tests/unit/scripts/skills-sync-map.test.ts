/**
 * Tests for scripts/skills-sync-map.mjs's counterpartPathOf (Issue #2904).
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { counterpartPathOf } from '../../../scripts/skills-sync-map.mjs';

describe('counterpartPathOf', () => {
  const pkg = { local: '.claude/skills/cmate-verify', counterpart: 'skills/cmate-verify' };

  it('prefers file.counterpartPath when present', () => {
    const file = {
      path: 'scripts/tests/fixtures/all-pass.yaml',
      counterpartPath: 'tests/fixtures/cmate-verify/fixtures/all-pass.yaml',
      policy: 'byte-identical',
      sha256: 'x',
    };
    expect(counterpartPathOf(pkg, file)).toBe(
      'tests/fixtures/cmate-verify/fixtures/all-pass.yaml',
    );
  });

  it('falls back to `${pkg.counterpart}/${file.path}` when counterpartPath is absent', () => {
    const file = { path: 'scripts/monitor.sh', policy: 'port-required', sha256: 'x' };
    expect(counterpartPathOf(pkg, file)).toBe('skills/cmate-verify/scripts/monitor.sh');
  });
});
