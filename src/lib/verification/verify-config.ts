/**
 * Loader and validator for `.commandmate/verify.yaml`.
 *
 * Canonical spec: docs/design/verification-config.md
 * Phase 0 reference implementation: .claude/skills/cmate-verify/scripts/verify-run.sh
 *
 * Server-only: reads from disk, so import this from API routes / CLI only.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

export interface VerifyGate {
  id: string;
  command: string;
  timeoutSec: number;
  /**
   * Name of a machine-wide lock this gate must hold while it runs (Issue #1771).
   *
   * Declares "only one of these may run on this machine at a time", which a
   * gate owning a fixed port, database or emulator needs and which command and
   * timeout cannot express. Two parallel worktrees running such a gate at once
   * make the second fail on the resource, and `GATE e2e FAIL exit=1` reads
   * exactly like the change being broken.
   *
   * Optional rather than `string | null`: contracts store their gate list as
   * JSON in `tasks.contract_json` and are read back with `JSON.parse`, never
   * re-validated, so every row written before this field existed simply has no
   * key — and `undefined` is the honest reading of that.
   */
  mutex?: string;
}

export interface VerifyOptions {
  /** null when unset; the caller resolves the repository default branch. */
  baseRef: string | null;
  skipInPrimaryCheckout: boolean;
  maxLogTailBytes: number;
  /**
   * Whether `work-evidence` demands a COMMIT rather than any change at all
   * (Issue #1628, D-4). Default false — the gate's job has always been "is
   * there work here to verify", and a dirty tree answers that.
   *
   * Turn it on in a repository whose delegations end in a commit (the task
   * contract preamble tells agents "未 commit の作業は未完了とみなされる", and
   * without this the gate happily passes `commits=0 uncommitted=1`, so
   * `RESULT passed` proved nothing about the commit). Repository-wide by
   * design: it is a property of how the repository is worked, not of one run.
   */
  requireCommit: boolean;
  /**
   * Whether the built-in `env-clean` gate judges this repository's runs
   * (Issue #1740). Default false — every contract written before the gate
   * existed must keep its verdict, and a gate that starts failing runs the day
   * it lands is a gate that gets switched off again.
   *
   * Turning it on has a second effect: baselines are only recorded (at task
   * creation) while it is on, because a snapshot of the machine is a side effect
   * and the off state must have none. A run without a baseline reports UNKNOWN,
   * never a pass.
   */
  requireEnvClean: boolean;
}

export interface VerifyConfig {
  version: 1;
  gates: VerifyGate[];
  options: VerifyOptions;
}

/**
 * Built-in gate that answers "is there any work here to verify?".
 *
 * Declared here rather than in the runner so modules that only reason *about*
 * gate selection (task contracts) can name it without importing the engine.
 */
export const WORK_EVIDENCE_GATE_ID = 'work-evidence';

/**
 * Built-in gate that reconciles the changed files against the contract's
 * `scope.allow` / `scope.deny` (#1546). Declared alongside work-evidence for the
 * same reason: `lib/tasks/contract-message.ts` has to name it while resolving a
 * contract's gate list, and must not pull the engine in to do so.
 */
export const SCOPE_GATE_ID = 'scope';

/**
 * Built-in gate that reconciles the *machine* against the snapshot taken when
 * the task was created (#1740): listening CommandMate servers, `mcbd-*` tmux
 * sessions, `$HOME` and `~/.commandmate`. `scope` answers what a delegation
 * changed inside the repository; this answers what it changed outside one.
 */
export const ENV_CLEAN_GATE_ID = 'env-clean';

/** Gate IDs reserved for built-in gates; using one in `gates` is a config error. */
export const RESERVED_GATE_IDS = [
  WORK_EVIDENCE_GATE_ID,
  SCOPE_GATE_ID,
  ENV_CLEAN_GATE_ID,
] as const;

export const VERIFY_CONFIG_RELATIVE_PATH = '.commandmate/verify.yaml';

export const DEFAULT_TIMEOUT_SEC = 600;
export const DEFAULT_MAX_LOG_TAIL_BYTES = 8192;

const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 7200;
const MAX_LOG_TAIL_BYTES = 1048576;

/**
 * Shape a gate id may take, wherever a gate is declared.
 *
 * Exported because the task contract declares gates too (#1791) and names them
 * in `verify.gates`. A second copy of this expression would let the two
 * declaration sites drift into accepting different ids, and a contract gate the
 * runner refuses to resolve is a completion criterion nothing can evaluate.
 */
export const GATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Shape a `mutex` name may take (Issue #1771).
 *
 * Wider than {@link GATE_ID_PATTERN} because a mutex names a *resource*, not a
 * gate: two repositories that both bind port 60303 should be able to agree on
 * `port.60303` and be serialized against each other. Narrow enough that the
 * name is safe as a path segment — no separator, no whitespace, nothing a shell
 * re-interprets — because both runners turn it into
 * `~/.commandmate/locks/<name>.lock`.
 */
export const GATE_MUTEX_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** Keeps the lock directory name inside every filesystem's limit. */
export const MAX_GATE_MUTEX_LENGTH = 64;

const TOP_LEVEL_KEYS = ['version', 'gates', 'options'];
const GATE_KEYS = ['id', 'command', 'timeoutSec', 'mutex'];
const OPTION_KEYS = [
  'baseRef',
  'skipInPrimaryCheckout',
  'maxLogTailBytes',
  'requireCommit',
  'requireEnvClean',
];

export class VerifyConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`invalid verify config:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'VerifyConfigError';
    this.issues = issues;
  }
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The bash reference parser strips outer quotes before comparing, so `timeoutSec: "900"`
 * means 900 there. Accept the same spelling, but only an exact decimal literal.
 */
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
 * Validate a list of `{ id, command, timeoutSec }` entries.
 *
 * Shared with the task contract's `verify.gateDefinitions` (#1791), which
 * declares gates in the same shape and must be held to the same constraints —
 * id pattern, reserved ids, duplicates, integer timeout in range. Calling this
 * is what makes "the same constraints" a fact rather than a comment: a contract
 * gate accepted here is one the runner can execute and the report can name.
 *
 * Deliberately does *not* decide whether the list may be absent or empty. That
 * is the caller's rule: verify.yaml requires at least one gate, a contract that
 * declares none is the normal case.
 *
 * @param at path prefix for issue messages (`gates`, `verify.gateDefinitions`)
 * @returns the accepted entries; an entry that produced an issue is dropped so
 *          the result never carries a value that failed validation
 */
export function validateGateEntries(value: unknown, at: string, issues: string[]): VerifyGate[] {
  if (!Array.isArray(value)) {
    issues.push(`${at}: must be a list (got ${describe(value)})`);
    return [];
  }

  const gates: VerifyGate[] = [];
  const seenIds = new Set<string>();

  value.forEach((entry, index) => {
    const entryAt = `${at}[${index}]`;
    validateGateEntry(entry, entryAt, seenIds, gates, issues);
  });

  return gates;
}

/** One gate entry; accepted entries are appended to `gates`. */
function validateGateEntry(
  entry: unknown,
  at: string,
  seenIds: Set<string>,
  gates: VerifyGate[],
  issues: string[]
): void {
  const issuesBefore = issues.length;

  if (!isMapping(entry)) {
    issues.push(`${at}: must be a mapping (got ${describe(entry)})`);
    return;
  }
  collectUnknownKeys(entry, GATE_KEYS, at, issues);

  if (typeof entry.id !== 'string' || entry.id === '') {
    issues.push(`${at}.id: required, must be a non-empty string (got ${describe(entry.id)})`);
  } else if (!GATE_ID_PATTERN.test(entry.id)) {
    issues.push(`${at}.id: "${entry.id}" must match ${GATE_ID_PATTERN.source}`);
  } else if ((RESERVED_GATE_IDS as readonly string[]).includes(entry.id)) {
    issues.push(`${at}.id: "${entry.id}" is reserved for a built-in gate`);
  } else if (seenIds.has(entry.id)) {
    issues.push(`${at}.id: duplicate gate id "${entry.id}"`);
  } else {
    seenIds.add(entry.id);
  }

  if (typeof entry.command !== 'string' || entry.command.trim() === '') {
    issues.push(
      `${at}.command: required, must be a non-empty string (got ${describe(entry.command)})`
    );
  }

  let timeoutSec = DEFAULT_TIMEOUT_SEC;
  if (entry.timeoutSec !== undefined) {
    const parsed = asInteger(entry.timeoutSec);
    if (parsed === null) {
      issues.push(`${at}.timeoutSec: must be an integer (got ${describe(entry.timeoutSec)})`);
    } else if (parsed < MIN_TIMEOUT_SEC || parsed > MAX_TIMEOUT_SEC) {
      issues.push(
        `${at}.timeoutSec: must be ${MIN_TIMEOUT_SEC}..${MAX_TIMEOUT_SEC} (got ${parsed})`
      );
    } else {
      timeoutSec = parsed;
    }
  }

  let mutex: string | undefined;
  if (entry.mutex !== undefined) {
    if (typeof entry.mutex !== 'string' || entry.mutex === '') {
      issues.push(`${at}.mutex: must be a non-empty string (got ${describe(entry.mutex)})`);
    } else if (entry.mutex.length > MAX_GATE_MUTEX_LENGTH) {
      issues.push(
        `${at}.mutex: must be at most ${MAX_GATE_MUTEX_LENGTH} characters (got ${entry.mutex.length})`
      );
    } else if (!GATE_MUTEX_PATTERN.test(entry.mutex)) {
      issues.push(`${at}.mutex: "${entry.mutex}" must match ${GATE_MUTEX_PATTERN.source}`);
    } else {
      mutex = entry.mutex;
    }
  }

  if (issues.length === issuesBefore) {
    const gate: VerifyGate = {
      id: entry.id as string,
      command: entry.command as string,
      timeoutSec,
    };
    // Only set when declared: an explicit `mutex: undefined` would serialize
    // into a contract's stored JSON as a key, and "declared without a value"
    // is not a state this field has.
    if (mutex !== undefined) gate.mutex = mutex;
    gates.push(gate);
  }
}

function validateGates(value: unknown, issues: string[]): VerifyGate[] {
  if (value === undefined || value === null) {
    issues.push('gates: required, at least one gate must be defined');
    return [];
  }
  if (Array.isArray(value) && value.length === 0) {
    issues.push('gates: at least one gate must be defined');
    return [];
  }
  return validateGateEntries(value, 'gates', issues);
}

function validateOptions(value: unknown, issues: string[]): VerifyOptions {
  const options: VerifyOptions = {
    baseRef: null,
    skipInPrimaryCheckout: true,
    maxLogTailBytes: DEFAULT_MAX_LOG_TAIL_BYTES,
    requireCommit: false,
    requireEnvClean: false,
  };

  // A childless `options:` key parses as null and means "all defaults".
  if (value === undefined || value === null) return options;

  if (!isMapping(value)) {
    issues.push(`options: must be a mapping (got ${describe(value)})`);
    return options;
  }
  collectUnknownKeys(value, OPTION_KEYS, 'options', issues);

  if (value.baseRef !== undefined) {
    if (typeof value.baseRef !== 'string' || value.baseRef.trim() === '') {
      issues.push(
        `options.baseRef: must be a non-empty string (got ${describe(value.baseRef)})`
      );
    } else {
      options.baseRef = value.baseRef;
    }
  }

  if (value.skipInPrimaryCheckout !== undefined) {
    const parsed = asBoolean(value.skipInPrimaryCheckout);
    if (parsed === null) {
      issues.push(
        `options.skipInPrimaryCheckout: must be true or false (got ${describe(value.skipInPrimaryCheckout)})`
      );
    } else {
      options.skipInPrimaryCheckout = parsed;
    }
  }

  if (value.requireCommit !== undefined) {
    const parsed = asBoolean(value.requireCommit);
    if (parsed === null) {
      issues.push(
        `options.requireCommit: must be true or false (got ${describe(value.requireCommit)})`
      );
    } else {
      options.requireCommit = parsed;
    }
  }

  if (value.requireEnvClean !== undefined) {
    const parsed = asBoolean(value.requireEnvClean);
    if (parsed === null) {
      issues.push(
        `options.requireEnvClean: must be true or false (got ${describe(value.requireEnvClean)})`
      );
    } else {
      options.requireEnvClean = parsed;
    }
  }

  if (value.maxLogTailBytes !== undefined) {
    const parsed = asInteger(value.maxLogTailBytes);
    if (parsed === null) {
      issues.push(
        `options.maxLogTailBytes: must be an integer (got ${describe(value.maxLogTailBytes)})`
      );
    } else if (parsed < 0 || parsed > MAX_LOG_TAIL_BYTES) {
      issues.push(`options.maxLogTailBytes: must be 0..${MAX_LOG_TAIL_BYTES} (got ${parsed})`);
    } else {
      options.maxLogTailBytes = parsed;
    }
  }

  return options;
}

function parseVerifyConfig(raw: string, configPath: string): VerifyConfig {
  let document: unknown;
  try {
    document = parseYaml(raw);
  } catch (error) {
    throw new VerifyConfigError([`${configPath}: YAML parse error: ${(error as Error).message}`]);
  }

  if (!isMapping(document)) {
    throw new VerifyConfigError([
      `${configPath}: expected a YAML mapping at the top level (got ${describe(document)})`,
    ]);
  }

  const issues: string[] = [];
  collectUnknownKeys(document, TOP_LEVEL_KEYS, 'top level', issues);

  if (!('version' in document)) {
    issues.push('version: required, v1 configs must declare "version: 1"');
  } else if (asInteger(document.version) !== 1) {
    issues.push(`version: must be 1 (got ${describe(document.version)})`);
  }

  const gates = validateGates(document.gates, issues);
  const options = validateOptions(document.options, issues);

  if (issues.length > 0) throw new VerifyConfigError(issues);

  return { version: 1, gates, options };
}

/**
 * Read and validate `<repoPath>/.commandmate/verify.yaml`.
 *
 * @returns the validated config, or null when the file does not exist
 * @throws VerifyConfigError with every violation collected in `issues`
 */
export function loadVerifyConfig(repoPath: string): VerifyConfig | null {
  const configPath = join(repoPath, VERIFY_CONFIG_RELATIVE_PATH);

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new VerifyConfigError([`${configPath}: ${(error as Error).message}`]);
  }

  return parseVerifyConfig(raw, configPath);
}
