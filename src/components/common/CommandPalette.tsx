/**
 * CommandPalette (Issue #1053, enhanced #1077)
 *
 * A global ⌘K / Ctrl+K command palette (cmdk) mounted once under AppShell.
 * Command groups:
 *   - Recent: MRU of the last executed commands (empty query only, localStorage).
 *   - Navigation: jump to the main screens (lucide icons).
 *   - Worktrees: incremental search over repository + branch, read from the
 *     shared WorktreesCache (always fresh + auto-retried, single poller per
 *     Issue #709); each row shows a StatusDot (Issue #1051). Running sessions
 *     sort first; the group is omitted while the cache reports an error.
 *   - Actions: theme toggle, PC display-size switching, repository sync,
 *     language switch, open GitHub.
 *
 * The single global keyboard listener lives here so it does not conflict with
 * existing per-view shortcuts. It never opens while the user is typing in an
 * input/textarea/contentEditable or the worktree terminal pane (role="log").
 *
 * SSR-safe: 'use client', and `document` / `localStorage` are only referenced
 * after mount inside an effect / the portal (which renders only when mounted).
 */

'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { Command } from 'cmdk';
import {
  type LucideIcon,
  Search,
  Home,
  MessageSquare,
  AlignJustify,
  FolderGit2,
  CircleCheck,
  MoreHorizontal,
  GitBranch,
  Sun,
  Moon,
  Monitor,
  RefreshCw,
  Languages,
  Github,
  Keyboard,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { Z_INDEX } from '@/config/z-index';
import { useCommandPalette } from '@/contexts/CommandPaletteContext';
import { useKeyboardShortcuts } from '@/contexts/KeyboardShortcutsContext';
import { usePcDisplaySizeContext } from '@/contexts/PcDisplaySizeContext';
import { useOptionalWorktreesCacheContext } from '@/components/providers/WorktreesCacheProvider';
import { PC_DISPLAY_SIZE_ORDER } from '@/hooks/usePcDisplaySize';
import { useLocaleSwitch } from '@/hooks/useLocaleSwitch';
import { repositoryApi } from '@/lib/api-client';
import { StatusDot, type StatusDotStatus } from '@/components/ui/StatusDot';
import { Kbd } from '@/components/ui/Kbd';
import { useToast, ToastContainer } from '@/components/common/Toast';
import type { Worktree } from '@/types/models';

/** Navigation targets shown in the palette (mirrors Header / GlobalMobileNav). */
const NAV_ITEMS = [
  { key: 'home', href: '/' },
  { key: 'chat', href: '/chat' },
  { key: 'sessions', href: '/sessions' },
  { key: 'repositories', href: '/repositories' },
  { key: 'review', href: '/review' },
  { key: 'more', href: '/more' },
] as const;

/** lucide icon per navigation target (GlobalMobileNav set + Chat / Repos). */
const NAV_ICONS: Record<string, LucideIcon> = {
  home: Home,
  chat: MessageSquare,
  sessions: AlignJustify,
  repositories: FolderGit2,
  review: CircleCheck,
  more: MoreHorizontal,
};

/** localStorage key + cap for the Recent (MRU) group. */
const RECENTS_KEY = 'cm.palette.recents';
const RECENTS_MAX = 8;
/** Max worktrees shown in the group while the query is empty. */
const WORKTREES_EMPTY_LIMIT = 8;

/** A recorded command, replayed from the Recent group. */
type RecentEntry =
  | { kind: 'nav'; id: string }
  | { kind: 'worktree'; id: string }
  | { kind: 'action'; id: string };

function isRecentEntry(value: unknown): value is RecentEntry {
  if (!value || typeof value !== 'object') return false;
  const { kind, id } = value as Record<string, unknown>;
  return (
    (kind === 'nav' || kind === 'worktree' || kind === 'action') &&
    typeof id === 'string'
  );
}

function loadRecents(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentEntry).slice(0, RECENTS_MAX);
  } catch {
    return [];
  }
}

function pushRecent(prev: RecentEntry[], entry: RecentEntry): RecentEntry[] {
  const deduped = prev.filter(
    (e) => !(e.kind === entry.kind && e.id === entry.id)
  );
  const next = [entry, ...deduped].slice(0, RECENTS_MAX);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // ignore quota / disabled storage
  }
  return next;
}

/**
 * Derive a StatusDot status from a worktree's live session flags (same
 * precedence as the sidebar: waiting > processing > running > idle).
 */
function worktreeStatus(wt: Worktree): StatusDotStatus {
  if (wt.isWaitingForResponse) return 'waiting';
  if (wt.isProcessing) return 'running';
  if (wt.isSessionRunning) return 'ready';
  return 'idle';
}

/** Sort: running sessions first, then most-recently-updated. */
function sortWorktrees(worktrees: Worktree[]): Worktree[] {
  return [...worktrees].sort((a, b) => {
    const ar = a.isSessionRunning ? 1 : 0;
    const br = b.isSessionRunning ? 1 : 0;
    if (ar !== br) return br - ar;
    const at = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const bt = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return bt - at;
  });
}

/**
 * Whether a keyboard event target is a text-entry context where ⌘K must NOT
 * hijack the keystroke: form fields, contentEditable, or the terminal output
 * pane (a focusable `role="log"` div that captures keystrokes).
 *
 * Exported for unit testing.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  // Worktree terminal output pane captures keystrokes while focused.
  if (target.closest('[role="log"]')) return true;
  return false;
}

const ITEM_CLASS = cn(
  'flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm',
  'text-foreground',
  'data-[selected=true]:bg-accent-500/15 data-[selected=true]:text-accent-700',
  'dark:data-[selected=true]:text-accent-300'
);

const ICON_CLASS = 'shrink-0 text-muted-foreground';

/** A palette action descriptor, rendered in Actions and replayable from Recent. */
interface ActionDescriptor {
  id: string;
  label: string;
  icon: LucideIcon;
  run: () => void;
}

/** A resolved Recent row (dead entries resolve to null and are skipped). */
interface RecentRow {
  id: string;
  value: string;
  node: React.ReactNode;
  onSelect: () => void;
}

/**
 * Global command palette. Renders a persistent (portal) toast container plus,
 * while open, the palette dialog.
 */
export function CommandPalette() {
  const { open, setOpen } = useCommandPalette();
  const { setOpen: setShortcutsOpen } = useKeyboardShortcuts();
  const router = useRouter();
  const t = useTranslations('commandPalette');
  const tCommon = useTranslations('common');
  const { theme, setTheme } = useTheme();
  const { setSize, isMobile } = usePcDisplaySizeContext();
  const { currentLocale, switchLocale } = useLocaleSwitch();
  // Read from the shared worktrees cache (always fresh + auto-retried). Optional
  // so the palette degrades gracefully when no provider is present (unit tests).
  const worktreesCache = useOptionalWorktreesCacheContext();
  const { toasts, showToast, removeToast } = useToast();

  const [mounted, setMounted] = useState(false);
  const [search, setSearch] = useState('');
  const [recents, setRecents] = useState<RecentEntry[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);
  // Element focused before the palette opened, restored on close (a11y).
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Keep the latest open state readable from the stable keyboard listener.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // Only reference `document` after mount (SSR safety).
  useEffect(() => {
    setMounted(true);
  }, []);

  // Single global keyboard listener: ⌘K / Ctrl+K toggles, Escape closes.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const isToggle =
        (event.key === 'k' || event.key === 'K') &&
        (event.metaKey || event.ctrlKey);

      if (isToggle) {
        // When open, ⌘K always closes (even from the palette's own input).
        if (openRef.current) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          return;
        }
        // When closed, do not steal the keystroke from a text-entry context.
        if (isTypingTarget(event.target)) return;
        event.preventDefault();
        setOpen(true);
        return;
      }

      // While open, swallow Escape so nested overlays don't also react to it.
      if (event.key === 'Escape' && openRef.current) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setOpen]);

  // Move focus into the search input on open (so type-to-filter / arrows /
  // Enter work immediately without a click); restore focus to the previously
  // focused element on close. Also (re)load Recents from storage on open.
  useEffect(() => {
    if (open) {
      previouslyFocusedRef.current =
        (document.activeElement as HTMLElement | null) ?? null;
      inputRef.current?.focus();
      setSearch('');
      setRecents(loadRecents());
    } else if (previouslyFocusedRef.current) {
      previouslyFocusedRef.current.focus?.();
      previouslyFocusedRef.current = null;
    }
  }, [open]);

  const runCommand = useCallback(
    (action: () => void, recent?: RecentEntry) => {
      if (recent) setRecents((prev) => pushRecent(prev, recent));
      setOpen(false);
      action();
    },
    [setOpen]
  );

  const handleSyncRepositories = useCallback(async () => {
    try {
      await repositoryApi.sync();
      await worktreesCache?.refresh?.();
      showToast(t('actions.syncSuccess'), 'success');
    } catch {
      showToast(t('actions.syncError'), 'error');
    }
  }, [worktreesCache, showToast, t]);

  const isDark = theme === 'dark';
  const isEmptyQuery = search.trim() === '';

  const worktreesError = worktreesCache?.error ?? null;
  const worktreesLoading = worktreesCache?.isLoading ?? false;
  // On error, fall back to Navigation-only (the cache keeps polling and will
  // repopulate the group once a later poll succeeds).
  const worktrees = worktreesError ? [] : worktreesCache?.worktrees ?? [];
  const showWorktrees = worktrees.length > 0;
  const showWorktreesLoading =
    !worktreesError && worktreesLoading && worktrees.length === 0;

  const sortedWorktrees = sortWorktrees(worktrees);
  const visibleWorktrees = isEmptyQuery
    ? sortedWorktrees.slice(0, WORKTREES_EMPTY_LIMIT)
    : sortedWorktrees;

  // Actions available in the current context (mobile hides display-size).
  const actions: ActionDescriptor[] = [
    {
      id: 'theme',
      label: isDark ? t('actions.toLight') : t('actions.toDark'),
      icon: isDark ? Sun : Moon,
      run: () => setTheme(isDark ? 'light' : 'dark'),
    },
    ...(!isMobile
      ? PC_DISPLAY_SIZE_ORDER.map((size) => ({
          id: `displaysize:${size}`,
          label: `${t('actions.displaySizePrefix')}: ${tCommon(`displaySize.${size}`)}`,
          icon: Monitor,
          run: () => setSize(size),
        }))
      : []),
    {
      id: 'sync',
      label: t('actions.syncRepositories'),
      icon: RefreshCw,
      run: () => {
        void handleSyncRepositories();
      },
    },
    {
      id: 'locale',
      label: t('actions.switchLanguage'),
      icon: Languages,
      run: () => switchLocale(currentLocale === 'ja' ? 'en' : 'ja'),
    },
    {
      id: 'github',
      label: t('actions.openGitHub'),
      icon: Github,
      run: () =>
        window.open(
          'https://github.com/kewton/MyCodeBranchDesk',
          '_blank',
          'noopener,noreferrer'
        ),
    },
    {
      // Issue #1130: opens the `?` keyboard-shortcuts help overlay.
      id: 'keyboardShortcuts',
      label: t('actions.keyboardShortcuts'),
      icon: Keyboard,
      run: () => setShortcutsOpen(true),
    },
  ];

  // Resolve Recent entries against the CURRENT data; skip dead entries
  // (removed worktrees, actions unavailable in this context).
  const recentRows: RecentRow[] = isEmptyQuery
    ? recents
        .map((entry): RecentRow | null => {
          if (entry.kind === 'nav') {
            const nav = NAV_ITEMS.find((n) => n.key === entry.id);
            if (!nav) return null;
            const Icon = NAV_ICONS[nav.key];
            const label = tCommon(`nav.${nav.key}`);
            return {
              id: `nav-${nav.key}`,
              value: `recent nav ${nav.key}`,
              node: (
                <>
                  {Icon && <Icon size={16} className={ICON_CLASS} aria-hidden="true" />}
                  <span className="truncate">{label}</span>
                </>
              ),
              onSelect: () =>
                runCommand(() => router.push(nav.href), { kind: 'nav', id: nav.key }),
            };
          }
          if (entry.kind === 'worktree') {
            const wt = worktrees.find((w) => w.id === entry.id);
            if (!wt) return null;
            const repo = wt.repositoryDisplayName || wt.repositoryName || '';
            const branch = wt.branch || wt.name;
            return {
              id: `worktree-${wt.id}`,
              value: `recent worktree ${wt.id}`,
              node: (
                <>
                  <GitBranch size={16} className={ICON_CLASS} aria-hidden="true" />
                  <span className="truncate">{branch}</span>
                  {repo && (
                    <span className="ml-auto truncate pl-2 text-xs text-muted-foreground">
                      {repo}
                    </span>
                  )}
                  <StatusDot
                    status={worktreeStatus(wt)}
                    size="sm"
                    className={repo ? 'ml-2' : 'ml-auto'}
                  />
                </>
              ),
              onSelect: () =>
                runCommand(() => router.push(`/worktrees/${wt.id}`), {
                  kind: 'worktree',
                  id: wt.id,
                }),
            };
          }
          const action = actions.find((a) => a.id === entry.id);
          if (!action) return null;
          const Icon = action.icon;
          return {
            id: `action-${action.id}`,
            value: `recent action ${action.id}`,
            node: (
              <>
                <Icon size={16} className={ICON_CLASS} aria-hidden="true" />
                <span className="truncate">{action.label}</span>
              </>
            ),
            onSelect: () =>
              runCommand(action.run, { kind: 'action', id: action.id }),
          };
        })
        .filter((row): row is RecentRow => row !== null)
    : [];

  if (!mounted) return null;

  return createPortal(
    <>
      {open && (
        <div
          className="fixed inset-0 overflow-y-auto"
          style={{ zIndex: Z_INDEX.MODAL }}
          data-testid="command-palette"
        >
          {/* Backdrop — fade-in on mount (shared motion tokens, Issue #1050). */}
          <div
            data-state="open"
            aria-hidden="true"
            className="fixed inset-0 bg-black/40 backdrop-blur-sm transition-opacity data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-200"
            onClick={() => setOpen(false)}
          />

          <div className="relative flex min-h-full items-start justify-center p-4 pt-[15vh]">
            <div
              data-state="open"
              data-testid="command-palette-panel"
              className={cn(
                'relative w-full max-w-lg overflow-hidden rounded-xl bg-surface/95 shadow-2xl ring-1 ring-border backdrop-blur-xl',
                'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:duration-200'
              )}
            >
              <Command
                label={t('title')}
                className={cn(
                  'flex flex-col',
                  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2',
                  '[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground'
                )}
              >
                <div className="flex items-center gap-2 border-b border-border px-3">
                  <Search
                    size={16}
                    strokeWidth={2}
                    aria-hidden="true"
                    className="shrink-0 text-muted-foreground"
                  />
                  <Command.Input
                    ref={inputRef}
                    value={search}
                    onValueChange={setSearch}
                    placeholder={t('placeholder')}
                    data-testid="command-palette-input"
                    className="flex-1 bg-transparent py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
                  />
                </div>

                <Command.List className="max-h-[min(60vh,360px)] overflow-y-auto p-2">
                  <Command.Empty
                    data-testid="command-palette-empty"
                    className="py-6 text-center text-sm text-muted-foreground"
                  >
                    {t('empty')}
                  </Command.Empty>

                  {showWorktreesLoading && (
                    <Command.Loading
                      data-testid="command-palette-loading"
                      className="py-6 text-center text-sm text-muted-foreground"
                    >
                      {t('loading')}
                    </Command.Loading>
                  )}

                  {recentRows.length > 0 && (
                    <Command.Group heading={t('groups.recent')}>
                      {recentRows.map((row) => (
                        <Command.Item
                          key={row.id}
                          value={row.value}
                          onSelect={row.onSelect}
                          className={ITEM_CLASS}
                        >
                          {row.node}
                        </Command.Item>
                      ))}
                    </Command.Group>
                  )}

                  <Command.Group heading={t('groups.navigation')}>
                    {NAV_ITEMS.map((item) => {
                      const label = tCommon(`nav.${item.key}`);
                      const Icon = NAV_ICONS[item.key];
                      return (
                        <Command.Item
                          key={item.key}
                          value={`nav ${label} ${item.href}`}
                          onSelect={() =>
                            runCommand(() => router.push(item.href), {
                              kind: 'nav',
                              id: item.key,
                            })
                          }
                          className={ITEM_CLASS}
                        >
                          {Icon && (
                            <Icon size={16} className={ICON_CLASS} aria-hidden="true" />
                          )}
                          <span className="truncate">{label}</span>
                        </Command.Item>
                      );
                    })}
                  </Command.Group>

                  {showWorktrees && (
                    <Command.Group heading={t('groups.worktrees')}>
                      {visibleWorktrees.map((wt) => {
                        const repo =
                          wt.repositoryDisplayName || wt.repositoryName || '';
                        const branch = wt.branch || wt.name;
                        return (
                          <Command.Item
                            key={wt.id}
                            value={`worktree ${repo} ${branch} ${wt.name} ${wt.id}`}
                            onSelect={() =>
                              runCommand(() => router.push(`/worktrees/${wt.id}`), {
                                kind: 'worktree',
                                id: wt.id,
                              })
                            }
                            className={ITEM_CLASS}
                          >
                            <GitBranch
                              size={16}
                              className={ICON_CLASS}
                              aria-hidden="true"
                            />
                            <span className="truncate">{branch}</span>
                            {repo && (
                              <span className="ml-auto truncate pl-2 text-xs text-muted-foreground">
                                {repo}
                              </span>
                            )}
                            <StatusDot
                              status={worktreeStatus(wt)}
                              size="sm"
                              className={repo ? 'ml-2' : 'ml-auto'}
                            />
                          </Command.Item>
                        );
                      })}
                    </Command.Group>
                  )}

                  <Command.Group heading={t('groups.actions')}>
                    {actions.map((action) => {
                      const Icon = action.icon;
                      return (
                        <Command.Item
                          key={action.id}
                          value={`action ${action.id} ${action.label}`}
                          onSelect={() =>
                            runCommand(action.run, {
                              kind: 'action',
                              id: action.id,
                            })
                          }
                          className={ITEM_CLASS}
                        >
                          <Icon size={16} className={ICON_CLASS} aria-hidden="true" />
                          <span className="truncate">{action.label}</span>
                        </Command.Item>
                      );
                    })}
                  </Command.Group>
                </Command.List>

                {/* Keyboard hint footer (Issue #1077). */}
                <div className="flex items-center gap-3 border-t border-border bg-surface-2 px-3 py-2 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Kbd>↑</Kbd>
                    <Kbd>↓</Kbd>
                    {t('footer.navigate')}
                  </span>
                  <span className="flex items-center gap-1">
                    <Kbd>↵</Kbd>
                    {t('footer.select')}
                  </span>
                  <span className="flex items-center gap-1">
                    <Kbd>esc</Kbd>
                    {t('footer.close')}
                  </span>
                </div>
              </Command>
            </div>
          </div>
        </div>
      )}

      {/* Persistent so a toast (e.g. Sync repositories) survives the palette
          closing after the command runs. */}
      <ToastContainer toasts={toasts} onClose={removeToast} />
    </>,
    document.body
  );
}

export default CommandPalette;
