/**
 * relays Command - the standing delegations this machine is holding (#2377)
 *
 *   commandmate relays [--worktree <id>] [--instance <id|alias>] [--json]
 *   commandmate relays cancel <relay-id>
 *
 * ## Why a command and not a flag on `ls`
 *
 * A relay is the one piece of state in CommandMate that belongs to TWO sessions
 * at once: session A is owed an answer, session B owes one, and neither
 * worktree's own listing can show that without inventing a column for the other
 * side. So the listing is its own thing, and it prints the pair — `from` and
 * `to`, `→` between them — rather than a status word per row.
 *
 * With no `--worktree` it asks the session it is running inside (`whoami`'s
 * resolution) and prints that session's two sides. That is the shape an agent
 * uses: "what am I waiting for, and what do I owe?" is a question about the
 * caller, and making the caller name itself is what #2376 exists to stop.
 *
 * ## What this module exports besides the command
 *
 * The `--reply-to` plumbing, because `send` and `ask` both take that flag and
 * both have to turn one string into the two ids the ledger stores. Keeping
 * {@link resolveRelayEndpoint} here rather than in `send.ts` is what stops the
 * two commands from resolving `self` two different ways.
 */

import { Command } from 'commander';
import { ExitCode } from '../types';
import type {
  RelayCancelResponse,
  RelayCreateResponse,
  RelayListResponse,
  RelayView,
} from '../types/api-responses';
import { ApiClient, ApiError, isValidWorktreeId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { resolveSessionTarget } from '../utils/session-target';
import {
  isInstanceSelector,
  INSTANCE_SELECTOR_ERROR,
  resolveInstanceTarget,
} from './instances';
import { NOT_IN_SESSION_MESSAGE, resolveSessionIdentity } from './whoami';

/** crypto.randomUUID() output; mirrors RELAY_ID_PATTERN in the API route. */
const RELAY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `--reply-to` values that mean "the session running this command". */
const SELF_SELECTORS = new Set(['self', 'me']);

/**
 * The codes `POST /api/relays` refuses with.
 *
 * Mirrors `RelayRefusalCode` in `lib/relay/relay-policy` plus the route's own
 * not-found; duplicated rather than imported so the CLI bundle does not pull the
 * server's database graph in for four strings.
 */
export const RELAY_REFUSAL_CODES = new Set([
  'RELAY_CHAIN_BLOCKED',
  'RELAY_HOPS_EXCEEDED',
  'RELAY_DUPLICATE_PENDING',
  'RELAY_SELF_TARGET',
  'RELAY_WORKTREE_NOT_FOUND',
]);

/** One end of a relay, as the API wants it. */
export interface RelayEndpointArg {
  worktreeId: string;
  instanceId: string;
}

/** The text `--reply-to` is documented with, shared by `send` and `ask`. */
export const REPLY_TO_OPTION_DESCRIPTION =
  'Deliver the target\'s reply to this session when it finishes: '
  + '<worktree-id>[@<instance-id|alias>], or `self` for the session running this command';

/** The text `--allow-relay-chain` is documented with. */
export const ALLOW_RELAY_CHAIN_DESCRIPTION =
  'Permit a relay opened while answering a relayed message (refused by default; '
  + 'chains still stop at 3 hops)';

/**
 * Turn one `--reply-to` value into the two ids the ledger stores.
 *
 * Exits 2 rather than throwing: every failure here is a bad option value or a
 * shell that is not inside a CommandMate session, and both are things the
 * operator fixes on the command line.
 *
 * @param client - API client
 * @param spec - The raw `--reply-to` value
 */
export async function resolveRelayEndpoint(
  client: ApiClient,
  spec: string
): Promise<RelayEndpointArg> {
  if (SELF_SELECTORS.has(spec.trim().toLowerCase())) {
    const identity = await resolveSessionIdentity(client);
    if (!identity) {
      console.error(NOT_IN_SESSION_MESSAGE);
      console.error('  --reply-to self needs an identity; name the session explicitly instead.');
      process.exit(ExitCode.CONFIG_ERROR);
    }
    return { worktreeId: identity.worktreeId, instanceId: identity.instanceId };
  }

  const at = spec.indexOf('@');
  const worktreeId = at === -1 ? spec : spec.slice(0, at);
  const selector = at === -1 ? undefined : spec.slice(at + 1);

  if (!isValidWorktreeId(worktreeId)) {
    console.error('Error: --reply-to must start with a valid worktree ID.');
    process.exit(ExitCode.CONFIG_ERROR);
  }
  if (selector !== undefined && !isInstanceSelector(selector)) {
    console.error(`Error: --reply-to instance part: ${INSTANCE_SELECTOR_ERROR}`);
    process.exit(ExitCode.CONFIG_ERROR);
  }

  return resolveEndpointForWorktree(client, worktreeId, selector);
}

/**
 * The resolved endpoint for a worktree, with or without a named instance.
 *
 * Also what `send` / `ask` use for the relay's OTHER end — the session being
 * asked — because the ledger stores a resolved id at both ends and the send's
 * own `--instance` may have been omitted (meaning "the primary one", which only
 * the server can name).
 *
 * @param client - API client
 * @param worktreeId - Worktree ID
 * @param selector - An instance id or roster alias, or undefined
 * @param requestedAgent - The `--agent` value, if the caller gave one
 */
export async function resolveEndpointForWorktree(
  client: ApiClient,
  worktreeId: string,
  selector: string | undefined,
  requestedAgent?: string
): Promise<RelayEndpointArg> {
  if (selector !== undefined) {
    const target = await resolveInstanceTarget(client, worktreeId, selector, requestedAgent);
    const instanceId = target.instanceId;
    if (!instanceId) {
      console.error(`Error: could not resolve instance '${selector}' in ${worktreeId}.`);
      process.exit(ExitCode.CONFIG_ERROR);
    }
    return { worktreeId, instanceId };
  }

  // No instance named: the server's own default for the worktree, which for a
  // roster of one is that tool's primary instance. Asked rather than assumed —
  // the CLI guessing `claude` is exactly the second authority #1925 removed.
  const target = await resolveSessionTarget(client, worktreeId, {
    requestedCliTool: requestedAgent,
  });
  const instanceId = target.instanceId ?? target.cliToolId;
  if (!instanceId) {
    console.error(
      `Error: ${worktreeId} declares no agent, so --reply-to cannot name one of its sessions. `
      + 'Use <worktree-id>@<instance-id>.'
    );
    process.exit(ExitCode.CONFIG_ERROR);
  }
  return { worktreeId, instanceId };
}

/** What {@link registerRelay} needs. */
export interface RegisterRelayInput {
  /** The session that will receive the reply. */
  from: RelayEndpointArg;
  /** The session being asked. */
  to: RelayEndpointArg;
  allowRelayChain?: boolean;
}

/**
 * Open a relay, printing the server's own refusal and exiting 2 on one.
 *
 * Exit 2 and not a bespoke code: every refusal is a decision the operator can
 * change (drop the flag, cancel the other relay, stop forwarding), which is what
 * `CONFIG_ERROR` means everywhere else in this CLI.
 *
 * @returns The relay id
 */
export async function registerRelay(
  client: ApiClient,
  input: RegisterRelayInput
): Promise<string> {
  try {
    const response = await client.post<RelayCreateResponse>('/api/relays', {
      from: input.from,
      to: input.to,
      allowRelayChain: input.allowRelayChain === true,
    });
    return response.relay.id;
  } catch (error) {
    if (error instanceof ApiError && error.apiCode && RELAY_REFUSAL_CODES.has(error.apiCode)) {
      console.error(`Error: ${error.payload?.error ?? error.apiCode}`);
      process.exit(ExitCode.CONFIG_ERROR);
    }
    throw error;
  }
}

/** Withdraw a relay, best effort. Used when the send it accompanied failed. */
export async function cancelRelayQuietly(client: ApiClient, relayId: string): Promise<void> {
  try {
    await client.post<RelayCancelResponse>(`/api/relays/${relayId}/cancel`);
  } catch {
    console.error(`Warning: could not withdraw relay ${relayId}; it will expire on its own.`);
  }
}

function endpointLabel(endpoint: { worktreeId: string; instanceId: string }): string {
  return `${endpoint.worktreeId}/${endpoint.instanceId}`;
}

function printRelayLine(relay: RelayView): void {
  console.log(
    [
      relay.id,
      relay.state,
      `${endpointLabel(relay.from)} <- ${endpointLabel(relay.to)}`,
      `hops=${relay.hops}`,
      `expires=${new Date(relay.expiresAt).toISOString()}`,
    ].join('\t')
  );
}

interface RelaysOptions {
  worktree?: string;
  instance?: string;
  json?: boolean;
  token?: string;
}

export function createRelaysCommand(): Command {
  const cmd = new Command('relays');
  cmd
    .description('List the open relays this session is waiting on and owes')
    .option('--worktree <id>', 'Worktree to list (defaults to the session running this command)')
    .option('--instance <id>', 'Agent instance inside --worktree (id or roster alias)')
    .option('--json', 'JSON output')
    .option('--token <token>', TOKEN_WARNING)
    .addHelpText('after', `
Columns: <relay-id>  <state>  <requester> <- <worker>  hops=<n>  expires=<iso>

States: pending (the worker has not finished), prompt (it stopped on a
confirmation and the requester was told), delivered / expired / cancelled.

Withdraw one with \`commandmate relays cancel <relay-id>\`.
`)
    .action(async (options: RelaysOptions) => {
      try {
        if (options.worktree && !isValidWorktreeId(options.worktree)) {
          console.error('Error: Invalid worktree ID format.');
          process.exit(ExitCode.CONFIG_ERROR);
        }
        if (options.instance && !isInstanceSelector(options.instance)) {
          console.error(INSTANCE_SELECTOR_ERROR);
          process.exit(ExitCode.CONFIG_ERROR);
        }

        const client = new ApiClient({ token: options.token });

        let endpoint: RelayEndpointArg | null = null;
        if (options.worktree) {
          endpoint = await resolveEndpointForWorktree(
            client,
            options.worktree,
            options.instance
          );
        } else {
          const identity = await resolveSessionIdentity(client);
          if (identity) {
            endpoint = { worktreeId: identity.worktreeId, instanceId: identity.instanceId };
          }
        }

        const query = new URLSearchParams();
        if (endpoint) {
          query.set('worktree', endpoint.worktreeId);
          query.set('instance', endpoint.instanceId);
        }
        const qs = query.toString();
        const response = await client.get<RelayListResponse>(
          `/api/relays${qs ? `?${qs}` : ''}`
        );

        if (options.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }

        if (!endpoint) {
          console.error(
            'Not inside a CommandMate agent session and no --worktree given; '
            + 'printing counts only.'
          );
        }
        const { counts } = response;
        console.error(
          `relays: pending=${counts.pending} prompt=${counts.prompt} `
          + `delivered=${counts.delivered} expired=${counts.expired} cancelled=${counts.cancelled}`
        );

        if (response.awaiting.length === 0 && response.owed.length === 0) {
          console.error('No open relays.');
          return;
        }
        if (response.awaiting.length > 0) {
          console.error(`# waiting for (${response.awaiting.length})`);
          response.awaiting.forEach(printRelayLine);
        }
        if (response.owed.length > 0) {
          console.error(`# owed by me (${response.owed.length})`);
          response.owed.forEach(printRelayLine);
        }
      } catch (error) {
        handleCommandError(error);
      }
    });

  cmd
    .command('cancel')
    .description('Withdraw an open relay so its reply is never delivered')
    .argument('<relay-id>', 'Relay ID')
    .option('--json', 'JSON output')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (relayId: string, options: { json?: boolean; token?: string }) => {
      try {
        if (!RELAY_ID_PATTERN.test(relayId)) {
          console.error('Error: Invalid relay ID format.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        const client = new ApiClient({ token: options.token });
        try {
          const response = await client.post<RelayCancelResponse>(
            `/api/relays/${relayId}/cancel`
          );
          if (options.json) {
            console.log(JSON.stringify(response, null, 2));
          } else {
            console.error(`Relay ${relayId} cancelled.`);
          }
        } catch (error) {
          // A relay that already delivered is not a failure to report as one:
          // saying "cancelled" would tell the caller they stopped a delivery
          // that in fact happened.
          if (error instanceof ApiError && error.apiCode === 'RELAY_ALREADY_CLOSED') {
            console.error(`Error: ${error.payload?.error ?? 'Relay is already closed.'}`);
            process.exit(ExitCode.CONFIG_ERROR);
          }
          throw error;
        }
      } catch (error) {
        handleCommandError(error);
      }
    });

  return cmd;
}
