/**
 * WhatsNewDialog
 * Issue #2651: "What's new" after the app was updated.
 *
 * Compares the bundle version (NEXT_PUBLIC_APP_VERSION) with the version this
 * browser last acknowledged (localStorage). When the bundle is newer, fetches
 * the bundled release notes for the gap and opens a dialog; closing it records
 * the current version. Text follows the UI locale (ja → ja, otherwise en) and
 * is plain text — never rendered as Markdown or HTML.
 *
 * Mounted by AppShell in both the mobile and the desktop branch.
 *
 * Known limitation: a browser with no stored version (first visit, or an
 * update from a release that predates this dialog) only records the current
 * version and shows nothing; the dialog appears from the next update on.
 * The record is per browser, so another browser, a private window or cleared
 * site data is treated as a first visit too.
 *
 * @module components/common/WhatsNewDialog
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { appApi } from '@/lib/api-client';
import type { LocalizedText, ReleaseNote } from '@/lib/app-update/release-notes';
// Pure, dependency-free helpers; safe in the client bundle.
import { compareVersions, isComparableVersion } from '@/cli/utils/semver';

/** localStorage key of the version this browser last acknowledged */
export const LAST_SEEN_APP_VERSION_STORAGE_KEY = 'commandmate.lastSeenAppVersion';

/** GitHub release page of a version: `${RELEASE_TAG_URL_PREFIX}${version}` */
export const RELEASE_TAG_URL_PREFIX = 'https://github.com/Kewton/CommandMate/releases/tag/v';

/** What to do on mount */
export type WhatsNewDecision =
  /** Touch nothing */
  | { kind: 'none' }
  /** Store the current version and show nothing */
  | { kind: 'remember' }
  /** Fetch notes for (from, current] and open the dialog */
  | { kind: 'show'; from: string };

/**
 * @param stored - localStorage value (null when absent)
 * @param current - NEXT_PUBLIC_APP_VERSION ('' when unset)
 */
export function decideWhatsNew(stored: string | null, current: string): WhatsNewDecision {
  if (!isComparableVersion(current)) return { kind: 'none' };
  if (stored === null || !isComparableVersion(stored)) return { kind: 'remember' };
  const order = compareVersions(current, stored);
  if (order === 0) return { kind: 'none' };
  if (order < 0) return { kind: 'remember' };
  return { kind: 'show', from: stored };
}

function writeLastSeenVersion(version: string): void {
  try {
    window.localStorage.setItem(LAST_SEEN_APP_VERSION_STORAGE_KEY, version);
  } catch {
    // Storage unavailable (private mode, quota): the dialog simply shows again next time.
  }
}

/** Sections under each version, in display order */
const NOTE_SECTIONS = [
  { key: 'added', labelKey: 'whatsNew.added' },
  { key: 'improved', labelKey: 'whatsNew.improved' },
  { key: 'fixed', labelKey: 'whatsNew.fixed' },
] as const;

interface WhatsNewView {
  from: string;
  to: string;
  notes: ReleaseNote[];
}

export function WhatsNewDialog() {
  const t = useTranslations('common');
  const locale = useLocale();
  const [view, setView] = useState<WhatsNewView | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const current = process.env.NEXT_PUBLIC_APP_VERSION ?? '';
    let stored: string | null;
    try {
      stored = window.localStorage.getItem(LAST_SEEN_APP_VERSION_STORAGE_KEY);
    } catch {
      return;
    }

    const decision = decideWhatsNew(stored, current);
    if (decision.kind === 'none') return;
    if (decision.kind === 'remember') {
      writeLastSeenVersion(current);
      return;
    }

    let cancelled = false;
    appApi.getReleaseNotes(decision.from, current).then(
      (response) => {
        if (cancelled) return;
        setView({ from: decision.from, to: current, notes: response.notes });
        setOpen(true);
      },
      () => {
        // Fetch failed: show nothing and keep the stored version, so the next mount retries.
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const handleClose = useCallback(() => {
    if (view) writeLastSeenVersion(view.to);
    setOpen(false);
  }, [view]);

  // Kept after closing so the Modal's exit animation still has content.
  if (!view) return null;

  const lang: keyof LocalizedText = locale === 'ja' ? 'ja' : 'en';

  return (
    <Modal
      isOpen={open}
      onClose={handleClose}
      title={t('whatsNew.title', { from: view.from, to: view.to })}
      size="md"
    >
      <div className="space-y-4" data-testid="whats-new-dialog">
        {view.notes.length === 0 ? (
          <p className="text-sm text-foreground" data-testid="whats-new-empty">
            {t('whatsNew.empty')}
          </p>
        ) : (
          view.notes.map((note) => (
            <section
              key={note.version}
              className="space-y-3"
              data-testid={`whats-new-version-${note.version}`}
            >
              <h4 className="text-sm font-semibold text-foreground">
                v{note.version}
                <span className="ml-2 text-xs font-normal text-muted-foreground">{note.date}</span>
              </h4>
              {note.highlight && (
                <div data-testid="whats-new-highlight">
                  <h5 className="text-xs font-medium text-muted-foreground">
                    {t('whatsNew.highlight')}
                  </h5>
                  <p className="mt-1 text-sm text-foreground">{note.highlight[lang]}</p>
                </div>
              )}
              {NOTE_SECTIONS.map(({ key, labelKey }) =>
                note[key].length > 0 ? (
                  <div key={key} data-testid={`whats-new-${key}`}>
                    <h5 className="text-xs font-medium text-muted-foreground">{t(labelKey)}</h5>
                    <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-foreground">
                      {note[key].map((item, index) => (
                        <li key={index}>{item[lang]}</li>
                      ))}
                    </ul>
                  </div>
                ) : null
              )}
            </section>
          ))
        )}
        <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
          <a
            href={`${RELEASE_TAG_URL_PREFIX}${view.to}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-accent-600 dark:text-accent-400 hover:underline"
            data-testid="whats-new-release-link"
          >
            {t('whatsNew.releaseLink')}
          </a>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={handleClose}
            data-testid="whats-new-close"
          >
            {t('whatsNew.close')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
