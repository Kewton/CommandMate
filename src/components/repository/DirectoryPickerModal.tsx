/**
 * DirectoryPickerModal (Issue #1517)
 *
 * Browses the *server's* filesystem, because that is where the repository lives:
 * `showDirectoryPicker()` returns a handle without an absolute path and
 * `<input webkitdirectory>` only yields relative names, and the server may not
 * even be the machine running the browser.
 *
 * Navigation is one level at a time with a breadcrumb, and the folder currently
 * shown is the one "Select this folder" returns. It rides on `ui/Modal`, which
 * owns the portal, ESC handling and the `useFocusTrap` contract; the picker adds
 * no focus management of its own so it cannot break the Issue #1127 invariant.
 */

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight, CornerLeftUp, Folder, GitBranch } from 'lucide-react';
import { Badge, Button, Modal, Spinner } from '@/components/ui';
import { fsApi, handleApiError, type BrowseResponse } from '@/lib/api-client';

export interface DirectoryPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the absolute path of the folder the user confirmed. */
  onSelect: (absolutePath: string) => void;
  /** Open here instead of the most recently used directory. */
  initialPath?: string;
}

/** 44px minimum touch target (Issue #1080 mobile baseline). */
const ROW_CLASS =
  'w-full min-h-[44px] flex items-center gap-2 px-3 py-2 rounded-md text-left '
  + 'text-sm text-foreground hover:bg-muted transition-colors touch-manipulation';

interface Crumb {
  label: string;
  path: string | null;
}

/**
 * Breadcrumb from the containing root down to `currentPath`. The first crumb is
 * the roots listing (`path: null`) so the user can switch roots but never walk
 * above one.
 */
function buildCrumbs(currentPath: string | null, roots: string[]): Crumb[] {
  const crumbs: Crumb[] = [{ label: '/', path: null }];
  if (!currentPath) return crumbs;

  const owningRoot = roots
    .filter((root) => currentPath === root || currentPath.startsWith(`${root}/`))
    .sort((a, b) => b.length - a.length)[0];

  if (!owningRoot) {
    crumbs.push({ label: currentPath, path: currentPath });
    return crumbs;
  }

  crumbs.push({ label: owningRoot, path: owningRoot });

  const remainder = currentPath.slice(owningRoot.length).split('/').filter(Boolean);
  let walked = owningRoot;
  for (const segment of remainder) {
    walked = `${walked}/${segment}`;
    crumbs.push({ label: segment, path: walked });
  }

  return crumbs;
}

export function DirectoryPickerModal({
  isOpen,
  onClose,
  onSelect,
  initialPath,
}: DirectoryPickerModalProps) {
  const t = useTranslations('common');
  const [listing, setListing] = useState<BrowseResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const navigate = useCallback(async (target?: string) => {
    setIsLoading(true);
    setError(null);
    try {
      setListing(await fsApi.browse(target));
    } catch (err) {
      setError(handleApiError(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;

    const open = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const roots = await fsApi.browse(initialPath);
        if (cancelled) return;

        // With no caller-supplied path, reopen where the user left off. The
        // stored path can have been deleted since, so fall back to the roots.
        const resumeAt = !initialPath ? roots.recentPaths[0] : undefined;
        if (resumeAt) {
          try {
            const resumed = await fsApi.browse(resumeAt);
            if (!cancelled) setListing(resumed);
            return;
          } catch {
            if (cancelled) return;
          }
        }

        setListing(roots);
      } catch (err) {
        if (!cancelled) setError(handleApiError(err));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void open();
    return () => {
      cancelled = true;
    };
  }, [isOpen, initialPath]);

  const handleSelect = useCallback(async () => {
    const selected = listing?.path;
    if (!selected) return;
    // Best-effort: the selection must not fail because the MRU write failed.
    await fsApi.addRecentPath(selected).catch(() => undefined);
    onSelect(selected);
    onClose();
  }, [listing?.path, onSelect, onClose]);

  const crumbs = buildCrumbs(listing?.path ?? null, listing?.roots ?? []);
  const atRootListing = listing !== null && listing.path === null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('repositories.pickerTitle')} size="full">
      {/* Near-viewport height on phones so the picker reads as a full-screen
          sheet, a fixed panel on desktop. */}
      <div className="flex flex-col h-[calc(100vh-12rem)] md:h-[26rem]">
        {/* Breadcrumb */}
        <nav
          aria-label={t('repositories.pickerTitle')}
          className="flex items-center flex-wrap gap-1 pb-2 border-b border-border text-xs"
        >
          {crumbs.map((crumb, index) => (
            <React.Fragment key={crumb.path ?? 'roots'}>
              {index > 0 && (
                <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" aria-hidden />
              )}
              <button
                type="button"
                onClick={() => void navigate(crumb.path ?? undefined)}
                disabled={index === crumbs.length - 1}
                className="min-h-[32px] px-1.5 rounded font-mono text-muted-foreground hover:text-foreground hover:bg-muted disabled:text-foreground disabled:font-semibold disabled:hover:bg-transparent touch-manipulation"
              >
                {crumb.label}
              </button>
            </React.Fragment>
          ))}
        </nav>

        <div className="flex-1 min-h-0 overflow-y-auto py-2">
          {isLoading && (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
              <Spinner size="sm" />
              {t('repositories.pickerLoading')}
            </div>
          )}

          {!isLoading && error && (
            <p className="px-3 py-2 text-sm text-danger-foreground">{error}</p>
          )}

          {!isLoading && !error && listing && (
            <>
              {atRootListing && listing.recentPaths.length > 0 && (
                <div className="mb-3">
                  <p className="px-3 pb-1 text-xs font-medium text-muted-foreground">
                    {t('repositories.pickerRecentLabel')}
                  </p>
                  {listing.recentPaths.map((recent) => (
                    <button
                      key={recent}
                      type="button"
                      onClick={() => void navigate(recent)}
                      className={ROW_CLASS}
                    >
                      <Folder className="w-4 h-4 text-muted-foreground flex-shrink-0" aria-hidden />
                      <span className="font-mono truncate">{recent}</span>
                    </button>
                  ))}
                </div>
              )}

              {atRootListing && (
                <p className="px-3 pb-1 text-xs font-medium text-muted-foreground">
                  {t('repositories.pickerRootsLabel')}
                </p>
              )}

              {listing.parent && (
                <button
                  type="button"
                  onClick={() => void navigate(listing.parent ?? undefined)}
                  className={ROW_CLASS}
                >
                  <CornerLeftUp className="w-4 h-4 text-muted-foreground flex-shrink-0" aria-hidden />
                  {t('repositories.pickerUp')}
                </button>
              )}

              {listing.entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => void navigate(entry.path)}
                  className={ROW_CLASS}
                >
                  <Folder className="w-4 h-4 text-muted-foreground flex-shrink-0" aria-hidden />
                  <span className="font-mono truncate flex-1">{entry.name}</span>
                  {entry.isGitRepo && (
                    <Badge variant="info" className="flex-shrink-0">
                      <GitBranch className="w-3 h-3 mr-1" aria-hidden />
                      {entry.worktreeCount === null
                        ? 'git'
                        : t('repositories.pickerWorktreeCount', { count: entry.worktreeCount })}
                    </Badge>
                  )}
                </button>
              ))}

              {listing.entries.length === 0 && (
                <p className="px-3 py-2 text-sm text-muted-foreground">
                  {t('repositories.pickerEmpty')}
                </p>
              )}

              {listing.truncated && (
                <p className="px-3 py-2 text-xs text-warning-foreground">
                  {t('repositories.pickerTruncated', { limit: listing.entryLimit })}
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex gap-2 pt-2 border-t border-border">
          <Button
            type="button"
            variant="primary"
            onClick={() => void handleSelect()}
            disabled={!listing?.path}
            className="min-h-[44px]"
          >
            {t('repositories.pickerSelectHere')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose} className="min-h-[44px]">
            {t('cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
