/**
 * WorktreeDetailDesktop (Issue #755)
 *
 * PC (desktop) orchestrator extracted from WorktreeDetailRefactored.tsx as a
 * pure structural refactor (no behavior change). Owns the PC-only memoized
 * panes (renderSplitPane / terminalSplitRegion / rightPaneSplitMemo /
 * activityContent / activityPaneMemo) and the 2-column
 * desktop layout body, delegating the layout frame to WorktreeDesktopLayout
 * (S1-003) and the terminal column to TerminalContainer.
 *
 * Markdown editing lives in the file tab panel (FilePanelContent owns its own
 * dynamic, ssr:false MarkdownEditor); there is no separate editor modal.
 *
 * Closure-dependency stability (S1-004): every value `renderSplitPane` closes
 * over (pendingInsertTextMap / handleInsertToSplit / handleInsertConsumed,
 * setFocusedSplitIndex, makeAutoYesToggleHandler, deriveCliStatus-derived
 * status) is received as a stable-reference prop so the useCallback dependency
 * array structure here matches the pre-refactor parent exactly, preserving the
 * #728/#740/#743 per-split re-render characteristics.
 */

'use client';

import React, { memo, useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  WorktreeDesktopLayout,
  type WorktreeDesktopLayoutProps,
} from '@/components/worktree/WorktreeDesktopLayout';
import { TerminalContainer } from '@/components/worktree/TerminalContainer';
import { type WorktreeStatus } from '@/components/mobile/MobileHeader';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
import { SearchBar } from '@/components/worktree/SearchBar';
import { ActivityPane, type ActivityContentMap } from '@/components/worktree/ActivityPane';
import {
  ACTIVITIES,
  ACTIVITY_PANE_PINNED_STORAGE_KEY,
  CHIP_ACTIVITY_ID,
  type ActivityId,
} from '@/config/activity-bar-config';
import {
  usePaneDirtyTracker,
  usePanePinnedState,
  type PaneDismissReason,
} from '@/hooks/useActivityPaneOverlay';
import { FileTreeView } from '@/components/worktree/FileTreeView';
import { FilePanelSplit } from '@/components/worktree/FilePanelSplit';
import { TerminalSplitContainer, type SelectedSplit } from '@/components/worktree/TerminalSplitContainer';
import { useTerminalSplitPlacement } from '@/hooks/useTerminalSplitPlacement';
import { AgentAddMenu } from '@/components/worktree/AgentAddMenu';
import type { AgentPlacement } from '@/config/terminal-split-config';
import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import { MemoPane } from '@/components/worktree/MemoPane';
import { TodoPane } from '@/components/worktree/TodoPane';
import { ExecutionLogPane } from '@/components/worktree/ExecutionLogPane';
import { TimerPane } from '@/components/worktree/TimerPane';
import { AgentInstancesPane } from '@/components/worktree/AgentInstancesPane';
import { GitPane } from '@/components/worktree/GitPane';
import { WorktreeSkillsPane } from '@/components/skills/WorktreeSkillsPane';
import { VerificationPane } from '@/components/worktree/VerificationPane';
import { EnvManagerPane } from '@/components/worktree/EnvManagerPane';
import {
  VerificationStatusChip,
  useGatesOfLatestRun,
} from '@/components/worktree/VerificationStatusChip';
import { Modal } from '@/components/ui/Modal';
import { BranchMismatchAlert } from '@/components/worktree/BranchMismatchAlert';
import { MoveDialog } from '@/components/worktree/MoveDialog';
import { NewFileDialog } from '@/components/worktree/NewFileDialog';
import { buildModelByInstance, DesktopHeader, formatAgentModelLabel, InfoModal } from '@/components/worktree/WorktreeDetailSubComponents';
import type { AgentSessionSnapshot } from '@/types/agent-session';
import { UPLOADABLE_EXTENSIONS } from '@/config/uploadable-extensions';
import { deriveCliStatus, isUnclassifiedCliStatus } from '@/types/sidebar';
import { getCliToolDisplayName, type AgentInstance, type CLIToolType } from '@/lib/cli-tools/types';
import type { SessionKillTarget } from '@/types/terminal-split-pane';
import type { AutoYesToggleParams } from '@/components/worktree/AutoYesToggle';
import type { ShowToast } from '@/types/markdown-editor';
import type { Worktree, FileContent } from '@/types/models';
import type { AutoYesInstanceSummary } from '@/types/auto-yes';
import { isReleasedByRestart } from '@/config/auto-yes-config';
import type { UseFileSearchReturn } from '@/hooks/useFileSearch';
import type { FileTabsState, FileTabsActions } from '@/hooks/useFileTabs';
import type { HistoryDisplayLimit } from '@/config/history-display-config';
import type { MoveTarget } from '@/hooks/useFileOperations';
import type { WorktreeVerificationState } from '@/hooks/useWorktreeVerification';

/**
 * Issue #3589: presses here do not dismiss the unpinned activity pane (and Esc
 * pressed here closes it). Issue #3591: the pane's entry points are the
 * header's tools (`HeaderToolBar`, its "…" list included) and the
 * Verification chip (`data-activity-entry`, wherever the second row put it),
 * and the second row's "…" the chip folds behind — pressing it to reach the
 * chip must not be the press that closes the pane the chip opened.
 */
const ACTIVITY_PANE_IGNORE_OUTSIDE: readonly string[] = [
  '[data-testid="header-tool-bar"]',
  '[data-activity-entry]',
  '[data-testid="split-action-bar-items-overflow"]',
];

/**
 * Issue #3591: put the keyboard back on what opens `activity` — its header
 * tool, or the Verification chip — or, when that is folded away, on the "…"
 * holding it (the header's for a tool, the second row's for the chip).
 */
export function focusActivityEntry(activity: ActivityId): void {
  if (typeof document === 'undefined') return;
  const entry = document.querySelector<HTMLElement>(`[data-activity-entry="${activity}"]`);
  const target =
    entry === null
      ? document.querySelector<HTMLElement>(
          activity === CHIP_ACTIVITY_ID
            ? '[data-testid="split-action-bar-items-overflow"]'
            : '[data-testid="header-tool-more"]'
        )
      : entry instanceof HTMLButtonElement
        ? entry
        : entry.querySelector<HTMLElement>('button');
  target?.focus();
}

/** Props for WorktreeDetailDesktop. */
export interface WorktreeDetailDesktopProps {
  worktreeId: string;
  worktree: Worktree | null;
  worktreeName: string;
  worktreeStatus: WorktreeStatus;
  /** Issue #869: agent instance roster (drives instance tabs / split selectors). */
  instances: AgentInstance[];
  /**
   * Issue #898: `true` once the real roster for this worktree has loaded.
   * Forwarded to TerminalSplitContainer so the split reconcile is suppressed
   * while the roster is still the transient seed/default (which would otherwise
   * evict persisted alias splits like `claude-2`).
   */
  rosterReady: boolean;
  /** Issue #869: active agent instance id (tab/split identity). */
  activeInstanceId: string;
  /** Issue #869: set the active agent instance (also syncs activeCliTab). */
  setActiveInstanceId: (instanceId: string) => void;
  /**
   * Issue #2656: an instance chosen outside this screen (the sidebar's
   * sessions view), token-stamped by the controller. Applied once per token,
   * exactly like a header pick, so the selected split shows it (#3593).
   */
  instanceSelectionRequest?: { instanceId: string; token: number } | null;
  /** Issue #2656: tells the controller a request was applied (clears it). */
  onInstanceSelectionHandled?: (token: number) => void;
  hasUpdate: boolean;
  lastAutoResponse: string | null;

  // Activity Bar
  activeActivity: ActivityId | null;
  onActivityToggle: (id: ActivityId) => void;
  /**
   * Issue #1816: open an activity without the toggle-closed behaviour.
   * Issue #3591: no longer read here — the Verification chip toggles like the
   * header's tools. Kept so the detail screen's props stay unchanged.
   */
  onActivityOpen: (id: ActivityId) => void;

  /**
   * Issue #1816: task contract + verification runs for this worktree, owned by
   * `useWorktreeVerification` in the detail controller. Feeds BOTH the header
   * chip and the Verification activity pane from one set of requests.
   */
  verification: WorktreeVerificationState;

  // Header actions
  onInfoClick: () => void;

  // Pending insert text (usePendingInsertText, Issue #755)
  pendingInsertTextMap: Map<number, string | null>;
  setFocusedSplitIndex: (idx: number) => void;
  handleInsertToSplit: (splitIndex: number, text: string) => void;
  handleInsertConsumed: (idx: number) => void;
  handleInsertToMessage: (text: string) => void;

  // Auto-yes (Issue #896: per-instance; map keyed by instanceId)
  autoYesStateMap: Map<string, AutoYesInstanceSummary>;
  makeAutoYesToggleHandler: (cliToolId: CLIToolType, instanceId?: string) => (params: AutoYesToggleParams) => Promise<void>;

  // History controls
  showArchived: boolean;
  onShowArchivedChange: (show: boolean) => void;
  historyDisplayLimit: HistoryDisplayLimit;
  onHistoryDisplayLimitChange: (limit: HistoryDisplayLimit) => void;
  historyUserOnly: boolean;
  onHistoryUserOnlyChange: (userOnly: boolean) => void;

  // Messaging
  onMessageSent: () => void;
  onFilePathClick: (path: string) => void;
  /** Issue #786 (D-5): shared `ShowToast` alias (`'warning'` included for drop reject toast). */
  showToast: ShowToast;

  // File tabs / right pane
  tabsState: FileTabsState;
  tabsActions: FileTabsActions;
  onLoadContent: (path: string, content: FileContent) => void;
  onLoadError: (path: string, errorMsg: string) => void;
  onSetLoading: (path: string, isLoading: boolean) => void;
  onFilePanelSave: (savedPath: string) => void;
  onDirtyChange: (path: string, isDirty: boolean) => void;
  onOpenFile: (path: string) => void;
  diffContent: string | null;
  diffFilePath: string | null;
  onCloseDiff: () => void;

  // Files activity (tree + search)
  fileSearch: UseFileSearchReturn;
  fileTreeRefresh: number;
  onFileSelect: (path: string) => void;
  onNewFile: (parentPath: string) => void;
  onNewDirectory: (parentPath: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  onUpload: (targetDir: string) => void;
  onMove: (path: string, type: 'file' | 'directory') => void;
  /** [Issue #1108] Reset the controller-owned Files view state (search + tabs/viewer). */
  onFileTreeReset: () => void;

  // Git activity
  onDiffSelect: (diff: string, filePath: string) => void;

  // Agent activity (Issue #869: instance roster manager)
  onAgentInstancesChange: (instances: AgentInstance[]) => void;
  vibeLocalModel: string | null;
  onVibeLocalModelChange: (model: string | null) => void;
  vibeLocalContextWindow: number | null;
  onVibeLocalContextWindowChange: (value: number | null) => void;

  // Info modal
  isInfoModalOpen: boolean;
  onInfoModalClose: () => void;
  onWorktreeUpdate: (updated: Worktree) => void;

  // File input
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;

  // Kill session confirmation (Issue #1171: target-snapshot based)
  /** Opens the kill confirmation modal for the active agent instance (DesktopHeader, Issue #784). */
  onKillSession: () => void;
  /** Issue #1171: open the confirm dialog for a specific split's snapshotted target. */
  onRequestSessionEnd: (target: SessionKillTarget) => void;
  /** Issue #1171: the snapshotted kill target; non-null opens the dialog (no separate boolean). */
  killTarget: SessionKillTarget | null;
  /** Issue #1171: true while the kill POST is in flight (disables Confirm, blocks double-submit). */
  isKillPending: boolean;
  onKillCancel: () => void;
  onKillConfirm: () => void;

  // Move dialog
  moveTarget: MoveTarget | null;
  isMoveDialogOpen: boolean;
  onMoveCancel: () => void;
  onMoveConfirm: (destPath: string) => void;

  // New file dialog
  showNewFileDialog: boolean;
  newFileParentPath: string;
  onNewFileConfirm: (finalName: string) => void;
  onNewFileCancel: () => void;

  // i18n strings (resolved by parent to avoid duplicate translation namespaces)
  killDialogTitle: string;
  killDialogWarning: string;
  cancelLabel: string;
  endLabel: string;
}

/**
 * WorktreeDetailDesktop - PC orchestrator for the worktree detail screen.
 */
/**
 * The Verification chip for the PC worktree screen (Issue #1816 / #2064 / #3590).
 *
 * Always rendered (Issue #2064): it used to hide itself on a worktree with no
 * task row, which put the Verification entry point out of reach of exactly the
 * people who have never sent a contract.
 *
 * `latestRunGates` is gated on the pane's selection because that is the only
 * run whose gate rows this state ever holds. Issue #3590: and held here, not
 * only in the chip — the chip remounts whenever `FilePanelSplit` moves the
 * terminal (first file opened / last one closed), and the failing gates of the
 * latest run must survive that once the operator has selected an older run.
 *
 * @param verification - The worktree's verification state (task, latest run, the pane's selected run)
 * @param onOpen - Opens the Verification pane (Issue #3591: toggles it)
 * @param paneOpen - Whether the Verification pane is open (Issue #3591: the chip's hint says "close" then)
 */
export function useDesktopVerificationChip(
  verification: Pick<WorktreeVerificationState, 'task' | 'latestRun' | 'selectedRun'>,
  onOpen: () => void,
  paneOpen = false
): React.ReactElement {
  const { task, latestRun, selectedRun } = verification;
  const latestRunGates = useGatesOfLatestRun(
    latestRun,
    selectedRun !== null && selectedRun.id === latestRun?.id ? selectedRun.gates : null
  );
  return useMemo(
    () => (
      <VerificationStatusChip
        task={task}
        latestRun={latestRun}
        latestRunGates={latestRunGates}
        onOpen={onOpen}
        paneOpen={paneOpen}
        // Issue #3590: the action bar clips, and the terminal pane beside an
        // open file panel is `overflow-hidden` — the reason floats out of both.
        popover="floating"
      />
    ),
    [task, latestRun, latestRunGates, onOpen, paneOpen],
  );
}

export const WorktreeDetailDesktop = memo(function WorktreeDetailDesktop({
  worktreeId,
  worktree,
  worktreeName,
  worktreeStatus,
  instances,
  rosterReady,
  activeInstanceId,
  setActiveInstanceId,
  instanceSelectionRequest = null,
  onInstanceSelectionHandled,
  hasUpdate,
  lastAutoResponse,
  activeActivity,
  onActivityToggle,
  verification,
  onInfoClick,
  pendingInsertTextMap,
  setFocusedSplitIndex,
  handleInsertToSplit,
  handleInsertConsumed,
  handleInsertToMessage,
  autoYesStateMap,
  makeAutoYesToggleHandler,
  showArchived,
  onShowArchivedChange,
  historyDisplayLimit,
  onHistoryDisplayLimitChange,
  historyUserOnly,
  onHistoryUserOnlyChange,
  onMessageSent,
  onFilePathClick,
  showToast,
  tabsState,
  tabsActions,
  onLoadContent,
  onLoadError,
  onSetLoading,
  onFilePanelSave,
  onDirtyChange,
  onOpenFile,
  diffContent,
  diffFilePath,
  onCloseDiff,
  fileSearch,
  fileTreeRefresh,
  onFileSelect,
  onNewFile,
  onNewDirectory,
  onRename,
  onDelete,
  onUpload,
  onMove,
  onFileTreeReset,
  onDiffSelect,
  onAgentInstancesChange,
  vibeLocalModel,
  onVibeLocalModelChange,
  vibeLocalContextWindow,
  onVibeLocalContextWindowChange,
  isInfoModalOpen,
  onInfoModalClose,
  onWorktreeUpdate,
  fileInputRef,
  onFileInputChange,
  onKillSession,
  onRequestSessionEnd,
  killTarget,
  isKillPending,
  onKillCancel,
  onKillConfirm,
  moveTarget,
  isMoveDialogOpen,
  onMoveCancel,
  onMoveConfirm,
  showNewFileDialog,
  newFileParentPath,
  onNewFileConfirm,
  onNewFileCancel,
  killDialogTitle,
  killDialogWarning,
  cancelLabel,
  endLabel,
}: WorktreeDetailDesktopProps) {
  const tWorktree = useTranslations('worktree');

  /**
   * Issue #786 / #869: the agent instanceId currently being dragged from a
   * DesktopHeader instance tab. Published here so each split can drive its
   * dragOver allowed/forbidden ring (D-2; getData is unreadable during dragover
   * in real browsers). This is React state, not a ref, because the splits must
   * re-render to show the ring while a drag is in flight. That transient
   * re-render only happens at drag start/end — NOT on the polling cadence — so
   * it does not regress the #743/#756 memo stability (which concerns the steady
   * state).
   */
  const [draggedInstanceId, setDraggedInstanceId] = React.useState<string | null>(null);
  const handleAgentDragStart = useCallback(
    (instanceId: string) => setDraggedInstanceId(instanceId),
    [],
  );
  const handleAgentDragEnd = useCallback(() => setDraggedInstanceId(null), []);

  /**
   * Issue #1783: instanceId -> reported model, for the roster pane.
   *
   * A projection of `sessionStatusByInstance` rather than the map itself,
   * because the pane takes a plain id->model lookup and should not have to know
   * the shape of the status payload. Entries with no model are dropped, so the
   * pane's `?? null` is reached for exactly the instances that reported nothing.
   */
  const agentModelByInstance = useMemo(
    () => buildModelByInstance(worktree?.sessionStatusByInstance),
    [worktree?.sessionStatusByInstance]
  );

  /**
   * Issue #2042: instanceId -> what that instance's agent says about its session.
   *
   * Collected from the splits rather than fetched here, because the only server
   * route that carries it is `current-output`, which each split already polls
   * for its own instance — a second fetch per roster row would multiply that
   * poll by the roster size to fill a tooltip.
   *
   * Consequences worth stating: an instance with no open split has no entry (its
   * pill's tooltip reads exactly as it did before #2042), and an entry outlives
   * the split that produced it until another one replaces it. The second is
   * deliberate — a user closing a split has not ended the session — and bounded,
   * because the server retires the record when the pane is killed and the next
   * poll from any split then publishes nulls.
   */
  const [agentSessionByInstance, setAgentSessionByInstance] = useState<
    Readonly<Record<string, AgentSessionSnapshot>>
  >({});
  const handleAgentSessionChange = useCallback(
    (instanceId: string, snapshot: AgentSessionSnapshot) => {
      setAgentSessionByInstance(prev =>
        prev[instanceId] === snapshot ? prev : { ...prev, [instanceId]: snapshot }
      );
    },
    []
  );

  /**
   * Issue #1152: header instance switcher → terminal wiring.
   *
   * Previously the DesktopHeader instance pills called `setActiveInstanceId`
   * only, which drives the header badge / kill target / Auto-Yes UI but is NOT
   * connected to `useTerminalSplits` (owned inside TerminalSplitContainer). So
   * selecting "Claude" in the header left the split — and therefore the display
   * polling and message send — pinned to whatever instance the split held (e.g.
   * `claude-2`). This handler publishes a token-stamped selection the container
   * applies to the selected split (see `headerInstanceSelection` on
   * TerminalSplitContainer). The token bumps per click so the container applies
   * it exactly once and does not confuse it with the drop / reconcile paths.
   */
  const [headerInstanceSelection, setHeaderInstanceSelection] =
    React.useState<{ instanceId: string; token: number } | null>(null);
  const headerSelectTokenRef = React.useRef(0);
  const handleHeaderInstanceSelect = useCallback((instanceId: string) => {
    // Issue #3593: route the selection into the selected terminal split. The
    // active instance (kill / Auto-Yes / the header's current session) follows
    // the split through `selectedSplit` below, so it is not set here: setting
    // it first would show a session the split may not end up showing.
    headerSelectTokenRef.current += 1;
    setHeaderInstanceSelection({ instanceId, token: headerSelectTokenRef.current });
  }, []);

  /**
   * Issue #3593: the selected split, published by the split container. The
   * header's current session is the session it shows, and so are End and
   * Auto Yes: the active instance is kept equal to it, so the three read one
   * value. Applied only for an instance the roster holds — the controller's
   * own reconcile moves the active instance off anything else, and the two
   * must not fight.
   */
  const [selectedSplit, setSelectedSplit] = useState<SelectedSplit | null>(null);
  const selectedInstanceId = selectedSplit?.instanceId ?? null;
  const activeInstanceIdRef = React.useRef(activeInstanceId);
  activeInstanceIdRef.current = activeInstanceId;
  React.useEffect(() => {
    if (!selectedInstanceId) return;
    if (!instances.some((inst) => inst.id === selectedInstanceId)) return;
    if (activeInstanceIdRef.current === selectedInstanceId) return;
    setActiveInstanceId(selectedInstanceId);
  }, [selectedInstanceId, instances, setActiveInstanceId]);

  /**
   * Issue #3514: the header "+" (AgentAddMenu).
   *
   * The menu PATCHes the roster and reports where the user asked to open the
   * new agent; that becomes a token-stamped placement request the split
   * container applies once the new roster reaches it. `splitCount` is mirrored
   * up from the container so the menu can refuse `new-split` at the ceiling.
   */
  const [splitCount, setSplitCount] = useState(1);
  const {
    request: instancePlacementRequest,
    requestPlacement,
    handleApplied: handleInstancePlacementApplied,
  } = useTerminalSplitPlacement();
  const handleAgentAdded = useCallback(
    (instance: AgentInstance, placement: AgentPlacement) => {
      requestPlacement(instance.id, placement);
    },
    [requestPlacement],
  );

  const agentAddControl = useMemo(
    () => (
      <AgentAddMenu
        worktreeId={worktreeId}
        instances={instances}
        splitCount={splitCount}
        onInstancesChange={onAgentInstancesChange}
        onAdded={handleAgentAdded}
      />
    ),
    [worktreeId, instances, splitCount, onAgentInstancesChange, handleAgentAdded],
  );

  // Issue #3514: the branch each split's composer names ("To: <agent> ·
  // <branch>"). The header's own rule: the checked-out branch unless git could
  // not tell, then the worktree's name.
  const currentBranch = worktree?.gitStatus?.currentBranch;
  const composerBranchName =
    currentBranch && currentBranch !== '(unknown)' ? currentBranch : worktreeName;

  // Issue #2656: route an instance picked in the sidebar's sessions view
  // through the same path as a header pick (the selected split if shown
  // nowhere — split 0 before #3593 — focus move if another split shows it). The token guard keeps a re-created
  // `handleHeaderInstanceSelect` from re-applying an old request within this
  // mount; acknowledging clears the request so a remount cannot either.
  const appliedInstanceRequestTokenRef = React.useRef(0);
  React.useEffect(() => {
    if (!instanceSelectionRequest) return;
    if (instanceSelectionRequest.token === appliedInstanceRequestTokenRef.current) return;
    appliedInstanceRequestTokenRef.current = instanceSelectionRequest.token;
    handleHeaderInstanceSelect(instanceSelectionRequest.instanceId);
    onInstanceSelectionHandled?.(instanceSelectionRequest.token);
  }, [instanceSelectionRequest, handleHeaderInstanceSelect, onInstanceSelectionHandled]);

  /**
   * Issue #1816: the header chip opens the Verification pane.
   *
   * Issue #3591: the chip is Verification's only entry point now, so it
   * toggles like the header's tools — pressed while the Verification pane is
   * open it closes it; pressed while another pane is open it switches.
   */
  const handleOpenVerification = useCallback(() => {
    onActivityToggle(CHIP_ACTIVITY_ID);
  }, [onActivityToggle]);

  /**
   * Issue #728 (R3-005): PC-only per-split polling fan-out.
   *
   * Each `TerminalSplitPaneContent` owns its own
   * `useTerminalPanePolling({ worktreeId, cliToolId })` instance, so
   *   split 0 (Claude) and split 1 (Codex) hit /current-output for their own
   *   CLI independently. NavigationButtons / PromptPanel / MessageInput are
   *   rendered for every split.
   *
   * The activeCliTab still tracks split 0 so HistoryPane / Auto-Yes UI / kill
   * session controls (which are CLI-tab-scoped, not split-scoped) continue
   * working. We only sync activeCliTab when split 0's CLI changes.
   */
  const renderSplitPane = useCallback(
    ({
      splitIndex,
      cliToolId: paneCli,
      instanceId: paneInstanceId,
      instance: paneInstance,
      availableInstances: paneAvailableInstances,
      onInstanceChange,
      onFocus: onPaneFocus,
      onDropInstance,
      isMaximized: paneIsMaximized,
      onToggleMaximize,
      maximizeDisabled,
      showFocusFrame: paneShowFocusFrame,
    }: {
      splitIndex: number;
      cliToolId: CLIToolType;
      instanceId: string;
      instance: AgentInstance | undefined;
      availableInstances: AgentInstance[];
      onInstanceChange: (instanceId: string) => void;
      onFocus: () => void;
      isFocused: boolean;
      onDropInstance: (instanceId: string) => void;
      /** Issue #2261: container-owned maximize state + toggle for this split. */
      isMaximized: boolean;
      onToggleMaximize: () => void;
      /** Issue #3612: a lone split cannot be maximized. */
      maximizeDisabled?: boolean;
      /** Issue #3514: frame the selected split (focused, and >1 split open). */
      showFocusFrame?: boolean;
    }) => {
      const panePendingInsert = pendingInsertTextMap.get(splitIndex) ?? null;
      // Issue #525 / #740 / #896: auto-yes state is per-INSTANCE in
      // autoYesStateMap; each split resolves its own enabled/expiresAt by its own
      // instanceId so multiple instances of the same CLI tool toggle independently.
      const paneAutoYes = autoYesStateMap.get(paneInstanceId);
      const paneAutoYesEnabled = paneAutoYes?.enabled ?? false;
      const paneAutoYesExpiresAt = paneAutoYes?.expiresAt ?? null;
      // Issue #3723: armed, but this pane's contract says `autoYes.mode: off`.
      const paneAutoYesBlockedByContract = paneAutoYes?.blockedByContract === true;
      // Issue #3730: OFF because the last server restart released this pane's grant.
      const paneAutoYesReleasedByRestart = isReleasedByRestart(paneAutoYes);
      // Issue #743/#875: derive THIS pane's AI agent status. Splits are
      // per-instance, so resolve from the per-instance status map keyed by the
      // pane's instanceId (alias instances show their own status); fall back to
      // the per-CLI map for backward compat. Only the resolved BranchStatus
      // string is handed to the child, so a polling tick that leaves the status
      // unchanged does not break the child's memo (S3-001 memo-safe).
      const paneCliEntry =
        worktree?.sessionStatusByInstance?.[paneInstanceId] ?? worktree?.sessionStatusByCli?.[paneCli];
      const paneCliStatus = deriveCliStatus(paneCliEntry);
      // Issue #2775: whether that status is a `ready` nothing actually read. A
      // boolean, so the child's memo is as safe as it is with the string above.
      const paneCliUnclassified = isUnclassifiedCliStatus(paneCliEntry);
      return (
        <TerminalSplitPaneContent
          worktreeId={worktreeId}
          splitIndex={splitIndex}
          cliToolId={paneCli}
          instanceId={paneInstanceId}
          instance={paneInstance}
          availableInstances={paneAvailableInstances}
          // Issue #869 / #3593: the active instance follows the SELECTED split
          // (see `selectedSplit`), which is published when this split's
          // instance changes — not split 0's, whichever split is selected.
          onInstanceChange={onInstanceChange}
          onFocus={onPaneFocus}
          pendingInsertText={panePendingInsert}
          onInsertConsumed={() => handleInsertConsumed(splitIndex)}
          onMessageSent={onMessageSent}
          // Issue #743: derived per-CLI status string for the split header dot.
          cliStatus={paneCliStatus}
          // Issue #2775: draw that dot as "cannot tell" when it is a fallback.
          cliStatusUnclassified={paneCliUnclassified}
          // Issue #1783: the model this pane's agent reported. Per-INSTANCE
          // only — `sessionStatusByCli` is an aggregate over every instance of
          // the tool, so it has no model to speak of. Undefined (no entry, no
          // hooks, no model) renders nothing.
          // Issue #1784 appends "· <effort>" when the frame showed one.
          onAgentSessionChange={handleAgentSessionChange}
          agentModel={formatAgentModelLabel(
            worktree?.sessionStatusByInstance?.[paneInstanceId]?.model,
            worktree?.sessionStatusByInstance?.[paneInstanceId]?.reasoningEffort
          )}
          // Issue #756: Auto-Yes domain group. Issue #740: enabled/expiresAt are
          // per-CLI; lastAutoResponse is activeCliTab-scoped (useAutoYes), shared
          // across splits for the toggle notification (Issue #501 owns per-split
          // client-side notification, which is out of scope). onToggle is the
          // per-split toggle bound to THIS pane's CLI. Plain inline object: this
          // is a render-prop callback so hooks (useMemo) are illegal here, and
          // the call site already passed unstable inline fns (re-render unchanged).
          autoYes={{
            enabled: paneAutoYesEnabled,
            expiresAt: paneAutoYesExpiresAt,
            lastAutoResponse: lastAutoResponse,
            // Issue #896: bind the toggle to THIS pane's instance so each
            // instance enables/disables its own auto-yes poller independently.
            onToggle: makeAutoYesToggleHandler(paneCli, paneInstanceId),
          }}
          autoYesBlockedByContract={paneAutoYesBlockedByContract}
          autoYesReleasedByRestart={paneAutoYesReleasedByRestart}
          // Issue #756: History domain group. Issue #744: embedded per-split
          // HistoryPane. Each split fetches its OWN cliToolId's messages
          // (useSplitMessages) and shows them only in its own pane. History
          // display controls are common (MVP); the insert handler is bound to
          // THIS splitIndex so an "Insert" click targets this split's
          // MessageInput directly (S3-005), not focusedSplitIndex.
          history={{
            showArchived: showArchived,
            onShowArchivedChange: onShowArchivedChange,
            historyDisplayLimit: historyDisplayLimit,
            onHistoryDisplayLimitChange: onHistoryDisplayLimitChange,
            historyUserOnly: historyUserOnly,
            onHistoryUserOnlyChange: onHistoryUserOnlyChange,
            onInsertToMessage: (text) => handleInsertToSplit(splitIndex, text),
            onFilePathClick: onFilePathClick,
            showToast: showToast,
          }}
          // Issue #786 / #869: drag-drop. onDropInstance is the container-owned
          // drop handler (no-op/reject/apply classification) supplied via
          // renderPane args — passed through unchanged. draggedInstanceId drives
          // the dragOver ring (D-2). The hover ring state stays child-local (D-3).
          onDropInstance={onDropInstance}
          draggedInstanceId={draggedInstanceId}
          // Issue #2261: the container owns "which split is maximized"; the pane
          // renders the title-bar toggle and owns the keyboard chord.
          isMaximized={paneIsMaximized}
          onToggleMaximize={onToggleMaximize}
          maximizeDisabled={maximizeDisabled}
          // Issue #3514: the selected-split frame and the composer's
          // "To: <agent> · <branch>" line.
          showFocusFrame={paneShowFocusFrame ?? false}
          branchName={composerBranchName}
          // Issue #1171: the split builds its own kill-target snapshot and calls
          // this to open the confirm dialog for exactly the session it shows.
          onRequestSessionEnd={onRequestSessionEnd}
        />
      );
    },
    [
      worktreeId,
      pendingInsertTextMap,
      autoYesStateMap,
      handleInsertConsumed,
      onMessageSent,
      lastAutoResponse,
      makeAutoYesToggleHandler,
      // Issue #743/#875: re-create renderPane when the session status maps
      // change so the derived `cliStatus` stays current. The child only
      // re-renders when its resolved status string actually changes (memo-safe).
      worktree?.sessionStatusByCli,
      worktree?.sessionStatusByInstance,
      // Issue #744: embedded HistoryPane wiring deps.
      onFilePathClick,
      showToast,
      handleInsertToSplit,
      showArchived,
      onShowArchivedChange,
      historyDisplayLimit,
      onHistoryDisplayLimitChange,
      historyUserOnly,
      onHistoryUserOnlyChange,
      // Issue #786 / #869: re-create renderPane when the dragged instanceId
      // changes so each split's dragOver ring reflects the in-flight drag
      // (drag-time only, not a polling-cadence re-render).
      draggedInstanceId,
      // Issue #1171: stable controller callback; listed for exhaustive-deps.
      onRequestSessionEnd,
      // Issue #2042: stable (useCallback with no deps); listed for exhaustive-deps.
      handleAgentSessionChange,
      // Issue #3514: changes with the checked-out branch only.
      composerBranchName,
    ],
  );

  // Issue #3590: drawn on the second row (the split action bar), next to the
  // layout icons, instead of in the header.
  const verificationChip = useDesktopVerificationChip(
    verification,
    handleOpenVerification,
    activeActivity === CHIP_ACTIVITY_ID
  );

  const terminalSplitRegion = useMemo(
    () => (
      <TerminalSplitContainer
        worktreeId={worktreeId}
        instances={instances}
        // Issue #898: suppress split reconcile until the real roster is loaded.
        rosterReady={rosterReady}
        renderPane={renderSplitPane}
        onFocusedSplitChange={setFocusedSplitIndex}
        // Issue #786 / #869: the container is the drop validation owner; it
        // fires the success/reject toast and syncs the active instance on an
        // applied drop.
        showToast={showToast}
        onActiveInstanceChange={setActiveInstanceId}
        // Issue #1152 / #3593: route header picks into the selected split.
        headerInstanceSelection={headerInstanceSelection}
        // Issue #3514: show an agent added from the header "+".
        instancePlacementRequest={instancePlacementRequest}
        onInstancePlacementApplied={handleInstancePlacementApplied}
        onSplitCountChange={setSplitCount}
        // Issue #3593: the header's current session and End / Auto Yes follow it.
        onSelectedSplitChange={setSelectedSplit}
        // Issue #3590: the second row's one entry point (`actionBarItems`).
        actionBarItems={verificationChip}
      />
    ),
    // setFocusedSplitIndex / setActiveInstanceId are stable callbacks, and
    // showToast is a stable parent callback, so listing them does not
    // destabilize the memo beyond the existing per-render cadence.
    // headerInstanceSelection changes only on a header pick (a user
    // action, not the polling cadence), so re-creating the region then is fine.
    [worktreeId, instances, rosterReady, renderSplitPane, setFocusedSplitIndex, showToast, setActiveInstanceId, headerInstanceSelection, instancePlacementRequest, handleInstancePlacementApplied, verificationChip],
  );

  /**
   * Issue #728: PC right pane variant. Uses TerminalSplitContainer in the
   * terminal slot of FilePanelSplit and passes terminalHeader={null}.
   */
  const rightPaneSplitMemo = useMemo(
    () => (
      <FilePanelSplit
        terminal={terminalSplitRegion}
        terminalHeader={null}
        fileTabs={tabsState}
        worktreeId={worktreeId}
        onCloseTab={tabsActions.closeTab}
        onActivateTab={tabsActions.activateTab}
        onLoadContent={onLoadContent}
        onLoadError={onLoadError}
        onSetLoading={onSetLoading}
        onFileSaved={onFilePanelSave}
        diffContent={diffContent}
        diffFilePath={diffFilePath}
        onCloseDiff={onCloseDiff}
        onDirtyChange={onDirtyChange}
        onMoveToFront={tabsActions.moveToFront}
        onOpenFile={onOpenFile}
      />
    ),
    [
      terminalSplitRegion,
      tabsState,
      worktreeId,
      tabsActions.closeTab,
      tabsActions.activateTab,
      onLoadContent,
      onLoadError,
      onSetLoading,
      onFilePanelSave,
      diffContent,
      diffFilePath,
      onCloseDiff,
      onDirtyChange,
      tabsActions.moveToFront,
      onOpenFile,
    ],
  );

  /*
   * Issue #3591: the vertical Activity Bar (#727, `activityBarMemo`) is gone.
   * Its tools are drawn by `DesktopHeader` at the right of the header
   * (`activeActivity` / `onActivityToggle` below) and Verification opens from
   * the chip on the second row (`verificationChip`).
   */

  /**
   * Issue #3589: the activity pane opens OVER the terminal unless pinned. The
   * pin is global (`ACTIVITY_PANE_PINNED_STORAGE_KEY`), not per worktree.
   */
  const { pinned: activityPanePinned, togglePinned: toggleActivityPanePinned } =
    usePanePinnedState(ACTIVITY_PANE_PINNED_STORAGE_KEY);

  /**
   * Close the open activity (toggling the active one closes it — the same
   * persisted closed state a re-click of its icon writes). `returnFocus` puts
   * the keyboard back on the icon that opened it (Esc / ×, and a file opened
   * from the keyboard) — Issue #3591: the header tool, the "…" it folded into,
   * or the Verification chip; an outside press leaves focus where the user put it.
   */
  const closeActivityPane = useCallback(
    (returnFocus: boolean) => {
      if (activeActivity === null) return;
      onActivityToggle(activeActivity);
      if (returnFocus) focusActivityEntry(activeActivity);
    },
    [activeActivity, onActivityToggle]
  );
  const handleActivityPaneClose = useCallback(() => closeActivityPane(true), [closeActivityPane]);
  /** Issue #3589: the active content's unsaved state (the Env editor reports it). */
  const { reportDirty: reportActivityPaneDirty, isDirty: isActivityPaneDirty } =
    usePaneDirtyTracker();
  const handleActivityPaneDismiss = useCallback(
    (reason: PaneDismissReason) => closeActivityPane(reason === 'escape'),
    [closeActivityPane]
  );

  /**
   * Issue #3589: opening a file from the tree closes an unpinned pane — the
   * file opens in the body the pane was covering. A pinned pane stays.
   * When the keyboard was in the pane (a row opened with Enter / Space), it
   * goes back to the icon that opened the pane, as on Esc / × — otherwise it
   * would fall to <body> with the unmounted row.
   */
  const handleTreeFileSelect = useCallback(
    (path: string) => {
      const focusInPane =
        typeof document !== 'undefined' &&
        document.activeElement?.closest('[data-testid="activity-pane-slot"]') != null;
      onFileSelect(path);
      if (!activityPanePinned) closeActivityPane(focusInPane);
    },
    [onFileSelect, activityPanePinned, closeActivityPane]
  );

  /**
   * Issue #727: Activity Pane content map (memoized).
   *
   * MAINTENANCE NOTE (Issue #411 R3-007 / Issue #727):
   * Add every prop / state / callback used inside any activity child to the
   * deps array below or the memoized child output will be stale.
   */
  const activityContent = useMemo<ActivityContentMap>(
    () => ({
      files: (
        <div className="h-full flex flex-col">
          <SearchBar
            query={fileSearch.query}
            mode={fileSearch.mode}
            isSearching={fileSearch.isSearching}
            error={fileSearch.error}
            onQueryChange={fileSearch.setQuery}
            onModeChange={fileSearch.setMode}
            onClear={fileSearch.clearSearch}
          />
          <FileTreeView
            worktreeId={worktreeId}
            onFileSelect={handleTreeFileSelect}
            onNewFile={onNewFile}
            onNewDirectory={onNewDirectory}
            onRename={onRename}
            onDelete={onDelete}
            onUpload={onUpload}
            onMove={onMove}
            onResetView={onFileTreeReset}
            refreshTrigger={fileTreeRefresh}
            pollingEnabled={activeActivity === 'files'}
            searchQuery={fileSearch.query}
            searchMode={fileSearch.mode}
            searchResults={fileSearch.results?.results}
            className="flex-1 min-h-0"
          />
        </div>
      ),
      git: (
        <GitPane
          worktreeId={worktreeId}
          onDiffSelect={onDiffSelect}
          isMobile={false}
          worktree={worktree ?? undefined}
          onInsertToMessage={handleInsertToMessage}
          className="h-full"
        />
      ),
      notes: (
        <MemoPane
          worktreeId={worktreeId}
          className="h-full"
          onInsertToMessage={handleInsertToMessage}
        />
      ),
      schedules: (
        <ExecutionLogPane
          worktreeId={worktreeId}
          className="h-full"
          onInsertToMessage={handleInsertToMessage}
          instances={instances}
        />
      ),
      agent: (
        <AgentInstancesPane
          worktreeId={worktreeId}
          instances={instances}
          onInstancesChange={onAgentInstancesChange}
          vibeLocalModel={vibeLocalModel}
          onVibeLocalModelChange={onVibeLocalModelChange}
          vibeLocalContextWindow={vibeLocalContextWindow}
          onVibeLocalContextWindowChange={onVibeLocalContextWindowChange}
          // Issue #1783: read-only observed model per roster row. The map is
          // the per-instance status map itself — the pane reads `[id]?.model`
          // — so no extra derivation and no extra memo dependency.
          modelByInstance={agentModelByInstance}
          // Issue #2316: the pane is otherwise laid out at content height (the
          // mobile shell embeds the same component in its own scroller), so the
          // activity column's fixed height would just clip its two bottom
          // disclosures. Handing it `h-full` — the same class git / notes /
          // schedules / todo / skills / verification / env are mounted with —
          // makes it the scroll owner inside ActivityPane's `min-h-0` column.
          className="h-full"
        />
      ),
      timer: <TimerPane worktreeId={worktreeId} instances={instances} />,
      // Issue #1015: branch-scoped ToDo list. NOTE: ActivityContentMap is a
      // Partial<Record<ActivityId, ReactNode>> ([S3-002]) so omitting this entry
      // would NOT be a tsc error — it would silently render an empty pane. Keep
      // both this map entry and `worktreeId` in the deps array below.
      todo: <TodoPane worktreeId={worktreeId} className="h-full" />,
      // Issue #1441: worktree-scoped Skill install/uninstall. The pane is fixed
      // to the parent-owned worktreeId, so it plans/installs against this
      // checkout without a target picker.
      skills: <WorktreeSkillsPane worktreeId={worktreeId} className="h-full" />,
      // Issue #1816: execution contract + verification gates. Fully controlled
      // by the shared `verification` state, so this pane and the header chip
      // never disagree and never fetch the same rows twice.
      verification: <VerificationPane state={verification} className="h-full" />,
      // Issue #1968: the masked `.env` editor. Owns its own state via
      // `useEnvManager` (an env file is edited by a human, not polled), so the
      // only thing it needs from here is the worktree it is scoped to.
      env: <EnvManagerPane worktreeId={worktreeId} className="h-full" />,
    }),
    [
      worktreeId,
      worktree,
      activeActivity,
      fileSearch.query,
      fileSearch.mode,
      fileSearch.isSearching,
      fileSearch.error,
      fileSearch.setQuery,
      fileSearch.setMode,
      fileSearch.clearSearch,
      fileSearch.results?.results,
      handleTreeFileSelect,
      onNewFile,
      onNewDirectory,
      onRename,
      onDelete,
      onUpload,
      onMove,
      onFileTreeReset,
      fileTreeRefresh,
      onDiffSelect,
      handleInsertToMessage,
      instances,
      onAgentInstancesChange,
      vibeLocalModel,
      onVibeLocalModelChange,
      vibeLocalContextWindow,
      onVibeLocalContextWindowChange,
      agentModelByInstance,
      verification,
    ]
  );

  const activityTitle = useMemo(() => {
    const def = ACTIVITIES.find((a) => a.id === activeActivity);
    return def ? tWorktree(def.labelKey) : '';
  }, [activeActivity, tWorktree]);

  const activityPaneMemo = useMemo(
    () =>
      activeActivity === null ? null : (
        <ActivityPane
          active={activeActivity}
          activities={activityContent}
          onDirtyChange={reportActivityPaneDirty}
        />
      ),
    [activeActivity, activityContent, reportActivityPaneDirty]
  );

  /**
   * Issue #3589: the frame the layout shows the pane in — title row with pin /
   * ×, Esc dismissal (pinned or not, from the pane or the icon that opened it;
   * unpinned also from the page body) and, while unpinned only, outside-press
   * dismissal. A press on a header tool or the Verification chip is not
   * "outside": re-clicking an icon is the tool's own toggle (Issue #3591).
   */
  const activityPaneFrame = useMemo<WorktreeDesktopLayoutProps['activityPaneFrame']>(
    () => ({
      title: activityTitle,
      onTogglePinned: toggleActivityPanePinned,
      onClose: handleActivityPaneClose,
      onDismiss: handleActivityPaneDismiss,
      ignoreOutsideSelectors: ACTIVITY_PANE_IGNORE_OUTSIDE,
      isDirty: isActivityPaneDirty,
      resetKey: activeActivity,
      testIdPrefix: 'activity-pane',
    }),
    [
      activityTitle,
      toggleActivityPanePinned,
      handleActivityPaneClose,
      handleActivityPaneDismiss,
      isActivityPaneDirty,
      activeActivity,
    ]
  );

  // Issue #744: the top-level HistoryPane (historyPaneMemo) was removed — the
  // History pane now lives inside each PC terminal split
  // (`TerminalSplitPaneContent`), fetching its own cliToolId's messages. The
  // mobile path renders its own HistoryPane via `MobileContent` (unchanged).

  return (
    <ErrorBoundary componentName="WorktreeDetailRefactored">
      {/*
        Issue #730: Outer flex put the ActivityBar as a full-height column on
        the left. Issue #3591: that column is gone — its tools are in
        DesktopHeader — so the only column left of the screen is the app's
        icon rail. The inner column hosts DesktopHeader / BranchMismatchAlert /
        WorktreeDesktopLayout (now a 2-column layout) / NavigationButtons /
        MessageInput / PromptPanel.

        History now lives inside `TerminalContainer` (passed as `rightPane`),
        so the desktop layout itself no longer takes a `historyPane` prop.

        Issue #2481: `overflow-hidden` clips without a scrollbar, so nothing in
        this column may count on overflowing it. DesktopHeader fits itself to
        the column's width instead (see `useDesktopHeaderFit`).
      */}
      <div className="flex h-full overflow-hidden relative">
        {/* Issue #732: min-w-0 主因。flex-row(L1738) の直接 flex item のため
            main 軸に min-width:auto が効き、子孫 FilePanelSplit の固定幅ペインの
            コンテンツ要求まで膨張して FilePanel が viewport 外へ押し出される問題を防ぐ */}
        <div className="flex flex-col flex-1 min-h-0 min-w-0">
          {/* Desktop Header with status and info */}
          <DesktopHeader
            worktreeId={worktreeId}
            worktreeName={worktreeName}
            repositoryName={
              worktree?.repositoryDisplayName ??
              worktree?.repositoryName ??
              tWorktree('detail.unknownRepository')
            }
            description={worktree?.description}
            status={worktreeStatus}
            gitStatus={worktree?.gitStatus}
            onInfoClick={onInfoClick}
            hasUpdate={hasUpdate}
            sessionStatusByCli={worktree?.sessionStatusByCli}
            sessionStatusByInstance={worktree?.sessionStatusByInstance}
            instances={instances}
            activeInstanceId={activeInstanceId}
            // Issue #1152 / #3593: a header pick drives the selected terminal
            // split (display polling + send); the active instance follows it.
            onActiveInstanceChange={handleHeaderInstanceSelect}
            // Issue #786 / #869: publish the dragged agent's instanceId so each
            // terminal split can show its dragOver allowed/forbidden ring (D-2).
            onAgentDragStart={handleAgentDragStart}
            onAgentDragEnd={handleAgentDragEnd}
            onKillSession={onKillSession}
            // Issue #2042: cost / context for the sessions' tooltips. Sparse — only
            // instances with an open split have an entry.
            agentSessionByInstance={agentSessionByInstance}
            // Issue #3514: "+" at the right end of the session field.
            agentAddControl={agentAddControl}
            // Issue #3593: the "N others" list names each session's split.
            splitInstanceIds={selectedSplit?.splitInstanceIds}
            // Issue #3591: the worktree's tools, at the right of the header.
            activeActivity={activeActivity}
            onActivityToggle={onActivityToggle}
          />
          {/* Issue #111: Branch mismatch warning */}
          {worktree?.gitStatus && (
            <BranchMismatchAlert
              isBranchMismatch={worktree.gitStatus.isBranchMismatch}
              currentBranch={worktree.gitStatus.currentBranch}
              initialBranch={worktree.gitStatus.initialBranch}
            />
          )}
          {/* Issue #732: min-w-0 防御的補強。横溢れ防止のため main 軸主因(L1740)と
              併せて付与。将来のクリーンアップで誤削除しないこと */}
          <div className="flex-1 min-h-0 min-w-0">
            <WorktreeDesktopLayout
              activityPane={activityPaneMemo}
              activityPanePinned={activityPanePinned}
              activityPaneFrame={activityPaneFrame}
              rightPane={
                // Issue #744: History moved into each terminal split, so the
                // top-level History column is no longer rendered on PC.
                <TerminalContainer terminal={rightPaneSplitMemo} />
              }
            />
          </div>
          {/*
            Issue #728: MessageInput / NavigationButtons / PromptPanel were
            moved into each TerminalSplitPane (`rightPaneSplitMemo`). No
            shared footer rendering on PC anymore.
          */}
        </div>
        {/* Info Modal */}
        <InfoModal
          worktreeId={worktreeId}
          worktree={worktree}
          isOpen={isInfoModalOpen}
          onClose={onInfoModalClose}
          onWorktreeUpdate={onWorktreeUpdate}
        />
        {/* Issue #438: Desktop FileViewer modal replaced by FilePanelSplit in rightPaneMemo */}
        {/* Hidden file input for upload */}
        <input
          ref={fileInputRef}
          type="file"
          accept={UPLOADABLE_EXTENSIONS.join(',')}
          onChange={onFileInputChange}
          className="hidden"
          aria-label={tWorktree('detail.uploadFile')}
        />
        {/* Kill session confirmation dialog (Issue #1171: target-snapshot based;
            `killTarget !== null` is the single open-state source, and Confirm is
            disabled while the POST is in flight to prevent a double-submit). */}
        <Modal
          isOpen={killTarget !== null}
          onClose={onKillCancel}
          title={killDialogTitle}
          size="sm"
          showCloseButton={true}
        >
          <div className="space-y-4">
            <p className="text-sm text-foreground">
              {killDialogWarning}
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onKillCancel}
                className="px-4 py-2 text-sm font-medium rounded-md bg-muted hover:bg-muted/80 text-foreground"
              >
                {cancelLabel}
              </button>
              <button
                type="button"
                onClick={onKillConfirm}
                disabled={isKillPending}
                data-testid="kill-session-confirm-button"
                className="px-4 py-2 text-sm font-medium rounded-md bg-danger hover:bg-danger/90 text-white disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {endLabel}
              </button>
            </div>
          </div>
        </Modal>
        {/* [Issue #162] Move Dialog */}
        {moveTarget && (
          <MoveDialog
            isOpen={isMoveDialogOpen}
            onClose={onMoveCancel}
            onConfirm={onMoveConfirm}
            worktreeId={worktreeId}
            sourcePath={moveTarget.path}
            sourceType={moveTarget.type}
          />
        )}
        {/* [Issue #646] New file dialog */}
        <NewFileDialog
          isOpen={showNewFileDialog}
          parentPath={newFileParentPath}
          onConfirm={onNewFileConfirm}
          onCancel={onNewFileCancel}
        />
      </div>
    </ErrorBoundary>
  );
});

// Note: getCliToolDisplayName is re-exported indirectly via the parent; keeping
// it imported here documents the kill-dialog title source (resolved by parent).
void getCliToolDisplayName;
