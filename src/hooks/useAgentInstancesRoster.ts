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
 *  - each write is a BUILDER, `(base) => next | null`, run when its turn comes on the
 *    roster the server last said is there. So ids are allocated against the roster that
 *    actually exists, and a rename cannot resurrect a row a delete just removed;
 *  - `onSaved` runs before the next write starts, so the parent's state is
 *    updated in order too.
 *
 * ## Writes from elsewhere (Issue #4117)
 *
 * The queue only orders this tab. Another tab, a phone or the CLI can change the
 * roster too, and a full replace from an older list would erase what they added. So
 * every write starts from a snapshot and sends its revision (`useInstanceRoleSettings`):
 * with none held it is read first, and if it cannot be read the write does not happen.
 * A server that has moved on answers 409, the snapshot is read again, and the builder
 * runs once more on what is really there. Builders go by id, so that is safe. The
 * parent's props are not a base: they carry no revision.
 *
 * Creating with a role goes through the same queue, so a rename issued while the
 * create is saving starts from the roster that contains it.
 *
 * An answer that crossed a newer one is not handed on: `onSaved` replaces the parent's
 * roster, and an older list there would undo what was read since. The roster is read
 * again instead, and if that fails the write reports `saved_unverified`: it happened,
 * but no roster can be given for it. A body not yet read when that is known is not
 * waited for: it has nothing to give, and it would hold up everything behind it.
 *
 * ## Answers that were lost
 *
 * A route commits before it answers, so a 5xx, no answer or a deadline passed on the
 * body says nothing about whether the write happened. Reporting a failure would invite
 * the same add again, which a rebuild gives the next free id: a second instance. So such
 * a write ends in a read, still in its turn in the queue and with its caller's form
 * still saving, and the read decides:
 *  - what was sent is there: saved, the same as if the answer had come;
 *  - nothing of it is there: failed, and sending it again is safe;
 *  - it cannot be told, or nothing could be read: `saved_unverified` with `unconfirmed`.
 *
 * A create compares its row, since ids are the smallest free one and an absent id means
 * no such row. A PATCH replaces the whole list, so it compares the list, and the revision
 * it started from means nothing moved.
 */

'use client';

import { useCallback, useRef } from 'react';
import type { AgentInstance } from '@/lib/cli-tools/types';
import { roleApi, sendRosterPatch } from '@/lib/api-client-agent-roles';
import {
  clearRosterSnapshot,
  ensureRosterSnapshot,
  recordRosterSaved,
  refreshAfterWrite,
  rosterFromRoleEntries,
  watchForNewerAnswer,
  writeInstanceRoleSettings,
} from '@/hooks/useInstanceRoleSettings';
import type {
  AgentRoleErrorResponse,
  InstanceRoleSettingsResponse,
  RoleAssignmentInput,
} from '@/types/agent-roles';

/** Builds the next roster from the latest one, or `null` to skip the write. */
export type RosterBuilder = (base: AgentInstance[]) => AgentInstance[] | null;

/** `roster_unreadable`: no revision could be had, so nothing was sent. */
export type RosterWriteError = AgentRoleErrorResponse['error'] | 'roster_unreadable';

export type RosterWriteResult =
  | { status: 'saved'; roster: AgentInstance[] }
  /**
   * Saved, but its answer could not be trusted and nothing could be read after it. With
   * `unconfirmed`, whether it was saved at all is not known. Either way, not to be sent again.
   */
  | { status: 'saved_unverified'; unconfirmed?: boolean }
  | { status: 'skipped' }
  | { status: 'failed'; error?: RosterWriteError };

/** The instance a create adds, worked out from the latest roster. */
export type RosterInstanceBuilder = (base: AgentInstance[]) => { id: string; cliTool: string; alias: string } | null;

/** One attempt at a write. `conflict`: the server's roster is not the one it started from. */
type RosterAttempt =
  | { status: 'saved'; roster: AgentInstance[] }
  | { status: 'saved_unverified'; unconfirmed?: boolean }
  | { status: 'skipped' }
  | { status: 'failed'; error?: AgentRoleErrorResponse['error'] }
  | { status: 'conflict' };

type RosterOperation = (base: AgentInstance[], expectedRevision: string) => Promise<RosterAttempt>;

/** How many times a write is rebuilt on a fresh roster before it reports failure. */
const MAX_CONFLICT_RETRIES = 2;

interface WorktreeQueue {
  tail: Promise<unknown>;
  pending: number;
}

const queues = new Map<string, WorktreeQueue>();

function queueFor(worktreeId: string): WorktreeQueue {
  let queue = queues.get(worktreeId);
  if (!queue) {
    queue = { tail: Promise.resolve(), pending: 0 };
    queues.set(worktreeId, queue);
  }
  return queue;
}

function enqueue(
  worktreeId: string,
  operation: RosterOperation,
  onSaved: (roster: AgentInstance[]) => void,
): Promise<RosterWriteResult> {
  const queue = queueFor(worktreeId);
  queue.pending += 1;
  const run = async (): Promise<RosterWriteResult> => {
    try {
      for (let attempt = 0; ; attempt += 1) {
        const snapshot = await ensureRosterSnapshot(worktreeId);
        if (!snapshot) {
          return { status: 'failed', error: attempt === 0 ? 'roster_unreadable' : 'roster_changed' };
        }
        const result = await operation(snapshot.roster, snapshot.revision);
        if (result.status === 'saved') {
          onSaved(result.roster);
          return result;
        }
        if (result.status !== 'conflict') return result;
        // What was held is stale. The next attempt reads it again, and with no
        // fresh read there is nothing safe to rebuild on.
        clearRosterSnapshot(worktreeId);
        if (attempt >= MAX_CONFLICT_RETRIES) return { status: 'failed', error: 'roster_changed' };
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

/** A PATCH saved, and something newer was taken meanwhile: only a read made now can be believed. */
async function readAfterCrossing(worktreeId: string): Promise<RosterAttempt> {
  const settings = await refreshAfterWrite(worktreeId);
  return settings
    ? { status: 'saved', roster: rosterFromRoleEntries(settings.instances) }
    : { status: 'saved_unverified' };
}

function sameRoster(left: readonly AgentInstance[], right: readonly AgentInstance[]): boolean {
  return (
    left.length === right.length &&
    left.every((inst, index) => {
      const other = right[index];
      return inst.id === other.id && inst.cliTool === other.cliTool && inst.alias === other.alias;
    })
  );
}

/** A PATCH with no usable answer. Reads the roster route: the "+" falls back here when the role route is failing. */
async function settleLostPatch(
  worktreeId: string,
  sent: readonly AgentInstance[],
  expectedRevision: string,
): Promise<RosterAttempt> {
  clearRosterSnapshot(worktreeId);
  const confirmed = await ensureRosterSnapshot(worktreeId);
  if (!confirmed) {
    await refreshAfterWrite(worktreeId);
    return { status: 'saved_unverified', unconfirmed: true };
  }
  if (sameRoster(confirmed.roster, sent)) {
    recordRosterSaved(worktreeId, confirmed.roster, confirmed.revision);
    return { status: 'saved', roster: confirmed.roster };
  }
  if (confirmed.revision === expectedRevision) return { status: 'failed' };
  recordRosterSaved(worktreeId, confirmed.roster, confirmed.revision);
  return { status: 'saved_unverified', unconfirmed: true };
}

/** A create with no usable answer, from what was read after it. */
function settleLostCreate(
  settings: InstanceRoleSettingsResponse | null,
  instance: { id: string; cliTool: string; alias: string },
  role: RoleAssignmentInput,
): RosterAttempt {
  if (!settings) return { status: 'saved_unverified', unconfirmed: true };
  const row = settings.instances.find((entry) => entry.instanceId === instance.id);
  if (!row) return { status: 'failed' };
  const { stored } = row;
  const sameRole = stored.state === 'role' ? role.state === 'role' && role.roleId === stored.roleId : role.state === stored.state;
  // A row with that id but other content may be this one changed since, or another client's.
  return row.cliToolId === instance.cliTool && row.alias === instance.alias && sameRole
    ? { status: 'saved', roster: rosterFromRoleEntries(settings.instances) }
    : { status: 'saved_unverified', unconfirmed: true };
}

/**
 * Queue one roster write for `worktreeId`.
 *
 * @param build - computes the next roster from the base.
 * @param onSaved - called with the saved roster before the next write starts.
 */
export function enqueueRosterWrite(
  worktreeId: string,
  build: RosterBuilder,
  onSaved: (roster: AgentInstance[]) => void,
): Promise<RosterWriteResult> {
  return enqueue(
    worktreeId,
    async (base, expectedRevision) => {
      const built = build(base);
      if (!built) return { status: 'skipped' };
      const roster = built.map((inst, order) => ({ ...inst, order }));
      const crossed = watchForNewerAnswer(worktreeId);
      const answer = await sendRosterPatch(worktreeId, {
        agentInstances: roster,
        expectedRosterRevision: expectedRevision,
      });
      if (answer.kind === 'conflict') return { status: 'conflict' };
      if (answer.kind === 'refused') return { status: 'failed' };
      if (answer.kind === 'unknown') return settleLostPatch(worktreeId, roster, expectedRevision);
      if (crossed()) {
        answer.abandon();
        return readAfterCrossing(worktreeId);
      }
      const body = await answer.readBody();
      if (!body) return settleLostPatch(worktreeId, roster, expectedRevision);
      // Again after the body: reading it waits, and a newer answer can be taken meanwhile.
      if (crossed()) return readAfterCrossing(worktreeId);
      const saved = body.roster ?? roster;
      recordRosterSaved(worktreeId, saved, body.revision);
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
  buildInstance: RosterInstanceBuilder,
  role: RoleAssignmentInput,
  onSaved: (roster: AgentInstance[]) => void,
): Promise<RosterWriteResult> {
  return enqueue(
    worktreeId,
    async (base, expectedRevision) => {
      const instance = buildInstance(base);
      if (!instance) return { status: 'skipped' };
      const result = await writeInstanceRoleSettings(worktreeId, () =>
        roleApi.createInstance(worktreeId, { instance, role, expectedRosterRevision: expectedRevision }),
      );
      if (!result.ok) {
        if (result.outcomeUnknown) return settleLostCreate(result.settings, instance, role);
        const stale = result.error === 'roster_changed' || result.error === 'instance_exists';
        return stale ? { status: 'conflict' } : { status: 'failed', error: result.error };
      }
      return result.settings
        ? { status: 'saved', roster: rosterFromRoleEntries(result.settings.instances) }
        : { status: 'saved_unverified' };
    },
    onSaved,
  );
}

/**
 * The hook form: binds the queue to a component's worktree and `onInstancesChange`,
 * reading the latest through a ref so the returned `write` is stable.
 */
export function useAgentInstancesRoster(
  worktreeId: string,
  onInstancesChange: (instances: AgentInstance[]) => void,
): (build: RosterBuilder) => Promise<RosterWriteResult> {
  const onChangeRef = useRef(onInstancesChange);
  onChangeRef.current = onInstancesChange;
  return useCallback(
    (build: RosterBuilder) =>
      enqueueRosterWrite(
        worktreeId,
        build,
        (roster) => onChangeRef.current(roster),
      ),
    [worktreeId],
  );
}

/** The create form of {@link useAgentInstancesRoster}. */
export function useAgentInstanceCreate(
  worktreeId: string,
  onInstancesChange: (instances: AgentInstance[]) => void,
): (buildInstance: RosterInstanceBuilder, role: RoleAssignmentInput) => Promise<RosterWriteResult> {
  const onChangeRef = useRef(onInstancesChange);
  onChangeRef.current = onInstancesChange;
  return useCallback(
    (buildInstance: RosterInstanceBuilder, role: RoleAssignmentInput) =>
      enqueueRosterCreate(
        worktreeId,
        buildInstance,
        role,
        (roster) => onChangeRef.current(roster),
      ),
    [worktreeId],
  );
}
