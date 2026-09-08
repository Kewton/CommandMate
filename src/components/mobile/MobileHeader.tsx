/**
 * MobileHeader Component
 *
 * Mobile header for displaying worktree info and status
 *
 * SF1: Uses centralized status colors from @/config/status-colors
 * Issue #111: Added branch name display
 *
 * Issue #2395: this header also carries the command palette's only entry point
 * on a phone. `/worktrees/*` is the one route with `showGlobalNav: false`, so
 * `GlobalMobileNav` — which owns the palette trigger everywhere else — is not
 * rendered there, while `AppShell` mounts `<CommandPalette />` on every mobile
 * route regardless. The palette was therefore mounted and unreachable: ⌘K is
 * not a gesture a phone has. This header is the surviving chrome on that
 * screen, hence the button.
 */

'use client';

import { memo } from 'react';
import { useTranslations } from 'next-intl';
import { type WorktreeStatusType } from '@/config/status-colors';
import { Button } from '@/components/ui';
import { StatusDot } from '@/components/ui/StatusDot';
import { useCommandPalette } from '@/contexts/CommandPaletteContext';
import { truncateString } from '@/lib/utils';
import type { GitStatus } from '@/types/models';

/**
 * Status type for worktree
 */
export type WorktreeStatus = WorktreeStatusType;

/**
 * Props for MobileHeader component
 */
export interface MobileHeaderProps {
  /** Worktree name to display */
  worktreeName: string;
  /** Repository name to display */
  repositoryName?: string;
  /** Current status */
  status: WorktreeStatus;
  /** Git status for branch display (Issue #111) */
  gitStatus?: GitStatus;
  /** Optional callback for back button */
  onBackClick?: () => void;
  /** Optional callback for menu button */
  onMenuClick?: () => void;
}

/** Common SVG icon props */
interface IconProps {
  /** SVG path d attribute */
  path: string;
  /** Icon size class (default: w-6 h-6) */
  className?: string;
}

/**
 * Base icon component to reduce SVG attribute repetition
 */
const Icon = memo(function Icon({ path, className = 'w-6 h-6' }: IconProps) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d={path}
      />
    </svg>
  );
});

/** Icon path definitions */
const ICON_PATHS = {
  back: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  // Issue #2395: the command palette trigger. A magnifier, matching the icon
  // `GlobalMobileNav` uses for the same action on every other route — drawn as
  // a path here rather than imported from lucide so it inherits this header's
  // own stroke weight and 24px box, like its two neighbours.
  search: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
} as const;


/** Truncate branch name using shared utility (Issue #111 - DRY) */
const MOBILE_BRANCH_MAX_LENGTH = 20;

/**
 * MobileHeader - Header for mobile view
 *
 * Displays worktree name, status indicator, and optional navigation buttons.
 * Respects safe area insets for notched devices.
 */
export function MobileHeader({
  worktreeName,
  repositoryName,
  status,
  gitStatus,
  onBackClick,
  onMenuClick,
}: MobileHeaderProps) {
  const t = useTranslations('common');
  const tWorktree = useTranslations('worktree');
  // Issue #2395: the same wording `GlobalMobileNav` labels its trigger with —
  // one phrase for one action, rather than a second `worktree` key saying the
  // same thing in a different voice.
  const tPalette = useTranslations('commandPalette');
  // Issue #2395: the context defaults to a no-op, so this header still renders
  // (and unit-tests) with no provider above it.
  const { setOpen: setCommandPaletteOpen } = useCommandPalette();

  return (
    <header
      data-testid="mobile-header"
      role="banner"
      className="sticky top-0 inset-x-0 bg-surface border-b border-border shadow-sm pt-safe z-40"
    >
      <div className="flex items-center justify-between h-14 px-4">
        {/* Left section: Back button or spacer */}
        <div className="w-10 flex-shrink-0">
          {onBackClick && (
            <Button
              variant="ghost"
              type="button"
              onClick={onBackClick}
              aria-label={t('back')}
              className="p-2 -ml-2 rounded-full hover:bg-muted transition-colors dark:text-foreground"
            >
              <Icon path={ICON_PATHS.back} />
            </Button>
          )}
        </div>

        {/* Center section: Worktree name, repository, and status */}
        <div className="flex-1 flex items-center justify-center min-w-0 px-2">
          {/* Status indicator (Issue #1078: unified StatusDot visual language) */}
          <StatusDot
            data-testid="status-indicator"
            status={status}
            size="sm"
            className="mr-2"
          />

          {/* Worktree name and repository */}
          <div className="flex flex-col items-center min-w-0">
            <h1
              role="heading"
              data-testid="worktree-name"
              title={worktreeName}
              className="text-sm font-medium text-foreground truncate text-center leading-tight"
            >
              {worktreeName}
            </h1>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              {repositoryName && (
                <span className="truncate max-w-[100px] text-center">
                  {repositoryName}
                </span>
              )}
              {gitStatus && gitStatus.currentBranch !== '(unknown)' && (
                <>
                  {repositoryName && <span className="text-muted-foreground/50">/</span>}
                  <span
                    className="truncate max-w-[80px] font-mono"
                    title={gitStatus.currentBranch}
                    data-testid="mobile-branch-name"
                  >
                    {truncateString(gitStatus.currentBranch, MOBILE_BRANCH_MAX_LENGTH)}
                  </span>
                  {gitStatus.isDirty && (
                    <span className="text-warning" title={tWorktree('git.uncommittedChanges')}>*</span>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Right section: command palette trigger (Issue #2395) + menu button */}
        <div className="flex-shrink-0 flex items-center justify-end">
          <Button
            variant="ghost"
            type="button"
            data-testid="mobile-header-command-palette-trigger"
            onClick={() => setCommandPaletteOpen(true)}
            aria-label={tPalette('mobileTrigger')}
            title={tPalette('mobileTrigger')}
            className="p-2 rounded-full hover:bg-muted transition-colors dark:text-foreground"
          >
            <Icon path={ICON_PATHS.search} />
          </Button>

          {onMenuClick && (
            <Button
              variant="ghost"
              type="button"
              onClick={onMenuClick}
              aria-label={t('menu')}
              className="p-2 -mr-2 rounded-full hover:bg-muted transition-colors dark:text-foreground"
            >
              <Icon path={ICON_PATHS.menu} />
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}

export default MobileHeader;
