/**
 * OpenCode V2's agent event source (Issue #2934, Epic #2370 Phase 1).
 *
 * A pull source like v1's: CommandMate subscribes to the agent's server rather
 * than being called by it. What differs is whose server it is. v1's TUI serves
 * the API itself once given `--port`; OpenCode V2's TUI is a client of a
 * separate `opencode2 serve`, so the launch line runs
 * `scripts/opencode-v2/launch.sh`, which starts the server on the instance's
 * own port with the instance's own password, waits for it, runs the TUI
 * against it, and stops the server however the TUI goes away.
 *
 * Phase 1 publishes state, and (Issue #2940) each finished turn's reply into
 * History (`./history`).
 *
 * Issue #2945 (Phase 2) makes approvals and questions answerable from
 * CommandMate: `eventIdentity: 'permission-id'` (the `per_…` / `frm_…` id the
 * reply URL takes), `listPending` reads the server's own lists
 * (`GET /api/permission/request`, `GET /api/form`), and `decide` answers over
 * `POST …/permission/{requestID}/reply` / `POST …/form/{formID}/reply`. The
 * PC panel, the phone sheet, `commandmate respond` and Auto-Yes all reach
 * those through the tool-independent seams (`answerPendingDecision`,
 * `adjudicatePendingPermission`), exactly as they reach v1.
 *
 * @module lib/hooks/sources/opencode-v2/source
 */

import { existsSync } from 'fs';
import { basename, resolve } from 'path';
import { shellQuote } from '@/lib/hooks/hook-settings-generator';
import { createLogger } from '@/lib/logger';
import { definePullEventSource } from '../define-source';
import { isPlainObject } from '../event-mapper';
import { recordDecisionDelivery } from '../pending-decisions';
import type {
  AgentEventSource,
  AgentInstanceRef,
  AgentLaunchContext,
  AgentLaunchPlan,
  PendingDecision,
  SourceLiveness,
  Verdict,
} from '../types';
import {
  fetchOpencodeV2PendingForms,
  fetchOpencodeV2PendingPermissions,
  replyOpencodeV2Form,
  replyOpencodeV2Permission,
  type OpencodeV2PermissionReply,
} from './client';
import { OPENCODE_V2_MAPPERS, opencodeV2EventIdentity } from './mappers';
import {
  buildOpencodeV2FormAnswer,
  parseOpencodeV2Form,
  parseOpencodeV2PermissionRequest,
  toOpencodeV2PendingPermission,
  toOpencodeV2PendingQuestion,
} from './payloads';
import { getAssignedOpencodeV2Port } from './ports';
import { getOpencodeV2PasswordFilePath, readOpencodeV2Password } from './secrets';
import {
  getOpencodeV2Liveness,
  openOpencodeV2Subscription,
} from './subscription';
import { OPENCODE_V2_CLI_TOOL_ID, OPENCODE_V2_COMMAND } from './tool-id';

const logger = createLogger('lib/hooks/sources/opencode-v2/source');

/** The wrapper, relative to the package root CommandMate runs from. */
export const OPENCODE_V2_LAUNCH_SCRIPT_RELATIVE_PATH = ['scripts', 'opencode-v2', 'launch.sh'];

/** Absolute path of the wrapper, or null when it is not on disk. */
export function resolveOpencodeV2LaunchScriptPath(): string | null {
  const candidate = resolve(process.cwd(), ...OPENCODE_V2_LAUNCH_SCRIPT_RELATIVE_PATH);
  return existsSync(candidate) ? candidate : null;
}

/**
 * The launch line for an instance.
 *
 * With a reserved port and a written password file (the runtime's
 * `reserveOpencodeV2Server` does both first) it is
 * `bash <launch.sh> --port <N> --password-file <path> --directory <worktree>`:
 * the password travels as a PATH, and `env` stays empty, so neither the line
 * typed into the pane nor the environment it renders carries the secret.
 *
 * Without them — the port range exhausted, the state directory unwritable, the
 * wrapper missing from the install — it falls back to
 * `opencode2 --standalone <worktree>`: a private server with no structured
 * events, which the screen scraper still reads. Never the bare `opencode2`,
 * which would attach to the user's shared background service.
 *
 * Issue #2939: the wrapper starts `opencode2` by that name, so it is only used
 * when the resolved executable IS an `opencode2`. OpenCode V2 installed under
 * the `opencode` name alone takes the standalone line, run by its absolute path.
 */
export function prepareOpencodeV2Launch({
  target,
  executablePath,
  worktreePath,
}: AgentLaunchContext): AgentLaunchPlan {
  const standalone: AgentLaunchPlan = {
    command: `${shellQuote(executablePath)} --standalone ${shellQuote(worktreePath)}`,
    settingsPath: null,
    env: {},
  };
  const port = getAssignedOpencodeV2Port(target);
  if (port === null) return standalone;
  const passwordFile = getOpencodeV2PasswordFilePath(target);
  const script = resolveOpencodeV2LaunchScriptPath();
  const reason =
    script === null
      ? 'launch-script-missing'
      : !existsSync(passwordFile)
        ? 'password-file-missing'
        : basename(executablePath) !== OPENCODE_V2_COMMAND
          ? 'opencode2-not-installed'
          : null;
  if (script === null || reason !== null) {
    logger.warn('opencode-v2-launch-degraded-to-standalone', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      reason,
    });
    return standalone;
  }
  return {
    command: [
      'bash',
      shellQuote(script),
      '--port',
      String(port),
      '--password-file',
      shellQuote(passwordFile),
      '--directory',
      shellQuote(worktreePath),
    ].join(' '),
    settingsPath: null,
    env: {},
  };
}

/**
 * Map a verdict onto OpenCode V2's three-valued reply (`Permission.Reply`), or
 * null when it has none — the same mapping v1 uses: `Allow once` → `once`,
 * `Always allow` → `always`, reject → `reject`.
 */
export function toOpencodeV2PermissionReply(verdict: Verdict): OpencodeV2PermissionReply | null {
  switch (verdict.kind) {
    case 'allowOnce':
      return 'once';
    case 'allowAlways':
      return 'always';
    case 'deny':
      return 'reject';
    case 'answer':
    case 'abstain':
      return null;
  }
}

/** The instance's server and its password, or why a request cannot be made. */
function serverOf(
  target: AgentInstanceRef
): { port: number; password: string } | { reason: 'no-port' | 'no-password' } {
  const port = getAssignedOpencodeV2Port(target);
  if (port === null) return { reason: 'no-port' };
  const password = readOpencodeV2Password(target);
  if (password === null) return { reason: 'no-password' };
  return { port, password };
}

/**
 * Send a verdict to the instance's server (Issue #2945).
 *
 * An approval goes to `…/permission/{requestID}/reply` as `{decision}`; a
 * question to `…/form/{formID}/reply` as `{answer}`, built from the form the
 * pending decision was read from. Both URLs name the session, which is the
 * decision's `conversationId`. Every outcome is recorded with
 * `recordDecisionDelivery`, so the caller knows whether anybody is still
 * blocked.
 */
async function decideOpencodeV2(
  target: AgentInstanceRef,
  decision: PendingDecision,
  verdict: Verdict
): Promise<void> {
  const instanceId = target.instanceId ?? target.cliToolId;
  const undelivered = (reason: string): void => {
    logger.info('opencode-v2-verdict-undelivered', {
      worktreeId: target.worktreeId,
      instanceId,
      decisionId: decision.id,
      verdict: verdict.kind,
      reason,
    });
    recordDecisionDelivery(target, decision.id, { delivered: false, reason });
  };

  // Silence is an action here, as on v1: the agent waits with no timeout.
  if (verdict.kind === 'abstain') return undelivered('abstained');
  const sessionId = decision.conversationId;
  if (!sessionId) return undelivered('no-session');
  const server = serverOf(target);
  if ('reason' in server) return undelivered(server.reason);

  if (decision.kind === 'question') {
    if (verdict.kind !== 'answer') return undelivered('question-needs-answer-verdict');
    const answer = buildOpencodeV2FormAnswer(decision.raw, verdict.answers);
    if (answer === null) return undelivered('form-answer-does-not-fit');
    const delivered = await replyOpencodeV2Form(
      server.port,
      server.password,
      sessionId,
      decision.id,
      answer
    );
    logger.info('opencode-v2-form-replied', {
      worktreeId: target.worktreeId,
      instanceId,
      decisionId: decision.id,
      delivered,
    });
    recordDecisionDelivery(target, decision.id, {
      delivered,
      reason: delivered ? 'form-reply' : 'form-reply-failed',
    });
    return;
  }

  const reply = toOpencodeV2PermissionReply(verdict);
  if (reply === null) return undelivered('no-wire-value');
  const delivered = await replyOpencodeV2Permission(
    server.port,
    server.password,
    sessionId,
    decision.id,
    reply,
    verdict.kind === 'deny' ? verdict.message : undefined
  );
  logger.info('opencode-v2-permission-replied', {
    worktreeId: target.worktreeId,
    instanceId,
    decisionId: decision.id,
    reply,
    delivered,
  });
  recordDecisionDelivery(target, decision.id, {
    delivered,
    reason: delivered ? `permission-reply:${reply}` : 'permission-reply-failed',
  });
}

/**
 * What the instance's server is waiting on a human for (Issue #2945).
 *
 * Read from the server itself — `GET /api/permission/request` and
 * `GET /api/form` — so an id the `/respond` route is asked about is checked
 * against the agent's own lists, not against what the stream happened to
 * deliver. The server is the instance's alone, so both lists are this
 * instance's. An unreachable server answers an empty list, as v1 does.
 */
async function listOpencodeV2Pending(target: AgentInstanceRef): Promise<PendingDecision[]> {
  const server = serverOf(target);
  if ('reason' in server) return [];
  const askedAt = Date.now();
  const [permissions, forms] = await Promise.all([
    fetchOpencodeV2PendingPermissions(server.port, server.password),
    fetchOpencodeV2PendingForms(server.port, server.password),
  ]);
  const pending: PendingDecision[] = [];
  for (const entry of permissions ?? []) {
    if (!isPlainObject(entry)) continue;
    const decision = toOpencodeV2PendingPermission(entry, askedAt);
    if (decision) pending.push(decision);
  }
  for (const entry of forms ?? []) {
    if (!isPlainObject(entry)) continue;
    const decision = toOpencodeV2PendingQuestion(entry, askedAt);
    if (decision) pending.push(decision);
  }
  return pending;
}

export const opencodeV2AgentEventSource: AgentEventSource = definePullEventSource({
  cliToolId: OPENCODE_V2_CLI_TOOL_ID,
  noDecision: { kind: 'blocks' },
  capabilities: {
    supportedEvents: ['user_prompt_submit', 'stop', 'notification'],
    configScope: 'none',
    decisionTimeoutSeconds: null,
    permissionHookPredictsDialog: false,
    sessionStartMayArriveLate: false,
    permissionReplyReleasesPrompt: true,
    // Issue #2945: `per_…` / `frm_…`, the id the reply URL takes and the one
    // `permission.replied` / `form.replied` settle. Moves together with
    // `extractEventIdentity` below.
    eventIdentity: 'permission-id',
    resync: 'none',
    // Issue #2940: the subscription writes each finished turn from
    // `GET /api/session/{id}/message` (`./history`), so the scraper stands
    // down while it is live.
    transcriptHistory: 'push',
    stopReportsSelfResume: false,
  },
  mappers: OPENCODE_V2_MAPPERS,
  nativeEventNameFields: ['type'],
  conversationIdFields: [],
  extractModel: () => null,
  extractEventIdentity: opencodeV2EventIdentity,
  extractDetail: () => null,
  parsePermissionRequest: parseOpencodeV2PermissionRequest,
  // `form.created` carries the form as `data.form`; when a frame does not, the
  // ingest reads it from `GET /api/session/{id}/form`.
  parseQuestion: parseOpencodeV2Form,
  subscribe: async (target, onEvent) => {
    const port = getAssignedOpencodeV2Port(target);
    if (port === null) return { close: async () => {}, liveness: { state: 'unknown' } };
    return openOpencodeV2Subscription(target, port, onEvent, (raw) =>
      opencodeV2AgentEventSource.normalizeEvent(raw)
    );
  },
  decide: decideOpencodeV2,
  listPending: listOpencodeV2Pending,
  probeActivity: async () => null,
  liveness: (target: AgentInstanceRef): SourceLiveness => getOpencodeV2Liveness(target),
  prepareLaunch: prepareOpencodeV2Launch,
});

