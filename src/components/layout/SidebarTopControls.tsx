/**
 * SidebarTopControls — the top of the open PC sidebar (Issue #3512).
 *
 * Logo row (open/close button + the CommandMate logo linking to `/`), then
 * New task and the ⌘K search row. The destinations (Repositories + sync,
 * Sessions, Review) follow in `Sidebar.tsx`.
 *
 * Rendered as the sidebar's first child, above the padded header, so the
 * open/close cell is at the column's top-left (see `SidebarPanelToggle`).
 *
 * Issue #3515: the phone's drawer renders the same rows with `drawer`. The
 * open/close cell becomes the drawer's close button (×), the ⌘K key hint is
 * not drawn (a phone has no keyboard to press it on), and every row closes the
 * drawer before it acts, so the New task dialog and the command palette open
 * on a clear screen and the logo lands on `/` with the drawer shut. The drawer
 * copy carries its own test ids for the container and the close button
 * (`sidebar-drawer-top-controls` / `sidebar-drawer-close`): the button does a
 * different thing from the PC toggle, and the PC ids keep naming the PC rows.
 *
 * @module components/layout/SidebarTopControls
 */

'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Folder, Search, SquarePen } from 'lucide-react';
import { TransitionLink } from '@/components/view-transitions/TransitionLink';
import { Kbd } from '@/components/ui/Kbd';
import { useCommandPalette } from '@/contexts/CommandPaletteContext';
import { useNewTask } from '@/contexts/NewTaskContext';
import { useSidebarContext } from '@/contexts/SidebarContext';
import { isMacPlatform } from '@/config/keyboard-shortcuts';
import { SidebarPanelToggle } from './SidebarPanelToggle';

const ROW_CLASS =
  'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-sidebar-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * ⌘ on macOS, Ctrl elsewhere. Null until mounted so the server render (which
 * cannot know the OS) and the first client render agree.
 */
function useModKeyLabel(): string | null {
  const [modKey, setModKey] = React.useState<string | null>(null);
  React.useEffect(() => {
    setModKey(isMacPlatform() ? '⌘' : 'Ctrl');
  }, []);
  return modKey;
}

export interface SidebarTopControlsProps {
  /** Issue #3515: rendered inside the phone's drawer (see the module doc). */
  drawer?: boolean;
}

export function SidebarTopControls({ drawer = false }: SidebarTopControlsProps) {
  const tCommon = useTranslations('common');
  const tPalette = useTranslations('commandPalette');
  const { setOpen: setPaletteOpen } = useCommandPalette();
  const { openNewTask } = useNewTask();
  const { closeMobileDrawer } = useSidebarContext();
  const modKey = useModKeyLabel();
  const showKeyHint = !drawer && modKey !== null;
  // The PC sidebar stays where it is; the drawer gets out of the way first.
  const leaveDrawer = drawer ? closeMobileDrawer : undefined;

  return (
    <div data-testid={drawer ? 'sidebar-drawer-top-controls' : 'sidebar-top-controls'} className="flex-shrink-0">
      {/* First in the sidebar, no padding around it: the toggle cell starts at
          the column's top-left, where the rail has it too. */}
      <div className="flex min-w-0 items-center">
        {drawer ? (
          <SidebarPanelToggle testId="sidebar-drawer-close" onClose={closeMobileDrawer} />
        ) : (
          <SidebarPanelToggle testId="sidebar-panel-toggle" />
        )}
        <TransitionLink
          href="/"
          onClick={leaveDrawer}
          data-testid="sidebar-logo"
          className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-accent-600">
            <Folder size={14} strokeWidth={2} className="text-white" aria-hidden="true" />
          </span>
          <span className="truncate text-sm font-bold text-sidebar-foreground">CommandMate</span>
        </TransitionLink>
      </div>
      <div className="space-y-0.5 px-2">
        <button
          type="button"
          data-testid="sidebar-new-task"
          onClick={() => {
            leaveDrawer?.();
            openNewTask();
          }}
          aria-haspopup="dialog"
          className={ROW_CLASS}
        >
          <SquarePen className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{tCommon('newTask.title')}</span>
        </button>
        <button
          type="button"
          data-testid="sidebar-search"
          onClick={() => {
            leaveDrawer?.();
            setPaletteOpen(true);
          }}
          aria-label={tPalette('mobileTrigger')}
          className={ROW_CLASS}
        >
          <Search className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{tPalette('searchAction')}</span>
          {showKeyHint && (
            <span className="flex flex-shrink-0 items-center gap-0.5" aria-hidden="true">
              <Kbd>{modKey}</Kbd>
              <Kbd>K</Kbd>
            </span>
          )}
        </button>
      </div>
    </div>
  );
}

export default SidebarTopControls;
