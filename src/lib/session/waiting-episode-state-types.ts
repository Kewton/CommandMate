/**
 * The types of the waiting-episode store (Issue #1786 / #3798). No runtime
 * state lives here; `waiting-episode-state` re-exports every public name.
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import type { WaitingKind } from '@/lib/session/waiting-kind';

/** One uninterrupted stretch of waiting by one agent instance. */
export interface WaitingEpisode {
  /**
   * Epoch ms the wait began.
   *
   * Fixed when the episode opens and never moved while it lasts — a value that
   * crept forward on every poll would make "waiting for 12 minutes" unreadable,
   * which is the whole reason #1787 asked for it.
   */
  since: number;
  /** The most recent classification of this wait. May change mid-episode. */
  kind: WaitingKind | null;
}

// =============================================================================
// Issue #3798: identity and attribution
// =============================================================================
//
// `since` is a time, and two waits can share one (the same millisecond, or a
// structured `at` reused by the next prompt). Everything that has to tell one
// wait from another — the turn transition that ends it, a closer that comes
// back from an `await`, the push gate's hold — needs an identity that is not a
// time, and needs to know which turn the wait belongs to. That is kept here,
// beside the episode and not on it: `getWaitingEpisode` and the transition the
// listeners receive keep the shape #1786 published (the suites compare them
// whole), and the new facts are read through `getWaitingEpisodeRecord` and
// `onWaitingEpisodeTransition`. Design: `docs/design/issue-3798-waiting-episode.md`.

/** Unique within the process; carries no time (Issue #3798). */
export type WaitingEpisodeId = string;

/** The generation an episode belongs to. "None opened" is not spelled null. */
export type GenerationRef = { kind: 'opened'; at: number } | { kind: 'none' };

/** Which wait the episode opened as (design §2.2). */
export type EpisodeBinding =
  /** A wait inside turn `turnId`; that turn's end may close it. */
  | { kind: 'turn'; generation: GenerationRef; turnId: string }
  /** A dialog the agent reported before any turn was open (a dialog-only record with live decisions). */
  | { kind: 'dialog-only'; generation: GenerationRef; recordTurnId: string; sessionId: string | null }
  /** Seen with no open turn and no dialog record; `lastClosedTurnId` is what had last ended then. */
  | { kind: 'unattributed'; generation: GenerationRef; lastClosedTurnId: string | null }
  /** A screen only a person drives (survey, picker, trust). Not ended by a turn's end. */
  | { kind: 'screen'; generation: GenerationRef; originTurnId: string | null };

/** Who opened an episode. `legacy-edge` is `observeWaitingEdge`, whose caller is not named. */
export type WaitingObserver =
  | 'status-probe'
  | 'response-checker'
  | 'auto-yes-poller'
  | 'turn-transition'
  | 'legacy-stop'
  | 'legacy-edge';

export type WaitingCloseReason =
  | 'turn-stop'
  | 'turn-session-end'
  | 'turn-superseded'
  | 'decision-settled'
  | 'generation'
  | 'screen-cleared'
  | 'session-gone'
  | 'response-recorded'
  | 'poller-answered'
  | 'legacy-stop';

/** The facts an episode carries besides `since` and `kind`. */
export interface WaitingEpisodeMeta {
  episodeId: WaitingEpisodeId;
  /** When the episode was opened (or put in place by a replacement). */
  openedAt: number;
  /** When `binding` last changed; `openedAt` until a rebind. */
  boundAt: number;
  binding: EpisodeBinding;
  openedBy: WaitingObserver;
  promptScreenKey: string | null;
}

/** An open episode with everything known about it. A snapshot: writing to it changes nothing. */
export interface WaitingEpisodeRecord extends WaitingEpisode, WaitingEpisodeMeta {}

/** The last episode that ended for one instance (closed, or replaced). */
export interface LastClosedEpisode {
  at: number;
  promptScreenKey: string | null;
}

/** compositeKey parts, as every write takes them. */
export interface EpisodeKeyParts {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** The agent instance; undefined/`cliToolId` both mean the primary. */
  instanceId?: string;
}

/** A crossing with its identity — what `onWaitingEpisodeTransition` delivers. */
export interface WaitingEpisodeTransition extends WaitingTransition {
  cause: 'opened' | 'closed' | 'replaced';
  /** The episode now open (opened / replaced), or null (closed). */
  episodeId: WaitingEpisodeId | null;
  /** The episode that ended (closed / replaced), or null (opened). */
  previousEpisodeId: WaitingEpisodeId | null;
  closeReason: WaitingCloseReason | null;
}

export type WaitingEpisodeTransitionListener = (transition: WaitingEpisodeTransition) => void;

/**
 * Decides the binding of an episode `observeWaitingEdge` opens. Registered by
 * `waiting-episode-binding`, which reads the turn model; this module imports
 * neither, so the store stays a leaf of the graph.
 */
export type EpisodeBindingResolver = (parts: EpisodeKeyParts, at: number) => EpisodeBinding;

/** A crossing of the waiting edge, handed to every listener. */
export interface WaitingTransition {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** The agent instance; undefined/`cliToolId` both mean the primary. */
  instanceId: string | undefined;
  /** Which way it crossed: true = the wait began, false = it ended. */
  waiting: boolean;
  /** The episode's start, or null when the wait just ended. */
  since: number | null;
  /** The episode's kind, or null when the wait just ended. */
  kind: WaitingKind | null;
  /** Epoch ms the crossing was observed. */
  at: number;
}

export type WaitingTransitionListener = (transition: WaitingTransition) => void;

/** What a new episode opens with. */
export interface NewEpisode {
  since: number;
  kind: WaitingKind | null;
  binding: EpisodeBinding;
  openedBy: WaitingObserver;
  promptScreenKey?: string | null;
}

export interface ObserveWaitingEdgeParams {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId?: string;
  /** The composed verdict for this poll — scraper OR structured. */
  waiting: boolean;
  /** This poll's classification, or null. */
  kind?: WaitingKind | null;
  /**
   * The structured episode's own start, when one exists.
   *
   * Preferred over the observation time when an episode opens, because it is
   * when the human was actually blocked: the agent posts the event the moment
   * the dialog is drawn, while the scraper reads the pane through a 5 s capture
   * cache on a poll of its own. Only consulted at the edge — once an episode is
   * open its `since` is frozen.
   */
  structuredSince?: number | null;
  /** Epoch ms; defaults to now. */
  now?: number;
}
