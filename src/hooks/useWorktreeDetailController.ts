'use client';

/**
 * useWorktreeDetailController (Issue #755)
 *
 * State-management controller hook extracted from WorktreeDetailRefactored.tsx
 * as a pure structural refactor (no behavior change). Owns all the worktree
 * detail screen's shared state, effects, and handlers that are consumed by both
 * the PC (WorktreeDetailDesktop) and Mobile render branches:
 * - Real-time terminal output polling / prompt detection / Auto-Yes
 * - useReducer-based UI state, file tabs, file operations, search
 * - Worktree data fetching, recovery, and session lifecycle handlers
 *
 * The parent WorktreeDetailRefactored.tsx is now a thin orchestrator that calls
 * this hook, destructures the returned values, and branches to the Desktop /
 * Mobile presentation. The dynamic MarkdownEditor (ssr:false) and its modal stay
 * in the parent (S3-002). pendingInsertText state lives in usePendingInsertText.
 *
 * Based on Issue #13 UX Improvement design specification.
 */

import React, { useEffect, useCallback, useMemo, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useWorktreeUIState } from '@/hooks/useWorktreeUIState';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useSidebarContext } from '@/contexts/SidebarContext';
import { useOptionalWorktreesCacheContext } from '@/components/providers/WorktreesCacheProvider';
import { type WorktreeStatus } from '@/components/mobile/MobileHeader';
import { type MobileTab } from '@/components/mobile/MobileTabBar';
import { useFileSearch } from '@/hooks/useFileSearch';
import { useActivityBarState } from '@/hooks/useActivityBarState';
import type { ActivityId } from '@/config/activity-bar-config';
import { useFileTabs, MAX_FILE_TABS } from '@/hooks/useFileTabs';
import { usePendingInsertText } from '@/hooks/usePendingInsertText';
import {
  deriveWorktreeStatus,
  parseMessageTimestamps,
} from '@/components/worktree/WorktreeDetailSubComponents';
import { UPLOADABLE_EXTENSIONS, getMaxFileSize, isUploadableExtension } from '@/config/uploadable-extensions';
import { useToast } from '@/components/common/Toast';
import { useAutoYes } from '@/hooks/useAutoYes';
import { buildPromptResponseBody } from '@/lib/prompt-response-body-builder';
import { useUpdateCheck } from '@/hooks/useUpdateCheck';
import { type AutoYesToggleParams } from '@/components/worktree/AutoYesToggle';
import type { AutoYesStopReason } from '@/config/auto-yes-config';
import type { Worktree, ChatMessage, PromptData, FileContent } from '@/types/models';
import {
  isCliToolType,
  isValidInstanceId,
  agentInstancesFromSelectedAgents,
  type CLIToolType,
  type AgentInstance,
} from '@/lib/cli-tools/types';
import { DEFAULT_SELECTED_AGENTS } from '@/lib/selected-agents-validator';
import { useMobileSelectedInstances } from '@/hooks/useMobileSelectedInstances';
import { useTranslations } from 'next-intl';
import { useFileOperations } from '@/hooks/useFileOperations';
import { encodePathForUrl } from '@/lib/url-path-encoder';
import {
  HISTORY_DISPLAY_LIMIT_STORAGE_KEY,
  HISTORY_USER_ONLY_STORAGE_KEY,
  DEFAULT_MESSAGES_LIMIT,
  isHistoryDisplayLimit,
  type HistoryDisplayLimit,
} from '@/config/history-display-config';

// ============================================================================
// Constants
// ============================================================================

/** localStorage key prefix for persisting the active CLI tool tab per worktree */
const ACTIVE_CLI_TAB_STORAGE_KEY_PREFIX = 'activeCliTab-';

/**
 * Issue #869: localStorage key prefix for the active agent *instance* per
 * worktree. Supersedes `activeCliTab-<wt>` (which stored a bare CLI tool id).
 * Migration: when the new key is absent we fall back to the legacy key, whose
 * value is a primary instance id (primary instance id === its CLI tool id).
 */
const ACTIVE_INSTANCE_STORAGE_KEY_PREFIX = 'activeInstanceId-';

// ============================================================================
// Types
// ============================================================================

/** Props for WorktreeDetailRefactored component */

/** API response shape for current output endpoint */
interface CurrentOutputResponse {
  isRunning: boolean;
  cliToolId?: CLIToolType;
  isGenerating?: boolean;
  isPromptWaiting?: boolean;
  promptData?: PromptData;
  content?: string;
  fullOutput?: string;
  realtimeSnippet?: string;
  thinking?: boolean;
  /** Issue #473: OpenCode TUI selection list active flag */
  isSelectionListActive?: boolean;
  autoYes?: {
    enabled: boolean;
    expiresAt: number | null;
    stopReason?: AutoYesStopReason;
  };
  /** Issue #501: Server-side auto-yes response timestamp for client duplicate prevention */
  lastServerResponseTimestamp?: number | null;
  /** Issue #501: Whether server-side auto-yes poller is active */
  serverPollerActive?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/** Polling interval when terminal is active (ms) */
const ACTIVE_POLLING_INTERVAL_MS = 2000;

/** Polling interval when terminal is idle (ms) */
const IDLE_POLLING_INTERVAL_MS = 5000;

/**
 * Throttle interval for visibilitychange recovery (ms).
 * Prevents excessive API calls when the page rapidly transitions between
 * visible and hidden states.
 * Same value as IDLE_POLLING_INTERVAL_MS but semantically independent:
 * - IDLE_POLLING_INTERVAL_MS: steady-state polling frequency
 * - RECOVERY_THROTTLE_MS: visibilitychange burst prevention threshold
 * (Issue #246, SF-001)
 */
const RECOVERY_THROTTLE_MS = 5000;

/** Default worktree name when not loaded */
const DEFAULT_WORKTREE_NAME = 'Unknown';

// ============================================================================
// Main Component
// ============================================================================

/**
 * WorktreeDetailRefactored - Integrated worktree detail component
 *
 * @example
 * ```tsx
 * <WorktreeDetailRefactored worktreeId="feature-123" />
 * ```
 */

export function useWorktreeDetailController({ worktreeId }: { worktreeId: string }) {
  const router = useRouter();
  const isMobile = useIsMobile();
  // Issue #874: ref mirror so the message/output fetchers (which read state via
  // refs to keep a stable identity) can mobile-gate the `instance` query param
  // without being recreated on every isMobile change.
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;
  // Issue #747: the sidebar toggle moved into the ActivityBar (which reads
  // SidebarContext directly), so DesktopHeader no longer needs `toggle` here.
  const { openMobileDrawer } = useSidebarContext();
  const { state, actions } = useWorktreeUIState();
  const tWorktree = useTranslations('worktree');
  const tError = useTranslations('error');
  const tCommon = useTranslations('common');
  const tAutoYes = useTranslations('autoYes');

  // Issue #839: Stale-while-revalidate priming. The worktree *list* is already
  // cached by useWorktreesCache (exposed via WorktreesCacheProvider). When the
  // user opens a detail screen for a worktree that is already in that cache, we
  // seed the local `worktree` state from the cached list item so the screen
  // renders immediately with real data instead of flashing "Loading worktree
  // info...". The background fetchWorktree() below still runs and overwrites the
  // seeded value with the authoritative (full) detail payload (fresh > cached).
  //
  // Read through the *context* (non-throwing variant) rather than calling
  // useWorktreesCache() directly: a second direct call would spawn an extra
  // /api/worktrees poller, the regression Issue #709 fixed. When the provider is
  // absent (isolated unit tests) this degrades to the cache-miss path.
  const cache = useOptionalWorktreesCacheContext();
  const initialFromCache = cache?.worktrees.find((w) => w.id === worktreeId) ?? null;

  // Local state for worktree data and loading status
  const [worktree, setWorktree] = useState<Worktree | null>(initialFromCache);
  // On a cache hit we already have data to show, so skip the full-screen loading
  // gate; on a cache miss fall back to the previous loading-first behavior.
  const [loading, setLoading] = useState(initialFromCache === null);
  const [error, setError] = useState<string | null>(null);
  // Captured once at mount: whether the initial render was primed from cache.
  // Drives the loadInitialData loading guard so the background refresh on a
  // cache hit never flips the screen back to the loading indicator.
  const primedFromCacheRef = useRef(initialFromCache !== null);
  const [isInfoModalOpen, setIsInfoModalOpen] = useState(false);
  // Issue #438: File tabs state (replaces fileViewerPath for desktop)
  // Issue #683: B案 - [tabsState, tabsActions] tuple; tabsActions is stable across renders
  const [tabsState, tabsActions] = useFileTabs(worktreeId);
  // Mobile-only: file viewer path for modal display (desktop uses fileTabs)
  const [mobileFileViewerPath, setMobileFileViewerPath] = useState<string | null>(null);
  const [editorFilePath, setEditorFilePath] = useState<string | null>(null);
  // Issue #104: Track editor maximized state to disable Modal close handlers
  const [isEditorMaximized, setIsEditorMaximized] = useState(false);
  // Issue #525: Per-agent auto-yes state management
  const [autoYesStateMap, setAutoYesStateMap] = useState<Map<string, { enabled: boolean; expiresAt: number | null }>>(new Map());
  // Issue #501: Track last server-side auto-yes response timestamp for duplicate prevention
  const [lastServerResponseTimestamp, setLastServerResponseTimestamp] = useState<number | null>(null);
  // Issue #501: Track whether server-side auto-yes poller is active
  const [serverPollerActive, setServerPollerActive] = useState(false);
  // Issue #473: Track OpenCode TUI selection list state
  const [isSelectionListActive, setIsSelectionListActive] = useState(false);
  // Issue #314: Track previous auto-yes enabled state for stop reason toast
  const prevAutoYesEnabledRef = useRef<boolean>(false);
  // Issue #314 / #499 Item 5: Pending stop reason toast (deferred until showToast is available)
  // Stores the actual stopReason value to determine toast level (info vs warning)
  const [pendingStopReason, setPendingStopReason] = useState<AutoYesStopReason | null>(null);
  // Issue #368: Selected agents state (initialized from API, drives terminal header tabs)
  const [selectedAgents, setSelectedAgents] = useState<CLIToolType[]>(DEFAULT_SELECTED_AGENTS);
  // Ref to access latest selectedAgents inside fetchWorktree without adding to useCallback deps
  const selectedAgentsRef = useRef(selectedAgents);
  selectedAgentsRef.current = selectedAgents;
  // Issue #869: Agent instance roster (PC). Drives the instance tabs / split
  // selectors. Decoupled from selectedAgents server-side; seeded from the
  // default selection until the worktree's agentInstances arrive from the API.
  const [agentInstances, setAgentInstances] = useState<AgentInstance[]>(
    () => agentInstancesFromSelectedAgents(DEFAULT_SELECTED_AGENTS),
  );
  const agentInstancesRef = useRef(agentInstances);
  agentInstancesRef.current = agentInstances;
  // Issue #368: Vibe-local Ollama model state (initialized from API)
  const [vibeLocalModel, setVibeLocalModel] = useState<string | null>(null);
  // Issue #374: Vibe-local context window state (initialized from API)
  const [vibeLocalContextWindow, setVibeLocalContextWindow] = useState<number | null>(null);
  // Issue #4: CLI tool tab state - restored from localStorage or fallback to selectedAgents[0]
  const [activeCliTab, setActiveCliTabRaw] = useState<CLIToolType>(() => {
    try {
      const saved = window.localStorage.getItem(ACTIVE_CLI_TAB_STORAGE_KEY_PREFIX + worktreeId);
      if (saved && isCliToolType(saved)) {
        return saved;
      }
    } catch { /* localStorage unavailable (SSR) */ }
    return DEFAULT_SELECTED_AGENTS[0];
  });
  // Wrapper: persist activeCliTab to localStorage on change
  const setActiveCliTab = useCallback((tool: CLIToolType) => {
    setActiveCliTabRaw(tool);
    try {
      window.localStorage.setItem(ACTIVE_CLI_TAB_STORAGE_KEY_PREFIX + worktreeId, tool);
    } catch { /* localStorage unavailable */ }
  }, [worktreeId]);
  // Issue #4: Ref to avoid polling callback recreation on tab switch
  const activeCliTabRef = useRef<CLIToolType>(activeCliTab);
  activeCliTabRef.current = activeCliTab;
  // Issue #869: active agent *instance* (PC). The instance is the tab/split
  // identity; `activeCliTab` is kept in sync with the active instance's CLI tool
  // (cliTool-keyed concerns — auto-yes, status, kill — stay keyed on it).
  const [activeInstanceId, setActiveInstanceIdRaw] = useState<string>(() => {
    try {
      const saved = window.localStorage.getItem(ACTIVE_INSTANCE_STORAGE_KEY_PREFIX + worktreeId);
      if (saved && isValidInstanceId(saved)) {
        return saved;
      }
      // Migration: legacy key stored a bare CLI tool id (== primary instance id).
      const legacy = window.localStorage.getItem(ACTIVE_CLI_TAB_STORAGE_KEY_PREFIX + worktreeId);
      if (legacy && isCliToolType(legacy)) {
        return legacy;
      }
    } catch { /* localStorage unavailable (SSR) */ }
    return DEFAULT_SELECTED_AGENTS[0];
  });
  // Wrapper: persist activeInstanceId AND sync activeCliTab from the instance's
  // CLI tool so cliTool-keyed concerns follow the active instance.
  const setActiveInstanceId = useCallback((instanceId: string) => {
    setActiveInstanceIdRaw(instanceId);
    try {
      window.localStorage.setItem(ACTIVE_INSTANCE_STORAGE_KEY_PREFIX + worktreeId, instanceId);
    } catch { /* localStorage unavailable */ }
    const inst = agentInstancesRef.current.find(i => i.id === instanceId);
    if (inst) {
      setActiveCliTab(inst.cliTool);
    }
  }, [worktreeId, setActiveCliTab]);
  const activeInstanceIdRef = useRef<string>(activeInstanceId);
  activeInstanceIdRef.current = activeInstanceId;
  // Issue #597: Latest-request guards prevent stale async responses from older
  // polls/tab switches from overwriting the active CLI tab state.
  const latestMessagesRequestIdRef = useRef(0);
  const latestCurrentOutputRequestIdRef = useRef(0);
  // Issue #525: Derive active agent's auto-yes state from per-agent map
  const autoYesEnabled = autoYesStateMap.get(activeCliTab)?.enabled ?? false;
  const autoYesExpiresAt = autoYesStateMap.get(activeCliTab)?.expiresAt ?? null;
  // Trigger to refresh FileTreeView after file operations
  const [fileTreeRefresh, setFileTreeRefresh] = useState(0);

  // [Issue #646] NewFileDialog state
  const [showNewFileDialog, setShowNewFileDialog] = useState(false);
  const [newFileParentPath, setNewFileParentPath] = useState('');

  // Issue #727: Activity Bar + History pane state (PC)
  // Issue #858: persisted per-worktree so the open/closed state no longer
  // leaks across branch (worktree) switches.
  const {
    active: activeActivity,
    toggle: toggleActivity,
  } = useActivityBarState(worktreeId);
  // Issue #744: the top-level History column was removed on PC (History moved
  // into each terminal split), so `WorktreeDetailRefactored` no longer needs a
  // `useHistoryPaneState` instance. Each `TerminalSplitPaneContent` owns its
  // own instance for the split-internal History visibility/width.

  // [Issue #888] File-tree external-change detection was moved INTO
  // FileTreeView (it now covers the root + every expanded subdirectory, not
  // just the root). The controller only retains `fileTreeRefresh` to force an
  // explicit refresh after local file operations (create/rename/delete/upload).

  // [Issue #447] History sub-tab: 'message' (default) or 'git'
  const [historySubTab, setHistorySubTab] = useState<'message' | 'git'>('message');

  // Issue #168: showArchived toggle state with localStorage persistence
  const [showArchived, setShowArchived] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('commandmate:showArchived') === 'true';
  });
  const handleShowArchivedChange = useCallback((show: boolean) => {
    setShowArchived(show);
    localStorage.setItem('commandmate:showArchived', String(show));
  }, []);
  // Ref for showArchived to avoid callback recreation
  const showArchivedRef = useRef(showArchived);
  useEffect(() => {
    showArchivedRef.current = showArchived;
  }, [showArchived]);

  // Issue #725: HistoryPane "User only" filter toggle with localStorage persistence.
  // Value representation: 'true' / 'false' (matches commandmate:showArchived).
  // Any other value (including legacy '1'/'0') is treated as false (safe-off fallback).
  const [historyUserOnly, setHistoryUserOnly] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return localStorage.getItem(HISTORY_USER_ONLY_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const handleHistoryUserOnlyChange = useCallback((next: boolean) => {
    setHistoryUserOnly(next);
    try {
      localStorage.setItem(HISTORY_USER_ONLY_STORAGE_KEY, String(next));
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  // Issue #701: history display limit state with localStorage persistence
  const [historyDisplayLimit, setHistoryDisplayLimit] = useState<HistoryDisplayLimit>(() => {
    if (typeof window === 'undefined') return DEFAULT_MESSAGES_LIMIT;
    try {
      const stored = localStorage.getItem(HISTORY_DISPLAY_LIMIT_STORAGE_KEY);
      if (stored === null) return DEFAULT_MESSAGES_LIMIT;
      const parsed = parseInt(stored, 10);
      return isHistoryDisplayLimit(parsed) ? parsed : DEFAULT_MESSAGES_LIMIT;
    } catch {
      return DEFAULT_MESSAGES_LIMIT;
    }
  });
  const handleHistoryDisplayLimitChange = useCallback((limit: HistoryDisplayLimit) => {
    setHistoryDisplayLimit(limit);
    try {
      localStorage.setItem(HISTORY_DISPLAY_LIMIT_STORAGE_KEY, String(limit));
    } catch {
      /* localStorage unavailable */
    }
  }, []);
  // Ref for historyDisplayLimit to avoid fetchMessages callback recreation
  const historyDisplayLimitRef = useRef(historyDisplayLimit);
  useEffect(() => {
    historyDisplayLimitRef.current = historyDisplayLimit;
  }, [historyDisplayLimit]);

  // [Issue #485 / #728 / #744] Pending insert text state (history/memo -> input).
  // Issue #755: extracted to the usePendingInsertText hook (former inline state +
  // handlers). The hook owns pendingInsertTextMap + focusedSplitIndex +
  // setFocusedSplitIndex and exposes stable-reference handlers.
  const {
    pendingInsertTextMap,
    pendingInsertText,
    setFocusedSplitIndex,
    handleInsertToMessage,
    handleInsertToSplit,
    handleInsertConsumed,
    handleInsertConsumedSingle,
  } = usePendingInsertText();

  // [Issue #447] Diff content for right pane display (PC only)
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [diffFilePath, setDiffFilePath] = useState<string | null>(null);

  // [Issue #21] File search state
  const fileSearch = useFileSearch({ worktreeId });

  // Track if initial load has completed to prevent re-triggering
  const initialLoadCompletedRef = useRef(false);

  // Issue #131: Track previous worktreeId to detect worktree changes
  const prevWorktreeIdRef = useRef<string | undefined>(worktreeId);

  // Issue #131: Reset state when worktreeId changes (worktree switching)
  // This prevents stale messages from previous worktree causing scroll issues
  useEffect(() => {
    if (prevWorktreeIdRef.current !== worktreeId) {
      // Clear messages immediately to prevent scroll animation on stale data
      actions.clearMessages();
      // Reset initial load flag to trigger fresh data fetch
      initialLoadCompletedRef.current = false;
      // Issue #736: terminal output reset is handled by the mobile terminal
      // tab's useTerminalPanePolling (self-resets on worktreeId change).
      // Update ref for next comparison
      prevWorktreeIdRef.current = worktreeId;
    }
  }, [worktreeId, actions]);

  // ========================================================================
  // API Fetch Functions
  // ========================================================================

  /** Fetch worktree metadata */
  const fetchWorktree = useCallback(async (): Promise<Worktree | null> => {
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch worktree: ${response.status}`);
      }
      const data: Worktree = await response.json();
      setWorktree(data);
      // Skip setState when value is unchanged to prevent unnecessary re-renders
      if (data.selectedAgents) {
        const current = selectedAgentsRef.current;
        const isSame = data.selectedAgents.length === current.length &&
          data.selectedAgents.every((v: string, i: number) => v === current[i]);
        if (!isSame) {
          setSelectedAgents(data.selectedAgents);
        }
      }
      // Issue #869: sync the agent instance roster (GET always returns it,
      // falling back to a selectedAgents-derived primary set server-side).
      if (data.agentInstances) {
        const current = agentInstancesRef.current;
        const next = data.agentInstances;
        const isSame = next.length === current.length &&
          next.every((inst, i) =>
            inst.id === current[i].id &&
            inst.cliTool === current[i].cliTool &&
            inst.alias === current[i].alias);
        if (!isSame) {
          setAgentInstances(next);
        }
      }
      // Issue #368: Sync vibeLocalModel from API response
      if ('vibeLocalModel' in data) {
        setVibeLocalModel(data.vibeLocalModel ?? null);
      }
      // Issue #374: Sync vibeLocalContextWindow from API response
      if ('vibeLocalContextWindow' in data) {
        setVibeLocalContextWindow(data.vibeLocalContextWindow ?? null);
      }
      return data;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      return null;
    }
  }, [worktreeId]);

  /** Fetch message history for the worktree */
  // Issue #4: Use ref for activeCliTab to avoid callback recreation on tab switch
  const fetchMessages = useCallback(async (): Promise<void> => {
    const requestedCliTool = activeCliTabRef.current;
    // Issue #874: on mobile the History tab follows the active agent *instance*
    // (tabs are instance-based). Add `instance` only on mobile so PC requests
    // stay byte-for-byte identical (PC History is per-split, keyed elsewhere).
    const onMobile = isMobileRef.current;
    const requestedInstance = activeInstanceIdRef.current;
    const requestId = ++latestMessagesRequestIdRef.current;
    try {
      const params = new URLSearchParams({ cliTool: requestedCliTool });
      if (onMobile) {
        params.set('instance', requestedInstance);
      }
      if (showArchivedRef.current) {
        params.set('includeArchived', 'true');
      }
      // Issue #701: include user-selected history display limit
      params.set('limit', String(historyDisplayLimitRef.current));
      const response = await fetch(`/api/worktrees/${worktreeId}/messages?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch messages: ${response.status}`);
      }
      const data: ChatMessage[] = await response.json();
      if (
        latestMessagesRequestIdRef.current !== requestId ||
        activeCliTabRef.current !== requestedCliTool ||
        (onMobile && activeInstanceIdRef.current !== requestedInstance)
      ) {
        return;
      }
      actions.setMessages(parseMessageTimestamps(data));
    } catch (err) {
      if (
        latestMessagesRequestIdRef.current !== requestId ||
        activeCliTabRef.current !== requestedCliTool ||
        (onMobile && activeInstanceIdRef.current !== requestedInstance)
      ) {
        return;
      }
      console.error('[WorktreeDetailRefactored] Error fetching messages:', err);
    }
  }, [worktreeId, actions]);

  /** Fetch current terminal output and prompt status */
  // Issue #4: Use ref for activeCliTab to avoid callback recreation on tab switch
  const fetchCurrentOutput = useCallback(async (): Promise<void> => {
    const requestedCliTool = activeCliTabRef.current;
    // Issue #874: mobile-gate the instance selector (see fetchMessages). PC keeps
    // the cliTool-keyed parent poll byte-identical; the mobile terminal tab and
    // History follow the active instance.
    const onMobile = isMobileRef.current;
    const requestedInstance = activeInstanceIdRef.current;
    const requestId = ++latestCurrentOutputRequestIdRef.current;
    try {
      const outputUrl = onMobile
        ? `/api/worktrees/${worktreeId}/current-output?cliTool=${requestedCliTool}&instance=${encodeURIComponent(requestedInstance)}`
        : `/api/worktrees/${worktreeId}/current-output?cliTool=${requestedCliTool}`;
      const response = await fetch(outputUrl);
      if (!response.ok) {
        return;
      }
      const data: CurrentOutputResponse = await response.json();
      if (
        latestCurrentOutputRequestIdRef.current !== requestId ||
        activeCliTabRef.current !== requestedCliTool ||
        (onMobile && activeInstanceIdRef.current !== requestedInstance)
      ) {
        return;
      }
      if (data.cliToolId && data.cliToolId !== requestedCliTool) {
        return;
      }

      // Issue #736: terminal output/isActive/isThinking are no longer mirrored
      // into a reducer slice. The mobile terminal tab owns its own
      // `useTerminalPanePolling` instance (like the PC split panes, #728); this
      // parent poll only keeps prompt / selection-list / Auto-Yes state in sync.

      // Handle prompt state transitions
      if (data.isPromptWaiting && data.promptData) {
        actions.showPrompt(data.promptData, `prompt-${Date.now()}`);
      } else if (!data.isPromptWaiting && state.prompt.visible) {
        actions.clearPrompt();
      }

      // Issue #473: Update selection list state from server
      setIsSelectionListActive(data.isSelectionListActive ?? false);

      // Issue #501: Update last server response timestamp for useAutoYes duplicate prevention
      setLastServerResponseTimestamp(data.lastServerResponseTimestamp ?? null);
      setServerPollerActive(data.serverPollerActive ?? false);

      // Update auto-yes state from server (Issue #314: stopReason tracking, Issue #525: per-agent)
      if (data.autoYes) {
        const wasEnabled = prevAutoYesEnabledRef.current;
        const autoYes = data.autoYes;
        setAutoYesStateMap(prev => {
          const next = new Map(prev);
          next.set(requestedCliTool, { enabled: autoYes.enabled, expiresAt: autoYes.expiresAt });
          return next;
        });
        prevAutoYesEnabledRef.current = autoYes.enabled;

        // Issue #314 / #499 Item 5: Detect stop condition match or consecutive error (enabled -> disabled transition)
        if (wasEnabled && !data.autoYes.enabled &&
            (data.autoYes.stopReason === 'stop_pattern_matched' || data.autoYes.stopReason === 'consecutive_errors')) {
          setPendingStopReason(data.autoYes.stopReason);
        }
      }
    } catch (err) {
      if (
        latestCurrentOutputRequestIdRef.current !== requestId ||
        activeCliTabRef.current !== requestedCliTool ||
        (onMobile && activeInstanceIdRef.current !== requestedInstance)
      ) {
        return;
      }
      console.error('[WorktreeDetailRefactored] Error fetching current output:', err);
    }
  }, [worktreeId, actions, state.prompt.visible]);

  // Issue #874: Mobile now manages agent *instances* (折衷案). The shared roster
  // (agentInstances) lives in the DB; this hook owns ONLY the per-device "which
  // instances to show as tabs" selection (localStorage, never the DB) — so a
  // mobile user narrowing their tabs does not shrink the PC view (#837/#851).
  const {
    visibleInstances,
    visibleInstanceIds,
    toggleInstanceVisible,
  } = useMobileSelectedInstances({ worktreeId, roster: agentInstances });

  // Mobile tabs are the per-device visible subset; PC uses the full roster.
  const displayedInstances = isMobile ? visibleInstances : agentInstances;

  // Derived CLI-tool list for surfaces that still take CLIToolType[] (TimerPane,
  // legacy props). Mobile = unique cliTools of the visible instances (instance
  // order); PC = the DB selection (unchanged).
  const mobileSelectedAgents = useMemo(
    () => Array.from(new Set(visibleInstances.map((inst) => inst.cliTool))),
    [visibleInstances],
  );
  const displayedAgents = isMobile ? mobileSelectedAgents : selectedAgents;

  // Issue #869/#874: keep activeInstanceId pointing at a currently-displayed
  // instance. PC uses the full roster; mobile uses the visible subset. When the
  // active instance disappears (rename/delete/reorder, or hidden on this
  // device), fall back to the first displayed instance. setActiveInstanceId
  // mirrors the instance's CLI tool into activeCliTab, so cliTool-keyed concerns
  // (auto-yes, status, kill, message/output fetch) follow the active instance on
  // both PC and mobile.
  useEffect(() => {
    if (displayedInstances.length === 0) return;
    if (!displayedInstances.some(inst => inst.id === activeInstanceId)) {
      setActiveInstanceId(displayedInstances[0].id);
    }
  }, [displayedInstances, activeInstanceId, setActiveInstanceId]);

  // Idempotent mirror: keep activeCliTab in sync with the active instance's CLI
  // tool even when activeInstanceId itself is unchanged (e.g. localStorage
  // restored an instance/cliTool pair that drifted). setActiveCliTab no-ops when
  // already equal.
  useEffect(() => {
    const inst = displayedInstances.find(i => i.id === activeInstanceId);
    if (inst && inst.cliTool !== activeCliTab) {
      setActiveCliTab(inst.cliTool);
    }
  }, [displayedInstances, activeInstanceId, activeCliTab, setActiveCliTab]);

  // Issue #379: Disable auto-follow for full-screen TUI tools (OpenCode, Copilot).
  // These tools render in alternate screen mode where menus appear at the top.
  // Auto-following new content to bottom would hide these menus.
  const disableAutoFollow = activeCliTab === 'opencode' || activeCliTab === 'copilot';

  /** Issue #368: Callback for AgentSettingsPane to update selectedAgents */
  const handleSelectedAgentsChange = useCallback((agents: CLIToolType[]) => {
    setSelectedAgents(agents);
  }, []);

  /**
   * Issue #869: Callback for AgentSettingsPane to update the agent instance
   * roster after a successful PATCH. The reconcile effect keeps activeInstanceId
   * valid if the active instance was renamed/removed.
   */
  const handleAgentInstancesChange = useCallback((instances: AgentInstance[]) => {
    setAgentInstances(instances);
  }, []);

  /** Issue #368: Callback for AgentSettingsPane to update vibeLocalModel */
  const handleVibeLocalModelChange = useCallback((model: string | null) => {
    setVibeLocalModel(model);
  }, []);

  /** Issue #374: Callback for AgentSettingsPane to update vibeLocalContextWindow */
  const handleVibeLocalContextWindowChange = useCallback((value: number | null) => {
    setVibeLocalContextWindow(value);
  }, []);

  // Issue #4: Immediately refresh data when CLI tab changes (without polling restart)
  const prevCliTabRef = useRef<CLIToolType>(activeCliTab);
  useEffect(() => {
    if (prevCliTabRef.current !== activeCliTab) {
      prevCliTabRef.current = activeCliTab;
      // Clear stale data immediately for snappy UI.
      // Issue #736: terminal reset is owned by useTerminalPanePolling
      // (self-resets on the new cliToolId); only non-terminal state is cleared here.
      actions.clearMessages();
      actions.clearPrompt();
      setIsSelectionListActive(false);
      // Fetch fresh data for the new tab
      void fetchMessages();
      void fetchCurrentOutput();
    }
  }, [activeCliTab, actions, fetchMessages, fetchCurrentOutput]);

  // Issue #168: Re-fetch messages when showArchived toggle changes
  useEffect(() => {
    void fetchMessages();
  }, [showArchived, fetchMessages]);

  // Issue #701: Re-fetch messages when historyDisplayLimit changes
  useEffect(() => {
    void fetchMessages();
  }, [historyDisplayLimit, fetchMessages]);

  // Toast state for notifications (moved before event handlers that reference showToast)
  const { toasts, showToast, removeToast } = useToast();

  // ========================================================================
  // Event Handlers
  // ========================================================================

  /**
   * Show Toast notification when tab limit is reached.
   * [DR1-010, DR2-003] Dynamic message using MAX_FILE_TABS constant.
   */
  const showTabLimitToast = useCallback(() => {
    showToast(`Maximum ${MAX_FILE_TABS} file tabs. Close a tab first.`, 'info');
  }, [showToast]);

  /** Handle file path click in history pane */
  const handleFilePathClick = useCallback((path: string) => {
    if (isMobile) {
      setMobileFileViewerPath(path);
    } else {
      const result = tabsActions.openFile(path);
      if (result === 'limit_reached') {
        showTabLimitToast();
      }
    }
  }, [isMobile, tabsActions, showTabLimitToast]);

  /**
   * Handle file select from FileTreeView
   * Opens MarkdownEditor for .md files, file tab panel (desktop) or modal (mobile) for others
   * [Stage 3 SF-004] Separate editorFilePath state to avoid conflict
   * Issue #438: Uses file tabs instead of modal for non-editable files on desktop
   */
  const handleFileSelect = useCallback((path: string) => {
    if (isMobile) {
      // Mobile: all files open in FileViewer modal (includes MARP, path copy, fullscreen)
      setMobileFileViewerPath(path);
    } else {
      // Desktop: open in file tab panel (including .md files for preview)
      const result = tabsActions.openFile(path);
      if (result === 'limit_reached') {
        showTabLimitToast();
      }
    }
  }, [isMobile, tabsActions, showTabLimitToast]);

  /**
   * Handle opening a file from a link in MarkdownPreview/HtmlPreview (Issue #505).
   * Opens the file as a new tab, or shows Toast if limit is reached.
   */
  const handleOpenFile = useCallback((path: string) => {
    const result = tabsActions.openFile(path);
    if (result === 'limit_reached') {
      showTabLimitToast();
    }
  }, [tabsActions, showTabLimitToast]);

  /** Handle closing mobile FileViewer modal */
  const handleMobileFileViewerClose = useCallback(() => {
    setMobileFileViewerPath(null);
  }, []);

  /** Handle file save in tab panel - refresh tree to reflect changes (savedPath accepted for callback interface compatibility) */
  const handleFilePanelSave = useCallback((_savedPath: string) => {
    setFileTreeRefresh(prev => prev + 1);
  }, []);

  /** Handle MarkdownEditor close */
  const handleEditorClose = useCallback(() => {
    setEditorFilePath(null);
  }, []);

  /** Handle file save in editor - refresh tree to reflect changes (savedPath accepted for callback interface compatibility) */
  const handleEditorSave = useCallback((_savedPath: string) => {
    setFileTreeRefresh(prev => prev + 1);
  }, []);

  /** Handle ActivityBar toggle (PC) */
  const handleActivityToggle = useCallback(
    (id: ActivityId) => {
      toggleActivity(id);
    },
    [toggleActivity]
  );

  /** Handle back button click - navigate to portal */
  const handleBackClick = useCallback(() => {
    router.push('/');
  }, [router]);

  /** Handle diff selection from GitPane (Issue #447) */
  const handleDiffSelect = useCallback((diff: string, filePath: string) => {
    if (!isMobile) {
      // PC: show diff in right pane file panel area
      setDiffContent(diff);
      setDiffFilePath(filePath);
    }
    // Mobile: diff is shown inline within GitPane
  }, [isMobile]);

  /** Close diff view in right pane (Issue #447) */
  const handleCloseDiff = useCallback(() => {
    setDiffContent(null);
    setDiffFilePath(null);
  }, []);

  /** Handle worktree status change via dropdown */
  const handleWorktreeStatusChange = useCallback(async (newStatus: 'ready' | 'in_progress' | 'in_review' | 'done' | null) => {
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (response.ok) {
        const updated = await response.json();
        setWorktree(updated);
      }
    } catch {
      // Silently handle
    }
  }, [worktreeId]);

  /** Handle info button click - open info modal */
  const handleInfoClick = useCallback(() => {
    setIsInfoModalOpen(true);
  }, []);

  /** Handle info modal close */
  const handleInfoModalClose = useCallback(() => {
    setIsInfoModalOpen(false);
  }, []);

  /** Handle prompt response submission */
  const handlePromptRespond = useCallback(
    async (answer: string): Promise<void> => {
      actions.setPromptAnswering(true);
      try {
        // Issue #287: Use shared builder to include promptType and defaultOptionNumber
        // so the API can use cursor-key navigation even when promptCheck re-verification fails.
        // Issue #874: on mobile target the active agent instance (the builder only
        // attaches instanceId when non-primary, so PC stays byte-identical).
        const requestBody = buildPromptResponseBody(
          answer,
          activeCliTab,
          state.prompt.data,
          isMobileRef.current ? activeInstanceIdRef.current : undefined,
        );

        const response = await fetch(`/api/worktrees/${worktreeId}/prompt-response`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });
        if (!response.ok) {
          throw new Error(`Failed to send prompt response: ${response.status}`);
        }
        actions.clearPrompt();
        // Immediately fetch current output to update terminal without waiting for polling
        await fetchCurrentOutput();
      } catch (err) {
        console.error('[WorktreeDetailRefactored] Error sending prompt response:', err);
      } finally {
        actions.setPromptAnswering(false);
      }
    },
    [worktreeId, actions, fetchCurrentOutput, activeCliTab, state.prompt.data]
  );

  /** Handle prompt dismiss without response */
  const handlePromptDismiss = useCallback(() => {
    actions.clearPrompt();
  }, [actions]);

  /** Handle mobile tab navigation */
  const handleMobileTabChange = useCallback(
    (tab: MobileTab) => {
      actions.setMobileActivePane(tab);
    },
    [actions]
  );

  /** Handle message sent - refresh messages after sending */
  const handleMessageSent = useCallback(
    () => {
      // Refresh messages after sending
      void fetchMessages();
      void fetchCurrentOutput();
    },
    [fetchMessages, fetchCurrentOutput]
  );

  /**
   * Handle auto-yes toggle (Issue #225: duration, Issue #314: stopPattern).
   *
   * Issue #740: parameterized by cliToolId via a curried factory so each PC
   * split footer can toggle auto-yes for its OWN CLI independently. The factory
   * is stable per worktreeId (cliToolId is captured per call), keeping split
   * re-renders down. `activeCliTabRef` is read inside so the stop-reason ref is
   * only updated for the active CLI (preserving existing toast detection).
   */
  const makeAutoYesToggleHandler = useCallback(
    (cliToolId: CLIToolType) =>
      async (params: AutoYesToggleParams): Promise<void> => {
        try {
          const response = await fetch(`/api/worktrees/${worktreeId}/auto-yes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              enabled: params.enabled,
              cliToolId,
              duration: params.duration,
              stopPattern: params.stopPattern,
            }),
          });
          if (response.ok) {
            const data = await response.json();
            // Issue #525: Store per-agent state keyed by the toggled CLI.
            setAutoYesStateMap(prev => {
              const next = new Map(prev);
              next.set(cliToolId, { enabled: data.enabled, expiresAt: data.expiresAt });
              return next;
            });
            // Issue #740: the stop-reason ref tracks the ACTIVE CLI only; avoid
            // clobbering it when a non-active split is toggled.
            if (cliToolId === activeCliTabRef.current) {
              prevAutoYesEnabledRef.current = data.enabled;
            }
          }
        } catch (err) {
          console.error('[WorktreeDetailRefactored] Error toggling auto-yes:', err);
        }
      },
    [worktreeId],
  );

  /**
   * Mobile + active-CLI default handler (unchanged behavior). Issue #740: thin
   * wrapper over the curried factory bound to the current activeCliTab so the
   * Mobile AutoYesToggle call site stays untouched.
   */
  const handleAutoYesToggle = useCallback(
    (params: AutoYesToggleParams): Promise<void> =>
      makeAutoYesToggleHandler(activeCliTab)(params),
    [makeAutoYesToggleHandler, activeCliTab],
  );

  /** Issue #4: Kill session confirmation dialog state */
  const [showKillConfirm, setShowKillConfirm] = useState(false);

  /** Issue #4: Show confirmation dialog before killing session */
  const handleKillSession = useCallback((): void => {
    setShowKillConfirm(true);
  }, []);

  /** Issue #4: Execute session kill after confirmation */
  const handleKillConfirm = useCallback(async (): Promise<void> => {
    setShowKillConfirm(false);
    try {
      // Issue #874/#875: always scope the kill to the active agent instance, on
      // PC as well as mobile. The primary instance uses instanceId === cliToolId
      // (byte-identical session name), so this is unchanged for primary
      // instances; for alias instances it terminates only that instance's
      // session instead of every session of the backing CLI tool.
      const killUrl =
        `/api/worktrees/${worktreeId}/kill-session?cliTool=${activeCliTab}&instance=${encodeURIComponent(activeInstanceIdRef.current)}`;
      const response = await fetch(killUrl, { method: 'POST' });
      if (!response.ok) return;
      actions.clearMessages();
      // Issue #736: terminal reset reflected by useTerminalPanePolling on the
      // next poll (session no longer running); only non-terminal state cleared here.
      actions.clearPrompt();
      await fetchWorktree();
    } catch (err) {
      console.error('[WorktreeDetailRefactored] Error killing session:', err);
    }
  }, [worktreeId, activeCliTab, actions, fetchWorktree]);

  /** Issue #4: Cancel session kill */
  const handleKillCancel = useCallback((): void => {
    setShowKillConfirm(false);
  }, []);

  // ========================================================================
  // File Operation Handlers (for FileTreeView context menu)
  // ========================================================================

  /** Handle new file creation - open NewFileDialog (Issue #646) */
  const handleNewFile = useCallback((parentPath: string) => {
    setNewFileParentPath(parentPath);
    setShowNewFileDialog(true);
  }, []);

  /** Handle new file creation confirmation from NewFileDialog (Issue #646) */
  const handleNewFileConfirm = useCallback(async (finalName: string) => {
    setShowNewFileDialog(false);
    const newPath = newFileParentPath ? `${newFileParentPath}/${finalName}` : finalName;

    try {
      const response = await fetch(
        `/api/worktrees/${worktreeId}/files/${encodePathForUrl(newPath)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'file', content: '' }),
        }
      );
      if (!response.ok) {
        throw new Error('Failed to create file');
      }
      // File created successfully - trigger FileTreeView refresh
      setFileTreeRefresh(prev => prev + 1);
    } catch {
      window.alert(tError('fileOps.failedToCreateFile'));
    }
  }, [worktreeId, newFileParentPath, tError]);

  /** Handle new file dialog cancel (Issue #646) */
  const handleNewFileCancel = useCallback(() => {
    setShowNewFileDialog(false);
  }, []);

  /** Handle new directory creation in FileTreeView */
  const handleNewDirectory = useCallback(async (parentPath: string) => {
    const dirName = window.prompt('Enter directory name:');
    if (!dirName) return;

    const newPath = parentPath ? `${parentPath}/${dirName}` : dirName;

    try {
      const response = await fetch(
        `/api/worktrees/${worktreeId}/files/${encodePathForUrl(newPath)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'directory' }),
        }
      );
      if (!response.ok) {
        throw new Error('Failed to create directory');
      }
      // Directory created successfully - trigger FileTreeView refresh
      setFileTreeRefresh(prev => prev + 1);
    } catch (err) {
      console.error('[WorktreeDetailRefactored] Failed to create directory:', err);
      window.alert(tError('fileOps.failedToCreateDirectory'));
    }
  }, [worktreeId, tError]);

  /** Handle file/directory rename in FileTreeView */
  const handleRename = useCallback(async (path: string) => {
    const currentName = path.split('/').pop() || '';
    const newName = window.prompt('Enter new name:', currentName);
    if (!newName || newName === currentName) return;

    try {
      const response = await fetch(
        `/api/worktrees/${worktreeId}/files/${encodePathForUrl(path)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'rename', newName }),
        }
      );
      if (!response.ok) {
        throw new Error('Failed to rename');
      }
      // Renamed successfully - update file tab if the renamed file was open
      const parentDir = path.includes('/') ? path.substring(0, path.lastIndexOf('/') + 1) : '';
      tabsActions.onFileRenamed(path, `${parentDir}${newName}`);
      // Trigger FileTreeView refresh
      setFileTreeRefresh(prev => prev + 1);
    } catch (err) {
      console.error('[WorktreeDetailRefactored] Failed to rename:', err);
      window.alert(tError('fileOps.failedToRename'));
    }
  }, [worktreeId, tabsActions, tError]);

  /** Handle file/directory delete in FileTreeView */
  const handleDelete = useCallback(async (path: string) => {
    const name = path.split('/').pop() || path;
    if (!window.confirm(tCommon('confirmDelete', { name }))) return;

    try {
      const response = await fetch(
        `/api/worktrees/${worktreeId}/files/${encodePathForUrl(path)}?recursive=true`,
        {
          method: 'DELETE',
        }
      );
      if (!response.ok) {
        throw new Error('Failed to delete');
      }
      // Deleted successfully - close editor if the deleted file was open
      if (editorFilePath === path || editorFilePath?.startsWith(`${path}/`)) {
        setEditorFilePath(null);
      }
      // Issue #438: Close file tab if the deleted file was open
      tabsActions.onFileDeleted(path);
      // Trigger FileTreeView refresh
      setFileTreeRefresh(prev => prev + 1);
    } catch (err) {
      console.error('[WorktreeDetailRefactored] Failed to delete:', err);
      window.alert(tError('fileOps.failedToDelete'));
    }
  }, [worktreeId, editorFilePath, tabsActions, tCommon, tError]);

  // Issue #314 / #499 Item 5: Show stop reason toast when pending (deferred from fetchCurrentOutput)
  useEffect(() => {
    if (pendingStopReason === 'stop_pattern_matched') {
      showToast(tAutoYes('stopPatternMatched'), 'info');
      setPendingStopReason(null);
    } else if (pendingStopReason === 'consecutive_errors') {
      showToast(tAutoYes('consecutiveErrorsStopped'), 'warning');
      setPendingStopReason(null);
    }
  }, [pendingStopReason, showToast, tAutoYes]);

  // [Issue #162] File operations hook (move dialog state management)
  const {
    moveTarget,
    isMoveDialogOpen,
    handleMove,
    handleMoveConfirm,
    handleMoveCancel,
  } = useFileOperations(
    worktreeId,
    () => setFileTreeRefresh(prev => prev + 1),
    (msg) => showToast(msg, 'success'),
    (msg) => showToast(msg, 'error')
  );

  // Hidden file input ref for upload
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetPathRef = useRef<string>('');

  /** Handle file upload from FileTreeView context menu [IMPACT-004] */
  const handleUpload = useCallback((targetDir: string) => {
    uploadTargetPathRef.current = targetDir;
    fileInputRef.current?.click();
  }, []);

  /** Handle file input change - perform actual upload */
  const handleFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset input for re-selection of same file
    e.target.value = '';

    const targetDir = uploadTargetPathRef.current;
    const ext = `.${file.name.split('.').pop()?.toLowerCase()}`;

    // Client-side validation
    if (!isUploadableExtension(ext)) {
      showToast(`Unsupported file type: ${ext}. Allowed: ${UPLOADABLE_EXTENSIONS.join(', ')}`, 'error');
      return;
    }

    const maxSize = getMaxFileSize(ext);
    if (file.size > maxSize) {
      showToast(`File too large. Maximum size: ${(maxSize / 1024 / 1024).toFixed(1)}MB`, 'error');
      return;
    }

    // Build form data
    const formData = new FormData();
    formData.append('file', file);

    // Upload API call [API-004] Using /upload/:path endpoint
    try {
      const uploadPath = targetDir || '.';
      const response = await fetch(
        `/api/worktrees/${worktreeId}/upload/${encodePathForUrl(uploadPath)}`,
        {
          method: 'POST',
          body: formData,
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData?.error?.message || 'Failed to upload file';
        showToast(errorMessage, 'error');
        return;
      }

      const result = await response.json();
      showToast(`Uploaded: ${result.filename}`, 'success');

      // Refresh file tree [IMPACT-004]
      setFileTreeRefresh(prev => prev + 1);
    } catch (err) {
      console.error('[WorktreeDetailRefactored] Failed to upload:', err);
      showToast('Upload failed. Please try again.', 'error');
    }
  }, [worktreeId, showToast]);

  // Update check hook (Issue #278: hasUpdate state for DesktopHeader/MobileTabBar)
  const { data: updateCheckData } = useUpdateCheck();
  const hasUpdate = updateCheckData?.hasUpdate ?? false;

  // Auto-yes hook
  const { lastAutoResponse } = useAutoYes({
    worktreeId,
    cliTool: activeCliTab,
    isPromptWaiting: state.prompt.visible,
    promptData: state.prompt.data,
    autoYesEnabled,
    lastServerResponseTimestamp,
    serverPollerActive,
  });

  /** Retry loading all data after error */
  const handleRetry = useCallback(async (): Promise<void> => {
    setError(null);
    setLoading(true);
    const worktreeData = await fetchWorktree();
    if (worktreeData) {
      await Promise.all([fetchMessages(), fetchCurrentOutput()]);
    }
    setLoading(false);
  }, [fetchWorktree, fetchMessages, fetchCurrentOutput]);

  // ========================================================================
  // Visibility Change Recovery (Issue #246, Issue #266)
  // ========================================================================

  /**
   * Timestamp of the last visibilitychange recovery to prevent rapid re-fetches.
   * Used as a throttle guard: if less than RECOVERY_THROTTLE_MS has elapsed
   * since the last recovery, the handler skips execution.
   */
  const lastRecoveryTimestampRef = useRef<number>(0);

  /**
   * Handle page visibility change for background recovery.
   * When the page becomes visible again (e.g., smartphone foreground restoration),
   * performs data re-fetch to synchronize stale state.
   *
   * Design rationale (Issue #246, Issue #266):
   *
   * [SF-001] SRP: handleVisibilityChange is responsible for "background recovery
   *   data sync" only. Full recovery (handleRetry) is a separate concern.
   *
   * [SF-002] KISS: Simple error guard - error state uses handleRetry (full recovery),
   *   normal state uses lightweight recovery (no loading state change).
   *
   * [IA-002] Overlap: When the page becomes visible, up to 3 data-fetch
   *   sources may fire concurrently:
   *   1. This visibilitychange handler (lightweight recovery)
   *   2. The setInterval polling timer (if it fires during the same tick)
   *   3. WebSocket reconnection triggering a broadcast-based fetch
   *   All fetches are idempotent GET requests, so concurrent execution is
   *   safe -- it may cause redundant network calls but no data corruption.
   */
  const handleVisibilityChange = useCallback(async () => {
    if (document.visibilityState !== 'visible') return;

    const now = Date.now();
    if (now - lastRecoveryTimestampRef.current < RECOVERY_THROTTLE_MS) {
      return;
    }
    lastRecoveryTimestampRef.current = now;

    // [SF-001] Error state requires full recovery (handleRetry) to reset
    // loading state and rebuild the UI from ErrorDisplay back to normal.
    if (error) {
      handleRetry();
      return;
    }

    // [SF-002] Normal state uses lightweight recovery (loading state unchanged).
    // This preserves the component tree, preventing MessageInput/PromptPanel
    // content from being cleared by unmount/remount caused by setLoading(true/false).
    //
    // [SF-DRY-001] Note: These fetch calls duplicate the data retrieval done by
    // handleRetry(). handleRetry uses setLoading(true/false) for full recovery,
    // while this path intentionally omits loading state changes for lightweight
    // recovery. When adding/changing fetch functions, update handleRetry() as well.
    //
    // [SF-CONS-001] handleRetry uses a sequential pattern (fetchWorktree first,
    // then conditionally fetchMessages/fetchCurrentOutput). Lightweight recovery
    // uses Promise.all for parallel execution because: failure is silently ignored
    // (next polling cycle recovers), all requests are idempotent GETs (no data
    // corruption risk), and parallel execution improves response time.
    try {
      await Promise.all([
        fetchWorktree(),
        fetchMessages(),
        fetchCurrentOutput(),
      ]);
    } finally {
      // [SF-IMP-001] fetchWorktree() internally catches errors and calls
      // setError(message) without rethrowing. This means Promise.all resolves
      // successfully even when fetchWorktree fails, but error state has already
      // been set internally. Call setError(null) unconditionally to counter any
      // internal setError() calls and maintain the component tree.
      // On success, this is a no-op (error is already null).
      // On failure, this prevents ErrorDisplay from replacing the normal UI,
      // allowing the next polling cycle to recover naturally.
      setError(null);
    }
    // [SF-IMP-002] Note: error in the dependency array causes useCallback to
    // regenerate when error state changes, triggering useEffect listener
    // re-registration (removeEventListener/addEventListener). Performance impact
    // is negligible as these are synchronous lightweight operations.
  }, [error, handleRetry, fetchWorktree, fetchMessages, fetchCurrentOutput]);

  // ========================================================================
  // Effects
  // ========================================================================

  /** Initial data fetch on mount - runs only once */
  useEffect(() => {
    // Skip if already loaded to prevent re-triggering on dependency changes
    if (initialLoadCompletedRef.current) {
      return;
    }

    let isMounted = true;

    const loadInitialData = async () => {
      // Issue #839: Only show the full-screen loading indicator when there was no
      // cached worktree to display at mount. On a cache hit we keep rendering the
      // seeded data and revalidate silently in the background (SWR).
      if (!primedFromCacheRef.current) {
        setLoading(true);
      }
      // Parallel: fetch worktree, messages, and current output simultaneously.
      // fetchMessages/fetchCurrentOutput handle missing worktree gracefully.
      await Promise.all([
        fetchWorktree(),
        fetchMessages(),
        fetchCurrentOutput(),
      ]);
      if (isMounted) {
        setLoading(false);
        initialLoadCompletedRef.current = true;
      }
    };

    loadInitialData();

    return () => {
      isMounted = false;
    };
  }, [fetchWorktree, fetchMessages, fetchCurrentOutput]);

  /**
   * Register visibilitychange event listener for background recovery (Issue #246, #266).
   * When the page becomes visible, performs lightweight recovery (normal state)
   * or full recovery via handleRetry() (error state) to re-fetch all data.
   * This handles the case where the browser suspended network requests while
   * the page was in the background (common on mobile browsers).
   *
   * Unlike WorktreeList.tsx (SF-003), this component needs:
   * - Error state branching: full recovery (handleRetry) vs lightweight recovery
   * - Throttle guard (RECOVERY_THROTTLE_MS) to prevent rapid re-fetches
   */
  useEffect(() => {
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [handleVisibilityChange]);

  /**
   * Poll for current output and worktree status at adaptive intervals.
   *
   * Issue #736: cadence was previously gated on the removed terminal reducer
   * slice's isActive flag. It now derives the active/idle switch from the active
   * CLI's running flag (`worktree.sessionStatusByCli[activeCliTab].isRunning`), refreshed
   * by `fetchWorktree()` inside this same loop — preserving the prior adaptive
   * behavior without the terminal reducer slice.
   */
  const activeCliRunning = worktree?.sessionStatusByCli?.[activeCliTab]?.isRunning ?? false;
  useEffect(() => {
    if (loading || error) return;

    const pollingInterval = activeCliRunning
      ? ACTIVE_POLLING_INTERVAL_MS
      : IDLE_POLLING_INTERVAL_MS;

    const pollData = async () => {
      // Issue #744: `state.messages` is consumed ONLY by the mobile MobileContent
      // path; on PC each terminal split fetches its own history independently via
      // `useSplitMessages`. Polling `fetchMessages()` on PC would double-fetch the
      // active CLI's messages for a result nothing renders, so it is gated to
      // mobile. The non-poll call sites (initial load, activeCliTab/showArchived/
      // limit change, handleMessageSent, visibilitychange recovery) keep calling
      // fetchMessages() unconditionally, so `state.messages` is still populated on
      // PC for an immediate mobile-switch and search.
      const tasks: Array<Promise<unknown>> = [fetchCurrentOutput(), fetchWorktree()];
      if (isMobile) {
        tasks.push(fetchMessages());
      }
      await Promise.all(tasks);
    };

    const intervalId = setInterval(pollData, pollingInterval);

    return () => clearInterval(intervalId);
  }, [loading, error, fetchCurrentOutput, fetchWorktree, fetchMessages, activeCliRunning, isMobile]);

  /** Sync layout mode with viewport size */
  useEffect(() => {
    actions.setLayoutMode(isMobile ? 'tabs' : 'split');
  }, [isMobile, actions]);

  // ========================================================================
  // Computed Values
  // ========================================================================

  /** Derive worktree status - consistent with sidebar display */
  const worktreeStatus = useMemo<WorktreeStatus>(
    () => deriveWorktreeStatus(worktree, state.error.type !== null, activeCliTab),
    [worktree, state.error.type, activeCliTab]
  );

  /** Current active tab for mobile view */
  const activeTab = useMemo<MobileTab>(
    () => state.layout.mobileActivePane,
    [state.layout.mobileActivePane]
  );

  // Note (Issue #727): PC no longer uses `state.layout.leftPaneTab`. The
  // mobile MobileContent still consumes it via the mobile path. The reducer
  // value remains for backward compatibility.

  /** Display name for worktree */
  const worktreeName = worktree?.name ?? DEFAULT_WORKTREE_NAME;

  // ========================================================================
  // Issue #438: File panel loading callbacks (memoized for FilePanelSplit)
  // ========================================================================

  // [Issue #675, #683] tabsActions is stable (useMemo-wrapped, all fns are useCallback with [])
  const handleLoadContent = useCallback((path: string, content: FileContent) => {
    tabsActions.dispatch({ type: 'SET_CONTENT', path, content });
  }, [tabsActions]);

  const handleLoadError = useCallback((path: string, errorMsg: string) => {
    tabsActions.dispatch({ type: 'SET_ERROR', path, error: errorMsg });
  }, [tabsActions]);

  const handleSetLoading = useCallback((path: string, isLoading: boolean) => {
    tabsActions.dispatch({ type: 'SET_LOADING', path, loading: isLoading });
  }, [tabsActions]);

  // [Issue #469] isDirty state change callback for file content polling control
  const handleDirtyChange = useCallback((path: string, isDirty: boolean) => {
    tabsActions.dispatch({ type: 'SET_DIRTY', path, isDirty });
  }, [tabsActions]);


  // ========================================================================

  return {
    activeActivity,
    activeCliTab,
    activeInstanceId,
    activeTab,
    agentInstances,
    autoYesEnabled,
    autoYesExpiresAt,
    autoYesStateMap,
    diffContent,
    diffFilePath,
    disableAutoFollow,
    displayedAgents,
    displayedInstances,
    editorFilePath,
    error,
    fetchCurrentOutput,
    fileInputRef,
    fileSearch,
    fileTreeRefresh,
    handleActivityToggle,
    handleAgentInstancesChange,
    handleAutoYesToggle,
    handleBackClick,
    handleCloseDiff,
    handleDelete,
    handleDiffSelect,
    handleDirtyChange,
    handleEditorClose,
    handleEditorSave,
    handleFileInputChange,
    handleFilePanelSave,
    handleFilePathClick,
    handleFileSelect,
    handleHistoryDisplayLimitChange,
    handleHistoryUserOnlyChange,
    handleInfoClick,
    handleInfoModalClose,
    handleInsertConsumed,
    handleInsertConsumedSingle,
    handleInsertToMessage,
    handleInsertToSplit,
    handleKillCancel,
    handleKillConfirm,
    handleKillSession,
    handleLoadContent,
    handleLoadError,
    handleMessageSent,
    handleMobileFileViewerClose,
    handleMobileTabChange,
    handleMove,
    handleMoveCancel,
    handleMoveConfirm,
    handleNewDirectory,
    handleNewFile,
    handleNewFileCancel,
    handleNewFileConfirm,
    handleOpenFile,
    handlePromptDismiss,
    handlePromptRespond,
    handleRename,
    handleRetry,
    handleSelectedAgentsChange,
    handleSetLoading,
    handleShowArchivedChange,
    handleUpload,
    handleVibeLocalContextWindowChange,
    handleVibeLocalModelChange,
    handleWorktreeStatusChange,
    hasUpdate,
    historyDisplayLimit,
    historySubTab,
    historyUserOnly,
    isEditorMaximized,
    isInfoModalOpen,
    isMobile,
    isMoveDialogOpen,
    isSelectionListActive,
    lastAutoResponse,
    loading,
    makeAutoYesToggleHandler,
    mobileFileViewerPath,
    mobileSelectedAgents,
    moveTarget,
    newFileParentPath,
    openMobileDrawer,
    pendingInsertText,
    pendingInsertTextMap,
    removeToast,
    selectedAgents,
    setActiveCliTab,
    setActiveInstanceId,
    setEditorFilePath,
    setFocusedSplitIndex,
    setHistorySubTab,
    setIsEditorMaximized,
    setWorktree,
    showArchived,
    showKillConfirm,
    showNewFileDialog,
    showToast,
    state,
    tCommon,
    tWorktree,
    tabsActions,
    tabsState,
    toasts,
    toggleInstanceVisible,
    vibeLocalContextWindow,
    vibeLocalModel,
    visibleInstanceIds,
    worktree,
    worktreeName,
    worktreeStatus,
  };
}
