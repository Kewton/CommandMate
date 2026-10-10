/**
 * SidebarPanelToggle — the PC sidebar's open/close button (Issue #3512).
 *
 * One button, drawn in two places that put it at the same spot on screen: the
 * top-left cell of the open sidebar and the top cell of the collapsed icon rail
 * (`SidebarRail`). The cell is sized in px (`SIDEBAR_TOGGLE_CELL_PADDING` /
 * `SIDEBAR_TOGGLE_SIZE`), never in rem, and each host puts it first, at the
 * column's top-left with no padding of its own around it; AppShell gives both
 * columns the same top. So opening or closing never moves the button under the
 * pointer, whatever the display size or tab-strip mode.
 *
 * The icon is a panel whose left column is drawn or not, so it shows which way
 * the click goes; the accessible name says it in words (`sidebar.open` /
 * `sidebar.close`) and `aria-expanded` carries the state.
 *
 * Replaces the ActivityBar hamburger (#747) and the never-mounted
 * `SidebarToggle`.
 *
 * Issue #3515: the phone's drawer draws the same button in the same cell with
 * `onClose`. There it only closes (the drawer is opened from the mobile header
 * and the bottom tab bar), so it is an × named `sidebar.close`, without the
 * tooltip a touch screen cannot hover and without `aria-expanded`, which
 * describes the PC sidebar's state, not the drawer's.
 *
 * @module components/layout/SidebarPanelToggle
 */

'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { useSidebarContext } from '@/contexts/SidebarContext';
import { Tooltip } from '@/components/common/Tooltip';
import { SIDEBAR_TOGGLE_CELL_PADDING, SIDEBAR_TOGGLE_SIZE } from '@/lib/sidebar-utils';

export interface SidebarPanelToggleProps {
  /** `sidebar-panel-toggle` in the sidebar, `sidebar-rail-toggle` in the rail. */
  testId: string;
  /**
   * Issue #3515: the mobile drawer's close button. Given, the button is an ×
   * that calls this instead of toggling the PC sidebar.
   */
  onClose?: () => void;
}

const BUTTON_CLASS =
  'flex items-center justify-center rounded-md text-sidebar-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const BUTTON_STYLE = { width: `${SIDEBAR_TOGGLE_SIZE}px`, height: `${SIDEBAR_TOGGLE_SIZE}px` };

export function SidebarPanelToggle({ testId, onClose }: SidebarPanelToggleProps) {
  const t = useTranslations('common');
  const { isOpen, toggle } = useSidebarContext();
  const label = isOpen ? t('sidebar.close') : t('sidebar.open');
  const Icon = isOpen ? PanelLeftClose : PanelLeftOpen;

  return (
    <div
      data-sidebar-toggle-cell=""
      className="flex flex-shrink-0"
      style={{ padding: `${SIDEBAR_TOGGLE_CELL_PADDING}px` }}
    >
      {onClose ? (
        <button
          type="button"
          data-testid={testId}
          onClick={onClose}
          aria-label={t('sidebar.close')}
          style={BUTTON_STYLE}
          className={BUTTON_CLASS}
        >
          <X size={20} aria-hidden="true" />
        </button>
      ) : (
        <Tooltip content={label} placement={isOpen ? 'bottom' : 'right'}>
          <button
            type="button"
            data-testid={testId}
            onClick={toggle}
            aria-label={label}
            aria-expanded={isOpen}
            style={BUTTON_STYLE}
            className={BUTTON_CLASS}
          >
            <Icon size={20} aria-hidden="true" />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

export default SidebarPanelToggle;
