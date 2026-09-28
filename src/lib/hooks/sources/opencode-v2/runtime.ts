/**
 * The calls `cli-tools/opencode-v2.ts` makes around a pane's life
 * (Issue #2934).
 *
 *  - {@link reserveOpencodeV2Server} before the launch line is built: a port
 *    and a fresh password file, which `prepareOpencodeV2Launch` turns into the
 *    wrapper's arguments;
 *  - {@link attachOpencodeV2EventStream} once the TUI is up;
 *  - {@link resumeOpencodeV2EventStream} for a pane that outlived a CommandMate
 *    restart;
 *  - {@link releaseOpencodeV2Server} when the pane is killed: subscription,
 *    port assignment and password file, all three.
 *
 * Every one of them is fail-open. A pane that runs without structured events is
 * still driven by the screen scraper.
 *
 * @module lib/hooks/sources/opencode-v2/runtime
 */

import { createLogger } from '@/lib/logger';
import type { AgentInstanceRef } from '../types';
import { probeOpencodeV2Server } from './client';
import { ingestOpencodeV2Event } from './ingest';
import {
  allocateOpencodeV2Port,
  forgetOpencodeV2Port,
  getAssignedOpencodeV2Port,
  recoverOpencodeV2Port,
} from './ports';
import {
  readOpencodeV2Password,
  removeOpencodeV2Password,
  writeOpencodeV2Password,
} from './secrets';
import { opencodeV2AgentEventSource } from './source';
import { closeOpencodeV2Subscription, isOpencodeV2Subscribed } from './subscription';
import { OPENCODE_V2_CLI_TOOL_ID } from './tool-id';

const logger = createLogger('lib/hooks/sources/opencode-v2/runtime');

/** Waits before each health probe of a freshly started server. */
export const OPENCODE_V2_ATTACH_PROBE_DELAYS_MS: readonly number[] = [0, 500, 1_000, 2_000];

/** The instance reference every OpenCode V2 call keys off. */
export function opencodeV2Target(worktreeId: string, instanceId?: string): AgentInstanceRef {
  return { worktreeId, cliToolId: OPENCODE_V2_CLI_TOOL_ID, instanceId };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reserve a port and write a fresh password file for one launch.
 *
 * @returns The port, or null when either could not be had — the launch line
 *   then degrades to `--standalone` (see `prepareOpencodeV2Launch`)
 */
export async function reserveOpencodeV2Server(
  target: AgentInstanceRef,
  worktreePath: string
): Promise<number | null> {
  try {
    const port = await allocateOpencodeV2Port(target, worktreePath);
    if (port === null) return null;
    writeOpencodeV2Password(target);
    return port;
  } catch (error) {
    logger.warn('opencode-v2-server-reserve-failed', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      error: errorMessage(error),
    });
    return null;
  }
}

/** Whether the server on `port` accepts the instance's current password. */
export async function isOpencodeV2ServerOurs(
  target: AgentInstanceRef,
  port: number
): Promise<boolean> {
  const password = readOpencodeV2Password(target);
  if (password === null) return false;
  return (await probeOpencodeV2Server(port, password)).kind === 'healthy';
}

/**
 * Subscribe to the instance's server.
 *
 * @returns Whether a subscription is open afterwards
 */
export async function attachOpencodeV2EventStream(target: AgentInstanceRef): Promise<boolean> {
  try {
    const port = getAssignedOpencodeV2Port(target);
    if (port === null) return false;
    if (isOpencodeV2Subscribed(target)) return true;

    let healthy = false;
    for (const waitMs of OPENCODE_V2_ATTACH_PROBE_DELAYS_MS) {
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      if (await isOpencodeV2ServerOurs(target, port)) {
        healthy = true;
        break;
      }
    }
    if (!healthy) {
      logger.info('opencode-v2-server-not-reachable', {
        worktreeId: target.worktreeId,
        instanceId: target.instanceId ?? target.cliToolId,
        port,
      });
      return false;
    }

    await opencodeV2AgentEventSource.subscribe(target, (event) => {
      void ingestOpencodeV2Event(target, event);
    });
    logger.info('opencode-v2-event-stream-attached', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      port,
    });
    return true;
  } catch (error) {
    logger.warn('opencode-v2-event-stream-attach-failed', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      error: errorMessage(error),
    });
    return false;
  }
}

/**
 * Re-subscribe to a server that outlived a CommandMate restart, from the
 * persisted port and the password file on disk.
 *
 * @returns Whether a subscription is open afterwards
 */
export async function resumeOpencodeV2EventStream(
  target: AgentInstanceRef,
  worktreePath: string
): Promise<boolean> {
  try {
    if (isOpencodeV2Subscribed(target)) return true;
    const port = await recoverOpencodeV2Port(target, worktreePath, (candidate) =>
      isOpencodeV2ServerOurs(target, candidate)
    );
    if (port === null) return false;
    return await attachOpencodeV2EventStream(target);
  } catch (error) {
    logger.warn('opencode-v2-event-stream-resume-failed', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      error: errorMessage(error),
    });
    return false;
  }
}

/**
 * Let go of everything the instance held: the subscription, the port
 * assignment and the password file.
 */
export async function releaseOpencodeV2Server(target: AgentInstanceRef): Promise<void> {
  try {
    await closeOpencodeV2Subscription(target);
  } catch (error) {
    logger.warn('opencode-v2-subscription-close-failed', {
      worktreeId: target.worktreeId,
      error: errorMessage(error),
    });
  }
  try {
    forgetOpencodeV2Port(target);
  } catch (error) {
    logger.warn('opencode-v2-port-forget-failed', {
      worktreeId: target.worktreeId,
      error: errorMessage(error),
    });
  }
  try {
    removeOpencodeV2Password(target);
  } catch (error) {
    logger.warn('opencode-v2-password-remove-failed', {
      worktreeId: target.worktreeId,
      error: errorMessage(error),
    });
  }
}
