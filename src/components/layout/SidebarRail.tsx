/**
 * SidebarRail — the icon column left when the PC sidebar is closed (Issue #3512).
 *
 * Closing the sidebar used to remove every way to the other screens on
 * `/worktrees/*` (no global Header there). The rail keeps them one click away:
 * open/close · New task · search (⌘K) · Sessions · Repositories · Review (order: SIDEBAR_NAV_ORDER)
 * (with the waiting count) · and, pinned to the bottom, the settings menu.
 *
 * Role next to the worktree ActivityBar: the rail is app-wide navigation and
 * only exists while the sidebar is closed; the ActivityBar moves between the
 * panes INSIDE one worktree. On the worktree screen the two stand side by side,
 * rail (56px) then ActivityBar (48px).
 *
 * The open/close button is the first cell, at the same spot as in the open
 * sidebar (`SidebarPanelToggle`).
 *
 * @module components/layout/SidebarRail
 */

'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  AlignJustify,
  CircleCheck,
  Database,
  Search,
  Settings,
  SquarePen,
  type LucideIcon,
} from 'lucide-react';
import { TransitionLink } from '@/components/view-transitions/TransitionLink';
import { Tooltip } from '@/components/common/Tooltip';
import { useCommandPalette } from '@/contexts/CommandPaletteContext';
import { useNewTask } from '@/contexts/NewTaskContext';
import { useAttentionCount } from '@/hooks/useAttentionCount';
import { ATTENTION_REVIEW_HREF } from '@/config/review-config';
import { SIDEBAR_NAV_ORDER, SIDEBAR_RAIL_WIDTH, type SidebarNavId } from '@/lib/sidebar-utils';
import { AttentionBadgeBubble } from './AttentionBadge';
import { SettingsMenu, SettingsMenuTrigger } from './SettingsMenu';
import { SidebarPanelToggle } from './SidebarPanelToggle';

const CELL_CLASS =
  'relative flex h-10 w-10 items-center justify-center rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const IDLE_CLASS = 'text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-foreground';
const ACTIVE_CLASS = 'bg-sidebar-hover text-sidebar-foreground';

function RailLink({
  href,
  icon: Icon,
  label,
  testId,
  isActive,
  badge,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  testId: string;
  isActive: boolean;
  badge?: React.ReactNode;
}) {
  return (
    <Tooltip content={label} placement="right">
      <TransitionLink
        href={href}
        data-testid={testId}
        aria-label={label}
        aria-current={isActive ? 'page' : undefined}
        className={`${CELL_CLASS} ${isActive ? ACTIVE_CLASS : IDLE_CLASS}`}
      >
        {/* The bubble anchors to the icon, so it stays inside the 56px rail. */}
        <span className="relative flex">
          <Icon size={20} aria-hidden="true" />
          {badge}
        </span>
      </TransitionLink>
    </Tooltip>
  );
}

function RailButton({
  icon: Icon,
  label,
  testId,
  onClick,
  hasPopup,
}: {
  icon: LucideIcon;
  label: string;
  testId: string;
  onClick: () => void;
  hasPopup?: 'dialog';
}) {
  return (
    <Tooltip content={label} placement="right">
      <button
        type="button"
        data-testid={testId}
        aria-label={label}
        aria-haspopup={hasPopup}
        onClick={onClick}
        className={`${CELL_CLASS} ${IDLE_CLASS}`}
      >
        <Icon size={20} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

export function SidebarRail() {
  const t = useTranslations('common');
  const tPalette = useTranslations('commandPalette');
  const pathname = usePathname() ?? '';
  const { setOpen: setPaletteOpen } = useCommandPalette();
  const { openNewTask } = useNewTask();
  const { count: attentionCount } = useAttentionCount();
  const settingsLabel = t('settings.title');

  const navLinks: Record<SidebarNavId, React.ReactNode> = {
    sessions: (
      <RailLink
        href="/sessions"
        icon={AlignJustify}
        label={t('nav.sessions')}
        testId="sidebar-rail-sessions"
        isActive={pathname.startsWith('/sessions')}
      />
    ),
    repositories: (
      <RailLink
        href="/repositories"
        icon={Database}
        label={t('nav.repositories')}
        testId="sidebar-rail-repositories"
        isActive={pathname.startsWith('/repositories')}
      />
    ),
    review: (
      <RailLink
        href={attentionCount > 0 ? ATTENTION_REVIEW_HREF : '/review'}
        icon={CircleCheck}
        label={t('nav.review')}
        testId="sidebar-rail-review"
        isActive={pathname.startsWith('/review')}
        badge={<AttentionBadgeBubble count={attentionCount} />}
      />
    ),
  };

  return (
    <nav
      data-testid="sidebar-rail"
      aria-label={t('sidebar.railLabel')}
      // No padding above or beside the first cell: the open/close cell is
      // 8 + 40 + 8 px, exactly this width, and starts at the top-left like the
      // open sidebar's (SidebarPanelToggle).
      className="flex h-full flex-col items-center gap-1 bg-sidebar pb-2 text-sidebar-foreground"
      style={{ width: `${SIDEBAR_RAIL_WIDTH}px` }}
    >
      <SidebarPanelToggle testId="sidebar-rail-toggle" />
      <RailButton
        icon={SquarePen}
        label={t('newTask.title')}
        testId="sidebar-rail-new-task"
        onClick={() => openNewTask()}
        hasPopup="dialog"
      />
      <RailButton
        icon={Search}
        label={tPalette('mobileTrigger')}
        testId="sidebar-rail-search"
        onClick={() => setPaletteOpen(true)}
      />
      <div className="my-1 w-8 border-b border-sidebar-border" aria-hidden="true" />
      {SIDEBAR_NAV_ORDER.map((id) => (
        <React.Fragment key={id}>{navLinks[id]}</React.Fragment>
      ))}
      <div className="mt-auto">
        <SettingsMenu testIdPrefix="sidebar-rail-settings" side="right" align="end" showDisplayPreferences>
          <Tooltip content={settingsLabel} placement="right">
            <SettingsMenuTrigger asChild>
              <button
                type="button"
                data-testid="sidebar-rail-settings"
                aria-label={settingsLabel}
                className={`${CELL_CLASS} ${IDLE_CLASS}`}
              >
                <Settings size={20} aria-hidden="true" />
              </button>
            </SettingsMenuTrigger>
          </Tooltip>
        </SettingsMenu>
      </div>
    </nav>
  );
}

export default SidebarRail;
