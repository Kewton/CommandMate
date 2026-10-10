/**
 * SidebarPanelToggle — the PC sidebar's open/close button (Issue #3512).
 *
 * One button, drawn in two places that put it at the same spot on screen: the
 * top-left cell of the open sidebar and the top cell of the collapsed icon rail
 * (`SidebarRail`). Both cells are `SIDEBAR_RAIL_WIDTH` wide and start at the
 * left edge, so opening or closing never moves the button under the pointer.
 *
 * The icon is a panel whose left column is drawn or not, so it shows which way
 * the click goes; the accessible name says it in words (`sidebar.open` /
 * `sidebar.close`) and `aria-expanded` carries the state.
 *
 * Replaces the ActivityBar hamburger (#747) and the never-mounted
 * `SidebarToggle`.
 *
 * @module components/layout/SidebarPanelToggle
 */

'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useSidebarContext } from '@/contexts/SidebarContext';
import { Tooltip } from '@/components/common/Tooltip';

export interface SidebarPanelToggleProps {
  /** `sidebar-panel-toggle` in the sidebar, `sidebar-rail-toggle` in the rail. */
  testId: string;
}

export function SidebarPanelToggle({ testId }: SidebarPanelToggleProps) {
  const t = useTranslations('common');
  const { isOpen, toggle } = useSidebarContext();
  const label = isOpen ? t('sidebar.close') : t('sidebar.open');
  const Icon = isOpen ? PanelLeftClose : PanelLeftOpen;

  return (
    <Tooltip content={label} placement={isOpen ? 'bottom' : 'right'}>
      <button
        type="button"
        data-testid={testId}
        onClick={toggle}
        aria-label={label}
        aria-expanded={isOpen}
        className="flex h-10 w-10 items-center justify-center rounded-md text-sidebar-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon size={20} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

export default SidebarPanelToggle;
