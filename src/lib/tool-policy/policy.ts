/**
 * Tool policy (Issue #4436 / #4437): which CLI tools CommandMate may drive, for which
 * operation, from which origin, under which usage declaration.
 *
 * Google Antigravity Additional Terms §6 (https://antigravity.google/terms) and its FAQ
 * (https://antigravity.google/docs/faq) restrict using Antigravity on a consumer
 * (personal) plan through third-party software or agents. So for antigravity, unless the
 * user declares an API-key or enterprise plan, unattended runs and Auto-Yes are refused,
 * and send / ask / respond / relay are refused unless a person started them (the web UI,
 * an older CLI, or a terminal).
 *
 * Pure: no side effects, no I/O, no DB, no node built-ins and no `process.env` — the
 * declaration is an argument (see `declaration.ts`). Read from the CLI by a relative path
 * and from the web UI, so the only import is the `CLIToolType` type.
 *
 * @module lib/tool-policy/policy
 */

import type { CLIToolType } from '../cli-tools/types';

/** Operations the policy decides on. */
export type ToolOperation = 'send' | 'ask' | 'respond' | 'relay' | 'schedule' | 'auto-yes';

/**
 * Who started the operation. `legacy` = no origin in the request (web UI, older CLI);
 * `relay` / `timer` are server-internal and never accepted from a request body.
 */
export type SendOrigin = 'legacy' | 'terminal' | 'session' | 'agent' | 'schedule' | 'unknown' | 'relay' | 'timer';

/** The user's declared Antigravity plan. */
export type UsageDeclaration = 'personal' | 'api-key' | 'enterprise';

/** Environment variable holding the usage declaration. */
export const USAGE_DECLARATION_ENV = 'CM_ANTIGRAVITY_USAGE';

/** Environment variable marking the origin of a child process (value `schedule`). */
export const RUN_ORIGIN_ENV = 'CM_RUN_ORIGIN';

/** HTTP / CLI code of a refusal on send, ask, respond, schedule and Auto-Yes. */
export const TOOL_POLICY_DENIED = 'TOOL_POLICY_DENIED';

/** Code of a refusal on relay creation (follows the `RELAY_*` refusal codes). */
export const RELAY_TOOL_POLICY_DENIED = 'RELAY_TOOL_POLICY_DENIED';

/** Reason: Antigravity consumer-plan terms (§6 / FAQ). */
export const ANTIGRAVITY_CONSUMER_TERMS = 'ANTIGRAVITY_CONSUMER_TERMS';

/** Why the policy refused. */
export type ToolPolicyReason = typeof ANTIGRAVITY_CONSUMER_TERMS;

/** Google Antigravity Additional Terms. */
export const ANTIGRAVITY_TERMS_URL = 'https://antigravity.google/terms';

/** Google Antigravity FAQ. */
export const ANTIGRAVITY_FAQ_URL = 'https://antigravity.google/docs/faq';

/** Date the terms and FAQ wording were checked. */
export const ANTIGRAVITY_TERMS_CHECKED_AT = '2026-11-16';

/** One English sentence for the `error` of the API and the CLI. */
export const TOOL_POLICY_DENIED_MESSAGE =
  'Refused by default for antigravity under the Google Antigravity terms §6 (consumer plans). Nothing was typed.';

/** Origins accepted from a request body as they are. */
const BODY_ORIGINS: readonly SendOrigin[] = ['terminal', 'session', 'agent', 'schedule', 'unknown'];

/**
 * Parse a request's `origin`. Missing → `legacy`; a known body origin → itself; any
 * other string (including `relay`, `timer`, `legacy`, which a body may not claim) →
 * `unknown`; a non-string (including `null`) → `invalid` (the caller answers 400).
 */
export function parseSendOrigin(value: unknown): SendOrigin | 'invalid' {
  if (value === undefined) return 'legacy';
  if (typeof value !== 'string') return 'invalid';
  return (BODY_ORIGINS as readonly string[]).includes(value) ? (value as SendOrigin) : 'unknown';
}

/** A restriction on one tool. `null` in the table = no restriction. */
interface ToolRestriction {
  readonly reason: ToolPolicyReason;
  readonly links: { readonly terms: string; readonly faq: string };
  /** Declarations that lift the restriction entirely. */
  readonly unlockedBy: readonly UsageDeclaration[];
  /** Origins still allowed per operation while restricted (empty = refused from any origin). */
  readonly allowedOrigins: Readonly<Record<ToolOperation, readonly SendOrigin[]>>;
}

const HUMAN_ORIGINS: readonly SendOrigin[] = Object.freeze(['legacy', 'terminal'] as const);

const ANTIGRAVITY_RESTRICTION: ToolRestriction = Object.freeze({
  reason: ANTIGRAVITY_CONSUMER_TERMS,
  links: Object.freeze({ terms: ANTIGRAVITY_TERMS_URL, faq: ANTIGRAVITY_FAQ_URL }),
  unlockedBy: Object.freeze(['api-key', 'enterprise'] as const),
  allowedOrigins: Object.freeze({
    send: HUMAN_ORIGINS,
    ask: HUMAN_ORIGINS,
    respond: HUMAN_ORIGINS,
    relay: HUMAN_ORIGINS,
    schedule: Object.freeze([] as SendOrigin[]),
    'auto-yes': Object.freeze([] as SendOrigin[]),
  }),
});

/**
 * The policy as data: change one entry to change the rule. A full `Record` so adding a
 * tool to `CLI_TOOL_IDS` fails typecheck until it is listed here.
 */
export const TOOL_POLICY_TABLE: Readonly<Record<CLIToolType, ToolRestriction | null>> = Object.freeze({
  claude: null,
  codex: null,
  gemini: null,
  'vibe-local': null,
  opencode: null,
  copilot: null,
  antigravity: ANTIGRAVITY_RESTRICTION,
  'command-code': null,
  'opencode-v2': null,
});

/** Input of {@link decideToolPolicy}. */
export interface ToolPolicyInput {
  tool: CLIToolType;
  operation: ToolOperation;
  origin: SendOrigin;
  declaration: UsageDeclaration;
}

/** Result of {@link decideToolPolicy}. */
export type ToolPolicyDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: typeof TOOL_POLICY_DENIED;
      reason: ToolPolicyReason;
      tool: CLIToolType;
      operation: ToolOperation;
      origin: SendOrigin;
      declaration: UsageDeclaration;
      links: { terms: string; faq: string };
    };

/** Decide whether `tool` may be driven for `operation` from `origin` under `declaration`. */
export function decideToolPolicy({ tool, operation, origin, declaration }: ToolPolicyInput): ToolPolicyDecision {
  const restriction = TOOL_POLICY_TABLE[tool] ?? null;
  if (restriction === null) return { allowed: true };
  if (restriction.unlockedBy.includes(declaration)) return { allowed: true };
  if (restriction.allowedOrigins[operation].includes(origin)) return { allowed: true };
  return {
    allowed: false,
    code: TOOL_POLICY_DENIED,
    reason: restriction.reason,
    tool,
    operation,
    origin,
    declaration,
    links: { terms: restriction.links.terms, faq: restriction.links.faq },
  };
}

/** Human-readable message for a refusal (empty string when allowed). Not legal advice. */
export function formatToolPolicyDenial(decision: ToolPolicyDecision, locale: 'ja' | 'en'): string {
  if (decision.allowed) return '';
  if (locale === 'ja') {
    return [
      '個人向けプランの Antigravity を CommandMate 経由で無人・エージェント起点で使うことは、Google Antigravity 追加利用規約 6 条と FAQ で制限されているため、実行しませんでした（何も打っていません）。',
      `API キーまたは企業向けプランで使っている場合は、${USAGE_DECLARATION_ENV}=api-key（または ${USAGE_DECLARATION_ENV}=enterprise）を設定し、サーバーを再起動してください。`,
      `規約: ${decision.links.terms}`,
      `FAQ: ${decision.links.faq}`,
    ].join('\n');
  }
  return [
    'CommandMate did not run this (nothing was typed): using Antigravity on a personal plan unattended or from an agent through CommandMate is restricted by the Google Antigravity Additional Terms §6 and the FAQ.',
    `If you use an API key or an enterprise plan, set ${USAGE_DECLARATION_ENV}=api-key (or ${USAGE_DECLARATION_ENV}=enterprise) and restart the server.`,
    `Terms: ${decision.links.terms}`,
    `FAQ: ${decision.links.faq}`,
  ].join('\n');
}
