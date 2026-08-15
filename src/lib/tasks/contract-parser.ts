/**
 * Loader and validator for `.commandmate/tasks/<name>.yaml` — the execution
 * contract (Issue #1545, Phase 2-1).
 *
 * Canonical spec: docs/design/task-contract.md
 *
 * A contract declares, before the message is ever sent, what the task is for,
 * which paths may change, what counts as done, and what the auto-answer policy
 * is. This module only *validates and preserves* those declarations: the scope
 * gate is #1546 and autoYes enforcement is #1547.
 *
 * Written in the same discipline as `lib/verification/verify-config.ts`: the
 * `yaml` package, every violation collected rather than thrown one at a time,
 * a closed key set, and a dedicated error class. Note that the Issue body says
 * "ignore unknown keys" while also requiring that discipline; verify-config
 * rejects them, and so does this. A misspelled `allowPromtTypes` that parsed
 * cleanly would produce a contract that looks like it constrains auto-answering
 * and does not — the worst failure a contract can have.
 *
 * Server-only: reads from disk, so import from API routes / CLI only.
 *
 * @module lib/tasks/contract-parser
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { isPathSafe } from '@/lib/security/path-validator';
import {
  GATE_ID_PATTERN,
  validateGateEntries,
  type VerifyGate,
} from '@/lib/verification/verify-config';
import type { PromptType } from '@/types/models';

/** Directory contracts live in, relative to the worktree root. */
export const TASK_CONTRACT_DIR = '.commandmate/tasks';

/**
 * Auto-answer policy modes.
 *
 * A contract that omits `autoYes.mode` leaves the mode `null`, which is *not*
 * `off`: null means "this contract says nothing about auto-answering, keep the
 * existing behaviour", while `off` is an active prohibition. Phase 2-3's
 * enforcement has to be able to tell those apart.
 */
export const AUTO_YES_MODES = ['off', 'safe', 'allow-listed'] as const;

export type AutoYesMode = (typeof AUTO_YES_MODES)[number];

/**
 * Prompt-type names accepted in `autoYes.allowPromptTypes`.
 *
 * Built from a `Record<PromptType, true>` so the list is exhaustive by
 * construction: adding a variant to {@link PromptType} without adding it here
 * fails the build, instead of silently making a valid contract invalid.
 */
const PROMPT_TYPE_KEYS: Record<PromptType, true> = {
  yes_no: true,
  multiple_choice: true,
  approval: true,
  choice: true,
  input: true,
  continue: true,
};

export const PROMPT_TYPES = Object.keys(PROMPT_TYPE_KEYS) as PromptType[];

export interface TaskContractScope {
  /** Glob patterns, relative to the worktree root, that may be changed. */
  allow: string[];
  /** Glob patterns that must not be changed even when an allow pattern matches. */
  deny: string[];
}

export interface TaskContractVerify {
  /**
   * Gate ids to run; null means "every declared gate".
   *
   * A *selection*, never a definition — the ids come from verify.yaml or from
   * {@link TaskContractVerify.gateDefinitions} below. null resolves to every
   * verify.yaml gate plus every gate this contract defines.
   */
  gates: string[] | null;
  /**
   * Gates that exist for this delegation alone (Issue #1791).
   *
   * An Issue-specific check (a reproduction script, a one-off invariant) has to
   * reach the worktree somehow, and the only other route was for the
   * orchestrator to append it to `.commandmate/verify.yaml` — a file that stays
   * in the work-evidence change set (#1756), so a worktree carrying nothing but
   * that append reads as "the agent did work". The contract is already
   * snapshotted into `tasks.contract_json` at send time and already excluded
   * from both gates' change sets (#1580), so carrying the definition here adds
   * no tamper surface that did not already exist.
   *
   * Empty when the contract defines none, which is the ordinary case.
   */
  gateDefinitions: VerifyGate[];
}

export interface TaskContractAutoYes {
  /** null when the contract declares no policy (see {@link AUTO_YES_MODES}). */
  mode: AutoYesMode | null;
  /** Only meaningful under `mode: allow-listed`. */
  allowPromptTypes: PromptType[];
  /** Regex sources that must escalate to a human instead of being auto-answered. */
  denyPatterns: string[];
}

export interface TaskContractSuccess {
  requireWorkEvidence: boolean;
  /** Honoured by the scope gate in Phase 2-2 (#1546); ignored until then. */
  requireScopeClean: boolean;
  /**
   * Make the work-evidence gate demand a commit, not just a dirty tree (#1642).
   *
   * The preamble has always told the agent "未 commit の作業は未完了とみなされる"
   * while the gate passed on `commits=0 uncommitted=1` — a rule declared and
   * never checked (#1628 D-4). `options.requireCommit` in verify.yaml answers
   * the same need per *repository*, which cannot separate "a delegated worker
   * must commit" from "my own interactive `commandmate verify` must not be
   * blocked by uncommitted work". This flag answers it per *delegation*.
   *
   * The two are ORed, never overridden: a contract can turn the requirement on
   * where the repository left it off, but cannot turn one the repository set
   * back off. Letting it relax the repository's rule would reopen the same hole
   * one delegation at a time.
   *
   * Defaults to false for the reason {@link autoVerifyOnStop} does — every
   * contract written before this field existed would otherwise change verdict.
   */
  requireCommit: boolean;
  /**
   * Run the verification gates when the agent reports it stopped (#1549).
   *
   * Defaults to false while its siblings default to true, because it is the one
   * flag that makes the server *do* something rather than judge something: a
   * contract written before this field existed must not start spawning
   * verification runs the moment a Stop hook is configured.
   */
  autoVerifyOnStop: boolean;
}

export interface TaskContract {
  version: 1;
  title: string;
  goal: string;
  scope: TaskContractScope;
  verify: TaskContractVerify;
  autoYes: TaskContractAutoYes;
  success: TaskContractSuccess;
}

export const MAX_TITLE_LENGTH = 200;
export const MAX_GOAL_LENGTH = 8000;
/** Applies to scope patterns and to autoYes.denyPatterns (ReDoS bound). */
export const MAX_PATTERN_LENGTH = 200;
export const MAX_SCOPE_PATTERNS = 200;
export const MAX_GATE_IDS = 32;
/** Matches {@link MAX_GATE_IDS}: a contract cannot select more gates than it may define. */
export const MAX_GATE_DEFINITIONS = 32;
export const MAX_DENY_PATTERNS = 32;
export const MAX_ALLOW_PROMPT_TYPES = 16;

const TOP_LEVEL_KEYS = ['version', 'title', 'goal', 'scope', 'verify', 'autoYes', 'success'];
const SCOPE_KEYS = ['allow', 'deny'];
const VERIFY_KEYS = ['gates', 'gateDefinitions'];
const AUTO_YES_KEYS = ['mode', 'allowPromptTypes', 'denyPatterns'];
const SUCCESS_KEYS = [
  'requireWorkEvidence',
  'requireScopeClean',
  'requireCommit',
  'autoVerifyOnStop',
];

export class TaskContractError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`invalid task contract:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'TaskContractError';
    this.issues = issues;
  }
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asInteger(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  return String(value);
}

function collectUnknownKeys(
  mapping: Record<string, unknown>,
  allowed: string[],
  at: string,
  issues: string[]
): void {
  for (const key of Object.keys(mapping)) {
    if (!allowed.includes(key)) {
      issues.push(`${at}: unknown key "${key}" (v1 is a closed set)`);
    }
  }
}

/**
 * Validate a list of strings, rejecting per-entry violations individually.
 *
 * @returns the accepted entries; entries that produced an issue are dropped so
 *          the returned contract never carries a value that failed validation
 */
function validateStringList(
  value: unknown,
  at: string,
  limits: { maxEntries: number; maxLength: number },
  issues: string[]
): string[] | null {
  if (value === undefined) return null;
  if (value === null) return [];
  if (!Array.isArray(value)) {
    issues.push(`${at}: must be a list (got ${describe(value)})`);
    return null;
  }
  if (value.length > limits.maxEntries) {
    issues.push(`${at}: at most ${limits.maxEntries} entries (got ${value.length})`);
    return null;
  }

  const accepted: string[] = [];
  value.forEach((entry, index) => {
    const entryAt = `${at}[${index}]`;
    if (typeof entry !== 'string' || entry.trim() === '') {
      issues.push(`${entryAt}: must be a non-empty string (got ${describe(entry)})`);
      return;
    }
    if (entry.length > limits.maxLength) {
      issues.push(`${entryAt}: at most ${limits.maxLength} characters (got ${entry.length})`);
      return;
    }
    accepted.push(entry);
  });
  return accepted;
}

/**
 * A scope pattern can only speak about the inside of the worktree.
 *
 * An absolute path or a `..` segment is unjudgeable by the Phase 2-2 gate, and
 * a NUL byte is never a path — all three are rejected at declaration time
 * rather than becoming a pattern that silently matches nothing.
 */
function validateScopePattern(pattern: string, at: string, issues: string[]): void {
  if (pattern.includes('\0')) {
    issues.push(`${at}: must not contain a NUL byte`);
    return;
  }
  if (pattern.startsWith('/')) {
    issues.push(`${at}: must be relative to the worktree root (got the absolute path "${pattern}")`);
    return;
  }
  if (pattern.split('/').includes('..')) {
    issues.push(`${at}: must not escape the worktree root with ".." (got "${pattern}")`);
  }
}

function validateScope(value: unknown, issues: string[]): TaskContractScope {
  const scope: TaskContractScope = { allow: [], deny: [] };
  if (value === undefined || value === null) return scope;

  if (!isMapping(value)) {
    issues.push(`scope: must be a mapping (got ${describe(value)})`);
    return scope;
  }
  collectUnknownKeys(value, SCOPE_KEYS, 'scope', issues);

  const limits = { maxEntries: MAX_SCOPE_PATTERNS, maxLength: MAX_PATTERN_LENGTH };
  for (const key of ['allow', 'deny'] as const) {
    const list = validateStringList(value[key], `scope.${key}`, limits, issues);
    if (!list) continue;
    list.forEach((pattern, index) =>
      validateScopePattern(pattern, `scope.${key}[${index}]`, issues)
    );
    scope[key] = list;
  }

  return scope;
}

/**
 * Validate `verify.gateDefinitions` (Issue #1791).
 *
 * Delegates every per-entry rule to verify-config's own gate validator, so a
 * gate defined in a contract is held to exactly the constraints a gate declared
 * in `.commandmate/verify.yaml` is — including the reserved ids, which is where
 * a contract shadowing `work-evidence` or `scope` is rejected. That rejection
 * lands here, at parse time, rather than in the verify.yaml cross-check: it
 * needs no config to decide, and both run at send.
 *
 * An empty list is accepted as equivalent to omitting the key. Unlike
 * `verify.gates: []` — which would read as "pass having run nothing" — a
 * definition list with no entries has exactly one possible meaning, and an
 * orchestrator that emits YAML programmatically should not have to special-case
 * "this delegation happens to need no extra gate".
 */
function validateGateDefinitions(value: unknown, issues: string[]): VerifyGate[] {
  if (value === undefined || value === null) return [];

  if (Array.isArray(value) && value.length > MAX_GATE_DEFINITIONS) {
    issues.push(
      `verify.gateDefinitions: at most ${MAX_GATE_DEFINITIONS} entries (got ${value.length})`
    );
    return [];
  }

  return validateGateEntries(value, 'verify.gateDefinitions', issues);
}

function validateVerify(value: unknown, issues: string[]): TaskContractVerify {
  const empty = (): TaskContractVerify => ({ gates: null, gateDefinitions: [] });
  if (value === undefined || value === null) return empty();

  if (!isMapping(value)) {
    issues.push(`verify: must be a mapping (got ${describe(value)})`);
    return empty();
  }
  collectUnknownKeys(value, VERIFY_KEYS, 'verify', issues);

  const gateDefinitions = validateGateDefinitions(value.gateDefinitions, issues);
  const withDefinitions = (gates: string[] | null): TaskContractVerify => ({
    gates,
    gateDefinitions,
  });

  if (value.gates === undefined || value.gates === null) return withDefinitions(null);

  const gates = validateStringList(
    value.gates,
    'verify.gates',
    { maxEntries: MAX_GATE_IDS, maxLength: 32 },
    issues
  );
  if (!gates) return withDefinitions(null);

  // An empty list would read as "pass with no gates run". "Run everything" is
  // spelled by omitting the key, so the two can never be confused.
  if (Array.isArray(value.gates) && value.gates.length === 0) {
    issues.push('verify.gates: must name at least one gate (omit the key to run every gate)');
    return withDefinitions(null);
  }

  const valid: string[] = [];
  const seen = new Set<string>();
  gates.forEach((id, index) => {
    if (!GATE_ID_PATTERN.test(id)) {
      issues.push(`verify.gates[${index}]: "${id}" must match ${GATE_ID_PATTERN.source}`);
      return;
    }
    if (seen.has(id)) {
      issues.push(`verify.gates[${index}]: duplicate gate id "${id}"`);
      return;
    }
    seen.add(id);
    valid.push(id);
  });

  return withDefinitions(valid.length > 0 ? valid : null);
}

function validateAutoYes(value: unknown, issues: string[]): TaskContractAutoYes {
  const autoYes: TaskContractAutoYes = { mode: null, allowPromptTypes: [], denyPatterns: [] };
  if (value === undefined || value === null) return autoYes;

  if (!isMapping(value)) {
    issues.push(`autoYes: must be a mapping (got ${describe(value)})`);
    return autoYes;
  }
  collectUnknownKeys(value, AUTO_YES_KEYS, 'autoYes', issues);

  if (value.mode !== undefined && value.mode !== null) {
    if (
      typeof value.mode !== 'string' ||
      !(AUTO_YES_MODES as readonly string[]).includes(value.mode)
    ) {
      issues.push(
        `autoYes.mode: must be one of ${AUTO_YES_MODES.join(', ')} (got ${describe(value.mode)})`
      );
    } else {
      autoYes.mode = value.mode as AutoYesMode;
    }
  }

  const promptTypes = validateStringList(
    value.allowPromptTypes,
    'autoYes.allowPromptTypes',
    { maxEntries: MAX_ALLOW_PROMPT_TYPES, maxLength: 64 },
    issues
  );
  if (promptTypes) {
    promptTypes.forEach((type, index) => {
      if (!(PROMPT_TYPES as readonly string[]).includes(type)) {
        issues.push(
          `autoYes.allowPromptTypes[${index}]: unknown prompt type "${type}" ` +
            `(known: ${PROMPT_TYPES.join(', ')})`
        );
        return;
      }
      autoYes.allowPromptTypes.push(type as PromptType);
    });
  }

  const denyPatterns = validateStringList(
    value.denyPatterns,
    'autoYes.denyPatterns',
    { maxEntries: MAX_DENY_PATTERNS, maxLength: MAX_PATTERN_LENGTH },
    issues
  );
  if (denyPatterns) {
    denyPatterns.forEach((pattern, index) => {
      try {
        new RegExp(pattern);
      } catch (error) {
        issues.push(
          `autoYes.denyPatterns[${index}]: not a valid regular expression: ${(error as Error).message}`
        );
        return;
      }
      autoYes.denyPatterns.push(pattern);
    });
  }

  return autoYes;
}

function validateSuccess(value: unknown, issues: string[]): TaskContractSuccess {
  const success: TaskContractSuccess = {
    requireWorkEvidence: true,
    requireScopeClean: true,
    requireCommit: false,
    autoVerifyOnStop: false,
  };
  if (value === undefined || value === null) return success;

  if (!isMapping(value)) {
    issues.push(`success: must be a mapping (got ${describe(value)})`);
    return success;
  }
  collectUnknownKeys(value, SUCCESS_KEYS, 'success', issues);

  for (const key of SUCCESS_KEYS as Array<keyof TaskContractSuccess>) {
    if (value[key] === undefined) continue;
    const parsed = asBoolean(value[key]);
    if (parsed === null) {
      issues.push(`success.${key}: must be true or false (got ${describe(value[key])})`);
      continue;
    }
    success[key] = parsed;
  }

  return success;
}

function validateText(
  value: unknown,
  key: 'title' | 'goal',
  maxLength: number,
  issues: string[]
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push(`${key}: required, must be a non-empty string (got ${describe(value)})`);
    return '';
  }
  if (value.length > maxLength) {
    issues.push(`${key}: at most ${maxLength} characters (got ${value.length})`);
    return '';
  }
  return value.trim();
}

/**
 * Parse and validate a contract document.
 *
 * @param raw YAML source
 * @param sourceLabel path or label used to prefix document-level issues
 * @throws TaskContractError with every violation collected in `issues`
 */
export function parseTaskContract(raw: string, sourceLabel: string): TaskContract {
  let document: unknown;
  try {
    document = parseYaml(raw);
  } catch (error) {
    throw new TaskContractError([`${sourceLabel}: YAML parse error: ${(error as Error).message}`]);
  }

  if (!isMapping(document)) {
    throw new TaskContractError([
      `${sourceLabel}: expected a YAML mapping at the top level (got ${describe(document)})`,
    ]);
  }

  const issues: string[] = [];
  collectUnknownKeys(document, TOP_LEVEL_KEYS, 'top level', issues);

  if (!('version' in document)) {
    issues.push('version: required, v1 contracts must declare "version: 1"');
  } else if (asInteger(document.version) !== 1) {
    issues.push(`version: must be 1 (got ${describe(document.version)})`);
  }

  const title = validateText(document.title, 'title', MAX_TITLE_LENGTH, issues);
  const goal = validateText(document.goal, 'goal', MAX_GOAL_LENGTH, issues);
  const success = validateSuccess(document.success, issues);
  const scope = validateScope(document.scope, issues);
  const verify = validateVerify(document.verify, issues);
  const autoYes = validateAutoYes(document.autoYes, issues);

  // Checked after both sections are parsed: "keep changes inside scope" with no
  // scope listed makes the Phase 2-2 gate reject every change the moment it
  // switches on, so the contract is rejected now instead.
  if (success.requireScopeClean && scope.allow.length === 0) {
    issues.push(
      'scope.allow: at least one pattern is required while success.requireScopeClean is true'
    );
  }

  // Same discipline, and the same failure it prevents: the commit requirement is
  // judged by the work-evidence gate, and `requireWorkEvidence: false` keeps that
  // gate out of the contract's selection entirely. Accepting the pair would put
  // "必ず commit" in the preamble with nothing behind it — the exact D-4 defect
  // this field exists to close.
  if (success.requireCommit && !success.requireWorkEvidence) {
    issues.push(
      'success.requireCommit: requires success.requireWorkEvidence to be true ' +
        '(the commit requirement is judged by the work-evidence gate, which ' +
        'requireWorkEvidence: false switches off)'
    );
  }

  // Same rule again, for the gates this contract defines itself (#1791). A
  // definition that `verify.gates` leaves out is a check the contract appears to
  // add and never runs — and it is the *only* declaration of that gate, so
  // unlike a verify.yaml gate there is no other run that would ever execute it.
  // Selecting a subset is spelled by deleting the definition.
  if (verify.gates) {
    const unselected = verify.gateDefinitions
      .map((gate) => gate.id)
      .filter((id) => !verify.gates?.includes(id));
    if (unselected.length > 0) {
      issues.push(
        `verify.gateDefinitions: ${unselected.join(', ')} defined but not named in verify.gates, ` +
          'so nothing would ever run them (list them, or delete the definition)'
      );
    }
  }

  if (issues.length > 0) throw new TaskContractError(issues);

  return { version: 1, title, goal, scope, verify, autoYes, success };
}

/**
 * Read and validate a contract inside a worktree.
 *
 * `relativePath` is resolved against `worktreePath` and must stay inside it: a
 * contract is a statement about one worktree, and a path that leaves it would
 * let a send read an arbitrary file off the server's disk.
 *
 * @throws TaskContractError when the path escapes, the file is unreadable, or
 *         the document is invalid
 */
export function loadTaskContract(worktreePath: string, relativePath: string): TaskContract {
  if (!isPathSafe(relativePath, worktreePath)) {
    throw new TaskContractError([
      `${relativePath}: contract path must be inside the worktree (${worktreePath})`,
    ]);
  }

  const absolutePath = join(worktreePath, relativePath);

  let raw: string;
  try {
    raw = readFileSync(absolutePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new TaskContractError([
      code === 'ENOENT'
        ? `${relativePath}: contract file not found in ${worktreePath}`
        : `${relativePath}: ${(error as Error).message}`,
    ]);
  }

  return parseTaskContract(raw, relativePath);
}
