/**
 * CommandPalette (Issue #1053)
 *
 * A global ⌘K / Ctrl+K command palette (cmdk) mounted once under AppShell.
 * Provides three command groups:
 *   - Navigation: jump to the main screens.
 *   - Worktrees: incremental search over repository + branch, read from the
 *     shared WorktreesCache (always fresh + auto-retried, single poller per
 *     Issue #709); the group is omitted while the cache reports an error.
 *   - Actions: theme toggle and PC display-size switching.
 *
 * The single global keyboard listener lives here so it does not conflict with
 * existing per-view shortcuts. It never opens while the user is typing in an
 * input/textarea/contentEditable or the worktree terminal pane (role="log").
 *
 * SSR-safe: 'use client', and `document` is only referenced after mount inside
 * an effect / the portal (which renders only when `mounted && open`).
 */

'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { Command } from 'cmdk';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { Z_INDEX } from '@/config/z-index';
import { useCommandPalette } from '@/contexts/CommandPaletteContext';
import { usePcDisplaySizeContext } from '@/contexts/PcDisplaySizeContext';
import { useOptionalWorktreesCacheContext } from '@/components/providers/WorktreesCacheProvider';
import { PC_DISPLAY_SIZE_ORDER } from '@/hooks/usePcDisplaySize';

/** Navigation targets shown in the palette (mirrors Header / GlobalMobileNav). */
const NAV_ITEMS = [
  { key: 'home', href: '/' },
  { key: 'chat', href: '/chat' },
  { key: 'sessions', href: '/sessions' },
  { key: 'repositories', href: '/repositories' },
  { key: 'review', href: '/review' },
  { key: 'more', href: '/more' },
] as const;

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
  'text-gray-700 dark:text-gray-200',
  'data-[selected=true]:bg-accent-600/10 data-[selected=true]:text-accent-700',
  'dark:data-[selected=true]:text-accent-300'
);

/**
 * Global command palette. Renders nothing until opened.
 */
export function CommandPalette() {
  const { open, setOpen } = useCommandPalette();
  const router = useRouter();
  const t = useTranslations('commandPalette');
  const tCommon = useTranslations('common');
  const { theme, setTheme } = useTheme();
  const { setSize, isMobile } = usePcDisplaySizeContext();
  // Read from the shared worktrees cache (always fresh + auto-retried). Optional
  // so the palette degrades gracefully when no provider is present (unit tests).
  const worktreesCache = useOptionalWorktreesCacheContext();

  const [mounted, setMounted] = useState(false);
  const [search, setSearch] = useState('');

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
  // focused element on close.
  useEffect(() => {
    if (open) {
      previouslyFocusedRef.current =
        (document.activeElement as HTMLElement | null) ?? null;
      inputRef.current?.focus();
    } else if (previouslyFocusedRef.current) {
      previouslyFocusedRef.current.focus?.();
      previouslyFocusedRef.current = null;
    }
  }, [open]);

  // Reset the query each time the palette opens.
  useEffect(() => {
    if (open) setSearch('');
  }, [open]);

  const runCommand = useCallback(
    (action: () => void) => {
      setOpen(false);
      action();
    },
    [setOpen]
  );

  if (!mounted || !open) return null;

  const isDark = theme === 'dark';
  const worktrees = worktreesCache?.worktrees ?? [];
  const worktreesError = worktreesCache?.error ?? null;
  const worktreesLoading = worktreesCache?.isLoading ?? false;
  // On error, fall back to Navigation-only (the cache keeps polling and will
  // repopulate the group once a later poll succeeds).
  const showWorktrees = !worktreesError && worktrees.length > 0;
  const showWorktreesLoading =
    !worktreesError && worktreesLoading && worktrees.length === 0;

  return createPortal(
    <div
      className="fixed inset-0 overflow-y-auto"
      style={{ zIndex: Z_INDEX.MODAL }}
      data-testid="command-palette"
    >
      {/* Backdrop — fade-in on mount (shared motion tokens, Issue #1050). */}
      <div
        data-state="open"
        aria-hidden="true"
        className="fixed inset-0 bg-black bg-opacity-50 transition-opacity data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-200"
        onClick={() => setOpen(false)}
      />

      <div className="relative flex min-h-full items-start justify-center p-4 pt-[15vh]">
        <div
          data-state="open"
          data-testid="command-palette-panel"
          className={cn(
            'relative w-full max-w-lg overflow-hidden rounded-lg border border-border bg-white shadow-xl dark:bg-gray-900',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:duration-200'
          )}
        >
          <Command
            label={t('title')}
            className={cn(
              'flex flex-col',
              '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2',
              '[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-gray-500'
            )}
          >
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search size={16} strokeWidth={2} aria-hidden="true" className="shrink-0 text-gray-400" />
              <Command.Input
                ref={inputRef}
                value={search}
                onValueChange={setSearch}
                placeholder={t('placeholder')}
                data-testid="command-palette-input"
                className="flex-1 bg-transparent py-3 text-sm text-gray-900 outline-none placeholder:text-gray-400 dark:text-gray-100"
              />
            </div>

            <Command.List className="max-h-[min(60vh,360px)] overflow-y-auto p-2">
              <Command.Empty
                data-testid="command-palette-empty"
                className="py-6 text-center text-sm text-gray-500"
              >
                {t('empty')}
              </Command.Empty>

              {showWorktreesLoading && (
                <Command.Loading
                  data-testid="command-palette-loading"
                  className="py-6 text-center text-sm text-gray-500"
                >
                  {t('loading')}
                </Command.Loading>
              )}

              <Command.Group heading={t('groups.navigation')}>
                {NAV_ITEMS.map((item) => {
                  const label = t(`nav.${item.key}`);
                  return (
                    <Command.Item
                      key={item.key}
                      value={`nav ${label} ${item.href}`}
                      onSelect={() => runCommand(() => router.push(item.href))}
                      className={ITEM_CLASS}
                    >
                      {label}
                    </Command.Item>
                  );
                })}
              </Command.Group>

              {showWorktrees && (
                <Command.Group heading={t('groups.worktrees')}>
                  {worktrees.map((wt) => {
                    const repo = wt.repositoryDisplayName || wt.repositoryName || '';
                    const branch = wt.branch || wt.name;
                    return (
                      <Command.Item
                        key={wt.id}
                        value={`worktree ${repo} ${branch} ${wt.name} ${wt.id}`}
                        onSelect={() =>
                          runCommand(() => router.push(`/worktrees/${wt.id}`))
                        }
                        className={ITEM_CLASS}
                      >
                        <span className="truncate">{branch}</span>
                        {repo && (
                          <span className="ml-auto truncate pl-2 text-xs text-gray-400">
                            {repo}
                          </span>
                        )}
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              )}

              <Command.Group heading={t('groups.actions')}>
                <Command.Item
                  value={`action theme ${isDark ? 'light' : 'dark'}`}
                  onSelect={() =>
                    runCommand(() => setTheme(isDark ? 'light' : 'dark'))
                  }
                  className={ITEM_CLASS}
                >
                  {isDark ? t('actions.toLight') : t('actions.toDark')}
                </Command.Item>

                {!isMobile &&
                  PC_DISPLAY_SIZE_ORDER.map((size) => (
                    <Command.Item
                      key={size}
                      value={`action displaysize ${size} ${tCommon(`displaySize.${size}`)}`}
                      onSelect={() => runCommand(() => setSize(size))}
                      className={ITEM_CLASS}
                    >
                      {t('actions.displaySizePrefix')}: {tCommon(`displaySize.${size}`)}
                    </Command.Item>
                  ))}
              </Command.Group>
            </Command.List>
          </Command>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default CommandPalette;
