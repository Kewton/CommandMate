/**
 * NotesAndLogsPane Component
 * Issue #294: Combined Memo + Execution Log pane
 * Issue #368: Added 'agent' sub-tab for Agent settings
 * Issue #874: The 'agent' sub-tab can switch to instance-management mode (mobile)
 *
 * [S1-013] Props: { worktreeId: string; className?: string; }
 * Sub-tab state is managed internally (not exposed to parent)
 * Tab ID 'memo' is maintained for backward compatibility
 */

'use client';

import React, { useState, useCallback, memo } from 'react';
import { useTranslations } from 'next-intl';
import { MemoPane } from './MemoPane';
import { TodoPane } from './TodoPane';
import { ExecutionLogPane } from './ExecutionLogPane';
import { AgentSettingsPane } from './AgentSettingsPane';
import { MobileAgentInstancesPane } from './MobileAgentInstancesPane';
import { TimerPane } from './TimerPane';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';

// ============================================================================
// Types
// ============================================================================

/** Issue #368: Extended with 'agent' sub-tab. Issue #534: Extended with 'timer' sub-tab. Issue #1015: 'todo' sub-tab */
type SubTab = 'notes' | 'logs' | 'agent' | 'timer' | 'todo';

/** Configuration for a sub-tab button */
interface SubTabConfig {
  id: SubTab;
  labelKey: string;
}

export interface NotesAndLogsPaneProps {
  /** Worktree ID */
  worktreeId: string;
  /** Additional CSS classes */
  className?: string;
  /** Issue #485: Callback when memo content is inserted into message input */
  onInsertToMessage?: (content: string) => void;
  /** Issue #368: Currently selected agents for the worktree */
  selectedAgents: CLIToolType[];
  /** Issue #368: Callback when selected agents change */
  onSelectedAgentsChange: (agents: CLIToolType[]) => void;
  /** Issue #438: Maximum number of agents that can be selected */
  maxAgents?: number;
  /** Issue #837: Selectable agent pool for AgentSettingsPane (defaults to all CLI tools) */
  availableAgents?: readonly CLIToolType[];
  /** Issue #837: When false, AgentSettingsPane changes are not persisted to the DB */
  persistToServer?: boolean;
  /** Issue #368: Current vibe-local model selection */
  vibeLocalModel: string | null;
  /** Issue #368: Callback when vibe-local model changes */
  onVibeLocalModelChange: (model: string | null) => void;
  /** Issue #374: Current vibe-local context window (null = default) */
  vibeLocalContextWindow?: number | null;
  /** Issue #374: Callback when vibe-local context window changes */
  onVibeLocalContextWindowChange?: (value: number | null) => void;
  /**
   * Issue #874: When true the 'agent' sub-tab renders the instance-management UI
   * (MobileAgentInstancesPane) instead of AgentSettingsPane. Requires the
   * instance props below. Defaults to false (legacy checkbox UI) for backward
   * compatibility.
   */
  useInstanceManagement?: boolean;
  /** Issue #874: Shared agent instance roster (instance-management mode). */
  instances?: AgentInstance[];
  /** Issue #874: Callback when the roster changes (after a successful PATCH). */
  onInstancesChange?: (instances: AgentInstance[]) => void;
  /** Issue #874: Per-device visible instance ids (localStorage, never the DB). */
  visibleInstanceIds?: string[];
  /** Issue #874: Toggle one instance's per-device visibility. */
  onToggleInstanceVisible?: (instanceId: string) => void;
}

// ============================================================================
// Constants
// ============================================================================

/** Sub-tab definitions driven by data (DRY: avoids repeating button markup) */
const SUB_TABS: readonly SubTabConfig[] = [
  { id: 'notes', labelKey: 'notes' },
  { id: 'logs', labelKey: 'logs' },
  { id: 'agent', labelKey: 'agentTab' },
  { id: 'timer', labelKey: 'timerTab' },
  // Issue #1015: branch-scoped ToDo list. Label resolves from schedule.json
  // `todoTab` (added to BOTH en and ja, [S3-003]).
  { id: 'todo', labelKey: 'todoTab' },
] as const;

/** CSS class for the active sub-tab button */
const ACTIVE_TAB_CLASS = 'text-accent-600 dark:text-accent-400 border-b-2 border-accent-600 dark:border-accent-400 bg-accent-50 dark:bg-accent-900/30';
/** CSS class for inactive sub-tab buttons */
const INACTIVE_TAB_CLASS = 'text-muted-foreground hover:text-foreground hover:bg-muted';

// ============================================================================
// Component
// ============================================================================

export const NotesAndLogsPane = memo(function NotesAndLogsPane({
  worktreeId,
  className = '',
  selectedAgents,
  onSelectedAgentsChange,
  vibeLocalModel,
  onVibeLocalModelChange,
  vibeLocalContextWindow,
  onVibeLocalContextWindowChange,
  maxAgents,
  availableAgents,
  persistToServer,
  onInsertToMessage,
  useInstanceManagement = false,
  instances,
  onInstancesChange,
  visibleInstanceIds,
  onToggleInstanceVisible,
}: NotesAndLogsPaneProps) {
  const t = useTranslations('schedule');
  // Internal sub-tab state (not leaked to parent)
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('notes');

  const handleSubTabChange = useCallback((tab: SubTab) => {
    setActiveSubTab(tab);
  }, []);

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Sub-tab switcher */}
      <div className="flex border-b border-border bg-surface dark:bg-surface-2 flex-shrink-0">
        {SUB_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => handleSubTabChange(tab.id)}
            className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
              activeSubTab === tab.id ? ACTIVE_TAB_CLASS : INACTIVE_TAB_CLASS
            }`}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {/* Sub-tab content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeSubTab === 'notes' && (
          <MemoPane worktreeId={worktreeId} className="h-full" onInsertToMessage={onInsertToMessage} />
        )}
        {activeSubTab === 'logs' && (
          <ExecutionLogPane
            worktreeId={worktreeId}
            className="h-full"
            onInsertToMessage={onInsertToMessage}
            instances={instances}
          />
        )}
        {activeSubTab === 'agent' && (
          useInstanceManagement && instances && onInstancesChange && visibleInstanceIds && onToggleInstanceVisible ? (
            <div className="h-full overflow-y-auto">
              <MobileAgentInstancesPane
                worktreeId={worktreeId}
                instances={instances}
                onInstancesChange={onInstancesChange}
                vibeLocalModel={vibeLocalModel}
                onVibeLocalModelChange={onVibeLocalModelChange}
                vibeLocalContextWindow={vibeLocalContextWindow}
                onVibeLocalContextWindowChange={onVibeLocalContextWindowChange}
                visibleInstanceIds={visibleInstanceIds}
                onToggleInstanceVisible={onToggleInstanceVisible}
              />
            </div>
          ) : (
            <AgentSettingsPane
              worktreeId={worktreeId}
              selectedAgents={selectedAgents}
              onSelectedAgentsChange={onSelectedAgentsChange}
              vibeLocalModel={vibeLocalModel}
              onVibeLocalModelChange={onVibeLocalModelChange}
              vibeLocalContextWindow={vibeLocalContextWindow}
              onVibeLocalContextWindowChange={onVibeLocalContextWindowChange}
              maxAgents={maxAgents}
              availableAgents={availableAgents}
              persistToServer={persistToServer}
            />
          )
        )}
        {activeSubTab === 'timer' && (
          <TimerPane
            worktreeId={worktreeId}
            instances={instances}
            selectedAgents={selectedAgents}
          />
        )}
        {activeSubTab === 'todo' && (
          <TodoPane worktreeId={worktreeId} className="h-full" />
        )}
      </div>
    </div>
  );
});

export default NotesAndLogsPane;
