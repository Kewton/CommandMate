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
 *
 * ## Failures reach the screen (Issue #2109)
 *
 * Until #2109 every failure here ended at `console.error`. The only feedback a
 * press produced was the `pending` spinner, so a refusal looked exactly like a
 * button that does nothing: the spinner appeared for one frame and left.
 *
 * The routes behind these controls do not fail vaguely — they answer 409 with a
 * machine-readable `code`, verified against the route sources on 2026-08-27:
 *
 * | code | emitted by | means |
 * | --- | --- | --- |
 * | `NO_OPENCODE_PORT` | session + share, both verbs | no server on this pane |
 * | `NO_OPENCODE_SESSION` | session (`fork` only), share, unshare | nothing to act on yet |
 * | `SHARE_DISABLED` / `SHARE_REFUSED` | share `POST` | opencode said no |
 *
 * So the two codes the operator can actually do something about get a sentence
 * of their own, and everything else passes the route's `error` string through
 * unaltered — the same rule the sidebar's sync button follows.
 *
 * ### What the two 409s actually cost, measured
 *
 * Measured on opencode 1.18.23 (2026-08-27) against a CommandMate dev server in
 * an isolated `HOME` on a private tmux socket:
 *
 *   - **`NO_OPENCODE_PORT` reproduces trivially and #2108 will not remove it.**
 *     A pane that is *running* with no opencode server behind it — stopped
 *     server, or launched with `CM_AGENT_HOOKS_INJECT=0` — answers 409 with this
 *     code for all three of `new`, `list` and `fork`, while the buttons stay
 *     enabled because `disabled` tracks the tmux session, not the HTTP server.
 *   - **`NO_OPENCODE_SESSION` is rarer than "a pane that has not run a turn".**
 *     A freshly launched pane that has completed no turn still forks with 200:
 *     CommandMate's own launcher writes an entry into the session store, so
 *     `resolveOpencodeCurrentSessionId` answers from there. It returns null only
 *     when *both* its sources are empty — no observed agent-event session and no
 *     remembered one — which is a server CommandMate did not launch, or a store
 *     that was cleared. The share and unshare paths use the same resolver, so
 *     the code reaches this component from three routes regardless.
 *
 *   The live check covered `NO_OPENCODE_PORT` end to end (409 → toast, `ja` and
 *   `en`, with HEAD's build showing nothing at all for five seconds under the
 *   same click). `NO_OPENCODE_SESSION` was **not** reproduced on live hardware
 *   for the reason above; its wording is covered by the unit suite only.
 *
 * `NO_OPENCODE_SESSION` is deliberately not one sentence for both surfaces.
 * "nothing to fork yet" is wrong wording on a share button, so the caller picks
 * which of the two dedicated strings the code resolves to.
 *
 * ### Which surface the message lands on
 *
 * `showToast` when the mount supplies one — `MessageInput` passes the composer's
 * existing toast surface down — and an inline chip beside the buttons when it
 * does not. The fallback is not decoration: `WorktreeDetailRefactored.tsx`
 * renders `MessageInput` without `showToast`, so a toast-only fix would leave
 * the single-pane desktop view exactly as silent as before. Only one of the two
 * ever fires, never both.
 *
 * `console.error` stays. It is the record for a bug report, and it carries the
 * raw body, which the operator-facing sentence deliberately does not.
 *
 * Success is untouched: nothing is announced when a call is accepted.
 */

'use client';

import React, { memo, useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy, GitFork, Link2, Link2Off, ListTree, MessageSquarePlus } from 'lucide-react';
import { Button, Spinner, useConfirm } from '@/components/ui';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { ShowToast } from '@/types/markdown-editor';
import type { OpencodeShareState } from '@/types/opencode-share';

/** The actions the session route accepts. Mirrors `OPENCODE_SESSION_ACTIONS`. */
export type OpencodeSessionAction = 'new' | 'list' | 'fork';

/** Every control this component can show as busy. */
type PendingAction = OpencodeSessionAction | 'share' | 'unshare';

/** The shape every route behind these controls uses to refuse (Issue #2109). */
interface RouteFailure {
  error?: string;
  code?: string;
}

/**
 * The dedicated sentence for `NO_OPENCODE_SESSION` on the surface being used.
 *
 * The code is shared by the fork button and both share verbs, but "no session to
 * fork yet" is the wrong sentence to show someone who pressed *share*.
 */
type NoSessionKey = 'errorNoSessionFork' | 'errorNoSessionShare';

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
  /**
   * Where failures are announced (Issue #2109).
   *
   * Optional because not every mount has a toast surface to lend — see the
   * component docblock. When it is absent the message is rendered inline
   * instead, so a failure is visible either way.
   */
  showToast?: ShowToast;
}

export const OpencodeSessionControls = memo(function OpencodeSessionControls({
  worktreeId,
  cliToolId,
  instanceId,
  disabled = false,
  onActionComplete,
  showToast,
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
  /**
   * The last failure, shown inline (Issue #2109).
   *
   * Only ever set when there is no `showToast` to hand the message to, so the
   * two surfaces cannot both report the same failure. It survives until the
   * next press rather than fading, because the composer row is easy to look
   * away from and the reason is the whole point.
   */
  const [failure, setFailure] = useState<string | null>(null);

  const isOpencode = cliToolId === 'opencode';
  const target = instanceId ?? cliToolId;

  /**
   * Put one sentence in front of the operator.
   *
   * The toast surface is preferred when the mount lends one; the inline chip is
   * the fallback for the mounts that do not.
   */
  const notifyFailure = useCallback(
    (message: string) => {
      if (showToast) {
        setFailure(null);
        showToast(message, 'error');
        return;
      }
      setFailure(message);
    },
    [showToast]
  );

  /**
   * The route's refusal, in the operator's language.
   *
   * `NO_OPENCODE_PORT` and `NO_OPENCODE_SESSION` are the two the operator can
   * act on, so they get a sentence. Everything else — `SHARE_DISABLED`,
   * `SHARE_REFUSED`, a 502 from opencode, a 400 — passes the route's own `error`
   * through untouched, which keeps this map from having to track every code the
   * routes will ever grow.
   *
   * @param detail - the parsed failure body, `{}` when it did not parse
   * @param statusText - fallback when the body carried no `error` at all
   * @param noSessionKey - which `NO_OPENCODE_SESSION` sentence this surface wants
   */
  const failureReason = useCallback(
    (detail: RouteFailure, statusText: string | undefined, noSessionKey: NoSessionKey): string => {
      if (detail.code === 'NO_OPENCODE_PORT') return t('errorNoPort');
      if (detail.code === 'NO_OPENCODE_SESSION') return t(noSessionKey);
      return detail.error || statusText || t('errorUnknown');
    },
    [t]
  );

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
      setFailure(null);
      try {
        const response = await fetch(`/api/worktrees/${worktreeId}/opencode/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, instanceId: target }),
        });
        if (!response.ok) {
          const detail = (await response.json().catch(() => ({}))) as RouteFailure;
          console.error(
            '[OpencodeSessionControls] action failed:',
            action,
            detail.error || response.statusText
          );
          // Only `fork` can reach `NO_OPENCODE_SESSION` on this route (the port
          // check comes first for all three, the session lookup only after the
          // `new`/`list` branches have returned), so the fork wording is right
          // for every caller that gets here.
          notifyFailure(failureReason(detail, response.statusText, 'errorNoSessionFork'));
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
        notifyFailure(t('errorRequestFailed'));
      } finally {
        setPending(null);
      }
    },
    [worktreeId, target, onActionComplete, refreshShare, notifyFailure, failureReason, t]
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
    setFailure(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/opencode/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId: target }),
      });
      const detail = (await response.json().catch(() => ({}))) as RouteFailure & {
        url?: string;
      };
      if (!response.ok || typeof detail.url !== 'string') {
        console.error(
          '[OpencodeSessionControls] share failed:',
          detail.error || response.statusText
        );
        // Reported louder than the other three on purpose: this is the one
        // control whose outcome is a public URL, so "did it publish or not?"
        // must never be left to the operator to guess.
        notifyFailure(failureReason(detail, response.statusText, 'errorNoSessionShare'));
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
      notifyFailure(t('errorRequestFailed'));
    } finally {
      setPending(null);
    }
  }, [confirm, t, worktreeId, target, refreshShare, notifyFailure, failureReason]);

  const onUnshare = useCallback(async () => {
    setPending('unshare');
    setFailure(null);
    try {
      const response = await fetch(
        `/api/worktrees/${worktreeId}/opencode/share?instance=${encodeURIComponent(target)}`,
        { method: 'DELETE' }
      );
      if (!response.ok) {
        const detail = (await response.json().catch(() => ({}))) as RouteFailure;
        console.error(
          '[OpencodeSessionControls] unshare failed:',
          detail.error || response.statusText
        );
        // The link stays on screen when this fails (see the render below); the
        // message is what tells the operator the page is *still up*.
        notifyFailure(failureReason(detail, response.statusText, 'errorNoSessionShare'));
        return;
      }
      setPublishedUrl(null);
      setCopied(false);
      void refreshShare();
    } catch (error) {
      console.error('[OpencodeSessionControls] unshare request error:', error);
      notifyFailure(t('errorRequestFailed'));
    } finally {
      setPending(null);
    }
  }, [worktreeId, target, refreshShare, notifyFailure, failureReason, t]);

  const onCopy = useCallback(async () => {
    if (publishedUrl === null) return;
    try {
      await navigator.clipboard.writeText(publishedUrl);
      setCopied(true);
      setFailure(null);
    } catch (error) {
      // Clipboard access is refused outside a secure context and by permission
      // policy, and `navigator.clipboard` is simply absent on plain HTTP — which
      // is how CommandMate is reached from a phone on the LAN. Silence here read
      // as "copied": the icon did not change and nothing said why. The URL is on
      // screen and selectable, so the message says to copy it by hand.
      console.error('[OpencodeSessionControls] clipboard write failed:', error);
      notifyFailure(t('errorCopyFailed'));
    }
  }, [publishedUrl, notifyFailure, t]);

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

      {/* Issue #2109: the fallback surface, used only where no `showToast` was
          handed down. `role="alert"` so a screen reader hears the refusal the
          same way a sighted operator sees it, and `title` because the composer
          row is narrow enough that a passed-through route string can truncate. */}
      {failure !== null ? (
        <span
          role="alert"
          className="flex min-w-0 items-center rounded-full border border-danger-border bg-danger-subtle px-2 py-0.5 text-xs text-danger-foreground"
          title={failure}
          data-testid="opencode-session-error"
        >
          <span className="truncate">{failure}</span>
        </span>
      ) : null}
    </div>
  );
});
