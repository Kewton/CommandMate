'use client';

/**
 * SessionTile — one worktree's live conversation, as a fixed-height card
 * (Issue #2509, Epic #2508 Phase 1).
 *
 * The `/sessions` tile layout exists so several agents can be watched at once
 * without opening a worktree screen per agent. What makes that possible is that
 * this component is *self-contained*: hand it a worktree row from the list cache
 * the page already holds and whether it is on screen, and it mounts its own
 * poller, its own history fetch and its own chat surface.
 *
 * ## Why this is modelled on MobileTerminalTab and not TerminalSplitPaneContent
 *
 * The PC split's content component wants fifteen-odd props from a parent that
 * owns the whole worktree screen — `useWorktreeDetailController`'s reducer, the
 * composer, the file panel, the roster. None of that exists on `/sessions`, and
 * reproducing it per tile is the version of this feature that never ships.
 * `MobileTerminalTab` had already solved the same problem for the phone (five
 * props, everything else its own), so this follows the same arrangement: own
 * `useTerminalPanePolling`, own `useSplitMessages`, hand both to `ChatSurface`.
 *
 * ## What a tile deliberately is not
 *
 * **Not a composer.** Phase 1 is "watch several sessions", and the acceptance
 * criteria ask for the transcript, not for a send box. A reply box per tile
 * would also need the prompt sheet, the image attachment path and the unsent-
 * input bar to travel with it — the whole of `WorktreeChatSendContext` — and the
 * one-tap trail to the worktree screen already reaches all of that.
 *
 * **Not a second surface.** The output is `chat`, always. That is what satisfies
 * the "conversation history is visible" requirement with no new rendering path,
 * and it sidesteps the width problem a 200-column terminal frame has in a half-
 * width card. `ChatSurface` still draws its dialog card for the frames chat
 * cannot express (a selection list, a pager, an unclassified overlay), so a tile
 * is not blind to those either — see {@link ChatSurface}. Its "open the
 * terminal" button navigates to the worktree screen, which is where the terminal
 * actually is.
 *
 * ## The header is a row, not a wrapper
 *
 * The branch name is a `<Link>`; the CARD is not. Wrapping the card would make
 * every scroll-to-read, every jump-to-latest and every dialog key inside it a
 * navigation away from the screen — which is the one behaviour the Issue names
 * as unacceptable.
 *
 * @module components/sessions/SessionTile
 */

import { memo, useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChatSurface, type ChatSurfaceLiveState } from '@/components/worktree/ChatSurface';
import { StatusDot } from '@/components/ui';
import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';
import { useSplitMessages } from '@/hooks/useSplitMessages';
import { deriveCliStatus } from '@/types/sidebar';
import {
  agentInstancesFromSelectedAgents,
  getInstanceLabel,
} from '@/lib/cli-tools/types';
import { getClientDefaultSelectedAgents } from '@/config/default-agents';
import {
  TILE_MESSAGES_POLLING_CADENCE,
  TILE_PANE_POLLING_CADENCE,
} from '@/config/pane-polling-cadence';
import type { AgentInstance } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';

export interface SessionTileProps {
  /**
   * The list-cache row this tile is showing.
   *
   * The whole row rather than a bare `worktreeId`, because the header needs the
   * repository name, the branch and the per-instance status that `/api/worktrees`
   * already returned to the page — re-fetching any of it per tile would be a
   * second source for values the page is holding one poll of.
   */
  worktree: Worktree;
  /**
   * Whether this tile is on screen. `false` suspends BOTH network hooks; see
   * `useInViewport` for why a tile is quieted rather than unmounted.
   */
  enabled: boolean;
  className?: string;
}

/**
 * The roster this tile can switch between.
 *
 * `agentInstances` when the worktree has one, otherwise the primary-instance
 * projection of `selectedAgents` — the same two-step fallback
 * `useWorktreeDetailController` performs, so a tile and the worktree screen
 * never disagree about which agents a worktree has.
 */
function resolveInstances(worktree: Worktree): AgentInstance[] {
  if (worktree.agentInstances && worktree.agentInstances.length > 0) {
    return worktree.agentInstances;
  }
  return agentInstancesFromSelectedAgents(
    worktree.selectedAgents ?? getClientDefaultSelectedAgents(),
  );
}

export const SessionTile = memo(function SessionTile({
  worktree,
  enabled,
  className = '',
}: SessionTileProps) {
  const t = useTranslations('common');
  const router = useRouter();

  const instances = useMemo(() => resolveInstances(worktree), [worktree]);
  // Which instance this tile is showing. Held as an id and re-resolved against
  // the roster on every render, so a roster that changes under the tile (an
  // instance removed elsewhere) falls back to the first entry instead of
  // pointing the poller at a session that is no longer declared.
  const [requestedInstanceId, setRequestedInstanceId] = useState<string | null>(null);
  const activeInstance =
    instances.find((instance) => instance.id === requestedInstanceId) ?? instances[0];

  const instanceId = activeInstance?.id;
  const cliToolId = activeInstance?.cliTool ?? 'claude';

  // Issue #2511: the tile profile, not the worktree screen's. A tile is one of
  // up to twenty live panes on one screen, and the profile is what keeps that
  // affordable — measured at 2.0 req/s and 2.5 MB/s for twenty idle tiles,
  // against 11.3 req/s and 18.6 MB/s under the worktree screen's cadence. The
  // worktree screen keeps its own numbers precisely because they are not shared.
  // See `config/pane-polling-cadence` and `docs/design/sessions-tile-polling-2511.md`.
  const { terminal, prompt, refresh } = useTerminalPanePolling({
    worktreeId: worktree.id,
    cliToolId,
    instanceId,
    enabled,
    cadence: TILE_PANE_POLLING_CADENCE,
  });

  const { messages, isLoading } = useSplitMessages({
    worktreeId: worktree.id,
    cliToolId,
    instanceId,
    enabled,
    cadence: TILE_MESSAGES_POLLING_CADENCE,
  });

  // The same projection MobileTerminalTab builds, field for field: these are the
  // flags ChatSurface gates the in-flight bubble, the "session ended" label and
  // the dialog card on, and copying a subset is how two surfaces come to read
  // one pane differently.
  const live: ChatSurfaceLiveState = useMemo(
    () => ({
      isRunning: terminal.isRunning,
      attaching: terminal.attaching,
      sessionStatus: terminal.sessionStatus,
      isThinking: terminal.isThinking,
      isPromptWaiting: prompt.visible,
      promptData: prompt.data,
      isSelectionListActive: terminal.isSelectionListActive,
      isPagerActive: terminal.isPagerActive,
      isDismissablePanelActive: terminal.isDismissablePanelActive,
      isUnclassifiedActive: terminal.isUnclassifiedActive,
    }),
    [
      terminal.isRunning,
      terminal.attaching,
      terminal.sessionStatus,
      terminal.isThinking,
      terminal.isSelectionListActive,
      terminal.isPagerActive,
      terminal.isDismissablePanelActive,
      terminal.isUnclassifiedActive,
      prompt.visible,
      prompt.data,
    ],
  );

  // ChatSurface's banner offers a way out to the terminal. There is no terminal
  // on this screen, so the way out is the worktree screen — an explicit button
  // press, which is the only kind of navigation a tile may perform.
  const handleSurfaceModeChange = useCallback(() => {
    router.push(`/worktrees/${worktree.id}`);
  }, [router, worktree.id]);

  const handleInstanceChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    setRequestedInstanceId(event.target.value);
  }, []);

  const branchLabel = worktree.branch ?? worktree.name;
  const repositoryLabel = worktree.repositoryDisplayName ?? worktree.repositoryName;
  const status = deriveCliStatus(
    instanceId ? worktree.sessionStatusByInstance?.[instanceId] : undefined,
  );

  return (
    <section
      className={`flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-sm ${className}`}
      data-testid={`session-tile-${worktree.id}`}
      data-enabled={enabled ? 'true' : 'false'}
      aria-label={t('sessions.tileAriaLabel', { branch: branchLabel })}
    >
      {/* Header. Its own row rather than a wrapping <Link>: see the module comment. */}
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <StatusDot status={status} size="sm" label={t(`status.${status}`)} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs text-muted-foreground">{repositoryLabel}</div>
          <Link
            href={`/worktrees/${worktree.id}`}
            className="block truncate text-sm font-medium text-foreground underline-offset-2 hover:text-accent-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:text-accent-400"
            data-testid={`session-tile-branch-${worktree.id}`}
            title={branchLabel}
          >
            {branchLabel}
          </Link>
        </div>
        {instances.length > 1 && (
          <select
            value={activeInstance?.id ?? ''}
            onChange={handleInstanceChange}
            className="max-w-[9rem] shrink-0 rounded-md border border-border bg-surface px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            data-testid={`session-tile-instance-${worktree.id}`}
            aria-label={t('sessions.tileInstanceAriaLabel')}
          >
            {instances.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {getInstanceLabel(instance)}
              </option>
            ))}
          </select>
        )}
      </header>

      {/* Body. Nothing is rendered while the tile is off screen — the hooks above
          are already suspended, so a mounted ChatSurface would only be an empty
          transcript plus its own `/api/relays` poll. */}
      <div className="min-h-0 flex-1">
        {enabled ? (
          <ChatSurface
            messages={messages}
            worktreeId={worktree.id}
            worktreePath={worktree.path}
            cliToolId={cliToolId}
            instanceId={instanceId}
            live={live}
            frame={terminal.output}
            onKeysSent={refresh}
            onSurfaceModeChange={handleSurfaceModeChange}
            // The card's phone budget, for the same reason: half of a 1280px
            // screen is not much wider than a phone, and the transcript must
            // keep its rows.
            compact
            history={{ isLoading }}
          />
        ) : (
          <div
            className="h-full"
            data-testid={`session-tile-placeholder-${worktree.id}`}
            aria-hidden="true"
          />
        )}
      </div>
    </section>
  );
});

export default SessionTile;
