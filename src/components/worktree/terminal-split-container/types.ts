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
  /**
   * Issue #4484: who asked. `add` is the header "+" (#3514); `url` is
   * `?instance=` (#2656), which rides this same path. The two count their
   * tokens apart, so the container marks a request handled by
   * `${source}:${token}`, and a `url` request is acknowledged only once the
   * committed selected split shows it (and is visible).
   */
  source: InstancePlacementSource;
}

/** Issue #4484: see {@link InstancePlacementRequest.source}. */
export type InstancePlacementSource = 'add' | 'url';

/**
 * Issue #4484: what became of a placement request. `applied` — the instance
 * was placed (for `url`: the committed selected split shows it and is
 * visible); `focused` — another split already showed it and took focus
 * (`add` only; `url` reports `applied` once that focus is committed);
 * `refused` — the split could not take it (`setSplitInstance` said no).
 */
export type InstancePlacementOutcome = 'applied' | 'focused' | 'refused';

/**
 * Issue #4484: called once per request handled. `selectedInstanceId` comes
 * with every `url` outcome: the instance the selected split shows at that
 * moment (X on `applied`; what the screen still sends to on `refused`).
 */
export type InstancePlacementAppliedHandler = (
  token: number,
  source: InstancePlacementSource,
  outcome: InstancePlacementOutcome,
  selectedInstanceId?: string,
) => void;

/** Issue #3593: what `onSelectedSplitChange` publishes. */
export interface SelectedSplit {
  /** The selected (focused) split's index. */
  index: number;
  /** The instance that split shows. */
  instanceId: string;
  /** Each split's instance, by split index. */
  splitInstanceIds: string[];
}
