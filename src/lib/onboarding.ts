/**
 * Onboarding step derivation (Issue #1199).
 *
 * Both steps are derived from the shared worktrees cache, which already carries
 * `repositories` from the same /api/worktrees response (Issue #690) — so the
 * checklist adds no fetch and no poller (Issue #709).
 *
 * The two steps are nested rather than independent: `repositories` is itself
 * derived from the worktrees table, so hasSentMessage implies hasRepository.
 */

import type { Worktree } from '@/types/models';
import type { RepositorySummary } from '@/lib/api-client';

export const ONBOARDING_DISMISSED_KEY = 'commandmate:onboarding-dismissed';

export interface OnboardingSteps {
  hasRepository: boolean;
  hasSentMessage: boolean;
}

export function deriveOnboardingSteps(
  worktrees: Worktree[] = [],
  repositories: RepositorySummary[] = []
): OnboardingSteps {
  return {
    hasRepository: (repositories ?? []).length > 0,
    // Truthiness only: the declared Date is an ISO string over the wire.
    hasSentMessage: (worktrees ?? []).some((wt) => Boolean(wt.lastUserMessageAt)),
  };
}

export function isValidDismissed(value: unknown): value is boolean {
  return typeof value === 'boolean';
}
