/**
 * OpenCode session controls (Issue #2038, share added by Issue #2051)
 *
 * The session operations opencode has and no other supported agent does,
 * rendered beside the composer for opencode instances only:
 *
 *   - **New session** — `POST /tui/execute-command { command: "session_new" }`
 *   - **Session list** — `POST /tui/open-sessions`, opencode's own picker
 *   - **Fork** — `POST /session/:id/fork`, then `select-session` so the pane
 *     actually moves to the branch
 *   - **Share / unshare** — `POST` / `DELETE /session/:id/share` (#2051)
 *
 * The first three go through `POST /api/worktrees/:id/opencode/session`, which
 * holds the port lookup and the measured caveats; see that route for why the
 * session *list* is opencode's dialog rather than a list this UI renders
 * (`GET /session` is HOME-wide, measured on 1.18.22).
 *
 * ## Share is not like the other three
 *
 * The other three are local: they move a pane between conversations on the
 * operator's own machine. Share **publishes the conversation to the public
 * internet** under the operator's credentials, and — measured on 1.18.22 — the
 * page it produces is *unredacted*: the prompts, the replies and the session's
 * absolute directory path were all present in the HTML. So it differs here in
 * three ways, each of them deliberate:
 *
 * 1. It is behind a `ConfirmDialog` whose body says, in as many words, that
 *    anyone with the link can read the conversation. The other three ask
 *    nothing.
 * 2. It is not rendered at all until `GET …/opencode/share` says `canShare`.
 *    opencode's own refusal is a bare HTTP 500 with no machine-readable code
 *    (see the route), so the button's absence is the only way the `share:
 *    "disabled"` setting can be honoured.
 * 3. Its result is *state*, not a fire-and-forget action: the minted URL is put
 *    on screen with a copy control and a revoke beside it, because a link the
 *    operator cannot see is a link they cannot take down.
 *
 * ## Why this component fetches for itself
 *
 * `canShare` needs a request, and this component's call sites
 * (`MessageInput.tsx`, and #2054's panes) are owned elsewhere — adding a
 * required prop would mean editing them. One `GET` per mounted opencode
 * instance, issued only for opencode, is the smaller cost.
 *
 * ## Labels
 *
 * Now `next-intl` (`worktree.opencodeSession.*`). #2038 inlined a two-locale map
 * because its change scope excluded `locales/`, and left the move as a
 * follow-up; #2051 has `locales/` in scope and has to add dialog copy in both
 * languages anyway, so the map is gone rather than grown.
 */

'use client';

import React, { memo, useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy, GitFork, Link2, Link2Off, ListTree, MessageSquarePlus } from 'lucide-react';
import { Button, Spinner, useConfirm } from '@/components/ui';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { OpencodeShareState } from '@/types/opencode-share';

/** The actions the session route accepts. Mirrors `OPENCODE_SESSION_ACTIONS`. */
export type OpencodeSessionAction = 'new' | 'list' | 'fork';

/** Every control this component can show as busy. */
type PendingAction = OpencodeSessionAction | 'share' | 'unshare';

export interface OpencodeSessionControlsProps {
  worktreeId: string;
  /** Rendered only for `'opencode'`; anything else renders nothing at all. */
  cliToolId: CLIToolType;
  /** Agent instance id. Defaults to the primary instance (`=== cliToolId`). */
  instanceId?: string;
  /** Disabled while no session is running — every action needs a live server. */
  disabled?: boolean;
  /** Called after an action the server accepted. */
  onActionComplete?: (action: OpencodeSessionAction) => void;
}

export const OpencodeSessionControls = memo(function OpencodeSessionControls({
  worktreeId,
  cliToolId,
  instanceId,
  disabled = false,
  onActionComplete,
}: OpencodeSessionControlsProps) {
  const t = useTranslations('worktree.opencodeSession');
  const confirm = useConfirm();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [share, setShare] = useState<OpencodeShareState | null>(null);
  /**
   * The URL this session was published to in *this* view.
   *
   * Separate from `share.lastShareUrl` on purpose. Measured: a session keeps its
   * `share: { url }` after `DELETE`, across a server restart, for ever — so the
   * server's copy answers "was this ever published", not "is it published now".
   * This one is set on a publish and cleared on a revoke, so what the operator
   * sees tracks what they just did.
   */
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const isOpencode = cliToolId === 'opencode';
  const target = instanceId ?? cliToolId;

  const refreshShare = useCallback(async () => {
    if (!isOpencode) return;
    try {
      const response = await fetch(
        `/api/worktrees/${worktreeId}/opencode/share?instance=${encodeURIComponent(target)}`
      );
      if (!response.ok) {
        setShare(null);
        return;
      }
      setShare((await response.json()) as OpencodeShareState);
    } catch {
      // A share control that fails to appear is the safe failure: nothing is
      // published, and the other three buttons are unaffected.
      setShare(null);
    }
  }, [isOpencode, worktreeId, target]);

  useEffect(() => {
    void refreshShare();
  }, [refreshShare]);

  const run = useCallback(
    async (action: OpencodeSessionAction) => {
      setPending(action);
      try {
        const response = await fetch(`/api/worktrees/${worktreeId}/opencode/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, instanceId: target }),
        });
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}));
          console.error(
            '[OpencodeSessionControls] action failed:',
            action,
            detail.error || response.statusText
          );
          return;
        }
        onActionComplete?.(action);
        // `new` and `fork` move the pane to a different session, so the share
        // state that was read for the old one no longer describes it.
        if (action !== 'list') {
          setPublishedUrl(null);
          void refreshShare();
        }
      } catch (error) {
        console.error('[OpencodeSessionControls] request error:', error);
      } finally {
        setPending(null);
      }
    },
    [worktreeId, target, onActionComplete, refreshShare]
  );

  const onShare = useCallback(async () => {
    const ok = await confirm({
      title: t('shareConfirmTitle'),
      description: t('shareConfirmBody'),
      confirmLabel: t('shareConfirmLabel'),
      // `danger` because the step cannot be undone in the sense that matters:
      // revoking takes the page down, but not out of anyone's hands who read it.
      variant: 'danger',
    });
    if (!ok) return;

    setPending('share');
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/opencode/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId: target }),
      });
      const detail = (await response.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!response.ok || typeof detail.url !== 'string') {
        console.error(
          '[OpencodeSessionControls] share failed:',
          detail.error || response.statusText
        );
        // Re-read rather than assume: a 409 `SHARE_DISABLED` means the setting
        // changed under this view, and the button should now disappear.
        void refreshShare();
        return;
      }
      setPublishedUrl(detail.url);
      setCopied(false);
      void refreshShare();
    } catch (error) {
      console.error('[OpencodeSessionControls] share request error:', error);
    } finally {
      setPending(null);
    }
  }, [confirm, t, worktreeId, target, refreshShare]);

  const onUnshare = useCallback(async () => {
    setPending('unshare');
    try {
      const response = await fetch(
        `/api/worktrees/${worktreeId}/opencode/share?instance=${encodeURIComponent(target)}`,
        { method: 'DELETE' }
      );
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        console.error(
          '[OpencodeSessionControls] unshare failed:',
          detail.error || response.statusText
        );
        return;
      }
      setPublishedUrl(null);
      setCopied(false);
      void refreshShare();
    } catch (error) {
      console.error('[OpencodeSessionControls] unshare request error:', error);
    } finally {
      setPending(null);
    }
  }, [worktreeId, target, refreshShare]);

  const onCopy = useCallback(async () => {
    if (publishedUrl === null) return;
    try {
      await navigator.clipboard.writeText(publishedUrl);
      setCopied(true);
    } catch {
      // Clipboard access can be refused; the URL is on screen and selectable.
    }
  }, [publishedUrl]);

  // Not a runtime feature flag: every endpoint behind these buttons exists only
  // on opencode's server, so for any other tool there is nothing to render.
  if (!isOpencode) return null;

  const actions: { action: OpencodeSessionAction; icon: React.ReactNode }[] = [
    { action: 'new', icon: <MessageSquarePlus className="h-5 w-5" aria-hidden="true" /> },
    { action: 'list', icon: <ListTree className="h-5 w-5" aria-hidden="true" /> },
    { action: 'fork', icon: <GitFork className="h-5 w-5" aria-hidden="true" /> },
  ];

  const iconButtonClass =
    'flex-shrink-0 p-2 text-muted-foreground hover:text-accent-600 hover:bg-accent-50 ' +
    'dark:hover:text-accent-400 dark:hover:bg-accent-900/30 rounded-full transition-colors ' +
    'disabled:text-muted-foreground/50 disabled:hover:bg-transparent';

  return (
    <div className="flex items-center gap-1" data-testid="opencode-session-controls">
      {actions.map(({ action, icon }) => (
        <Button
          key={action}
          variant="ghost"
          type="button"
          onClick={() => void run(action)}
          disabled={disabled || pending !== null}
          className={iconButtonClass}
          aria-label={t(action)}
          title={t(action)}
          data-testid={`opencode-session-${action}`}
        >
          {pending === action ? <Spinner size="md" /> : icon}
        </Button>
      ))}

      {/* The share control appears only once the server has said it would
          accept one. `share: "disabled"` therefore renders nothing at all,
          which is the Issue's acceptance criterion. */}
      {share?.canShare ? (
        <Button
          variant="ghost"
          type="button"
          onClick={() => void onShare()}
          disabled={disabled || pending !== null}
          className={iconButtonClass}
          aria-label={t('share')}
          title={t('share')}
          data-testid="opencode-session-share"
        >
          {pending === 'share' ? (
            <Spinner size="md" />
          ) : (
            <Link2 className="h-5 w-5" aria-hidden="true" />
          )}
        </Button>
      ) : null}

      {publishedUrl !== null ? (
        <span
          className="flex min-w-0 items-center gap-1 rounded-full border border-warning-border bg-warning-subtle px-2 py-0.5 text-xs text-warning-foreground"
          data-testid="opencode-share-result"
        >
          {/* Stated every time the link is on screen, not only in the dialog:
              this is the state a reader needs in order to decide to revoke. */}
          <span className="sr-only">{t('sharePublicNotice')}</span>
          <a
            href={publishedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="truncate text-accent-600 underline dark:text-accent-400"
            title={publishedUrl}
            data-testid="opencode-share-url"
          >
            {publishedUrl}
          </a>
          <Button
            variant="ghost"
            type="button"
            onClick={() => void onCopy()}
            className="flex-shrink-0 rounded-full p-1 text-muted-foreground hover:text-accent-600"
            aria-label={t('shareCopy')}
            title={t('shareCopy')}
            data-testid="opencode-share-copy"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={() => void onUnshare()}
            disabled={pending !== null}
            className="flex-shrink-0 rounded-full p-1 text-muted-foreground hover:text-danger-foreground"
            aria-label={t('unshare')}
            title={t('unshare')}
            data-testid="opencode-session-unshare"
          >
            {pending === 'unshare' ? (
              <Spinner size="sm" />
            ) : (
              <Link2Off className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </Button>
        </span>
      ) : null}
    </div>
  );
});
