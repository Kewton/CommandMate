/**
 * useAgentInstancesRoster — serialized roster writes (Issue #3514)
 *
 * `PATCH /api/worktrees/[id]` with `agentInstances` REPLACES the whole roster
 * in the DB. Two components write it — the header's "+" (`AgentAddMenu`) and
 * the Agents pane (`AgentInstancesPane`: add / rename / reorder / delete) — and
 * each used to build its body from the roster it last rendered. A write issued
 * while the other's was still in flight therefore started from a roster that
 * did not contain the other's change: the second PATCH erased the first, and
 * two adds of the same tool both allocated the same id.
 *
 * Every roster write now goes through one per-worktree queue:
 *  - writes run one at a time, in the order they were issued;
 *  - each write is a BUILDER, `(base) => next | null`, run when its turn comes,
 *    where `base` is the roster the previous write in the same burst saved (or,
 *    for the first write of a burst, the caller's current roster). So ids are
 *    allocated against the roster that actually exists, and a rename cannot
 *    resurrect a row a delete just removed;
 *  - `onSaved` runs before the next write starts, so the parent's state is
 *    updated in order too.
 *
 * The "last saved" roster is only remembered while writes are queued; once the
 * queue drains the caller's props are the authority again (another tab, a
 * server-side refresh). A failed write leaves the base untouched.
 */

'use client';

import { useCallback, useRef } from 'react';
import type { AgentInstance } from '@/lib/cli-tools/types';

/** Builds the next roster from the latest one, or `null` to skip the write. */
export type RosterBuilder = (base: AgentInstance[]) => AgentInstance[] | null;

export type RosterWriteResult =
  | { status: 'saved'; roster: AgentInstance[] }
  | { status: 'skipped' }
  | { status: 'failed' };

interface WorktreeQueue {
  tail: Promise<unknown>;
  pending: number;
  /** Roster saved by the last write of the current burst, if any. */
  latest: AgentInstance[] | null;
}

const queues = new Map<string, WorktreeQueue>();

function queueFor(worktreeId: string): WorktreeQueue {
  let queue = queues.get(worktreeId);
  if (!queue) {
    queue = { tail: Promise.resolve(), pending: 0, latest: null };
    queues.set(worktreeId, queue);
  }
  return queue;
}

/**
 * Queue one roster write for `worktreeId`.
 *
 * @param getCurrent - the caller's roster at the moment the write RUNS (read
 *   through a ref), used as the base when no earlier write in the burst saved.
 * @param build - computes the next roster from the base.
 * @param onSaved - called with the saved roster before the next write starts.
 */
export function enqueueRosterWrite(
  worktreeId: string,
  getCurrent: () => AgentInstance[],
  build: RosterBuilder,
  onSaved: (roster: AgentInstance[]) => void,
): Promise<RosterWriteResult> {
  const queue = queueFor(worktreeId);
  queue.pending += 1;
  const run = async (): Promise<RosterWriteResult> => {
    try {
      const base = queue.latest ?? getCurrent();
      const built = build(base);
      if (!built) return { status: 'skipped' };
      const roster = built.map((inst, order) => ({ ...inst, order }));
      try {
        const response = await fetch(`/api/worktrees/${worktreeId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentInstances: roster }),
        });
        if (!response.ok) return { status: 'failed' };
      } catch {
        return { status: 'failed' };
      }
      queue.latest = roster;
      onSaved(roster);
      return { status: 'saved', roster };
    } finally {
      queue.pending -= 1;
      if (queue.pending === 0) queues.delete(worktreeId);
    }
  };
  const result = queue.tail.then(run, run);
  queue.tail = result;
  return result;
}

/**
 * The hook form: binds the queue to a component's worktree, roster and
 * `onInstancesChange`, reading the latest of each through refs so the returned
 * `write` is stable.
 */
export function useAgentInstancesRoster(
  worktreeId: string,
  instances: AgentInstance[],
  onInstancesChange: (instances: AgentInstance[]) => void,
): (build: RosterBuilder) => Promise<RosterWriteResult> {
  const instancesRef = useRef(instances);
  instancesRef.current = instances;
  const onChangeRef = useRef(onInstancesChange);
  onChangeRef.current = onInstancesChange;
  return useCallback(
    (build: RosterBuilder) =>
      enqueueRosterWrite(
        worktreeId,
        () => instancesRef.current,
        build,
        (roster) => onChangeRef.current(roster),
      ),
    [worktreeId],
  );
}
