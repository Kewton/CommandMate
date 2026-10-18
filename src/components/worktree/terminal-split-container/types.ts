/**
 * Types TerminalSplitContainer publishes, moved out of it (Issue #3603) so the
 * modules under this directory can use them without importing the container.
 */

import type { AgentPlacement } from '@/config/terminal-split-config';

/**
 * Issue #3514: a request to show a just-added agent instance. Token-stamped for
 * the reason `headerInstanceSelection` is: the container applies it exactly
 * once, and only after `instances` contains the new id (the roster PATCH and
 * this request land together, but the request must never be dropped because it
 * raced the roster).
 */
export interface InstancePlacementRequest {
  instanceId: string;
  placement: Exclude<AgentPlacement, 'roster-only'>;
  token: number;
}

/** Issue #3593: what `onSelectedSplitChange` publishes. */
export interface SelectedSplit {
  /** The selected (focused) split's index. */
  index: number;
  /** The instance that split shows. */
  instanceId: string;
  /** Each split's instance, by split index. */
  splitInstanceIds: string[];
}
