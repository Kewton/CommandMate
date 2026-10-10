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
 * PC only: `Sidebar` does not render this in the mobile drawer (#3515 owns the
 * phone), where the drawer is opened from the mobile header instead.
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

export function SidebarTopControls() {
  const tCommon = useTranslations('common');
  const tPalette = useTranslations('commandPalette');
  const { setOpen: setPaletteOpen } = useCommandPalette();
  const { openNewTask } = useNewTask();
  const modKey = useModKeyLabel();

  return (
    <div data-testid="sidebar-top-controls" className="flex-shrink-0">
      {/* First in the sidebar, no padding around it: the toggle cell starts at
          the column's top-left, where the rail has it too. */}
      <div className="flex min-w-0 items-center">
        <SidebarPanelToggle testId="sidebar-panel-toggle" />
        <TransitionLink
          href="/"
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
          onClick={() => openNewTask()}
          aria-haspopup="dialog"
          className={ROW_CLASS}
        >
          <SquarePen className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{tCommon('newTask.title')}</span>
        </button>
        <button
          type="button"
          data-testid="sidebar-search"
          onClick={() => setPaletteOpen(true)}
          aria-label={tPalette('mobileTrigger')}
          className={ROW_CLASS}
        >
          <Search className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{tPalette('searchAction')}</span>
          {modKey && (
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
