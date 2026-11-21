/**
 * Issue #4466 PR0: the rows of the send-operation table, generated from the axes of
 * `docs/design/send-atomic-4466.md` §6.1, with what each row expects.
 *
 * Pure data: no database, no route. The test file arranges a row (`fixture.ts` names the
 * worktree, the roster and the ids), drives it, and compares what it observes
 * (`observe.ts`) with {@link TableRow.expected}.
 *
 * The expectation is the design's, not today's: a refused operation leaves nothing (I1);
 * the policy refusals come first (I9, S0's early judgment): the target's tool policy, the
 * relay's rule 0, Auto-Yes's policy; then S2 (b)'s other refusals in its order: the relay's
 * own rules (C5), Auto-Yes's shutdown, the roster (C6), mem (C4). A target or reply-to end
 * that changed between S1 and S2 is `OPERATION_TARGET_CHANGED` (§4.2 (a), C3, exit 31).
 *
 * ## The axes, and what is reduced (r1, review P2-6 / reinstruction 7)
 *
 * Crossed in full: the base operation (7) × the subsets of the three modifiers that write
 * (`--reply-to`, `--auto-yes`, `--note`; `--note` needs `--reply-to`, so 6) × the four
 * that do not write (`--model`, `--new-conversation`, `--no-brief`, `--with-brief`) or none
 * (5) = 210 combinations, each with the origins its family is refused or allowed from.
 *
 * Reduced, each with its reason:
 *  - the declaration (`api-key`): one all-allowed row per base operation. It lifts every
 *    restriction (`ANTIGRAVITY_RESTRICTION.unlockedBy`; rule 0 reads the same table). The
 *    only reduction the PM approved beforehand (design §6.1, P5).
 *  - the plain modifiers one at a time, not as subsets (`--model --new-conversation` …):
 *    no judgment of §4.2 reads two of them together. `--no-brief --with-brief` is a usage
 *    error of the CLI (exit 2 before any request).
 *  - `--model` on codex: the CLI refuses it (exit 2); such a row sends to claude instead.
 *  - Auto-Yes's terms (`durationMs` 3,600,000, `answerMode` recommended, no stop pattern)
 *    in every row but the `auto-yes-terms` family (4 rows: 1 h / 24 h × recommended /
 *    careful, allowed, checked on the grant). No policy reads them.
 *  - the existing grant (`onlyIfOff`), the shutdown and the role-condition conflict (the
 *    `PUT /instances/roles` of today's CLI) are families of their own on a few
 *    combinations (`existing-grant` 14, `shutdown` 7, `role-conflict` 4), not crossed with
 *    the 210: each is one judgment of §4.2 (b) 3 / 5 whose position does not depend on the
 *    other modifiers.
 *  - the origins of the non-policy families (`relay-non-policy`, `roster`, `shutdown`):
 *    `terminal` only — the origin reads no non-policy judgment. `mem`: `session` only
 *    (a `--note` needs a session identity, `send.ts` exits 2 otherwise).
 *  - `auto-yes-policy` with `--reply-to` (35 of its 210 rows): the relay's rule 0 refuses
 *    them first (the target is antigravity), so their expected stage is `relay`.
 *
 * ## The success response (decided here for PR1b, not in design §4.1)
 *
 * An allowed operation answers `policy.target.tool` (the tool typed into, I2a) and, with a
 * relay, `policy.relay.from` / `policy.relay.to` (the tools rule 0 judged the ends by).
 * Without it the ad-hoc `--agent codex` control could not tell a `to` judged by the roster
 * default (claude) from one judged by the tool typed into (§6.3 「to の tool を名簿から解決し直す」).
 */

import { FIXTURE } from './fixture';
import type { SendOperationHookPoint } from './hooks';

export const ORIGINS = ['terminal', 'session', 'agent', 'schedule', 'unknown', 'legacy'] as const;
export type Origin = (typeof ORIGINS)[number];
/** `HUMAN_ORIGINS` of `src/lib/tool-policy/policy.ts`: the origins a person sends from. */
export const HUMAN_ORIGINS: readonly Origin[] = ['terminal', 'legacy'];
const isHuman = (origin: Origin): boolean => HUMAN_ORIGINS.includes(origin);

export type Declaration = 'none' | 'api-key';

export const BASE_OPS = ['send', 'contract', 'register', 'register-role', 'role', 'no-role', 'contract-role'] as const;
export type BaseOp = (typeof BASE_OPS)[number];

export const WRITING_MODIFIERS = ['reply-to', 'auto-yes', 'note'] as const;
export const PLAIN_MODIFIERS = ['model', 'new-conversation', 'no-brief', 'with-brief'] as const;
export type Modifier = (typeof WRITING_MODIFIERS)[number] | (typeof PLAIN_MODIFIERS)[number];

export type Tool = 'codex' | 'antigravity' | 'claude';

/** The judgment a row is built to be refused by (`none`: allowed). §6.1 「拒否する段」 and the added fixtures. */
export type Family =
  | 'target-policy'
  | 'relay-rule0'
  | 'auto-yes-policy'
  | 'relay-non-policy'
  | 'roster'
  | 'mem'
  | 'shutdown'
  | 'existing-grant'
  | 'role-conflict'
  | 'auto-yes-terms'
  | 'none'
  | 'declared'
  | 'interrupt'
  | 'mismatch'
  | 'endpoint-unresolved'
  | 's1-writes-nothing';

export type InterruptInput = 'roster-tool' | 'default' | 'reply-to-roster' | 'declaration';

/**
 * §6.1 「割り込み」.
 *  - `h-S2` `to-deny`: from the allowing value to the refusing one, at h-S2.
 *  - `h-S2` `to-other`: from the allowing value to another allowing one (a different target:
 *    §6.3 「S2 (a) の比較を外す」).
 *  - `s0-first`: the refusing value would be turned allowing at h-S2, but S0's early
 *    judgment refuses first, so h-S2 is never reached (I9). Named apart from the rows that
 *    go through S2's judgment again.
 */
export type Interrupt =
  | { kind: 'none' }
  | { kind: 'h-S2'; input: InterruptInput; direction: 'to-deny' | 'to-other' }
  | { kind: 's0-first'; input: InterruptInput }
  | { kind: 'h-S3' }
  | { kind: 'h-S3b' }
  | { kind: 'h-S1-stop' };

/** `policy.stage` of the refusal (§5.1 C1). */
export type PolicyStage = 'target' | 'relay' | 'auto-yes';

/** The decision the refusal carries (`toolPolicyDetail`): what was judged, by which operation, from which origin. */
export interface ExpectedPolicy {
  stage: PolicyStage;
  operation: 'send' | 'relay' | 'auto-yes';
  tool: Tool;
  /** The copy of the origin the decision was taken from: the body's for the target, `relay` for rule 0. */
  origins: readonly string[];
  /** The end rule 0 refused (`from` is judged before `to`, `findRelayToolPolicyDenial`). */
  endpoint?: 'from' | 'to';
}

export type Expected =
  | {
      kind: 'refused';
      status: number;
      /** The response `code` must be one of these; null = the design names none (the status alone is pinned). */
      codes: readonly string[] | null;
      policy?: ExpectedPolicy;
      /** The CLI's exit for this refusal (§5.1). */
      exit: number;
    }
  | {
      kind: 'allowed';
      writes: {
        task: boolean;
        /** The instance id added to the roster, or null. */
        rosterRow: string | null;
        /** The instance whose role setting is written, and to what, or null. */
        role: { instanceId: string; state: 'role' | 'none' } | null;
        /** The relay's ends (instance ids), or null. */
        relay: { from: string; to: string } | null;
        note: boolean;
        /** The grant enabled afterwards (`tool/instance`), with its answer mode, or null. */
        grant: { key: string; answerMode: 'recommended' | 'careful'; durationMs: number } | null;
      };
      /** The instance the message is typed into, and its tool (S2's target, I2). */
      typed: { tool: Tool; instanceId: string };
      /** `policy` of the success response (see the header): the tools judged. */
      judged: { target: Tool; relay?: { from: Tool; to: Tool } };
    }
  | { kind: 'stopped' };

export interface TableRow {
  name: string;
  family: Family;
  base: BaseOp;
  modifiers: readonly Modifier[];
  origin: Origin;
  declaration: Declaration;
  /** The worktree's default tool (the fixture's is codex). */
  worktreeDefault: Tool;
  /** What the operation names: an instance (on the roster or ad-hoc) and `--agent` when given; `''` names nothing. */
  target: { instanceId: string; agent?: Tool };
  /** The tool that instance is (the tool S2 types into). */
  targetTool: Tool;
  /** The instance typed into (the default's primary when nothing is named). */
  typedInstance: string;
  /** The reply-to end (an instance of {@link FIXTURE.worktreeId}). */
  replyTo?: { instanceId: string; tool: Tool };
  /** The roster is full before the operation (the roster check refuses `--register`). */
  rosterFull: boolean;
  /** mem on the fixture branch: on, off (mode), or on with the open `waiting` items at their limit. */
  mem: 'on' | 'off' | 'limit';
  /** A grant already on for the target (`answerMode: careful`), the `onlyIfOff` fixture. */
  existingGrant: boolean;
  /** Auto-Yes's shutdown has begun (`beginAutoYesShutdown`). */
  shutdown: boolean;
  /** The target's role setting before the operation (`none`: a row with no role), the role-conflict fixture. */
  existingRole: 'none' | null;
  autoYesTerms: { durationMs: number; answerMode: 'recommended' | 'careful' };
  interrupt: Interrupt;
  /** An instance whose roster read throws (§6.1 「端の解決の失敗」). */
  rosterFault?: string;
  /** The hook point that must have been reached, and the one that must not. */
  hooks: { reached: SendOperationHookPoint[]; notReached: SendOperationHookPoint[] };
  expected: Expected;
}

type RowFields = Omit<TableRow, 'expected' | 'name' | 'hooks'>;

const has = (row: Pick<TableRow, 'modifiers'>, modifier: Modifier): boolean => row.modifiers.includes(modifier);
const writesContract = (base: BaseOp): boolean => base === 'contract' || base === 'contract-role';
const registers = (base: BaseOp): boolean => base === 'register' || base === 'register-role';
const setsRole = (base: BaseOp): boolean => ['register-role', 'role', 'no-role', 'contract-role'].includes(base);

/** Exit codes (`src/cli/types`: 33 tool policy, 31 conflict, 2 usage / relay refusals, 99 unexpected). */
export const EXIT = { policy: 33, conflict: 31, usage: 2, unexpected: 99 } as const;

/**
 * The roster refusal (C6): today's `POST /instances/roles` at the limit answers 400 with
 * `error: 'invalid_request'` (pinned by the (iii) row `POST /instances/roles on a full
 * roster`); the new route answers the same as its `code`. The design names no code for C6:
 * this is PR0's choice for PR1b.
 */
export const ROSTER_LIMIT_REFUSAL = { status: 400, code: 'invalid_request' } as const;

/** Every modifier set: the 6 subsets of the writing three × the 4 plain ones or none. */
export function modifierSets(): Modifier[][] {
  const subsets: Modifier[][] = [];
  for (let mask = 0; mask < 1 << WRITING_MODIFIERS.length; mask += 1) {
    const set = WRITING_MODIFIERS.filter((_m, bit) => (mask >> bit) & 1);
    if (!set.includes('note') || set.includes('reply-to')) subsets.push(set);
  }
  return subsets.flatMap((set) => [set, ...PLAIN_MODIFIERS.map((plain): Modifier[] => [...set, plain])]);
}

/** The tool `--model` is given with on an allowed row (codex takes no --model). */
function toolFor(intended: Tool, modifiers: readonly Modifier[]): Tool {
  return modifiers.includes('model') && intended === 'codex' ? 'claude' : intended;
}

function targetOf(base: BaseOp, tool: Tool): Pick<TableRow, 'target' | 'targetTool' | 'typedInstance'> {
  if (registers(base)) return { target: { instanceId: FIXTURE.adHoc, agent: tool }, targetTool: tool, typedInstance: FIXTURE.adHoc };
  return { target: { instanceId: FIXTURE.instanceOf[tool] }, targetTool: tool, typedInstance: FIXTURE.instanceOf[tool] };
}

const DEFAULT_TERMS = { durationMs: 3_600_000, answerMode: 'recommended' as const };

/** The verdict without an interrupt, in the order of the header. */
export function verdictOf(row: RowFields): Expected {
  if (row.interrupt.kind === 'h-S1-stop') return { kind: 'stopped' };
  const declared = row.declaration === 'api-key';
  const restricted = (tool: Tool): boolean => tool === 'antigravity' && !declared;
  // S0: the policy refusals.
  if (restricted(row.targetTool) && !isHuman(row.origin)) {
    return {
      kind: 'refused', status: 409, codes: ['TOOL_POLICY_DENIED'], exit: EXIT.policy,
      policy: { stage: 'target', operation: 'send', tool: 'antigravity', origins: [row.origin] },
    };
  }
  if (row.replyTo) {
    if (row.rosterFault === row.replyTo.instanceId) {
      return { kind: 'refused', status: 503, codes: ['RELAY_ENDPOINT_UNRESOLVED'], exit: EXIT.unexpected };
    }
    // I2a: `to` is judged by the tool actually typed into, `from` by the roster's; `from` first.
    if (restricted(row.replyTo.tool) || restricted(row.targetTool)) {
      return {
        kind: 'refused', status: 409, codes: ['RELAY_TOOL_POLICY_DENIED'], exit: EXIT.policy,
        policy: { stage: 'relay', operation: 'relay', tool: 'antigravity', origins: ['relay'], endpoint: restricted(row.replyTo.tool) ? 'from' : 'to' },
      };
    }
  }
  if (has(row, 'auto-yes') && restricted(row.targetTool)) {
    // Auto-Yes is refused from every origin; today's judgment takes it as `legacy` (`findWriteToolPolicyRefusal`).
    return {
      kind: 'refused', status: 409, codes: ['TOOL_POLICY_DENIED'], exit: EXIT.policy,
      policy: { stage: 'auto-yes', operation: 'auto-yes', tool: 'antigravity', origins: ['legacy', row.origin] },
    };
  }
  // S2 (b): the other refusals.
  if (row.replyTo && row.replyTo.instanceId === row.typedInstance) {
    return { kind: 'refused', status: 409, codes: ['RELAY_SELF_TARGET'], exit: EXIT.usage };
  }
  if (has(row, 'auto-yes') && row.shutdown) {
    return { kind: 'refused', status: 503, codes: null, exit: EXIT.unexpected };
  }
  if (registers(row.base) && row.rosterFull) {
    return { kind: 'refused', status: ROSTER_LIMIT_REFUSAL.status, codes: [ROSTER_LIMIT_REFUSAL.code], exit: EXIT.usage };
  }
  if (has(row, 'note') && row.mem !== 'on') {
    const code = row.mem === 'off' ? 'disabled' : 'limit_exceeded';
    return { kind: 'refused', status: 409, codes: [code], exit: MEM_EXIT[code] };
  }
  const typedTool = row.targetTool;
  return {
    kind: 'allowed',
    writes: {
      task: writesContract(row.base),
      rosterRow: registers(row.base) ? row.target.instanceId : null,
      role: setsRole(row.base) ? { instanceId: row.typedInstance, state: row.base === 'no-role' ? 'none' : 'role' } : null,
      relay: row.replyTo ? { from: row.replyTo.instanceId, to: row.typedInstance } : null,
      note: has(row, 'note'),
      grant: has(row, 'auto-yes')
        ? { key: `${typedTool}/${row.typedInstance}`, answerMode: row.existingGrant ? 'careful' : row.autoYesTerms.answerMode, durationMs: row.autoYesTerms.durationMs }
        : null,
    },
    typed: { tool: typedTool, instanceId: row.typedInstance },
    judged: { target: typedTool, ...(row.replyTo ? { relay: { from: row.replyTo.tool, to: typedTool } } : {}) },
  };
}

/** `MEM_EXIT_BY_CODE` of `src/types/mem.ts` for the two mem refusals of the table (pinned by a test). */
export const MEM_EXIT = { disabled: 50, limit_exceeded: 56 } as const;

/** The verdict of a row with its interrupt. */
function interruptVerdict(row: RowFields): Expected {
  const interrupt = row.interrupt;
  if (interrupt.kind === 's0-first') return verdictOf(row);
  if (interrupt.kind !== 'h-S2') return verdictOf(row);
  if (interrupt.input === 'declaration') {
    // Not a target: S2 reads the declaration again (I3c) and judges it.
    return verdictOf({ ...row, declaration: 'none' });
  }
  // A target or reply-to end that is not S1's candidate any more (§4.2 (a), C3, H1).
  return { kind: 'refused', status: 409, codes: ['OPERATION_TARGET_CHANGED'], exit: EXIT.conflict };
}

function hooksOf(fields: RowFields): TableRow['hooks'] {
  switch (fields.interrupt.kind) {
    case 'h-S1-stop': return { reached: ['h-S1'], notReached: ['h-S2'] };
    case 'h-S2': return { reached: ['h-S2'], notReached: ['h-S3'] };
    case 's0-first': return { reached: [], notReached: ['h-S1', 'h-S2'] };
    case 'h-S3': return { reached: ['h-S3'], notReached: [] };
    case 'h-S3b': return { reached: ['h-S3b'], notReached: [] };
    case 'none': return { reached: [], notReached: [] };
  }
}

function row(fields: RowFields, label: string): TableRow {
  const mods = fields.modifiers.length > 0 ? ` +${fields.modifiers.join('+')}` : '';
  const decl = fields.declaration === 'api-key' ? ' [api-key]' : '';
  const named = fields.target.instanceId === '' ? '(default)' : fields.target.instanceId;
  return {
    ...fields,
    name: `${label}: ${fields.base}${mods} → ${named}(${fields.targetTool}) from ${fields.origin}${decl}`,
    hooks: hooksOf(fields),
    expected: interruptVerdict(fields),
  };
}

const plain = {
  declaration: 'none' as const,
  worktreeDefault: 'codex' as const,
  rosterFull: false,
  mem: 'on' as const,
  existingGrant: false,
  shutdown: false,
  existingRole: null,
  autoYesTerms: DEFAULT_TERMS,
  interrupt: { kind: 'none' } as const,
};
const replyToOf = (modifiers: readonly Modifier[], tool: Tool = 'claude'): TableRow['replyTo'] =>
  modifiers.includes('reply-to')
    ? { instanceId: tool === 'antigravity' ? FIXTURE.replyToAntigravity : FIXTURE.replyTo, tool }
    : undefined;

/** Every row of the new route's table (design §6.1). */
export function sendOperationRows(): TableRow[] {
  const rows: TableRow[] = [];
  const combos = BASE_OPS.flatMap((base) => modifierSets().map((modifiers) => ({ base, modifiers })));
  const withModifier = (modifier: Modifier) => combos.filter(({ modifiers }) => modifiers.includes(modifier));

  // 拒否する段 = 宛先の方針: antigravity, no declaration, from everyone but a person.
  for (const { base, modifiers } of combos) {
    for (const origin of ORIGINS.filter((o) => !isHuman(o))) {
      rows.push(row({ ...plain, base, modifiers, origin, ...targetOf(base, 'antigravity'), replyTo: replyToOf(modifiers), family: 'target-policy' }, 'target-policy'));
    }
  }
  // relay の規則 0: the reply-to end is antigravity; every origin.
  for (const { base, modifiers } of withModifier('reply-to')) {
    for (const origin of ORIGINS) {
      rows.push(row({ ...plain, base, modifiers, origin, ...targetOf(base, toolFor('codex', modifiers)), replyTo: replyToOf(modifiers, 'antigravity'), family: 'relay-rule0' }, 'relay-rule0'));
    }
  }
  // Auto-Yes の方針: a person may send to antigravity, nobody may arm Auto-Yes on it
  // (with --reply-to, rule 0 refuses first: see the header).
  for (const { base, modifiers } of withModifier('auto-yes')) {
    for (const origin of HUMAN_ORIGINS) {
      rows.push(row({ ...plain, base, modifiers, origin, ...targetOf(base, 'antigravity'), replyTo: replyToOf(modifiers), family: 'auto-yes-policy' }, 'auto-yes-policy'));
    }
  }
  // relay の方針以外 (C5): the reply-to end is the target itself.
  for (const { base, modifiers } of withModifier('reply-to')) {
    const targeted = targetOf(base, toolFor('codex', modifiers));
    rows.push(row({ ...plain, base, modifiers, origin: 'terminal', ...targeted, replyTo: { instanceId: targeted.typedInstance, tool: targeted.targetTool }, family: 'relay-non-policy' }, 'relay-non-policy'));
  }
  // 名簿 (C6): --register on a full roster.
  for (const { base, modifiers } of combos.filter(({ base }) => registers(base))) {
    rows.push(row({ ...plain, rosterFull: true, base, modifiers, origin: 'terminal', ...targetOf(base, toolFor('codex', modifiers)), replyTo: replyToOf(modifiers), family: 'roster' }, 'roster'));
  }
  // mem (C4): --note with mem off (`disabled`), and with the waiting items at their limit (`limit_exceeded`).
  for (const mem of ['off', 'limit'] as const) {
    for (const { base, modifiers } of withModifier('note')) {
      rows.push(row({ ...plain, mem, base, modifiers, origin: 'session', ...targetOf(base, toolFor('codex', modifiers)), replyTo: replyToOf(modifiers), family: 'mem' }, `mem ${mem}`));
    }
  }
  // Auto-Yes の shutdown (§4.2 (b) 3): refused in S2, nothing armed.
  for (const base of BASE_OPS) {
    rows.push(row({ ...plain, shutdown: true, base, modifiers: ['auto-yes'], origin: 'terminal', ...targetOf(base, 'codex'), family: 'shutdown' }, 'shutdown'));
  }
  // 既存の grant (onlyIfOff, §4.2 (b) 3): refused by rule 0 it stays as it was; allowed it stays on.
  for (const base of BASE_OPS) {
    rows.push(row({ ...plain, existingGrant: true, base, modifiers: ['reply-to', 'auto-yes'], origin: 'terminal', ...targetOf(base, 'codex'), replyTo: replyToOf(['reply-to'], 'antigravity'), family: 'existing-grant' }, 'existing-grant refused'));
    rows.push(row({ ...plain, existingGrant: true, base, modifiers: ['auto-yes'], origin: 'terminal', ...targetOf(base, 'codex'), family: 'existing-grant' }, 'existing-grant allowed'));
  }
  // ロールの条件の競合 (today's PUT /instances/roles): the target holds `none`, the operation sets a role.
  for (const base of ['role', 'contract-role'] as const) {
    rows.push(row({ ...plain, existingRole: 'none', base, modifiers: [], origin: 'terminal', ...targetOf(base, 'codex'), family: 'role-conflict' }, 'role-conflict allowed'));
    rows.push(row({ ...plain, existingRole: 'none', base, modifiers: ['reply-to'], origin: 'terminal', ...targetOf(base, 'codex'), replyTo: replyToOf(['reply-to'], 'antigravity'), family: 'role-conflict' }, 'role-conflict refused'));
  }
  // Auto-Yes の条件: the terms reach the grant.
  for (const durationMs of [3_600_000, 86_400_000]) {
    for (const answerMode of ['recommended', 'careful'] as const) {
      rows.push(row({ ...plain, autoYesTerms: { durationMs, answerMode }, base: 'send', modifiers: ['auto-yes'], origin: 'terminal', ...targetOf('send', 'codex'), family: 'auto-yes-terms' }, `auto-yes-terms ${durationMs / 3_600_000}h ${answerMode}`));
    }
  }
  // 拒否なし: codex (claude for --model), every origin. The negative control of the table.
  for (const { base, modifiers } of combos) {
    for (const origin of ORIGINS) {
      rows.push(row({ ...plain, base, modifiers, origin, ...targetOf(base, toolFor('codex', modifiers)), replyTo: replyToOf(modifiers), family: 'none' }, 'allowed'));
    }
  }
  // 申告あり (folded, P5): one all-allowed row per base, antigravity from an agent, every writing modifier.
  for (const base of BASE_OPS) {
    const modifiers: Modifier[] = ['reply-to', 'auto-yes', 'note'];
    rows.push(row({ ...plain, declaration: 'api-key', base, modifiers, origin: 'agent', ...targetOf(base, 'antigravity'), replyTo: replyToOf(modifiers), family: 'declared' }, 'declared'));
  }
  // 割り込み (§6.1, §4.3), on `--contract --reply-to --auto-yes` from an agent.
  const interruptBase = { ...plain, base: 'contract' as const, modifiers: ['reply-to', 'auto-yes'] as Modifier[], origin: 'agent' as const, family: 'interrupt' as const, replyTo: replyToOf(['reply-to']) };
  const byDefault = { target: { instanceId: '' }, targetTool: 'codex' as const, typedInstance: 'codex' };
  for (const input of ['roster-tool', 'default', 'reply-to-roster'] as const) {
    const targeted = input === 'default' ? byDefault : targetOf('contract', 'codex');
    for (const direction of ['to-deny', 'to-other'] as const) {
      rows.push(row({ ...interruptBase, ...targeted, interrupt: { kind: 'h-S2', input, direction } }, `h-S2 ${input} ${direction}`));
    }
    // Refusing to begin with: S0 refuses before the hook would turn it allowing.
    const refusing: RowFields = input === 'reply-to-roster'
      ? { ...interruptBase, ...targeted, replyTo: replyToOf(['reply-to'], 'antigravity'), interrupt: { kind: 's0-first', input } }
      : { ...interruptBase, ...targetOf('contract', 'antigravity'), ...(input === 'default' ? { target: { instanceId: '' }, typedInstance: 'antigravity', worktreeDefault: 'antigravity' as const } : {}), interrupt: { kind: 's0-first', input } };
    rows.push(row(refusing, `S0 refuses before h-S2 (${input})`));
  }
  rows.push(row({ ...interruptBase, ...targetOf('contract', 'antigravity'), declaration: 'api-key', interrupt: { kind: 'h-S2', input: 'declaration', direction: 'to-deny' } }, 'h-S2 declaration to-deny'));
  rows.push(row({ ...interruptBase, ...targetOf('contract', 'antigravity'), interrupt: { kind: 's0-first', input: 'declaration' } }, 'S0 refuses before h-S2 (declaration)'));
  rows.push(row({ ...interruptBase, ...targetOf('contract', 'codex'), interrupt: { kind: 'h-S3' } }, 'h-S3 the roster tool turns antigravity after the launch'));
  rows.push(row({ ...interruptBase, ...targetOf('contract', 'codex'), interrupt: { kind: 'h-S3b' } }, 'h-S3b the reply-to end turns antigravity after the keys'));
  // S1 の「書き込み無し」: stop at h-S1, every base with every writing modifier.
  for (const base of BASE_OPS) {
    const modifiers: Modifier[] = ['reply-to', 'auto-yes', 'note'];
    rows.push(row({ ...plain, base, modifiers, origin: 'session', ...targetOf(base, 'codex'), replyTo: replyToOf(modifiers), interrupt: { kind: 'h-S1-stop' }, family: 's1-writes-nothing' }, 'S1 writes nothing'));
  }
  // 解決の食い違い (N1, I2a): an ad-hoc id + --agent antigravity + --reply-to, with and without --register.
  for (const base of ['send', 'register'] as const) {
    for (const origin of ORIGINS) {
      rows.push(row({ ...plain, base, modifiers: ['reply-to'], origin, target: { instanceId: FIXTURE.adHoc, agent: 'antigravity' }, targetTool: 'antigravity', typedInstance: FIXTURE.adHoc, replyTo: replyToOf(['reply-to']), family: 'mismatch' }, 'mismatch'));
    }
    // Control: --agent codex with the default claude — allowed, and `to` judged as codex (`judged.relay.to`).
    rows.push(row({ ...plain, worktreeDefault: 'claude', base, modifiers: ['reply-to'], origin: 'agent', target: { instanceId: FIXTURE.adHoc, agent: 'codex' }, targetTool: 'codex', typedInstance: FIXTURE.adHoc, replyTo: replyToOf(['reply-to']), family: 'mismatch' }, 'mismatch control'));
  }
  // 端の解決の失敗: the reply-to end's roster read throws.
  rows.push(row({ ...plain, base: 'send', modifiers: ['reply-to'], origin: 'agent', ...targetOf('send', 'codex'), replyTo: replyToOf(['reply-to']), rosterFault: FIXTURE.replyTo, family: 'endpoint-unresolved' }, 'endpoint-unresolved'));

  return rows;
}

/**
 * The body of `POST /api/worktrees/:id/send-operation` for a row (§4.1). `roleId` is the
 * fixture's role, known only once it is created.
 */
export function sendOperationBody(row: Pick<TableRow, 'origin' | 'base' | 'target' | 'targetTool' | 'replyTo' | 'modifiers' | 'autoYesTerms'>, roleId: string): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (row.origin !== 'legacy') {
    body.origin = row.origin;
    body.originEvidence = 'test:send-operation-table-4466';
  }
  if (writesContract(row.base)) body.contract = { path: FIXTURE.contractPath };
  else body.message = FIXTURE.message;
  if (row.target.instanceId !== '') {
    body.target = row.target.agent ? { instanceId: row.target.instanceId, agent: row.target.agent } : { instanceId: row.target.instanceId };
  }
  if (registers(row.base)) body.register = { alias: null };
  if (setsRole(row.base)) body.role = row.base === 'no-role' ? { state: 'none' } : { state: 'role', roleId };
  if (row.replyTo) body.replyTo = { worktreeId: FIXTURE.worktreeId, instanceId: row.replyTo.instanceId, allowRelayChain: false };
  if (has(row, 'auto-yes')) {
    const afterSend = has(row, 'model') && row.targetTool !== 'claude';
    body.autoYes = {
      durationMs: row.autoYesTerms.durationMs,
      timing: afterSend ? 'after-send' : 'before-send',
      onlyIfOff: true,
      answerMode: row.autoYesTerms.answerMode,
      stopPattern: null,
    };
  }
  if (has(row, 'note') && row.replyTo) {
    body.note = { text: FIXTURE.noteText, author: { worktreeId: FIXTURE.worktreeId, instanceId: row.replyTo.instanceId } };
  }
  if (has(row, 'model')) body.model = row.targetTool === 'antigravity' ? FIXTURE.antigravityModel : FIXTURE.claudeModel;
  if (has(row, 'new-conversation')) body.newConversation = true;
  if (has(row, 'no-brief')) body.brief = 'skip';
  if (has(row, 'with-brief')) body.brief = 'force';
  return body;
}
