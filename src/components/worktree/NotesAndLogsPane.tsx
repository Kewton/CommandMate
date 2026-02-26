/**
 * NotesAndLogsPane Component
 * Issue #294: Combined Memo + Execution Log pane
 * Issue #368: Added 'agent' sub-tab for Agent settings
 *
 * [S1-013] Props: { worktreeId: string; className?: string; }
 * Sub-tab state is managed internally (not exposed to parent)
 * Tab ID 'memo' is maintained for backward compatibility
 */

'use client';

import React, { useState, useCallback, memo } from 'react';
import { useTranslations } from 'next-intl';
import { MemoPane } from './MemoPane';
import { ExecutionLogPane } from './ExecutionLogPane';
import { AgentSettingsPane } from './AgentSettingsPane';
import type { CLIToolType } from '@/lib/cli-tools/types';

// ============================================================================
// Types
// ============================================================================

/** Issue #368: Extended with 'agent' sub-tab */
type SubTab = 'notes' | 'logs' | 'agent';

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
  /** Issue #368: Currently selected agents for the worktree */
  selectedAgents: [CLIToolType, CLIToolType];
  /** Issue #368: Callback when selected agents change */
  onSelectedAgentsChange: (agents: [CLIToolType, CLIToolType]) => void;
  /** Issue #368: Current vibe-local model selection */
  vibeLocalModel: string | null;
  /** Issue #368: Callback when vibe-local model changes */
  onVibeLocalModelChange: (model: string | null) => void;
}

// ============================================================================
// Constants
// ============================================================================

/** Sub-tab definitions driven by data (DRY: avoids repeating button markup) */
const SUB_TABS: readonly SubTabConfig[] = [
  { id: 'notes', labelKey: 'notes' },
  { id: 'logs', labelKey: 'logs' },
  { id: 'agent', labelKey: 'agentTab' },
] as const;

/** CSS class for the active sub-tab button */
const ACTIVE_TAB_CLASS = 'text-blue-600 border-b-2 border-blue-600 bg-blue-50';
/** CSS class for inactive sub-tab buttons */
const INACTIVE_TAB_CLASS = 'text-gray-500 hover:text-gray-700 hover:bg-gray-50';

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
      <div className="flex border-b border-gray-200 bg-white flex-shrink-0">
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
          <MemoPane worktreeId={worktreeId} className="h-full" />
        )}
        {activeSubTab === 'logs' && (
          <ExecutionLogPane worktreeId={worktreeId} className="h-full" />
        )}
        {activeSubTab === 'agent' && (
          <AgentSettingsPane
            worktreeId={worktreeId}
            selectedAgents={selectedAgents}
            onSelectedAgentsChange={onSelectedAgentsChange}
            vibeLocalModel={vibeLocalModel}
            onVibeLocalModelChange={onVibeLocalModelChange}
          />
        )}
      </div>
    </div>
  );
});

export default NotesAndLogsPane;
