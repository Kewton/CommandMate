/**
 * OnboardingChecklist Component
 *
 * Issue #1199: first-run guidance for the Home page.
 *
 * Issue #1072 removed a hard-coded welcome banner because it kept occupying the
 * first fold with information that had gone stale. This checklist answers that
 * objection by construction: it is derived from real data, it only appears while
 * Home has no data to displace, and once every step has been observed complete
 * it latches off permanently.
 *
 * The latch matters because step 2 is not monotonic — kill-session clears
 * `last_user_message_at`, which would otherwise make the checklist reappear for
 * an experienced user.
 */

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CircleCheck, Circle, X } from 'lucide-react';
import { Card, Button } from '@/components/ui';
import { useLocalStorageState } from '@/hooks/useLocalStorageState';
import {
  ONBOARDING_DISMISSED_KEY,
  deriveOnboardingSteps,
  isValidDismissed,
} from '@/lib/onboarding';
import type { Worktree } from '@/types/models';
import type { RepositorySummary } from '@/lib/api-client';

export interface OnboardingChecklistProps {
  worktrees: Worktree[];
  repositories: RepositorySummary[];
  /** First-load gate. Callers should pass `isLoading && worktrees.length === 0`. */
  isLoading?: boolean;
  /** Worktrees fetch error. A failed fetch must not read as "new user". */
  error?: Error | null;
}

const STEPS = [
  { key: 'registerRepository', href: '/repositories' },
  { key: 'sendFirstMessage', href: '/sessions' },
] as const;

export function OnboardingChecklist({
  worktrees,
  repositories,
  isLoading = false,
  error = null,
}: OnboardingChecklistProps) {
  const t = useTranslations('home');

  const { value: dismissed, setValue: setDismissed } = useLocalStorageState<boolean>({
    key: ONBOARDING_DISMISSED_KEY,
    defaultValue: false,
    validate: isValidDismissed,
  });

  // `useLocalStorageState` starts at defaultValue and syncs in a mount effect,
  // so `dismissed` is false on the first render. Without this gate a warm
  // client-side navigation (the cache provider outlives the route) would paint
  // one frame of checklist at an already-dismissed user.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const steps = deriveOnboardingSteps(worktrees, repositories);
  const isComplete = steps.hasRepository && steps.hasSentMessage;
  const isReady = mounted && !isLoading && error === null;

  useEffect(() => {
    // Latch only — never unlatch, or an existing user's latch would be cleared
    // the moment a step regresses. Depends on the primitive, not on `steps`:
    // polling hands down a fresh array identity every few seconds.
    if (isReady && isComplete && !dismissed) {
      setDismissed(true);
    }
  }, [isReady, isComplete, dismissed, setDismissed]);

  if (!isReady || isComplete || dismissed) {
    return null;
  }

  return (
    <div className="mb-8">
      <Card variant="elevated" data-testid="onboarding-checklist">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-sm font-semibold text-foreground">{t('onboarding.title')}</h2>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('onboarding.dismiss')}
            data-testid="onboarding-dismiss"
            onClick={() => setDismissed(true)}
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </div>

        <ol className="mt-3 space-y-3">
          {STEPS.map(({ key, href }) => {
            const complete = key === 'registerRepository' ? steps.hasRepository : steps.hasSentMessage;
            return (
              <li
                key={key}
                className="flex items-center gap-3"
                data-testid={`onboarding-step-${key}`}
                data-complete={complete}
              >
                {complete ? (
                  <CircleCheck
                    size={20}
                    className="shrink-0 text-success-foreground"
                    aria-hidden="true"
                  />
                ) : (
                  <Circle
                    size={20}
                    className="shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
                <span
                  className={`min-w-0 flex-1 text-sm ${
                    complete ? 'text-muted-foreground line-through' : 'text-foreground'
                  }`}
                >
                  {t(`onboarding.steps.${key}`)}
                </span>
                {!complete && (
                  <Link
                    href={href}
                    data-testid={`onboarding-action-${key}`}
                    className="shrink-0 rounded-md bg-accent-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-accent-500 dark:hover:bg-accent-600"
                  >
                    {t(`onboarding.actions.${key}`)}
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      </Card>
    </div>
  );
}
