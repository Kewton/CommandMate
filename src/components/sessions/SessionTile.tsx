'use client';

/**
 * SessionTile — one worktree's live conversation, as a fixed-height card
 * (Issue #2509, Epic #2508 Phase 1; terminal surface in Issue #2510, Phase 2;
 * composer and Auto-Yes in Issue #2512, Phase 4).
 *
 * The `/sessions` tile layout exists so several agents can be watched at once
 * without opening a worktree screen per agent. What makes that possible is that
 * this component is *self-contained*: hand it a worktree row from the list cache
 * the page already holds and whether it is on screen, and it mounts its own
 * poller, its own history fetch, its own chat surface and its own composer.
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
 * ## The composer (Issue #2512)
 *
 * Watching several sessions is mostly waiting, and the reply a tile most often
 * needs is one line ("yes", "continue"). Phase 1 left that to the worktree
 * screen; this puts `MessageInput` at the bottom of the card, on both surfaces,
 * with the same optimistic layer the worktree screen has:
 *
 * - **`usePendingMessages` (#1121) lives here**, next to `useSplitMessages`,
 *   because it has to merge into the array the transcript renders. The send is
 *   `worktreeApi.sendMessage` → `POST /send` — the worktree screen's path, with
 *   this tile's `(cliToolId, instanceId)` — so what a tile sends is the same row
 *   in the same instance's history the worktree screen reads. Retry / discard
 *   ride `ChatSurface`'s and `HistoryPane`'s existing callbacks; a discarded
 *   message goes back into the composer.
 * - **Connectivity is wired (#2503 / #2535).** A send made while the connection
 *   is known to be down is parked, not failed, and resent once when the server
 *   answers. The verdict comes in as a prop because `SessionTileGrid` reads ONE
 *   for the whole wall — see {@link SessionTileProps.connectivity}.
 * - **Prompt answers are not new.** `ChatSurface`'s dialog card (#2254) already
 *   answers selection lists, pagers and waits; the composer adds free text.
 *
 * Mounted only while the tile is on screen, like the body: `MessageInput`
 * fetches its slash-command catalog when it mounts, and an off-screen tile must
 * not cost a request (#2509). A half-typed draft survives that — it is persisted
 * under the worktree's first split key, which is also what the worktree screen
 * restores, so a reply started here can be finished there.
 *
 * ## Auto-Yes (Issue #2512)
 *
 * The toggle sits in the composer's meta row, where the worktree screen has it
 * (#1080), and is the selected instance's. Its state rides the list payload the
 * page already polls; see `useSessionTileAutoYes` for why that is not a request
 * per tile, and for how a toggle is shown before the list has caught up.
 *
 * ## Two surfaces, chat first (Issue #2510)
 *
 * The output starts as `chat`, and stays there until the tile is switched. That
 * is what satisfies the "conversation history is visible" requirement with no
 * extra pane, and a transcript is variable-width text with no width problem.
 * `ChatSurface` still draws its dialog card for the frames chat cannot express
 * (a selection list, a pager, an unclassified overlay), and its "open the
 * terminal" button now switches THIS tile to its terminal rather than leaving
 * `/sessions` — the same in-place switch the worktree screen's button performs.
 *
 * The terminal surface is the part #2510 had to make usable, and two things
 * stood in the way:
 *
 * - **Width.** A claude / codex frame is 200 columns and a half-width tile's
 *   terminal is ~95 of them at the worktree screen's font (804px at 1920x1080),
 *   so re-wrapping folds every rule and box edge in two. The tile renders
 *   `TerminalDisplay` with {@link SESSION_TILE_TERMINAL_LAYOUT} — the frame
 *   keeps its own columns and scrolls sideways inside the tile, at a compact
 *   font. See that constant.
 * - **History.** The terminal is not a transcript, so History comes back as a
 *   second pane — stacked UNDER the terminal, because the worktree screen's
 *   side-by-side 40% column would leave an ~800px tile a ~480px terminal. Its
 *   visibility is the tile scope of `useHistoryPaneState`
 *   (`commandmate.sessions.tileHistoryVisible`, shown by default), so a tile
 *   and the worktree screen never close each other's History.
 *
 * The surface itself is remembered per worktree — `useSessionTileSurfaceMode`.
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
import { useTranslations } from 'next-intl';
import { History, MessageSquare, TerminalSquare } from 'lucide-react';
import { ChatSurface, type ChatSurfaceLiveState } from '@/components/worktree/ChatSurface';
import { HistoryPane } from '@/components/worktree/HistoryPane';
import { TerminalDisplay } from '@/components/worktree/TerminalDisplay';
import { MessageInput } from '@/components/worktree/MessageInput';
import { AutoYesToggle } from '@/components/worktree/AutoYesToggle';
import { StatusDot } from '@/components/ui';
import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';
import { useSplitMessages } from '@/hooks/useSplitMessages';
import {
  usePendingMessages,
  type OptimisticSendOptions,
  type PendingConnectivity,
} from '@/hooks/usePendingMessages';
import { usePendingConnectivity } from '@/hooks/usePendingConnectivity';
import { useSessionTileAutoYes } from '@/hooks/useSessionTileAutoYes';
import {
  SESSION_TILE_HISTORY_PANE_STORAGE_KEYS,
  useHistoryPaneState,
} from '@/hooks/useHistoryPaneState';
import { useSessionTileSurfaceMode } from '@/hooks/useSessionTileSurfaceMode';
import { worktreeApi } from '@/lib/api-client';
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
import {
  SESSION_TILE_TERMINAL_LAYOUT,
  getTerminalDisplayCompaction,
} from '@/config/terminal-display-compaction';
import type { AgentInstance } from '@/lib/cli-tools/types';
import type { ChatMessage, Worktree } from '@/types/models';
import type { SurfaceMode } from '@/types/ui-state';

/**
 * The floor under a tile's body — the output surface between the header and the
 * composer (Issue #2512).
 *
 * The tile's height is fixed (`SESSION_TILE_HEIGHT_CLASS`, 35rem = 560px), and
 * the composer below the body is `shrink-0`, so every pixel the composer grows by
 * comes out of the body. The floor is what "the conversation is not crushed"
 * means, and it is chosen so that it never has to hold against the composer.
 * Worked from the classes (not measured in a browser):
 *
 * | | header | composer | body |
 * |---|---|---|---|
 * | desktop, one-line draft | 55px | 97px (one input row + the Auto-Yes row) | 408px |
 * | phone, one-line draft | 55px | 137px (`MessageInput`'s two-row layout) | 368px |
 * | desktop, textarea at its 160px cap | 55px | 221px | 284px |
 * | phone, textarea at its 160px cap | 55px | 261px | 244px |
 *
 * 15rem = 240px sits under the worst row, so a draft as long as the composer
 * lets it get still leaves the transcript its floor with the send button on
 * screen. It also equals the two stacked floors below, so the terminal and
 * History always fit inside it.
 */
export const SESSION_TILE_BODY_FLOOR_CLASS = 'min-h-[15rem]';

/**
 * The terminal's share of a tile body while History is stacked under it
 * (Issue #2510), and the floor it keeps.
 *
 * 3 : 2 of the body. Measured in a real browser before the composer existed
 * (#2510, 457px of body): 274px of terminal (~16 rows at the compact font) over
 * 183px of History. With the composer (#2512) the same ratio of the desktop's
 * 408px is ~245px over ~163px. The floors are what "neither pane is crushed"
 * means if the body gets shorter: together they equal
 * {@link SESSION_TILE_BODY_FLOOR_CLASS}, so they can never push the stack past
 * the body, and on a one-line draft they never bind and the ratio decides.
 */
export const SESSION_TILE_TERMINAL_ROW_CLASS = 'flex-[3_3_0%] min-h-[8.5rem]';

/** History's share and floor under the terminal. See {@link SESSION_TILE_TERMINAL_ROW_CLASS}. */
export const SESSION_TILE_HISTORY_ROW_CLASS = 'flex-[2_2_0%] min-h-[6.5rem]';

/** DOM id of one tile's stacked History region — the header toggle's `aria-controls`. */
export function sessionTileHistoryRegionId(worktreeId: string): string {
  return `session-tile-history-${worktreeId}`;
}

/**
 * The surface segments in render order. i18n KEYS (in the `worktree` namespace)
 * rather than labels, and the same keys the worktree screen's split header
 * uses, so the two controls cannot name one surface two ways.
 */
const TILE_SURFACE_SEGMENTS: readonly {
  mode: SurfaceMode;
  labelKey: string;
  icon: typeof TerminalSquare;
}[] = [
  { mode: 'chat', labelKey: 'surfaceMode.showChat', icon: MessageSquare },
  { mode: 'terminal', labelKey: 'surfaceMode.showTerminal', icon: TerminalSquare },
] as const;

/** Shared look of the header's icon buttons; `active` is the pressed state. */
function headerIconButtonClass(active: boolean): string {
  return `flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
    active
      ? 'bg-accent-500/15 text-accent-600 dark:text-accent-400'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
  }`;
}

/** A tile has no file panel to open a path in; see the History pane below. */
const noopFilePathClick = (): void => {};

/**
 * The transcript a tile shows for one instance (Issue #2512).
 *
 * `useSplitMessages` is already scoped to the instance; the pending bubbles are
 * not, because `usePendingMessages` lives at the tile and outlives an instance
 * switch. A bubble keeps the target it was sent to (`MessageInput` names a
 * non-primary instance, and leaves the primary to its tool id), so one sent to
 * another instance of this worktree is held back here instead of reading as a
 * message this instance was sent — and retried from there, to the wrong pane.
 * It is still in the hook, and reappears when the tile is switched back.
 */
export function messagesForTileInstance(
  messages: ChatMessage[],
  instanceId: string,
): ChatMessage[] {
  const foreign = (message: ChatMessage) =>
    message.optimisticState !== undefined &&
    (message.instanceId ?? message.cliToolId) !== instanceId;
  return messages.some(foreign) ? messages.filter((message) => !foreign(message)) : messages;
}

export interface SessionTileProps {
  /**
   * The list-cache row this tile is showing.
   *
   * The whole row rather than a bare `worktreeId`, because the header needs the
   * repository name, the branch and the per-instance status that `/api/worktrees`
   * already returned to the page — re-fetching any of it per tile would be a
   * second source for values the page is holding one poll of. Since #2512 the
   * row also carries the Auto-Yes state (`autoYesByInstance`).
   */
  worktree: Worktree;
  /**
   * Whether this tile is on screen. `false` suspends BOTH network hooks and
   * unmounts the composer; see `useInViewport` for why a tile is quieted rather
   * than unmounted.
   */
  enabled: boolean;
  /**
   * The connection verdict the composer's pending layer parks sends on
   * (Issue #2512) — `usePendingConnectivity`'s shape.
   *
   * `SessionTileGrid` passes one value to every tile: each `useConnectivity`
   * probes the server on its own clock while the connection is degraded, and a
   * wall of twenty tiles must not be twenty probes. Omitted, the tile reads its
   * own verdict, so a tile mounted outside the grid is never left unwired.
   */
  connectivity?: PendingConnectivity;
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

export const SessionTile = memo(function SessionTile(props: SessionTileProps) {
  // Two components rather than a conditional hook: which one renders never
  // changes for a mounted tile (the grid always passes a verdict).
  return props.connectivity ? (
    <SessionTileCard {...props} connectivity={props.connectivity} />
  ) : (
    <SessionTileWithOwnConnectivity {...props} />
  );
});

/** A tile mounted without a verdict reads its own. See {@link SessionTileProps.connectivity}. */
function SessionTileWithOwnConnectivity(props: SessionTileProps) {
  const connectivity = usePendingConnectivity();
  return <SessionTileCard {...props} connectivity={connectivity} />;
}

function SessionTileCard({
  worktree,
  enabled,
  connectivity,
  className = '',
}: SessionTileProps & { connectivity: PendingConnectivity }) {
  const t = useTranslations('common');
  const tWorktree = useTranslations('worktree');

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
  // The id `/send`, the poller and the Auto-Yes map resolve an omitted instance
  // to: the primary is named by its tool.
  const resolvedInstanceId = instanceId ?? cliToolId;

  // Issue #2510: which surface, and — for the terminal — whether History is
  // stacked under it. The History toggle is the TILE scope, never the worktree
  // screen's; see the module comment.
  const { surfaceMode, setSurfaceMode } = useSessionTileSurfaceMode(worktree.id);
  const { visible: historyVisible, toggle: toggleHistory } = useHistoryPaneState(
    SESSION_TILE_HISTORY_PANE_STORAGE_KEYS,
  );
  const isTerminalSurface = surfaceMode === 'terminal';
  const showStackedHistory = isTerminalSurface && historyVisible;

  // Issue #2511: the tile profile, not the worktree screen's. A tile is one of
  // up to twenty live panes on one screen, and the profile is what keeps that
  // affordable — measured at 2.0 req/s and 2.5 MB/s for twenty idle tiles,
  // against 11.3 req/s and 18.6 MB/s under the worktree screen's cadence. The
  // worktree screen keeps its own numbers precisely because they are not shared.
  // See `config/pane-polling-cadence` and `docs/design/sessions-tile-polling-2511.md`.
  const { terminal, prompt, refresh, setAutoScroll } = useTerminalPanePolling({
    worktreeId: worktree.id,
    cliToolId,
    instanceId,
    enabled,
    cadence: TILE_PANE_POLLING_CADENCE,
  });

  // Issue #2510: the transcript is only on screen in chat, or under the
  // terminal while History is open. A terminal tile with History closed has no
  // reader for `/messages`, so it does not poll it — the same "nothing unseen
  // costs anything" rule `enabled` applies to an offscreen tile, and the same
  // #2511 cadence whenever it does run. Re-enabling fetches at once.
  //
  // Issue #2512: a send from that tile still reconciles. `refresh` fetches
  // whether or not the poll is enabled, and it is what `usePendingMessages`
  // calls once `/send` has answered.
  const {
    messages: serverMessages,
    isLoading,
    refresh: refreshMessages,
  } = useSplitMessages({
    worktreeId: worktree.id,
    cliToolId,
    instanceId,
    enabled: enabled && (!isTerminalSurface || historyVisible),
    cadence: TILE_MESSAGES_POLLING_CADENCE,
  });

  // Issue #2512: the worktree screen's optimistic layer, wired the way
  // `TerminalSplitPaneContent` wires it — same send, same refetch, and the
  // connection verdict so a send from a dead network is parked, not failed.
  const sendMessageFn = useCallback(
    (content: string, options: OptimisticSendOptions) =>
      worktreeApi.sendMessage(worktree.id, content, options),
    [worktree.id],
  );
  const {
    messages: mergedMessages,
    sendOptimistic,
    retry: retryPending,
    discard: discardPending,
  } = usePendingMessages({
    worktreeId: worktree.id,
    serverMessages,
    sendFn: sendMessageFn,
    onSent: refreshMessages,
    connectivity,
  });
  const messages = useMemo(
    () => messagesForTileInstance(mergedMessages, resolvedInstanceId),
    [mergedMessages, resolvedInstanceId],
  );

  // Text headed for the composer: a discarded send (so it can be edited and
  // sent again) or a previous prompt picked from the transcript. Consumed by
  // `MessageInput`, which appends rather than overwrites a draft.
  const [composerInsert, setComposerInsert] = useState<string | null>(null);
  const clearComposerInsert = useCallback(() => setComposerInsert(null), []);
  const handleDiscardPending = useCallback(
    (tempId: string) => {
      const content = discardPending(tempId);
      if (content) setComposerInsert(content);
    },
    [discardPending],
  );
  const handleMessageSent = useCallback(() => {
    // The pane, not the transcript: `usePendingMessages` refetches that itself
    // once the send lands. This is what shows the agent picking the message up.
    void refresh();
  }, [refresh]);

  const autoYes = useSessionTileAutoYes({
    worktree,
    cliToolId,
    instanceId: resolvedInstanceId,
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

  // Issue #2510: ChatSurface's banner offers a way out to the terminal. Phase 1
  // had no terminal here and navigated to the worktree screen; the tile now has
  // one, so the banner switches the tile in place like the header segments do.
  const handleSurfaceModeChange = useCallback(
    (mode: SurfaceMode) => setSurfaceMode(mode),
    [setSurfaceMode],
  );

  const chatHistory = useMemo(
    () => ({
      isLoading,
      onRetryPending: retryPending,
      onDiscardPending: handleDiscardPending,
      onInsertToMessage: setComposerInsert,
    }),
    [isLoading, retryPending, handleDiscardPending],
  );

  // The same per-tool display policy both worktree-screen surfaces read, so one
  // session's frame is compacted identically wherever it is watched.
  const { compactTuiLayoutPadding, preservePaintedPanelRows } = useMemo(
    () => getTerminalDisplayCompaction(cliToolId),
    [cliToolId],
  );
  // opencode / copilot draw their TUIs in the alternate screen with menus at the
  // top; following the tail would scroll those out of view. Same rule as the
  // worktree screen's split pane.
  const disableAutoFollow = cliToolId === 'opencode' || cliToolId === 'copilot';
  const historyRegionId = sessionTileHistoryRegionId(worktree.id);

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
        {/* Issue #2510: History under the terminal. Only offered on the terminal
            surface — on chat the surface IS the transcript. */}
        {isTerminalSurface && (
          <button
            type="button"
            onClick={toggleHistory}
            aria-pressed={historyVisible}
            aria-expanded={historyVisible}
            aria-controls={historyRegionId}
            aria-label={
              historyVisible ? tWorktree('terminal.hideHistory') : tWorktree('terminal.showHistory')
            }
            title={
              historyVisible ? tWorktree('terminal.hideHistory') : tWorktree('terminal.showHistory')
            }
            className={headerIconButtonClass(historyVisible)}
            data-testid={`session-tile-history-toggle-${worktree.id}`}
          >
            <History size={14} aria-hidden="true" />
          </button>
        )}
        {/* Issue #2510: the surface segments. */}
        <div
          role="group"
          aria-label={tWorktree('surfaceMode.groupLabelMobile')}
          className="flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5"
          data-testid={`session-tile-surface-mode-${worktree.id}`}
        >
          {TILE_SURFACE_SEGMENTS.map(({ mode, labelKey, icon: Icon }) => {
            const active = surfaceMode === mode;
            const label = tWorktree(labelKey);
            return (
              <button
                key={mode}
                type="button"
                onClick={() => setSurfaceMode(mode)}
                aria-pressed={active}
                aria-label={label}
                title={label}
                className={headerIconButtonClass(active)}
                data-testid={`session-tile-surface-${mode}-${worktree.id}`}
              >
                <Icon size={14} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </header>

      {/* Body. Nothing is rendered while the tile is off screen — the hooks above
          are already suspended, so a mounted ChatSurface would only be an empty
          transcript plus its own `/api/relays` poll.
          Issue #2512: `overflow-hidden` and the floor, because the composer
          below takes its height out of this box — see
          SESSION_TILE_BODY_FLOOR_CLASS. */}
      <div
        className={`min-w-0 flex-1 overflow-hidden ${SESSION_TILE_BODY_FLOOR_CLASS}`}
        data-testid={`session-tile-body-${worktree.id}`}
      >
        {enabled && isTerminalSurface ? (
          // Issue #2510: terminal on top, History stacked under it. Both rows
          // clip (`overflow-hidden`, `min-w-0`) so the frame's sideways scroll
          // stays inside `TerminalDisplay`'s own log and never widens the tile,
          // the grid cell or the page.
          <div
            className="flex h-full min-h-0 min-w-0 flex-col"
            data-testid={`session-tile-terminal-stack-${worktree.id}`}
          >
            <div
              className={`relative min-w-0 overflow-hidden ${
                showStackedHistory ? SESSION_TILE_TERMINAL_ROW_CLASS : 'min-h-0 flex-1'
              }`}
              data-testid={`session-tile-terminal-${worktree.id}`}
            >
              <TerminalDisplay
                output={terminal.output}
                isActive={terminal.isRunning}
                attaching={terminal.attaching}
                isThinking={terminal.isThinking}
                autoScroll={terminal.autoScroll}
                onScrollChange={setAutoScroll}
                disableAutoFollow={disableAutoFollow}
                compactTuiLayoutPadding={compactTuiLayoutPadding}
                preservePaintedPanelRows={preservePaintedPanelRows}
                wrapMode={SESSION_TILE_TERMINAL_LAYOUT.wrapMode}
                density={SESSION_TILE_TERMINAL_LAYOUT.density}
              />
            </div>
            {showStackedHistory && (
              <div
                id={historyRegionId}
                className={`min-w-0 overflow-hidden border-t border-border ${SESSION_TILE_HISTORY_ROW_CLASS}`}
                data-testid={`session-tile-history-${worktree.id}`}
              >
                {/* No `onCollapse`: its arrow points at a column to the left,
                    and the header toggle already owns this region. No file
                    panel either, so a path in a body opens nothing — the chat
                    surface in a tile behaves the same way. */}
                <HistoryPane
                  messages={messages}
                  worktreeId={worktree.id}
                  worktreePath={worktree.path}
                  cliToolId={cliToolId}
                  isLoading={isLoading}
                  onFilePathClick={noopFilePathClick}
                  onInsertToMessage={setComposerInsert}
                  onRetryPending={retryPending}
                  onDiscardPending={handleDiscardPending}
                  className="h-full"
                />
              </div>
            )}
          </div>
        ) : enabled ? (
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
            history={chatHistory}
          />
        ) : (
          <div
            className="h-full"
            data-testid={`session-tile-placeholder-${worktree.id}`}
            aria-hidden="true"
          />
        )}
      </div>

      {/* Issue #2512: the composer, on both surfaces, only while on screen. */}
      {enabled && (
        <div
          className="shrink-0 border-t border-border p-2"
          data-testid={`session-tile-composer-${worktree.id}`}
        >
          <MessageInput
            worktreeId={worktree.id}
            cliToolId={cliToolId}
            instanceId={resolvedInstanceId}
            isSessionRunning={terminal.isRunning}
            onOptimisticSend={sendOptimistic}
            onMessageSent={handleMessageSent}
            pendingInsertText={composerInsert}
            onInsertConsumed={clearComposerInsert}
            autoYesSlot={
              <AutoYesToggle
                enabled={autoYes.enabled}
                expiresAt={autoYes.expiresAt}
                onToggle={autoYes.toggle}
                lastAutoResponse={null}
                cliToolName={cliToolId}
                inline
              />
            }
          />
        </div>
      )}
    </section>
  );
}

export default SessionTile;
