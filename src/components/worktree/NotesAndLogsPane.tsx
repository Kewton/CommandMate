/**
 * NotesAndLogsPane Component
 * Issue #294: Combined Memo + Execution Log pane
 *
 * [S1-013] Props: { worktreeId: string; className?: string; }
 * Sub-tab state is managed internally (not exposed to parent)
 * Tab ID 'memo' is maintained for backward compatibility
 */

'use client';

import React, { useState, useCallback, memo } from 'react';
import { MemoPane } from './MemoPane';
import { ExecutionLogPane } from './ExecutionLogPane';

// ============================================================================
// Types
// ============================================================================

type SubTab = 'notes' | 'logs';

export interface NotesAndLogsPaneProps {
  /** Worktree ID */
  worktreeId: string;
  /** Additional CSS classes */
  className?: string;
}

// ============================================================================
// Component
// ============================================================================

export const NotesAndLogsPane = memo(function NotesAndLogsPane({
  worktreeId,
  className = '',
}: NotesAndLogsPaneProps) {
  // Internal sub-tab state (not leaked to parent)
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('notes');

  const handleSubTabChange = useCallback((tab: SubTab) => {
    setActiveSubTab(tab);
  }, []);

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Sub-tab switcher */}
      <div className="flex border-b border-gray-200 bg-white flex-shrink-0">
        <button
          type="button"
          onClick={() => handleSubTabChange('notes')}
          className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
            activeSubTab === 'notes'
              ? 'text-blue-600 border-b-2 border-blue-600 bg-blue-50'
              : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
          }`}
        >
          Notes
        </button>
        <button
          type="button"
          onClick={() => handleSubTabChange('logs')}
          className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
            activeSubTab === 'logs'
              ? 'text-blue-600 border-b-2 border-blue-600 bg-blue-50'
              : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
          }`}
        >
          Schedules
        </button>
      </div>

      {/* Sub-tab content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeSubTab === 'notes' ? (
          <MemoPane worktreeId={worktreeId} className="h-full" />
        ) : (
          <ExecutionLogPane worktreeId={worktreeId} className="h-full" />
        )}
      </div>
    </div>
  );
});

export default NotesAndLogsPane;
