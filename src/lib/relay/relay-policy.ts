/**
 * The four rules that stop relays from becoming a loop (Issue #2377).
 *
 * A relay is a standing instruction that fires on somebody else's turn, so the
 * failure mode it introduces is not "a wrong answer" but "two agents talking to
 * each other forever, each one's reply being the other's next prompt". None of
 * the guards below is expensive; all four exist because the cheap version of
 * this feature has no natural stopping point.
 *
 *  1. **A relayed message may not open a relay** (`RELAY_CHAIN_BLOCKED`). The
 *     default. `--allow-relay-chain` is the deliberate override, and the flag is
 *     named after what it permits rather than after what it disables.
 *  2. **Chains are bounded** (`RELAY_HOPS_EXCEEDED`). Even with the override,
 *     depth stops at {@link MAX_RELAY_HOPS}. Issue #4420: so are round trips —
 *     a session that opens relay after relay, each right after the reply to its
 *     own previous one, with nothing typed in between, stops at
 *     {@link MAX_RELAY_ROUNDS} (same code, its own sentence; the flag does not
 *     lift it either). The reply to a relay the session opened is NOT a relayed
 *     request for rule 1 — answering it is the session's own next step.
 *  3. **One open relay per direction** (`RELAY_DUPLICATE_PENDING`). A second
 *     standing instruction from A to B says nothing the first does not, and both
 *     would fire on the same finished turn.
 *  4. **A session may not relay to itself** (`RELAY_SELF_TARGET`), which is a
 *     one-message loop with no second party in it at all.
 *
 * And one rule that is not about loops (Issue #4437): **a relay may not have
 * antigravity at either end** while no API-key / enterprise use is declared
 * (`RELAY_TOOL_POLICY_DENIED`, Google Antigravity terms §6). A relay is an agent
 * driving another agent through CommandMate, which is what the consumer terms
 * restrict. It is asked right after the self-target typo and before every other
 * refusal, so a flag that lifts one of those (`--allow-relay-chain`) is never
 * read as the way past it. {@link findRelayToolPolicyDenial} is the same rule
 * for the delivery of a relay already open (`relay-delivery`).
 *
 * Pure: every decision is a function of values the caller already read. The
 * database work — finding the parent relay, counting the open ones — is
 * `relay-service`'s, so the rules can be tested without a schema.
 *
 * @module lib/relay/relay-policy
 */

import type { RelayEndpoint } from '@/lib/relay/types';
import type { CLIToolType } from '@/lib/cli-tools/types';
import {
  decideToolPolicy,
  RELAY_TOOL_POLICY_DENIED,
  type ToolPolicyDecision,
  type UsageDeclaration,
} from '@/lib/tool-policy/policy';

/** How long a relay stands before it is swept. 24h, per the Issue. */
export const DEFAULT_RELAY_TTL_MS = 24 * 60 * 60 * 1000;

/** Shortest TTL a caller may ask for: one minute. */
export const MIN_RELAY_TTL_MS = 60 * 1000;

/** Longest TTL a caller may ask for: seven days. */
export const MAX_RELAY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How deep a chain may go.
 *
 * Three, by the Issue. Depth 1 is a relay nothing relayed into; a relay opened
 * while answering one is 2, and so on. A request that would create depth 4 is
 * refused — `--allow-relay-chain` widens the door, it does not remove the wall.
 */
export const MAX_RELAY_HOPS = 3;

/**
 * How many relays a session may open in a row, each right after the reply to
 * its own previous one, before a person has to type something (Issue #4420).
 *
 * Ten, by the PM's decision. Counted per requesting session whoever it asks
 * (alternating targets must not reset it), from the delivered replies in its
 * history back to the newest ordinary row. Not {@link MAX_RELAY_HOPS}: depth is
 * nesting, this is length, and a requester asking → reading the reply → asking
 * again is the normal use. With one open relay per direction a one-sided
 * runaway (A answering every reply with a new relay) advances one reply per
 * turn of the other side, so ten bounds it to about ten turns. That bound does
 * NOT hold for two sessions relaying to each other: what B is asked arrives as
 * an ordinary row, which resets B's count (known limit (a)), and a relay opened
 * while answering one is not seen as a chain today (known limit (b), #4492).
 */
export const MAX_RELAY_ROUNDS = 10;

/**
 * How far back the walk that counts round trips may read, in user rows
 * (Issue #4420, I10).
 *
 * The walk reads to a settled end — an ordinary row, the start of the history,
 * the parent, or {@link MAX_RELAY_ROUNDS} replies — and notices and echoes are
 * stepped over without counting, so only a history of hundreds of them with no
 * person typing comes near this. When it does, the relay is refused
 * (fail-closed) with a sentence that says how many replies were confirmed and
 * that the history could not be read to its end.
 */
export const MAX_RELAY_LINEAGE_ROWS = 500;

/** How many open relays one from→to direction may hold at once. */
export const MAX_OPEN_RELAYS_PER_PAIR = 1;

/**
 * How long a scrape-only tool must sit still before its pane counts as a reply.
 *
 * copilot, gemini and vibe-local keep no transcript, so what a completed turn
 * leaves behind is the poller's copy of the SCREEN — and the poller's completion
 * judgement is a string analysis of a frame that is still being drawn. Delivering
 * on the first such judgement is how a half-written answer reaches session A as
 * "the reply". The relay therefore waits, re-reads the newest row and delivers
 * only if nothing newer arrived: the Issue's 「完了検知 + 数秒の静穏」.
 *
 * Tools with a transcript skip this entirely — their reader answers `true` only
 * for a turn the agent has closed, which is a stronger statement than any amount
 * of quiet.
 */
export const RELAY_SCRAPE_QUIET_MS = 4_000;

/** How often the pump retries deliveries and sweeps expired relays. */
export const RELAY_PUMP_INTERVAL_MS = 15_000;

/** Machine-readable reason a relay was refused. Also the API's `code`. */
export type RelayRefusalCode =
  | 'RELAY_CHAIN_BLOCKED'
  | 'RELAY_HOPS_EXCEEDED'
  | 'RELAY_DUPLICATE_PENDING'
  | 'RELAY_SELF_TARGET'
  | typeof RELAY_TOOL_POLICY_DENIED;

/** A tool policy's refusal of one end (Issue #4437). */
export type DeniedToolPolicy = Extract<ToolPolicyDecision, { allowed: false }>;

/** Which end of a relay the tool policy refused, and its decision (Issue #4437). */
export interface RelayToolPolicyDenial {
  endpoint: 'from' | 'to';
  decision: DeniedToolPolicy;
}

/** A refusal, with the sentence the CLI prints. */
export interface RelayRefusal {
  code: RelayRefusalCode;
  message: string;
  /** Issue #4437: set on `RELAY_TOOL_POLICY_DENIED` only. */
  toolPolicy?: RelayToolPolicyDenial;
}

/** The tools at both ends and the usage declaration, for rule 0 (Issue #4437). */
export interface RelayEndpointTools {
  from: CLIToolType;
  to: CLIToolType;
  declaration: UsageDeclaration;
}

/** Issue #4437: the sentence of `RELAY_TOOL_POLICY_DENIED`. */
export const RELAY_TOOL_POLICY_DENIED_MESSAGE =
  'A relay with antigravity at either end is refused by default under the Google Antigravity terms §6 '
  + '(consumer plans). No relay was opened and nothing was typed.';

/**
 * Issue #4437: the first end of a relay the tool policy refuses (`relay` from
 * the server's own `relay` origin), `from` before `to`; null when both may be
 * driven. Pure: the declaration is an argument.
 */
export function findRelayToolPolicyDenial(tools: RelayEndpointTools): RelayToolPolicyDenial | null {
  for (const endpoint of ['from', 'to'] as const) {
    const decision = decideToolPolicy({
      tool: tools[endpoint],
      operation: 'relay',
      origin: 'relay',
      declaration: tools.declaration,
    });
    if (!decision.allowed) return { endpoint, decision };
  }
  return null;
}

/** What {@link decideRelayCreation} is asked about. */
export interface RelayCreationInput {
  from: RelayEndpoint;
  to: RelayEndpoint;
  /**
   * The relay whose delivery is the message this session is currently answering,
   * or null when the session was not asked by a relay. `relay-service` reads it
   * from the newest user row's `relay:<id>` request id.
   */
  parentHops: number | null;
  /** Whether the caller passed `--allow-relay-chain`. */
  allowRelayChain: boolean;
  /** Open relays already running from `from` to `to`. */
  openBetween: number;
  /**
   * Issue #4420: replies to `from`'s own relays received in a row with no
   * ordinary row in between (`relay-service`'s `countConsecutiveReplyRounds`).
   * Absent means 0, so a caller that does not count is unaffected.
   */
  replyRounds?: number;
  /**
   * Issue #4420 (I10): the count could not be read to a settled end within
   * {@link MAX_RELAY_LINEAGE_ROWS}; `replyRounds` is what was confirmed.
   */
  historyTruncated?: boolean;
  /**
   * Issue #4437: the tools at both ends, for rule 0. Absent, rule 0 is not
   * asked (a caller with no tools to name); `relay-service` always passes it.
   */
  tools?: RelayEndpointTools;
}

/** A relay that may be created, and at what depth. */
export interface RelayCreationVerdict {
  ok: true;
  hops: number;
}

/** Whether two endpoints name the same session. */
export function isSameEndpoint(a: RelayEndpoint, b: RelayEndpoint): boolean {
  return a.worktreeId === b.worktreeId && a.instanceId === b.instanceId;
}

/**
 * Apply all four rules and hand back the depth, or the refusal.
 *
 * Order matters only for which sentence an operator sees first, and it is the
 * order they can act on: "you are the same session" is a typo, "this would be a
 * chain" is a flag away, "the chain is too deep" and "you already have one" are
 * decisions about work in flight.
 *
 * Issue #4437: the tool policy (rule 0) is asked right after the typo and
 * before the others — no flag of this request lifts it, only a declaration.
 *
 * Issue #4420: the round-trip ceiling sits right after the depth ceiling — the
 * same code, and like it not lifted by `allowRelayChain`.
 */
export function decideRelayCreation(
  input: RelayCreationInput
): RelayCreationVerdict | RelayRefusal {
  if (isSameEndpoint(input.from, input.to)) {
    return {
      code: 'RELAY_SELF_TARGET',
      message:
        'A session cannot relay a reply to itself. --reply-to must name a different '
        + 'worktree or a different agent instance.',
    };
  }

  const toolPolicy = input.tools ? findRelayToolPolicyDenial(input.tools) : null;
  if (toolPolicy) {
    return { code: RELAY_TOOL_POLICY_DENIED, message: RELAY_TOOL_POLICY_DENIED_MESSAGE, toolPolicy };
  }

  const hops = input.parentHops === null ? 1 : input.parentHops + 1;

  if (input.parentHops !== null && !input.allowRelayChain) {
    return {
      code: 'RELAY_CHAIN_BLOCKED',
      message:
        'The last message this session was given arrived over a relay, so opening '
        + 'another one would chain two deliveries together. Pass --allow-relay-chain '
        + 'if that is what you mean.',
    };
  }

  if (hops > MAX_RELAY_HOPS) {
    return {
      code: 'RELAY_HOPS_EXCEEDED',
      message:
        `Relay chains stop at ${MAX_RELAY_HOPS} hops; this one would be ${hops}. `
        + 'Report the reply to whoever asked instead of forwarding it again.',
    };
  }

  const replyRounds = input.replyRounds ?? 0;
  if (replyRounds >= MAX_RELAY_ROUNDS) {
    return {
      code: 'RELAY_HOPS_EXCEEDED',
      message:
        `This session has opened relays ${replyRounds} times in a row, each right after a reply, `
        + `with nothing typed in between; round trips stop at ${MAX_RELAY_ROUNDS}. `
        + 'Have a person look before sending another (any ordinary message resets the count).',
    };
  }
  if (input.historyTruncated === true) {
    return {
      code: 'RELAY_HOPS_EXCEEDED',
      message:
        `Only ${replyRounds} replies in a row could be confirmed: this session's history has no `
        + `ordinary message within the last ${MAX_RELAY_LINEAGE_ROWS} rows, so the round-trip count `
        + `(limit ${MAX_RELAY_ROUNDS}) could not be read to its end. `
        + 'Have a person look before sending another (any ordinary message resets the count).',
    };
  }

  if (input.openBetween >= MAX_OPEN_RELAYS_PER_PAIR) {
    return {
      code: 'RELAY_DUPLICATE_PENDING',
      message:
        'There is already an open relay between these two sessions. Wait for it, or '
        + 'withdraw it with `commandmate relays cancel <id>`.',
    };
  }

  return { ok: true, hops };
}

/** Whether a verdict is a refusal. */
export function isRelayRefusal(
  verdict: RelayCreationVerdict | RelayRefusal
): verdict is RelayRefusal {
  return 'code' in verdict;
}

/**
 * Clamp a requested TTL into the supported window.
 *
 * Clamped rather than refused: the TTL is a sweep deadline, not a promise, and
 * an operator who asked for a year gets the longest one that keeps the ledger
 * from accumulating rows nobody will ever collect.
 */
export function resolveRelayTtlMs(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_RELAY_TTL_MS;
  return Math.min(MAX_RELAY_TTL_MS, Math.max(MIN_RELAY_TTL_MS, Math.trunc(requested)));
}
