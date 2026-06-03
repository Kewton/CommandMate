/**
 * Domain prop types for the per-split terminal pane (Issue #756).
 *
 * `TerminalSplitPaneContent.tsx` previously accepted 24 flat props. This file
 * groups them into three cohesive domain interfaces so the component's direct
 * prop count drops to 13 (<= 15):
 *
 *   - `TerminalSplitPaneCoreProps`  identity + derived status of the split
 *   - `SplitAutoYesProps`           per-split Auto-Yes state + toggle handler
 *   - `HistoryPaneProps`            embedded per-split HistoryPane wiring (#744)
 *
 * This is a pure type re-organization; runtime behavior is unchanged. The
 * Auto-Yes toggle callback parameter type is the existing
 * `AutoYesToggleParams` (from `@/types/auto-yes`, Issue #314 / relocated in
 * #756) — it is reused here, NOT redefined, to avoid a name clash. It lives in
 * a non-TSX module so this file stays importable under tsconfig.server.json.
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import type { BranchStatus } from '@/types/sidebar';
import type { HistoryDisplayLimit } from '@/config/history-display-config';
import type { AutoYesToggleParams } from '@/types/auto-yes';
import type { ShowToast } from '@/types/markdown-editor';

/** Identity + derived status of a single terminal split (Issue #756). */
export interface TerminalSplitPaneCoreProps {
  worktreeId: string;
  splitIndex: number;
  cliToolId: CLIToolType;
  /** Issue #743: derived AI agent status (defaults to 'idle' when omitted). */
  cliStatus?: BranchStatus;
}

/** Per-split Auto-Yes state + toggle handler (Issue #756; from #740). */
export interface SplitAutoYesProps {
  enabled?: boolean;
  expiresAt?: number | null;
  lastAutoResponse?: string | null;
  onToggle: (params: AutoYesToggleParams) => Promise<void>;
}

/** Embedded per-split HistoryPane wiring (Issue #756; from #744). */
export interface HistoryPaneProps {
  showArchived?: boolean;
  onShowArchivedChange?: (show: boolean) => void;
  historyDisplayLimit?: HistoryDisplayLimit;
  onHistoryDisplayLimitChange?: (limit: HistoryDisplayLimit) => void;
  historyUserOnly?: boolean;
  onHistoryUserOnlyChange?: (next: boolean) => void;
  onInsertToMessage?: (content: string) => void;
  onFilePathClick?: (path: string) => void;
  /** Issue #786 (D-5): widened to the shared `ShowToast` alias (`'warning'` included). */
  showToast?: ShowToast;
}
