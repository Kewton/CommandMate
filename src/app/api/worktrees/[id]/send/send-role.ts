/**
 * POST /api/worktrees/:id/send — the role a send asks for (Issue #4115).
 *
 * `role` (`--role` / `--no-role`) is validated and saved first, outside any
 * transaction that a launch would have to sit through, and from then on is a
 * condition: the process that receives the body must have been started with exactly
 * what that setting injects. `expectedRole` pins the same thing without saving
 * anything (a generation and a fingerprint read earlier).
 *
 * The condition is read three times, because a driver may relaunch inside the send
 * (`requireSession` → `relaunchIfToolExited`), and anyone may change a setting
 * while the send waits:
 *
 * 1. for a process already running, before the send service is entered;
 * 2. for a process this request started, after the start;
 * 3. synchronously, right before the first key ({@link roleConditionBoundary}).
 *
 * A mismatch and missing evidence both refuse. The setting is left as saved, and
 * the answer says so, so the caller knows a retry after a restart needs no `--role`.
 */
import { NextResponse } from 'next/server';
import type Database from 'better-sqlite3';
import { forgetOpencodeSession } from '@/lib/session/opencode-session-store';
import {
  getLaunchRoleEvidence,
  recomputeInjectionFingerprint,
  resolveLaunchRole,
  takeResumedAcrossRoleNotice,
  type LaunchRoleSnapshot,
} from '@/lib/session/role-launch';
import { roleEnvReaderForPane } from '@/lib/agent-roles/pane-env';
import { InstanceRoleRequestError, readRosterRevision, setManagedInstanceRole } from '@/lib/agent-roles/management';
import { parseRoleAssignmentInput } from '@/lib/agent-roles/validation';
import {
  ROLE_CONDITION_UNMET_CODE,
  ROLE_LAUNCH_REFUSED_CODE,
  RoleConditionUnmetError,
} from '@/lib/agent-roles/launch-errors';
import { AgentRoleNotFoundError, getInstanceRoleState } from '@/lib/db/agent-roles-db';
import { getWorktreeById } from '@/lib/db';
import { resolveSessionTargetStrict } from '@/lib/session/resolve-session-target';
import type { InputBoundaryHooks } from '@/lib/session/instance-input-lock';
import type { SendAttemptReason } from '@/lib/session/send-attempt-types';
import type { CLIToolType } from '@/lib/cli-tools/types';
import {
  agentRoleReplacesDefaultInstructions,
  isAgentRoleAdapterEnabled,
  isAgentRoleCliTool,
  type StoredRoleState,
} from '@/types/agent-roles';
import type { Worktree } from '@/types/models';
import type { SendStep } from './send-request';

/** What a send can say about its role. Every field is optional on the wire. */
export interface SendRoleRequest {
  /** Save this for the instance, and require it. */
  role?: unknown;
  /** Require this, saving nothing. `sessionGeneration` omitted: any process with that fingerprint. */
  expectedRole?: unknown;
  /** OpenCode V1: start a new conversation instead of continuing the remembered one (§6.4). */
  newConversation?: unknown;
}

interface RoleCondition {
  /** Null: no role. */
  injectionFingerprint: string | null;
  /** Null: not pinned to a generation yet. */
  sessionGeneration: string | null;
}

/** One request's dealings with its role. */
export interface SendRoleGate {
  condition: RoleCondition | null;
  snapshot: LaunchRoleSnapshot | null;
  saved: boolean;
  stored: StoredRoleState;
}

interface SendRoleTarget {
  worktree: Worktree;
  cliToolId: CLIToolType;
  /** The instance id as the roster has it. */
  rosterInstanceId: string;
  /** As the request named it; undefined means the primary. */
  instanceId: string | undefined;
  /** Told right after a save, so every later answer of the request can say so. */
  onSaved?: (settings: { saved: true; stored: StoredRoleState }) => void;
}

function refuse(
  message: string,
  code: string,
  gate: Pick<SendRoleGate, 'saved' | 'stored'>,
  recordNotSent: (reason: SendAttemptReason) => void,
  reason: SendAttemptReason,
  status: number = 409,
  extra: Record<string, unknown> = {}
): { ok: false; response: NextResponse } {
  recordNotSent(reason);
  return {
    ok: false,
    response: NextResponse.json(
      { error: message, code, roleSettings: { saved: gate.saved, stored: gate.stored }, ...extra },
      { status }
    ),
  };
}

function parseExpectedRole(value: unknown): RoleCondition | null {
  if (typeof value !== 'object' || value === null) return null;
  const { injectionFingerprint, sessionGeneration } = value as Record<string, unknown>;
  if (injectionFingerprint !== null && typeof injectionFingerprint !== 'string') return null;
  if (sessionGeneration !== undefined && typeof sessionGeneration !== 'string') return null;
  return { injectionFingerprint, sessionGeneration: sessionGeneration ?? null };
}

/** Whether this send says anything about a role. */
function asksForRole(body: SendRoleRequest): boolean {
  return body.role !== undefined || body.expectedRole !== undefined;
}

/** Where a request settled who it is talking to: read again before a setting is saved. */
export function readRoleRosterMark(db: Database.Database, worktreeId: string, body: SendRoleRequest): string | null {
  return asksForRole(body) ? readRosterRevision(db, worktreeId) : null;
}

/**
 * The worktree row to save a role under, read now (Issue #4116). The row and the
 * target were read before this request's awaits: the roster may have moved since,
 * and an id may even name another tool. Anything different, and nothing is saved or
 * sent. Run with no await before {@link prepareSendRole}, whose save comes before its
 * first await, so what is checked here is what is saved.
 */
export function rereadWorktreeForRole(
  db: Database.Database,
  body: SendRoleRequest & { cliToolId?: CLIToolType; instanceId?: string },
  target: { worktree: Worktree; cliToolId: CLIToolType; rosterInstanceId: string; rosterMark: string | null },
  recordNotSent: (reason: SendAttemptReason) => void
): SendStep<Worktree> {
  const { worktree, cliToolId, rosterInstanceId, rosterMark } = target;
  if (!asksForRole(body)) return { ok: true, value: worktree };
  const row = getWorktreeById(db, worktree.id);
  const resolved = row
    ? resolveSessionTargetStrict(db, worktree.id, { instanceId: body.instanceId, requestedCliTool: body.cliToolId || undefined })
    : null;
  if (
    !row ||
    !resolved?.ok ||
    resolved.target.cliToolId !== cliToolId ||
    resolved.target.instanceId !== rosterInstanceId ||
    readRosterRevision(db, worktree.id) !== rosterMark
  ) {
    return refuse(
      'The roster changed while this send was waiting; nothing was saved or typed. Send it again.',
      'roster_changed',
      { saved: false, stored: getInstanceRoleState(db, worktree.id, rosterInstanceId) },
      recordNotSent,
      'role-condition-failed'
    );
  }
  return { ok: true, value: row };
}

/**
 * Validate and save the role this send asks for, and work out what it must inject.
 *
 * @returns Null when the request says nothing about a role
 */
export async function prepareSendRole(
  db: Database.Database,
  body: SendRoleRequest,
  target: SendRoleTarget,
  recordNotSent: (reason: SendAttemptReason) => void
): Promise<SendStep<SendRoleGate | null>> {
  const { worktree, cliToolId, rosterInstanceId, instanceId } = target;
  const untouched = (): Pick<SendRoleGate, 'saved' | 'stored'> => ({
    saved: false,
    stored: getInstanceRoleState(db, worktree.id, rosterInstanceId),
  });
  if (body.role === undefined && body.expectedRole === undefined) return { ok: true, value: null };

  let saved = false;
  if (body.role !== undefined) {
    const input = parseRoleAssignmentInput(body.role);
    if (!input) {
      return refuse('role must be inherit, none or a role id', 'invalid_request', untouched(), recordNotSent, 'role-launch-refused', 400);
    }
    if (input.state === 'role' && isAgentRoleCliTool(cliToolId) && !isAgentRoleAdapterEnabled(cliToolId)) {
      return refuse(`Roles are not enabled for ${cliToolId} yet`, ROLE_LAUNCH_REFUSED_CODE, untouched(), recordNotSent, 'role-launch-refused', 409, {
        roleRefusal: 'adapter-disabled',
      });
    }
    try {
      setManagedInstanceRole(db, worktree, rosterInstanceId, input);
      saved = true;
      target.onSaved?.({ saved: true, stored: getInstanceRoleState(db, worktree.id, rosterInstanceId) });
    } catch (error) {
      if (error instanceof InstanceRoleRequestError || error instanceof AgentRoleNotFoundError) {
        const code = error instanceof InstanceRoleRequestError ? error.code : 'not_found';
        const status = code === 'not_found' ? 404 : 400;
        return refuse(error.message, code, untouched(), recordNotSent, 'role-launch-refused', status);
      }
      throw error;
    }
  }
  const stored = getInstanceRoleState(db, worktree.id, rosterInstanceId);

  const expected = body.expectedRole === undefined ? null : parseExpectedRole(body.expectedRole);
  if (body.expectedRole !== undefined && expected === null) {
    return refuse('expectedRole must carry injectionFingerprint', 'invalid_request', { saved, stored }, recordNotSent, 'role-condition-failed', 400);
  }

  const snapshot = await resolveLaunchRole(db, {
    worktreeId: worktree.id,
    cliToolId,
    instanceId,
    worktreePath: worktree.path,
    readEnv: roleEnvReaderForPane({ worktreeId: worktree.id, cliToolId, instanceId }),
  });
  if (snapshot.refusal) {
    return refuse(snapshot.refusal.message, ROLE_LAUNCH_REFUSED_CODE, { saved, stored }, recordNotSent, 'role-launch-refused', 409, {
      roleRefusal: snapshot.refusal.reason,
    });
  }
  const condition: RoleCondition = expected ?? { injectionFingerprint: snapshot.injectionFingerprint, sessionGeneration: null };
  if (expected !== null && expected.injectionFingerprint !== snapshot.injectionFingerprint) {
    return refuse(
      'The settings no longer resolve to the role this send was pinned to; nothing was typed',
      ROLE_CONDITION_UNMET_CODE,
      { saved, stored },
      recordNotSent,
      'role-condition-failed'
    );
  }
  return { ok: true, value: { condition, snapshot, saved, stored } };
}

/**
 * A send pinned to a generation, and no process running: the one it was pinned to is
 * gone. Refused before a start, which could only make a process it would then refuse.
 */
export function refuseGonePinnedProcess(
  gate: SendRoleGate | null,
  recordNotSent: (reason: SendAttemptReason) => void
): NextResponse | null {
  if (!gate || (gate.condition?.sessionGeneration ?? null) === null) return null;
  return refuse(
    'The process this send was pinned to is no longer running; nothing was typed.',
    ROLE_CONDITION_UNMET_CODE,
    gate,
    recordNotSent,
    'role-condition-failed'
  ).response;
}

/**
 * Check the process about to receive the body, and pin the generation it runs under.
 *
 * @param gate - Mutated: the condition gets the generation that was read
 * @returns Null when the send may go on, or the refusal
 */
export function checkRunningRole(
  gate: SendRoleGate | null,
  target: { worktreeId: string; cliToolId: CLIToolType; instanceId: string | undefined },
  recordNotSent: (reason: SendAttemptReason) => void
): NextResponse | null {
  const condition = gate?.condition;
  if (!gate || !condition) return null;
  const evidence = getLaunchRoleEvidence(target);
  const problem =
    evidence === null
      ? 'This server has no record of what the running process was started with (for example after a server restart)'
      : evidence.injectionFingerprint !== condition.injectionFingerprint
        ? 'The running process was started with a different role'
        : condition.sessionGeneration !== null && evidence.sessionGeneration !== condition.sessionGeneration
          ? 'The process was replaced since the role was pinned'
          : null;
  if (problem !== null || evidence === null) {
    return refuse(
      `${problem}; nothing was typed. A role is fixed when the process starts: stop the session and send again.`,
      ROLE_CONDITION_UNMET_CODE,
      gate,
      recordNotSent,
      'role-condition-failed'
    ).response;
  }
  condition.sessionGeneration = evidence.sessionGeneration;
  return null;
}

/**
 * The last check, in the same synchronous step as the first key. It re-reads the
 * settings and the generation, so a default changed, a body edited or a process
 * replaced while this send waited stops it here.
 */
export function roleConditionBoundary(
  gate: SendRoleGate | null,
  target: { worktreeId: string; cliToolId: CLIToolType; instanceId: string | undefined },
  next?: InputBoundaryHooks
): InputBoundaryHooks | undefined {
  const condition = gate?.condition;
  const snapshot = gate?.snapshot;
  if (!condition || !snapshot) return next;
  return {
    beforeInput: (at, kind) => {
      const evidence = getLaunchRoleEvidence(target);
      if (evidence === null || evidence.sessionGeneration !== condition.sessionGeneration) {
        throw new RoleConditionUnmetError('The process was replaced while this send was on its way');
      }
      let now: string | null;
      try {
        now = recomputeInjectionFingerprint(snapshot);
      } catch (error) {
        throw new RoleConditionUnmetError(error instanceof Error ? error.message : 'The role could not be read');
      }
      if (now !== condition.injectionFingerprint || evidence.injectionFingerprint !== condition.injectionFingerprint) {
        throw new RoleConditionUnmetError('The role changed while this send was on its way');
      }
      next?.beforeInput(at, kind);
    },
    onDispatchFailed: next?.onDispatchFailed,
  };
}

/** What a send's answer adds about the role, once it went through. Empty for most. */
export function roleSendNotices(input: {
  cliToolId: CLIToolType;
  gate: SendRoleGate | null;
  evidence: { sessionGeneration: string; injectionFingerprint: string | null } | null;
  opencodeResume: OpencodeResumeNotice | null;
}): Record<string, unknown> {
  const { cliToolId, gate, evidence, opencodeResume } = input;
  const out: Record<string, unknown> = {};
  if (gate && evidence) {
    out.roleLaunch = {
      sessionGeneration: evidence.sessionGeneration,
      injectionFingerprint: evidence.injectionFingerprint,
      saved: gate.saved,
      stored: gate.stored,
    };
  }
  if (evidence?.injectionFingerprint && agentRoleReplacesDefaultInstructions(cliToolId)) {
    out.replacesDefaultInstructions = true;
  }
  if (opencodeResume) out.roleResume = opencodeResume;
  return out;
}

/** Said when an OpenCode V1 conversation continues under another role (§6.4). */
export interface OpencodeResumeNotice {
  continued: true;
  message: string;
  /** Send this field as true, with the session stopped, to start a new conversation instead. */
  newConversationField: 'newConversation';
}

/**
 * The choice of a new conversation (§6.4): drops only the remembered id, and the
 * history stays where it is. Without it the driver continues, and says so through
 * {@link takeOpencodeResumeNotice}.
 */
export function chooseNewOpencodeConversation(target: { worktreeId: string; instanceId: string | undefined }): void {
  forgetOpencodeSession({ worktreeId: target.worktreeId, cliToolId: 'opencode', instanceId: target.instanceId });
}

/**
 * What the launch noticed, whoever started it: this request, or the driver relaunching
 * inside the send. Once per process.
 */
export function takeOpencodeResumeNotice(target: { worktreeId: string; instanceId: string | undefined }): OpencodeResumeNotice | null {
  if (!takeResumedAcrossRoleNotice({ worktreeId: target.worktreeId, cliToolId: 'opencode', instanceId: target.instanceId })) {
    return null;
  }
  return {
    continued: true,
    message:
      'This conversation continues under a different role, and what the earlier role said stays in its history. ' +
      'To start a new conversation instead, stop the session and send with newConversation.',
    newConversationField: 'newConversation',
  };
}
