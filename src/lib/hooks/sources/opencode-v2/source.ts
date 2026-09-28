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
 * Phase 1 publishes state only. `decide` / `listPending` are inert and
 * `eventIdentity` is null, so no surface offers a structured answer to an
 * approval or a question yet — the human answers in the TUI (Phase 2 adds the
 * approval UI and `…/permission/{id}/reply`).
 *
 * @module lib/hooks/sources/opencode-v2/source
 */

import { existsSync } from 'fs';
import { resolve } from 'path';
import { shellQuote } from '@/lib/hooks/hook-settings-generator';
import { createLogger } from '@/lib/logger';
import { definePullEventSource } from '../define-source';
import { recordDecisionDelivery } from '../pending-decisions';
import type {
  AgentEventSource,
  AgentInstanceRef,
  AgentLaunchContext,
  AgentLaunchPlan,
  PendingDecision,
  SourceLiveness,
} from '../types';
import { OPENCODE_V2_MAPPERS } from './mappers';
import { getAssignedOpencodeV2Port } from './ports';
import { getOpencodeV2PasswordFilePath } from './secrets';
import {
  getOpencodeV2Liveness,
  openOpencodeV2Subscription,
} from './subscription';
import { OPENCODE_V2_CLI_TOOL_ID } from './tool-id';

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
  if (script === null || !existsSync(passwordFile)) {
    logger.warn('opencode-v2-launch-degraded-to-standalone', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      reason: script === null ? 'launch-script-missing' : 'password-file-missing',
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

async function decideOpencodeV2(
  target: AgentInstanceRef,
  decision: PendingDecision
): Promise<void> {
  // Phase 2. Recorded as undelivered so nothing waits for an answer that was
  // never sent; the human answers in the TUI.
  recordDecisionDelivery(target, decision.id, {
    delivered: false,
    reason: 'opencode-v2-structured-answers-not-supported',
  });
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
    eventIdentity: null,
    resync: 'none',
    transcriptHistory: null,
    stopReportsSelfResume: false,
  },
  mappers: OPENCODE_V2_MAPPERS,
  nativeEventNameFields: ['type'],
  conversationIdFields: [],
  extractModel: () => null,
  extractEventIdentity: () => null,
  extractDetail: () => null,
  parsePermissionRequest: () => null,
  parseQuestion: () => null,
  subscribe: async (target, onEvent) => {
    const port = getAssignedOpencodeV2Port(target);
    if (port === null) return { close: async () => {}, liveness: { state: 'unknown' } };
    return openOpencodeV2Subscription(target, port, onEvent, (raw) =>
      opencodeV2AgentEventSource.normalizeEvent(raw)
    );
  },
  decide: decideOpencodeV2,
  listPending: async () => [],
  probeActivity: async () => null,
  liveness: (target: AgentInstanceRef): SourceLiveness => getOpencodeV2Liveness(target),
  prepareLaunch: prepareOpencodeV2Launch,
});

