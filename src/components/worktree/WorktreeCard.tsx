/**
 * WorktreeCard Component
 * Displays worktree information in a card format
 */

'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent, Badge, Button } from '@/components/ui';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import type { Worktree } from '@/types/models';
import { useTranslations } from 'next-intl';
import { useLocale } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { getDateFnsLocale } from '@/lib/date-locale';
import { worktreeApi, handleApiError } from '@/lib/api-client';

export interface WorktreeCardProps {
  worktree: Worktree;
  onSessionKilled?: () => void;
  onStatusChanged?: () => void;
}

/**
 * Card component for displaying worktree information
 *
 * @example
 * ```tsx
 * <WorktreeCard worktree={worktree} />
 * ```
 */
export function WorktreeCard({ worktree, onSessionKilled }: WorktreeCardProps) {
  const { id, name, description, updatedAt, isSessionRunning, isWaitingForResponse, favorite, status, link, repositoryName, nextAction } = worktree;
  const [isKilling, setIsKilling] = useState(false);
  const [isFavorite, setIsFavorite] = useState(favorite || false);
  const [isTogglingFavorite, setIsTogglingFavorite] = useState(false);
  const currentStatus = status || null;

  const t = useTranslations();
  const confirm = useConfirm();
  const locale = useLocale();
  const dateFnsLocale = getDateFnsLocale(locale);

  // Format relative time for last update
  const relativeTime = updatedAt
    ? formatDistanceToNow(new Date(updatedAt), { addSuffix: true, locale: dateFnsLocale })
    : null;

  // Determine if this is the main branch
  const isMain = name === 'main' || name === 'master';

  /**
   * Handle kill session button click
   * Kills the Claude CLI session for this worktree
   */
  const handleKillSession = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!(await confirm({ description: t('worktree.session.confirmKill', { name }), variant: 'danger' }))) {
      return;
    }

    try {
      setIsKilling(true);
      await worktreeApi.killSession(id);

      // Notify parent component
      if (onSessionKilled) {
        onSessionKilled();
      }
    } catch (err) {
      const errorMessage = handleApiError(err);
      window.alert(`${t('worktree.session.failedToKill')}: ${errorMessage}`);
    } finally {
      setIsKilling(false);
    }
  };

  /**
   * Handle favorite toggle
   */
  const handleToggleFavorite = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    try {
      setIsTogglingFavorite(true);
      const newFavorite = !isFavorite;
      await worktreeApi.toggleFavorite(id, newFavorite);
      setIsFavorite(newFavorite);
    } catch (err) {
      const errorMessage = handleApiError(err);
      window.alert(`${t('worktree.errors.failedToUpdateFavorite')}: ${errorMessage}`);
    } finally {
      setIsTogglingFavorite(false);
    }
  };

  /**
   * Handle link click
   */
  const handleLinkClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (link) {
      window.open(link, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <Link href={`/worktrees/${id}`} className="block">
      <Card hover padding="lg" className="h-full">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="flex items-center gap-2 flex-wrap">
              {/* Favorite Star */}
              <button
                onClick={handleToggleFavorite}
                disabled={isTogglingFavorite}
                className="flex-shrink-0 transition-colors hover:scale-110"
                title={isFavorite ? t('common.favorites.remove') : t('common.favorites.add')}
              >
                <svg
                  className={`w-5 h-5 ${
                    isFavorite ? 'fill-yellow-400 text-yellow-400' : 'fill-none text-muted-foreground'
                  }`}
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z"
                  />
                </svg>
              </button>
              <span className="truncate">{name}</span>
              {isMain && <Badge variant="info">Main</Badge>}
              {isSessionRunning && isWaitingForResponse && (
                <Badge variant="warning" dot>
                  {t('worktree.status.waitingForResponse')}
                </Badge>
              )}
              {isSessionRunning && !isWaitingForResponse && (
                <Badge variant="success" dot>
                  {t('worktree.status.responseCompleted')}
                </Badge>
              )}
            </CardTitle>
            {isSessionRunning && (
              <Button
                variant="danger"
                size="sm"
                onClick={handleKillSession}
                disabled={isKilling}
                className="flex-shrink-0"
              >
                {isKilling ? t('common.ending') : t('common.end')}
              </Button>
            )}
          </div>
        </CardHeader>

        <CardContent>
          <div className="space-y-3">
            {/* Repository name */}
            {repositoryName && (
              <span
                data-testid="worktree-card-repo-name"
                className="text-xs text-muted-foreground"
              >
                {repositoryName}
              </span>
            )}

            {/* Next action (Issue #600) */}
            {nextAction && (
              <span
                data-testid="worktree-card-next-action"
                className="inline-block px-2 py-0.5 text-xs rounded bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300"
              >
                {nextAction}
              </span>
            )}

            {/* Description */}
            {description && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Description</p>
                <p className="text-sm text-foreground line-clamp-2 whitespace-pre-wrap">{description}</p>
              </div>
            )}

            {/* Link */}
            {link && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Link</p>
                <button
                  onClick={handleLinkClick}
                  className="flex items-center gap-1 text-sm text-accent-600 dark:text-accent-400 hover:text-accent-800 dark:hover:text-accent-300 hover:underline transition-colors"
                  title="Open link in new tab"
                >
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                    />
                  </svg>
                  <span className="truncate">{link}</span>
                </button>
              </div>
            )}

            {/* Status badge (read-only in card; editable in detail header) */}
            {currentStatus && (
              <div>
                <span className={`px-2 py-1 text-xs font-medium rounded ${
                  currentStatus === 'done'
                    ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300'
                    : currentStatus === 'in_review'
                    ? 'bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300'
                    : currentStatus === 'in_progress'
                    ? 'bg-accent-100 dark:bg-accent-900 text-accent-700 dark:text-accent-300'
                    : 'bg-muted text-muted-foreground'
                }`}>
                  {currentStatus === 'in_progress' ? 'In Progress' : currentStatus === 'in_review' ? 'In Review' : currentStatus === 'ready' ? 'Ready' : 'Done'}
                </span>
              </div>
            )}

            {/* Updated At */}
            {relativeTime && (
              <div className="flex items-center text-xs text-muted-foreground">
                <svg
                  className="w-4 h-4 mr-1"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <span>Updated {relativeTime}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
