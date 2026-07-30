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
}

export interface VerifyOptions {
  /** null when unset; the caller resolves the repository default branch. */
  baseRef: string | null;
  skipInPrimaryCheckout: boolean;
  maxLogTailBytes: number;
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

/** Gate IDs reserved for built-in gates; using one in `gates` is a config error. */
export const RESERVED_GATE_IDS = [WORK_EVIDENCE_GATE_ID, 'scope'] as const;

export const VERIFY_CONFIG_RELATIVE_PATH = '.commandmate/verify.yaml';

export const DEFAULT_TIMEOUT_SEC = 600;
export const DEFAULT_MAX_LOG_TAIL_BYTES = 8192;

const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 7200;
const MAX_LOG_TAIL_BYTES = 1048576;
const GATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

const TOP_LEVEL_KEYS = ['version', 'gates', 'options'];
const GATE_KEYS = ['id', 'command', 'timeoutSec'];
const OPTION_KEYS = ['baseRef', 'skipInPrimaryCheckout', 'maxLogTailBytes'];

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

function validateGates(value: unknown, issues: string[]): VerifyGate[] {
  if (value === undefined || value === null) {
    issues.push('gates: required, at least one gate must be defined');
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push(`gates: must be a list (got ${describe(value)})`);
    return [];
  }
  if (value.length === 0) {
    issues.push('gates: at least one gate must be defined');
    return [];
  }

  const gates: VerifyGate[] = [];
  const seenIds = new Set<string>();

  value.forEach((entry, index) => {
    const at = `gates[${index}]`;
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

    if (issues.length === issuesBefore) {
      gates.push({ id: entry.id as string, command: entry.command as string, timeoutSec });
    }
  });

  return gates;
}

function validateOptions(value: unknown, issues: string[]): VerifyOptions {
  const options: VerifyOptions = {
    baseRef: null,
    skipInPrimaryCheckout: true,
    maxLogTailBytes: DEFAULT_MAX_LOG_TAIL_BYTES,
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
