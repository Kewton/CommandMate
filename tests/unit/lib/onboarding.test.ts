/**
 * Issue #1199: onboarding step derivation.
 *
 * Fixtures use ISO strings for `lastUserMessageAt`, not Date objects: the type
 * says `Date` but the value reaches the client through NextResponse.json, so
 * production always sees a string here.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveOnboardingSteps,
  isValidDismissed,
  ONBOARDING_DISMISSED_KEY,
} from '@/lib/onboarding';
import type { Worktree } from '@/types/models';
import type { RepositorySummary } from '@/lib/api-client';

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    name: 'main',
    path: '/repo',
    repositoryPath: '/repo',
    repositoryName: 'repo',
    ...overrides,
  } as Worktree;
}

function makeRepository(overrides: Partial<RepositorySummary> = {}): RepositorySummary {
  return {
    path: '/repo',
    name: 'repo',
    worktreeCount: 1,
    visible: true,
    enabled: true,
    ...overrides,
  };
}

describe('deriveOnboardingSteps (Issue #1199)', () => {
  it('reports both steps incomplete for a brand-new user', () => {
    expect(deriveOnboardingSteps([], [])).toEqual({
      hasRepository: false,
      hasSentMessage: false,
    });
  });

  it('completes step 1 once a repository is present', () => {
    const steps = deriveOnboardingSteps([makeWorktree()], [makeRepository()]);
    expect(steps).toEqual({ hasRepository: true, hasSentMessage: false });
  });

  it('completes step 2 once any worktree has a user message', () => {
    const steps = deriveOnboardingSteps(
      [
        makeWorktree({ id: 'wt-1' }),
        makeWorktree({
          id: 'wt-2',
          lastUserMessageAt: '2026-07-15T10:00:00.000Z' as unknown as Date,
        }),
      ],
      [makeRepository()]
    );
    expect(steps).toEqual({ hasRepository: true, hasSentMessage: true });
  });

  it('treats a kill-session-cleared timestamp as not sent', () => {
    // kill-session nulls last_user_message_at, which arrives as an absent key.
    const steps = deriveOnboardingSteps(
      [makeWorktree({ lastUserMessageAt: undefined })],
      [makeRepository()]
    );
    expect(steps.hasSentMessage).toBe(false);
  });

  it('does not throw when arguments are missing', () => {
    expect(
      deriveOnboardingSteps(
        undefined as unknown as Worktree[],
        undefined as unknown as RepositorySummary[]
      )
    ).toEqual({ hasRepository: false, hasSentMessage: false });
  });
});

describe('isValidDismissed (Issue #1199)', () => {
  it('accepts booleans', () => {
    expect(isValidDismissed(true)).toBe(true);
    expect(isValidDismissed(false)).toBe(true);
  });

  it.each([['true'], [1], [null], [undefined], [{}], [[]]])(
    'rejects non-boolean %s',
    (value) => {
      expect(isValidDismissed(value)).toBe(false);
    }
  );
});

describe('ONBOARDING_DISMISSED_KEY (Issue #1199)', () => {
  it('follows the commandmate: namespace convention', () => {
    expect(ONBOARDING_DISMISSED_KEY).toBe('commandmate:onboarding-dismissed');
  });
});
