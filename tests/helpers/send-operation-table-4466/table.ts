/**
 * Issue #4466 PR0: the rows of the send-operation table, generated from the axes of
 * `docs/design/send-atomic-4466.md` §6.1, with what each row expects.
 *
 * Pure data: no database, no route. The test file arranges a row (`fixture.ts` names the
 * worktree, the roster and the ids), drives it, and compares what it observes
 * (`observe.ts`) with {@link TableRow.expected}.
 *
 * The expectation is the design's, not today's: a refused operation leaves nothing (I1),
 * the policy refusal comes before the non-policy one (I9), and the judgments run in the
 * order of §4.2 (b): the target's policy, the relay (rule 0, its ends resolved strictly),
 * Auto-Yes, then the roster, the role and mem.
 *
 * Folding (design §6.1, P5): the declaration axis is folded. `api-key` lifts every
 * restriction (`ANTIGRAVITY_RESTRICTION.unlockedBy`, `src/lib/tool-policy/policy.ts`; rule
 * 0 of the relay reads the same table), so its rows are one "all allowed" row per base
 * operation instead of a copy of the whole product. The modifiers are crossed as the
 * subsets of the three that write (`--reply-to`, `--auto-yes`, `--note`), plus each of the
 * four that do not write (`--model`, `--new-conversation`, `--no-brief`, `--with-brief`)
 * alone and with `--auto-yes` (the only one of them a policy reads: `--model --auto-yes`
 * is K2). Combinations the CLI refuses on their own (exit 2 before any request) are
 * left out: `--note` without `--reply-to`, `--model` on a tool it does not apply to.
 */

import { FIXTURE } from './fixture';

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

/** The judgment a row is built to be refused by (`none`: allowed). §6.1 「拒否する段」. */
export type Family =
  | 'target-policy'
  | 'relay-rule0'
  | 'auto-yes-policy'
  | 'relay-non-policy'
  | 'roster'
  | 'mem'
  | 'none'
  | 'declared'
  | 'interrupt'
  | 'mismatch'
  | 'endpoint-unresolved'
  | 's1-writes-nothing';

/** §6.1 「割り込み」. `to-deny`: from the allowing value to the refusing one; `to-other`: to another allowed value. */
export type Interrupt =
  | { kind: 'none' }
  | { kind: 'h-S2'; input: 'roster-tool' | 'default' | 'reply-to-roster' | 'declaration'; direction: 'to-deny' | 'to-other' }
  | { kind: 'h-S3' }
  | { kind: 'h-S3b' }
  | { kind: 'h-S1-stop' };

/** `policy.stage` of the refusal (§5.1 C1). */
export type PolicyStage = 'target' | 'relay' | 'auto-yes';

export type Expected =
  | {
      kind: 'refused';
      /** HTTP status, or `non-2xx` where the design leaves the number to PR1b. */
      status: number | 'non-2xx';
      /** The response `code` must be one of these; null = any (the design names none). */
      codes: readonly string[] | null;
      policyStage?: PolicyStage;
      /** The CLI's exit for this refusal (§5.1). */
      exit: number;
    }
  | {
      kind: 'allowed';
      writes: {
        task: boolean;
        /** The instance id that must be on the roster afterwards and was not before, or null. */
        rosterRow: string | null;
        /** The instance whose role setting changes, or null. */
        roleOf: string | null;
        relay: boolean;
        note: boolean;
        grant: boolean;
      };
      /** The tool whose pane the message is typed into (S2's, I2). */
      typedTool: Tool;
    }
  | { kind: 'stopped' };

export interface TableRow {
  name: string;
  family: Family;
  base: BaseOp;
  modifiers: readonly Modifier[];
  origin: Origin;
  declaration: Declaration;
  /** What the operation names: an instance (on the roster or ad-hoc) and `--agent` when given. */
  target: { instanceId: string; agent?: Tool };
  /** The tool that instance is (the tool S2 types into). */
  targetTool: Tool;
  /** The worktree's default tool (the fixture's is codex). */
  worktreeDefault: Tool;
  /** The reply-to end (an instance of {@link FIXTURE.worktreeId}). */
  replyTo?: { instanceId: string; tool: Tool };
  /** The roster is full before the operation (the roster check refuses `--register`). */
  rosterFull: boolean;
  /** Whether mem is on for the branch (`--note` is refused when it is not). */
  memOn: boolean;
  interrupt: Interrupt;
  /** An instance whose roster read throws (§6.1 「端の解決の失敗」). */
  rosterFault?: string;
  expected: Expected;
}

const has = (row: Pick<TableRow, 'modifiers'>, modifier: Modifier): boolean => row.modifiers.includes(modifier);
const writesContract = (base: BaseOp): boolean => base === 'contract' || base === 'contract-role';
const registers = (base: BaseOp): boolean => base === 'register' || base === 'register-role';
const setsRole = (base: BaseOp): boolean => ['register-role', 'role', 'no-role', 'contract-role'].includes(base);

/** Exit codes (src/cli/types: 33 tool policy, 31 conflict, 2 usage / relay refusals, 99 unexpected). */
export const EXIT = { policy: 33, conflict: 31, usage: 2, unexpected: 99 } as const;

/** mem's refusals the route may answer for a note on a branch where mem is not on (§5.1 C4). */
export const MEM_REFUSAL_CODES = ['disabled', 'branch_unresolved', 'not_registered', 'ambiguous', 'limit_exceeded'] as const;

/** Every modifier set: the subsets of the writing three, and each plain one alone and with --auto-yes. */
export function modifierSets(): Modifier[][] {
  const subsets: Modifier[][] = [];
  for (let mask = 0; mask < 1 << WRITING_MODIFIERS.length; mask += 1) {
    subsets.push(WRITING_MODIFIERS.filter((_m, bit) => (mask >> bit) & 1));
  }
  const plain = PLAIN_MODIFIERS.flatMap((modifier): Modifier[][] => [[modifier], ['auto-yes', modifier]]);
  return [...subsets, ...plain].filter((set) => !set.includes('note') || set.includes('reply-to'));
}

/** The tool `--model` is given with on an allowed row (codex takes no --model). */
function toolFor(intended: Tool, modifiers: readonly Modifier[]): Tool {
  return modifiers.includes('model') && intended === 'codex' ? 'claude' : intended;
}

function targetOf(base: BaseOp, tool: Tool): { target: TableRow['target']; targetTool: Tool } {
  if (registers(base)) return { target: { instanceId: FIXTURE.adHoc, agent: tool }, targetTool: tool };
  return { target: { instanceId: FIXTURE.instanceOf[tool] }, targetTool: tool };
}

/**
 * The design's verdict for a row, in the order of §4.2: S0's early policy judgment and
 * S2 (b) — target, relay (an unresolved end fails closed), Auto-Yes — then the non-policy
 * refusals (I9): the relay's own rules, the roster, mem.
 */
export function verdictOf(row: Omit<TableRow, 'expected' | 'name'>): Expected {
  if (row.interrupt.kind === 'h-S1-stop') return { kind: 'stopped' };
  const declared = row.declaration === 'api-key';
  const restricted = (tool: Tool): boolean => tool === 'antigravity' && !declared;
  if (restricted(row.targetTool) && !isHuman(row.origin)) {
    return { kind: 'refused', status: 409, codes: ['TOOL_POLICY_DENIED'], policyStage: 'target', exit: EXIT.policy };
  }
  if (row.replyTo) {
    if (row.rosterFault === row.replyTo.instanceId) {
      return { kind: 'refused', status: 503, codes: ['RELAY_ENDPOINT_UNRESOLVED'], exit: EXIT.unexpected };
    }
    // I2a: `to` is judged by the tool actually typed into, `from` by the roster's.
    if (restricted(row.targetTool) || restricted(row.replyTo.tool)) {
      return { kind: 'refused', status: 409, codes: ['RELAY_TOOL_POLICY_DENIED'], policyStage: 'relay', exit: EXIT.policy };
    }
  }
  if (has(row, 'auto-yes') && restricted(row.targetTool)) {
    return { kind: 'refused', status: 409, codes: ['TOOL_POLICY_DENIED'], policyStage: 'auto-yes', exit: EXIT.policy };
  }
  if (row.replyTo && row.replyTo.instanceId === row.target.instanceId) {
    return { kind: 'refused', status: 409, codes: ['RELAY_SELF_TARGET'], exit: EXIT.usage };
  }
  if (registers(row.base) && row.rosterFull) {
    return { kind: 'refused', status: 'non-2xx', codes: null, exit: EXIT.usage };
  }
  if (has(row, 'note') && !row.memOn) {
    return { kind: 'refused', status: 'non-2xx', codes: MEM_REFUSAL_CODES, exit: EXIT.usage };
  }
  return {
    kind: 'allowed',
    writes: {
      task: writesContract(row.base),
      rosterRow: registers(row.base) ? row.target.instanceId : null,
      roleOf: setsRole(row.base) ? row.target.instanceId : null,
      relay: Boolean(row.replyTo),
      note: has(row, 'note'),
      grant: has(row, 'auto-yes'),
    },
    typedTool: row.targetTool,
  };
}

/** The verdict of an h-S2 row: the inputs S2 reads again (I3c) are the changed ones. */
function interruptVerdict(row: Omit<TableRow, 'expected' | 'name'>): Expected {
  const interrupt = row.interrupt;
  if (interrupt.kind !== 'h-S2') return verdictOf(row);
  if (interrupt.input === 'declaration') {
    // Not a target: the declaration is read again in S2 and judged. Turned the other way
    // (none → api-key), S0's early judgment has refused already, before the hook (I9).
    return verdictOf({ ...row, declaration: 'none' });
  }
  // A changed target or reply-to end is S1's candidate no longer (§4.2 (a)): nothing is
  // written, and it may be sent again. To the refusing tool, the policy may say it first.
  const changed = { kind: 'refused', status: 409, codes: ['OPERATION_TARGET_CHANGED'], exit: EXIT.conflict } as const;
  if (interrupt.direction === 'to-other') return changed;
  const policyCode = interrupt.input === 'reply-to-roster' ? 'RELAY_TOOL_POLICY_DENIED' : 'TOOL_POLICY_DENIED';
  return { ...changed, codes: ['OPERATION_TARGET_CHANGED', policyCode] };
}

function row(fields: Omit<TableRow, 'expected' | 'name'>, label: string, expected?: Expected): TableRow {
  const mods = fields.modifiers.length > 0 ? ` +${fields.modifiers.join('+')}` : '';
  const decl = fields.declaration === 'api-key' ? ' [api-key]' : '';
  return {
    ...fields,
    name: `${label}: ${fields.base}${mods} → ${fields.target.instanceId}(${fields.targetTool}) from ${fields.origin}${decl}`,
    expected: expected ?? interruptVerdict(fields),
  };
}

const plain = { declaration: 'none' as const, worktreeDefault: 'codex' as const, rosterFull: false, memOn: true, interrupt: { kind: 'none' } as const };
const replyToOf = (modifiers: readonly Modifier[], tool: Tool = 'claude'): TableRow['replyTo'] =>
  modifiers.includes('reply-to')
    ? { instanceId: tool === 'antigravity' ? FIXTURE.replyToAntigravity : FIXTURE.replyTo, tool }
    : undefined;

/** Every row of the new route's table (design §6.1). */
export function sendOperationRows(): TableRow[] {
  const rows: TableRow[] = [];
  const combos = BASE_OPS.flatMap((base) => modifierSets().map((modifiers) => ({ base, modifiers })));

  // 拒否する段 = 宛先の方針: antigravity, no declaration, from everyone but a person.
  for (const { base, modifiers } of combos) {
    for (const origin of ORIGINS.filter((o) => !isHuman(o))) {
      rows.push(row({ ...plain, base, modifiers, origin, ...targetOf(base, 'antigravity'), replyTo: replyToOf(modifiers), family: 'target-policy' }, 'target-policy'));
    }
  }
  // relay の規則 0: the reply-to end is antigravity; every origin.
  for (const { base, modifiers } of combos.filter(({ modifiers }) => modifiers.includes('reply-to'))) {
    for (const origin of ORIGINS) {
      rows.push(row({ ...plain, base, modifiers, origin, ...targetOf(base, toolFor('codex', modifiers)), replyTo: replyToOf(modifiers, 'antigravity'), family: 'relay-rule0' }, 'relay-rule0'));
    }
  }
  // Auto-Yes の方針: a person may send to antigravity, nobody may arm Auto-Yes on it.
  for (const { base, modifiers } of combos.filter(({ modifiers }) => modifiers.includes('auto-yes'))) {
    for (const origin of HUMAN_ORIGINS) {
      rows.push(row({ ...plain, base, modifiers, origin, ...targetOf(base, 'antigravity'), replyTo: replyToOf(modifiers), family: 'auto-yes-policy' }, 'auto-yes-policy'));
    }
  }
  // relay の方針以外 (C5): the reply-to end is the target itself.
  for (const { base, modifiers } of combos.filter(({ modifiers }) => modifiers.includes('reply-to'))) {
    const { target, targetTool } = targetOf(base, toolFor('codex', modifiers));
    rows.push(row({ ...plain, base, modifiers, origin: 'terminal', target, targetTool, replyTo: { instanceId: target.instanceId, tool: targetTool }, family: 'relay-non-policy' }, 'relay-non-policy'));
  }
  // 名簿 (C6): --register on a full roster.
  for (const { base, modifiers } of combos.filter(({ base }) => registers(base))) {
    rows.push(row({ ...plain, rosterFull: true, base, modifiers, origin: 'terminal', ...targetOf(base, toolFor('codex', modifiers)), replyTo: replyToOf(modifiers), family: 'roster' }, 'roster'));
  }
  // mem (C4): --note on a branch where mem is not on.
  for (const { base, modifiers } of combos.filter(({ modifiers }) => modifiers.includes('note'))) {
    rows.push(row({ ...plain, memOn: false, base, modifiers, origin: 'session', ...targetOf(base, toolFor('codex', modifiers)), replyTo: replyToOf(modifiers), family: 'mem' }, 'mem'));
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
  // 割り込み: h-S2 on each input, both ways; h-S3; h-S3b.
  const interruptBase = { ...plain, base: 'contract' as const, modifiers: ['reply-to', 'auto-yes'] as Modifier[], ...targetOf('contract', 'codex'), family: 'interrupt' as const };
  for (const input of ['roster-tool', 'default', 'reply-to-roster', 'declaration'] as const) {
    for (const direction of ['to-deny', 'to-other'] as const) {
      const declaration: Declaration = input === 'declaration' && direction === 'to-deny' ? 'api-key' : 'none';
      // `default`: the operation names no target, so S2 resolves the worktree's default.
      // `declaration`: only antigravity's verdict reads it, so the target is antigravity.
      const targeted = input === 'default'
        ? { target: { instanceId: '' }, targetTool: 'codex' as const }
        : input === 'declaration' ? targetOf('contract', 'antigravity') : targetOf('contract', 'codex');
      rows.push(row({ ...interruptBase, declaration, ...targeted, origin: 'agent', replyTo: replyToOf(interruptBase.modifiers), interrupt: { kind: 'h-S2', input, direction } }, `h-S2 ${input} ${direction}`));
    }
  }
  rows.push(row({ ...interruptBase, origin: 'agent', replyTo: replyToOf(interruptBase.modifiers), interrupt: { kind: 'h-S3' } }, 'h-S3 the roster tool turns antigravity after the launch'));
  rows.push(row({ ...interruptBase, origin: 'agent', replyTo: replyToOf(interruptBase.modifiers), interrupt: { kind: 'h-S3b' } }, 'h-S3b the reply-to end turns antigravity after the keys'));
  // S1 の「書き込み無し」: stop after S1, every base with every writing modifier.
  for (const base of BASE_OPS) {
    const modifiers: Modifier[] = ['reply-to', 'auto-yes', 'note'];
    rows.push(row({ ...plain, base, modifiers, origin: 'session', ...targetOf(base, 'codex'), replyTo: replyToOf(modifiers), interrupt: { kind: 'h-S1-stop' }, family: 's1-writes-nothing' }, 'S1 writes nothing'));
  }
  // 解決の食い違い (N1, I2a): an ad-hoc id + --agent antigravity + --reply-to, with and without --register.
  for (const base of ['send', 'register'] as const) {
    for (const origin of ORIGINS) {
      rows.push(row({ ...plain, base, modifiers: ['reply-to'], origin, target: { instanceId: FIXTURE.adHoc, agent: 'antigravity' }, targetTool: 'antigravity', replyTo: replyToOf(['reply-to']), family: 'mismatch' }, 'mismatch'));
    }
    // Control: --agent codex with the default claude — allowed, and `to` is judged as codex (the response's policy).
    rows.push(row({ ...plain, worktreeDefault: 'claude', base, modifiers: ['reply-to'], origin: 'agent', target: { instanceId: FIXTURE.adHoc, agent: 'codex' }, targetTool: 'codex', replyTo: replyToOf(['reply-to']), family: 'mismatch' }, 'mismatch control'));
  }
  // 端の解決の失敗: the reply-to end's roster read throws.
  rows.push(row({ ...plain, base: 'send', modifiers: ['reply-to'], origin: 'agent', ...targetOf('send', 'codex'), replyTo: replyToOf(['reply-to']), rosterFault: FIXTURE.replyTo, family: 'endpoint-unresolved' }, 'endpoint-unresolved'));

  return rows;
}

/**
 * The body of `POST /api/worktrees/:id/send-operation` for a row (§4.1). `roleId` is the
 * fixture's role, known only once it is created.
 */
export function sendOperationBody(row: TableRow, roleId: string): Record<string, unknown> {
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
      durationMs: 3_600_000,
      timing: afterSend ? 'after-send' : 'before-send',
      onlyIfOff: true,
      answerMode: 'recommended',
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
