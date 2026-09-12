'use client';

/**
 * SessionTile — one worktree's live conversation, as a fixed-height card
 * (Issue #2509, Epic #2508 Phase 1; terminal surface in Issue #2510, Phase 2).
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
import { StatusDot } from '@/components/ui';
import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';
import { useSplitMessages } from '@/hooks/useSplitMessages';
import {
  SESSION_TILE_HISTORY_PANE_STORAGE_KEYS,
  useHistoryPaneState,
} from '@/hooks/useHistoryPaneState';
import { useSessionTileSurfaceMode } from '@/hooks/useSessionTileSurfaceMode';
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
import type { Worktree } from '@/types/models';
import type { SurfaceMode } from '@/types/ui-state';

/**
 * The terminal's share of a tile body while History is stacked under it
 * (Issue #2510), and the floor it keeps.
 *
 * 3 : 2 of the 457px under the header, measured in a real browser at every width
 * from 390px to 1920px: 274px of terminal (~16 rows at the compact font) over
 * 183px of History (its header plus a conversation card or two). The floors are what "neither pane is crushed" means if the tile ever
 * gets shorter: together 16rem, well inside the body, so on today's tile they
 * never bind and the ratio decides.
 */
export const SESSION_TILE_TERMINAL_ROW_CLASS = 'flex-[3_3_0%] min-h-[9rem]';

/** History's share and floor under the terminal. See {@link SESSION_TILE_TERMINAL_ROW_CLASS}. */
export const SESSION_TILE_HISTORY_ROW_CLASS = 'flex-[2_2_0%] min-h-[7rem]';

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
  const { messages, isLoading } = useSplitMessages({
    worktreeId: worktree.id,
    cliToolId,
    instanceId,
    enabled: enabled && (!isTerminalSurface || historyVisible),
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

  // Issue #2510: ChatSurface's banner offers a way out to the terminal. Phase 1
  // had no terminal here and navigated to the worktree screen; the tile now has
  // one, so the banner switches the tile in place like the header segments do.
  const handleSurfaceModeChange = useCallback(
    (mode: SurfaceMode) => setSurfaceMode(mode),
    [setSurfaceMode],
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
          transcript plus its own `/api/relays` poll. */}
      <div className="min-h-0 min-w-0 flex-1">
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
