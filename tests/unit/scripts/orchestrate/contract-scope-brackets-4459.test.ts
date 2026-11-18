/**
 * contract.mjs scope `[id]` → the scope gate (Issue #4459, run 3307).
 *
 * The gate reads `[` / `]` literally (scope-gate-glob.ts), so a contract that carried the shell
 * escape `[[]id[]]` matched nothing. The generated contract is run through the parser and the
 * gate's matcher. No file of the repository is written.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { contractYaml, literalBrackets, normalizeConfig } from '../../../../scripts/orchestrate/contract.mjs';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import { ScopeMatcher } from '@/lib/verification/scope-gate';

const matcherFor = (scope: string[]) => {
  const config = normalizeConfig({ issue: 4459, title: 't', scope, decisions: ['d'], issueBody: 'b' }, {});
  const contract = parseTaskContract(contractYaml(config), 'issue-4459.yaml');
  return new ScopeMatcher((contract as unknown as { scope: { allow: string[]; deny: string[] } }).scope);
};

const INSIDE = 'src/app/api/worktrees/[id]/send/route.ts';
const OUTSIDE = 'src/app/api/repositories/route.ts';

describe('scope [id] from a generated contract to the scope gate (#4459 I2)', () => {
  it.each([
    ['literal brackets', 'src/app/api/worktrees/[id]/**'],
    ['the shell escape (the written form of run 3307)', 'src/app/api/worktrees/[[]id[]]/**'],
  ])('%s: a change inside is admitted, one outside is a violation', (_label, pattern) => {
    const matcher = matcherFor([pattern]);
    expect(matcher.isViolation(INSIDE)).toBe(false);
    expect(matcher.isViolation(OUTSIDE)).toBe(true);
  });

  it('the gate itself is unchanged: an escaped pattern given to it directly still matches nothing real', () => {
    const matcher = new ScopeMatcher({ allow: ['src/app/api/worktrees/[[]id[]]/**'], deny: [] });
    expect(matcher.isViolation(INSIDE)).toBe(true);
  });

  it('literalBrackets leaves everything else alone (negative control)', () => {
    expect(literalBrackets('src/app/api/worktrees/[id]/**')).toBe('src/app/api/worktrees/[id]/**');
    expect(literalBrackets('src/app/proxy/[...path]/**')).toBe('src/app/proxy/[...path]/**');
    expect(literalBrackets('src/**/*.ts')).toBe('src/**/*.ts');
    expect(literalBrackets('a/[[]x[]]/[[]y[]]')).toBe('a/[x]/[y]');
  });
});
