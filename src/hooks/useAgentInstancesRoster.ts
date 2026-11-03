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
 *
 * ## Writes from elsewhere (Issue #4117)
 *
 * The queue only orders this tab. Another tab, a phone or the CLI can change the
 * roster too, and a full replace from an older list would erase what they added. So
 * when a roster snapshot is known (`useInstanceRoleSettings`) the write starts from
 * it and sends its revision; a server that has moved on answers 409, the snapshot is
 * read again, and the builder runs once more on what is really there. Builders go by
 * id, so that is safe. With no snapshot, nothing is sent and nothing changes.
 *
 * Creating with a role goes through the same queue, so a rename issued while the
 * create is saving starts from the roster that contains it.
 */

'use client';

import { useCallback, useRef } from 'react';
import type { AgentInstance } from '@/lib/cli-tools/types';
import { roleApi } from '@/lib/api-client-agent-roles';
import {
  applyInstanceRoleSettings,
  clearRosterSnapshot,
  getRosterSnapshot,
  recordRosterSaved,
  refreshInstanceRoleSettings,
  rosterFromRoleEntries,
} from '@/hooks/useInstanceRoleSettings';
import type { AgentRoleErrorResponse, RoleAssignmentInput } from '@/types/agent-roles';

/** Builds the next roster from the latest one, or `null` to skip the write. */
export type RosterBuilder = (base: AgentInstance[]) => AgentInstance[] | null;

export type RosterWriteResult =
  | { status: 'saved'; roster: AgentInstance[] }
  | { status: 'skipped' }
  | { status: 'failed'; error?: AgentRoleErrorResponse['error'] };

/** The instance a create adds, worked out from the latest roster. */
export type RosterInstanceBuilder = (base: AgentInstance[]) => { id: string; cliTool: string; alias: string } | null;

/** One attempt at a write. `conflict`: the server's roster is not the one it started from. */
type RosterAttempt =
  | { status: 'saved'; roster: AgentInstance[] }
  | { status: 'skipped' }
  | { status: 'failed'; error?: AgentRoleErrorResponse['error'] }
  | { status: 'conflict' };

type RosterOperation = (base: AgentInstance[], expectedRevision: string | undefined) => Promise<RosterAttempt>;

/** How many times a write is rebuilt on a fresh roster before it reports failure. */
const MAX_CONFLICT_RETRIES = 2;

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

function enqueue(
  worktreeId: string,
  getCurrent: () => AgentInstance[],
  operation: RosterOperation,
  onSaved: (roster: AgentInstance[]) => void,
): Promise<RosterWriteResult> {
  const queue = queueFor(worktreeId);
  queue.pending += 1;
  const run = async (): Promise<RosterWriteResult> => {
    try {
      for (let attempt = 0; ; attempt += 1) {
        const snapshot = getRosterSnapshot(worktreeId);
        const base = snapshot?.roster ?? queue.latest ?? getCurrent();
        const result = await operation(base, snapshot?.revision);
        if (result.status === 'saved') {
          queue.latest = result.roster;
          onSaved(result.roster);
          return result;
        }
        if (result.status !== 'conflict') return result;
        // What was held is stale. Without a fresh read there is nothing safe to
        // rebuild on, so this fails rather than replacing the list blind.
        clearRosterSnapshot(worktreeId);
        queue.latest = null;
        if (attempt >= MAX_CONFLICT_RETRIES) return { status: 'failed', error: 'roster_changed' };
        await refreshInstanceRoleSettings(worktreeId);
        if (!getRosterSnapshot(worktreeId)) return { status: 'failed', error: 'roster_changed' };
      }
    } finally {
      queue.pending -= 1;
      if (queue.pending === 0) queues.delete(worktreeId);
    }
  };
  const result = queue.tail.then(run, run);
  queue.tail = result;
  return result;
}

/** What a saving PATCH confirmed, where the response says. An older server says nothing. */
async function readPatchAnswer(response: Response): Promise<{ roster?: AgentInstance[]; revision?: string }> {
  try {
    const body = (await response.json()) as { agentInstances?: unknown; rosterRevision?: unknown } | null;
    return {
      roster: Array.isArray(body?.agentInstances) ? (body.agentInstances as AgentInstance[]) : undefined,
      revision: typeof body?.rosterRevision === 'string' ? body.rosterRevision : undefined,
    };
  } catch {
    return {};
  }
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
  return enqueue(
    worktreeId,
    getCurrent,
    async (base, expectedRevision) => {
      const built = build(base);
      if (!built) return { status: 'skipped' };
      const roster = built.map((inst, order) => ({ ...inst, order }));
      let response: Response;
      try {
        response = await fetch(`/api/worktrees/${worktreeId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentInstances: roster,
            ...(expectedRevision ? { expectedRosterRevision: expectedRevision } : {}),
          }),
        });
      } catch {
        return { status: 'failed' };
      }
      if (response.status === 409) return { status: 'conflict' };
      if (!response.ok) return { status: 'failed' };
      const answer = await readPatchAnswer(response);
      const saved = answer.roster ?? roster;
      recordRosterSaved(worktreeId, saved, answer.revision);
      return { status: 'saved', roster: saved };
    },
    onSaved,
  );
}

/**
 * Queue the creation of one instance and its role, in one request
 * (`POST /api/worktrees/:id/instances/roles`).
 *
 * @param buildInstance - the instance to add, from the latest roster; `null` skips.
 */
export function enqueueRosterCreate(
  worktreeId: string,
  getCurrent: () => AgentInstance[],
  buildInstance: RosterInstanceBuilder,
  role: RoleAssignmentInput,
  onSaved: (roster: AgentInstance[]) => void,
): Promise<RosterWriteResult> {
  return enqueue(
    worktreeId,
    getCurrent,
    async (base, expectedRevision) => {
      const instance = buildInstance(base);
      if (!instance) return { status: 'skipped' };
      const result = await roleApi.createInstance(worktreeId, {
        instance,
        role,
        ...(expectedRevision ? { expectedRosterRevision: expectedRevision } : {}),
      });
      if (!result.ok) {
        const stale = result.error === 'roster_changed' || result.error === 'instance_exists';
        return stale ? { status: 'conflict' } : { status: 'failed', error: result.error };
      }
      applyInstanceRoleSettings(worktreeId, result.data);
      return { status: 'saved', roster: rosterFromRoleEntries(result.data.instances) };
    },
    onSaved,
  );
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

/** The create form of {@link useAgentInstancesRoster}. */
export function useAgentInstanceCreate(
  worktreeId: string,
  instances: AgentInstance[],
  onInstancesChange: (instances: AgentInstance[]) => void,
): (buildInstance: RosterInstanceBuilder, role: RoleAssignmentInput) => Promise<RosterWriteResult> {
  const instancesRef = useRef(instances);
  instancesRef.current = instances;
  const onChangeRef = useRef(onInstancesChange);
  onChangeRef.current = onInstancesChange;
  return useCallback(
    (buildInstance: RosterInstanceBuilder, role: RoleAssignmentInput) =>
      enqueueRosterCreate(
        worktreeId,
        () => instancesRef.current,
        buildInstance,
        role,
        (roster) => onChangeRef.current(roster),
      ),
    [worktreeId],
  );
}
