/**
 * relays Command - the standing delegations this machine is holding (#2377)
 *
 *   commandmate relays [--worktree <id>] [--instance <id|alias>] [--json]
 *   commandmate relays --id <relay-id> [--json]   (Issue #3957: one relay, open or closed)
 *   commandmate relays cancel <relay-id>
 *   commandmate relays resolve <relay-id> --payload <id> --attempt <id> --confirm|--retry|--discard
 *     (Issue #4082: settle a delivery held as uncertain)
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
  RelayGetResponse,
  RelayListResponse,
  RelayResolveResponse,
  RelayView,
} from '../types/api-responses';
import { ApiClient, ApiError, isValidWorktreeId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { resolveSessionTarget } from '../utils/session-target';
import { paneCaptureCommand } from '../utils/follow-up-command';
import type { CommandTarget } from './command-target';
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

/** A relay {@link registerRelay} opened (Issue #3957). */
export interface RegisteredRelay {
  id: string;
  /**
   * The server confirmed `bindMode: 'bound'`: the relay id goes on the send,
   * and only that send's reply is delivered. False on an older server.
   */
  bound: boolean;
}

/** The one line an older server's relay gets on stderr (Issue #3957). */
export const LEGACY_RELAY_NOTICE =
  'Note: this server does not tie a relay to its send (legacy handling); '
  + 'the reply is taken from the first turn that ends after the relay was opened.';

/**
 * Open a relay, printing the server's own refusal and exiting 2 on one.
 *
 * Exit 2 and not a bespoke code: every refusal is a decision the operator can
 * change (drop the flag, cancel the other relay, stop forwarding), which is what
 * `CONFIG_ERROR` means everywhere else in this CLI.
 *
 * Issue #3957: asks for `bind: true` and believes it only when the answer says
 * `bindMode: 'bound'`. A server that does not know the flag answers without
 * the key; the relay is then the legacy kind and its id is not sent along.
 *
 * @returns The relay id, and whether it is bound
 */
export async function registerRelay(
  client: ApiClient,
  input: RegisterRelayInput
): Promise<RegisteredRelay> {
  try {
    const response = await client.post<RelayCreateResponse>('/api/relays', {
      from: input.from,
      to: input.to,
      allowRelayChain: input.allowRelayChain === true,
      bind: true,
    });
    const bound = (response.bindMode ?? response.relay.bindMode) === 'bound';
    if (!bound) console.error(LEGACY_RELAY_NOTICE);
    return { id: response.relay.id, bound };
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
  } catch (error) {
    // #3732: not withdrawable because its payload is going out right now, so
    // "it will expire" would be wrong — it will arrive.
    if (error instanceof ApiError && error.apiCode === 'RELAY_DELIVERING') {
      console.error(`Warning: relay ${relayId} is already being delivered and was not withdrawn.`);
      return;
    }
    console.error(`Warning: could not withdraw relay ${relayId}; it will expire on its own.`);
  }
}

/**
 * Print where a relay whose send could not be confirmed stands (Issue #3957).
 *
 * The relay is left open — withdrawing it would drop a reply that may well be
 * on its way — and the message is not resent, which could make it arrive twice.
 */
export function printRelayUnconfirmedNotice(relayId: string, worktreeId?: string, target?: CommandTarget): void {
  // Issue #3992: a failed send names the pane to look at before any resend, in
  // the same line rather than a second notice. Issue #3982: the target's pane.
  const resend = worktreeId === undefined
    ? ''
    : ` Do not resend before checking the pane (\`${paneCaptureCommand(worktreeId, target)}\`), or it may arrive twice.`;
  console.error(
    `Warning: whether the message reached the session is not known; relay ${relayId} was left open `
    + 'and the message was not resent. '
    + `Check it with \`commandmate relays --id ${relayId}\`.${resend}`
  );
}

function endpointLabel(endpoint: { worktreeId: string; instanceId: string }): string {
  return `${endpoint.worktreeId}/${endpoint.instanceId}`;
}

function printRelayLine(relay: RelayView): void {
  const fields = [
    relay.id,
    relay.state,
    `${endpointLabel(relay.from)} <- ${endpointLabel(relay.to)}`,
    `hops=${relay.hops}`,
    `expires=${new Date(relay.expiresAt).toISOString()}`,
  ];
  // Issue #3957: a bound relay's send state, overlap and hold reason, when it
  // has them. Absent on a legacy relay and on an older server.
  if (relay.sendState) fields.push(`send=${relay.sendState}`);
  if (relay.overlap) fields.push(`overlap=${relay.overlap}`);
  if (relay.holdReason) fields.push(`hold=${relay.holdReason}`);
  // Issue #4064: a payload whose delivery may have reached the requester. It
  // is never resent automatically; the pane named is where to look.
  const delivery = relay.deliveryHold;
  if (delivery) {
    fields.push(`delivery=${delivery.state}`);
    if (delivery.kind) fields.push(`payload=${delivery.kind}:${delivery.payloadId ?? '-'}`);
    // Issue #4082: what `relays resolve --attempt` names. Absent on an older server.
    if (delivery.attemptId) fields.push(`attempt=${delivery.attemptId}`);
    if (delivery.reason) fields.push(`reason=${delivery.reason}`);
    fields.push(`check=${delivery.checkCommand}`);
  }
  console.log(fields.join('\t'));
}

interface RelaysOptions {
  worktree?: string;
  instance?: string;
  id?: string;
  json?: boolean;
  token?: string;
}

/** `relays --id <id>`: one relay, whatever its state (Issue #3957). */
/**
 * `--json` / `--token` of a `relays` subcommand, the parent's included.
 *
 * The parent `relays` declares both options too, and commander gives an
 * option the parent knows to the parent — `relays --token T resolve …`, and
 * `relays resolve … --json` likewise — so the subcommand's own `options` never
 * see it and a token would fall back to `CM_AUTH_TOKEN`. The subcommand's own
 * value wins when both are given.
 */
function subcommandGlobals(
  options: { json?: boolean; token?: string },
  command: Command
): { json: boolean; token: string | undefined } {
  const all = command.optsWithGlobals<{ json?: boolean; token?: string }>();
  return { json: options.json === true || all.json === true, token: options.token ?? all.token };
}

async function showOneRelay(client: ApiClient, relayId: string, json: boolean): Promise<void> {
  const response = await client.get<RelayGetResponse>(`/api/relays/${relayId}`);
  if (json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  printRelayLine(response.relay);
}

/** `relays resolve`'s options (Issue #4082). */
interface RelayResolveOptions {
  payload: string;
  attempt: string;
  confirm?: boolean;
  retry?: boolean;
  discard?: boolean;
  json?: boolean;
  token?: string;
}

type RelayHoldActionArg = 'confirm' | 'retry' | 'discard';

/** The codes `POST /api/relays/:id/resolve` refuses with (409). Mirrors the route. */
const RELAY_HOLD_REFUSAL_CODES = new Set([
  'RELAY_HOLD_NOT_FOUND',
  'RELAY_HOLD_ATTEMPTING',
  'RELAY_HOLD_STALE',
  'RELAY_HOLD_NOT_ALLOWED',
]);

/** The one action given, or null when none or more than one was. */
function resolveAction(options: RelayResolveOptions): RelayHoldActionArg | null {
  const given = (['confirm', 'retry', 'discard'] as const).filter((action) => options[action] === true);
  return given.length === 1 ? given[0] : null;
}

/** What each action prints. `retry` says queued, never delivered. */
const RESOLVED_MESSAGES: Record<RelayHoldActionArg, (relayId: string, response: RelayResolveResponse) => string> = {
  confirm: (relayId, response) =>
    `Relay ${relayId}: the held payload is recorded as delivered (relay is ${response.relay.state}).`,
  retry: (relayId) =>
    `Relay ${relayId}: the held payload is queued for delivery again (not delivered yet). `
    + `Follow it with \`commandmate relays --id ${relayId}\`.`,
  discard: (relayId, response) =>
    `Relay ${relayId}: the held payload was discarded without sending (relay is ${response.relay.state}).`,
};

export function createRelaysCommand(): Command {
  const cmd = new Command('relays');
  cmd
    .description('List the open relays this session is waiting on and owes')
    .option('--worktree <id>', 'Worktree to list (defaults to the session running this command)')
    .option('--instance <id>', 'Agent instance inside --worktree (id or roster alias)')
    .option('--id <relay-id>', 'Show one relay, open or closed (its send state, overlap and hold reason)')
    .option('--json', 'JSON output')
    .option('--token <token>', TOKEN_WARNING)
    .addHelpText('after', `
Columns: <relay-id>  <state>  <requester> <- <worker>  hops=<n>  expires=<iso>
         [send=<state>]  [overlap=<none|later|earlier|both|unknown>]  [hold=<reason>]
         [delivery=<attempting|uncertain>  payload=<kind>:<id>  attempt=<id>  reason=<r>  check=<cmd>]

States: pending (the worker has not finished), prompt (it stopped on a
confirmation and the requester was told), delivered / expired / cancelled.

send= / overlap= / hold= appear on a relay tied to its send (Issue #3957):
send= is awaiting / input_started / sent / failed / unknown; hold= says why a
relay is not being answered (send_unknown, dispatch_unknown, generation_changed,
server_restarted, ...); overlap= says the reply may share a turn with another
request (unknown is not "none"). \`--id <relay-id>\` shows one relay even after
it closed.

delivery= (Issue #4064) marks a payload whose delivery to the requester may
have happened (uncertain: indeterminate, failed after it was sent, or the
server restarted mid-send). It is NOT resent automatically and the relay's
later payloads wait behind it. Look at the pane check= names first. Cancelling
the relay stops later deliveries; it cannot take back what may already be in
the requester's composer.

Settle an uncertain hold (Issue #4082) after looking at that pane:
  commandmate relays resolve <relay-id> --payload <id> --attempt <id> --confirm
  (it arrived), --retry (it did not: queue it again, sent once when the
  requester can take it), or --discard (drop it, send nothing).

Withdraw one with \`commandmate relays cancel <relay-id>\`.
`)
    .action(async (options: RelaysOptions) => {
      try {
        if (options.id !== undefined) {
          if (!RELAY_ID_PATTERN.test(options.id)) {
            console.error('Error: Invalid relay ID format.');
            process.exit(ExitCode.CONFIG_ERROR);
          }
          await showOneRelay(new ApiClient({ token: options.token }), options.id, options.json === true);
          return;
        }
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

        // Issue #4064: listed even when no relay is open — a held payload's
        // relay may have expired or been cancelled since.
        const held = response.held ?? [];
        if (held.length > 0) {
          console.error(`# delivery not confirmed, not resent (${held.length})`);
          held.forEach(printRelayLine);
        }
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
    .description('Withdraw an open relay and stop its later deliveries (a delivery already held as uncertain may have reached you)')
    .argument('<relay-id>', 'Relay ID')
    .option('--json', 'JSON output')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (relayId: string, options: { json?: boolean; token?: string }, command: Command) => {
      try {
        const { json, token } = subcommandGlobals(options, command);
        if (!RELAY_ID_PATTERN.test(relayId)) {
          console.error('Error: Invalid relay ID format.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        const client = new ApiClient({ token });
        try {
          const response = await client.post<RelayCancelResponse>(
            `/api/relays/${relayId}/cancel`
          );
          if (json) {
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
          // The send is already under way (#3732): the payload is reaching the
          // requester as we speak, so this too is a cancel that did not happen.
          if (error instanceof ApiError && error.apiCode === 'RELAY_DELIVERING') {
            console.error(
              `Error: ${error.payload?.error ?? 'Relay is being delivered and can no longer be cancelled.'}`
            );
            process.exit(ExitCode.CONFIG_ERROR);
          }
          throw error;
        }
      } catch (error) {
        handleCommandError(error);
      }
    });

  cmd
    .command('resolve')
    .description('Settle a delivery held as uncertain (look at the requester\'s pane first): confirm, retry or discard it')
    .argument('<relay-id>', 'Relay ID')
    .requiredOption('--payload <id>', 'The held payload id (payload=<kind>:<id> in `relays --id`)')
    .requiredOption('--attempt <id>', 'The held attempt id (attempt=<id> in `relays --id`)')
    .option('--confirm', 'It reached the requester: record it as delivered (types nothing)')
    .option('--retry', 'It did not: queue it again; sent once when the requester can take it')
    .option('--discard', 'Drop it without sending (types nothing)')
    .option('--json', 'JSON output')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (relayId: string, options: RelayResolveOptions, command: Command) => {
      try {
        const { json, token } = subcommandGlobals(options, command);
        if (!RELAY_ID_PATTERN.test(relayId)) {
          console.error('Error: Invalid relay ID format.');
          process.exit(ExitCode.CONFIG_ERROR);
        }
        const action = resolveAction(options);
        if (action === null) {
          console.error('Error: give exactly one of --confirm, --retry or --discard.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        const client = new ApiClient({ token });
        try {
          const response = await client.post<RelayResolveResponse>(
            `/api/relays/${relayId}/resolve`,
            { payloadId: options.payload, attemptId: options.attempt, action }
          );
          if (json) {
            console.log(JSON.stringify(response, null, 2));
          } else {
            console.error(RESOLVED_MESSAGES[action](relayId, response));
            if (response.promoted) {
              console.error('  The reply that waited behind it is queued for delivery.');
            }
          }
        } catch (error) {
          // A stale, in-progress or not-allowed hold: nothing was changed, and
          // re-reading the relay is what the operator does next.
          if (error instanceof ApiError && error.apiCode && RELAY_HOLD_REFUSAL_CODES.has(error.apiCode)) {
            console.error(`Error: ${error.payload?.error ?? error.apiCode}`);
            console.error(`  Nothing was changed. Read it again with \`commandmate relays --id ${relayId}\`.`);
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
