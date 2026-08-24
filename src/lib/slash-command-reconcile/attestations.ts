/**
 * Slash Command Catalog reconcile — source attestations (Issue #2026)
 *
 * One record per tool, each saying: *as of version V, source S enumerated
 * exactly this set of commands for tool T.* It is a human's reading of a source,
 * written by hand; nothing in the toolchain writes this file.
 *
 * It exists because the catalog pins used to describe the old set as literals —
 * `toBe(244)`, `toBe(56)`, and a hard-coded `[claude, codex, opencode]` for
 * /agents. Those numbers were never about arithmetic: their job was to stop an
 * unreviewed `catalog:refresh --write` from landing (the test said so itself —
 * "this number only pins that a refresh was reviewed rather than applied
 * blind"). But a *correct* addition turned them red exactly as loudly as a wrong
 * one, and the only way to clear the red was to retype the number, which left
 * the evidence nowhere but a commit message. #2024 measured that cost and
 * refused to relax the pins; this file removes the cost instead, by giving the
 * pins something to read that a human had to write.
 *
 * The invariant the pins now enforce is
 *
 *     catalog(tool) === attested(tool) \ excluded(tool)
 *
 * which fails in all four directions that matter: the catalog growing without
 * an attestation (an unreviewed `--write`), a name no source ever listed (the
 * #1503 docs-stub phantom), and an attested name going missing — while a
 * genuine addition passes as soon as the attestation moves with it.
 *
 * Structure follows exclusions.ts deliberately (Issue #1704): the *intent* is
 * data under src/config/, the *enforcement* is code, the *verification* is a
 * test, and an invalid row throws instead of being skipped — a silently dropped
 * attestation disarms precisely the guard the file is.
 *
 * Unlike the rest of this directory, this module IS reachable from the app
 * runtime: src/lib/standard-commands.ts derives `CATALOG_VERIFIED_AGAINST` from
 * it. It stays pure data + validation for that reason (no fetch, no fs).
 */

import { COMMAND_NAME_PATTERN, VERSION_PATTERN } from './sanitize';
import { DEFAULT_EXCLUSIONS, buildExclusionIndex, findExclusion } from './exclusions';
import type { AttestationDrift, CatalogAttestation, CatalogExclusion } from './types';
import attestationsJson from '../../config/slash-commands-attestations.json';

/** `YYYY-MM-DD`, the only accepted spelling of `observedAt`. */
export const OBSERVED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Shortest `source` accepted.
 *
 * The field has to be an instruction for re-running the measurement, not a
 * citation: "docs" or "the CLI" would satisfy a bare non-empty check and leave
 * the next reader exactly where #2024 was — re-deriving which document, at which
 * version, said what. The floor is set where a usable sentence starts.
 */
export const MIN_ATTESTATION_SOURCE_LENGTH = 20;

/** The tool a catalog entry serves when it names none (Issue #594 back-compat). */
const IMPLICIT_TOOL = 'claude';

function fail(message: string): never {
  throw new Error(`slash-command attestations: ${message}`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Validate one raw attestation row.
 *
 * `commands` must be sorted and duplicate-free. That is not tidiness: this list
 * is reviewed as a diff at release time, and an append-at-the-end habit turns
 * "three commands arrived" into a diff that cannot be read at a glance — which
 * is the failure the whole record is meant to end.
 */
function parseAttestation(raw: unknown, index: number): CatalogAttestation {
  const at = `attestations[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`${at} must be an object`);
  }
  const entry = raw as Record<string, unknown>;

  const tool = requireString(entry.tool, `${at}.tool`);

  const version = requireString(entry.version, `${at}.version`);
  if (!VERSION_PATTERN.test(version)) {
    fail(`${at}.version "${version}" is not a major.minor.patch version`);
  }

  const source = requireString(entry.source, `${at}.source`);
  if (source.trim().length < MIN_ATTESTATION_SOURCE_LENGTH) {
    fail(
      `${at}.source is too short to re-run the measurement from ` +
        `(min ${MIN_ATTESTATION_SOURCE_LENGTH} chars)`
    );
  }

  const observedAt = requireString(entry.observedAt, `${at}.observedAt`);
  if (!OBSERVED_AT_PATTERN.test(observedAt)) {
    fail(`${at}.observedAt "${observedAt}" must be a YYYY-MM-DD date`);
  }

  const issue = entry.issue;
  if (typeof issue !== 'number' || !Number.isInteger(issue) || issue <= 0) {
    fail(`${at}.issue must be a positive integer`);
  }

  if (!Array.isArray(entry.commands) || entry.commands.length === 0) {
    fail(`${at}.commands must be a non-empty array`);
  }
  const commands: string[] = [];
  for (const value of entry.commands) {
    const name = requireString(value, `${at}.commands[]`);
    if (!COMMAND_NAME_PATTERN.test(name)) {
      fail(`${at}.commands lists "${name}", which is not a valid command name`);
    }
    const previous = commands[commands.length - 1];
    if (previous === name) fail(`${at}.commands lists "${name}" twice`);
    if (previous !== undefined && previous > name) {
      fail(`${at}.commands must be sorted ("${name}" comes before "${previous}")`);
    }
    commands.push(name);
  }

  return { tool, version, source, observedAt, issue: issue as number, commands };
}

/**
 * Parse and validate the attestations file contents.
 *
 * Throws on any violation rather than skipping the bad row, for the reason
 * exclusions.ts throws: this is repo data edited by hand at release time, and a
 * row that vanishes quietly takes its guard with it.
 */
export function parseAttestations(raw: unknown): CatalogAttestation[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('file must be a JSON object');
  }
  const list = (raw as Record<string, unknown>).attestations;
  if (!Array.isArray(list)) {
    fail('"attestations" must be an array');
  }
  if (list.length === 0) {
    fail('"attestations" must not be empty');
  }

  const parsed = list.map(parseAttestation);

  const seen = new Set<string>();
  for (const entry of parsed) {
    if (seen.has(entry.tool)) fail(`duplicate attestation for ${entry.tool}`);
    seen.add(entry.tool);
  }
  return parsed;
}

/** Attestations bundled with the repo (src/config/slash-commands-attestations.json). */
export const DEFAULT_ATTESTATIONS: CatalogAttestation[] = parseAttestations(attestationsJson);

/** tool → attestation. */
export type AttestationIndex = Map<string, CatalogAttestation>;

export function buildAttestationIndex(attestations: CatalogAttestation[]): AttestationIndex {
  const index: AttestationIndex = new Map();
  for (const entry of attestations) index.set(entry.tool, entry);
  return index;
}

/**
 * The version stamp per tool, derived from the attestations.
 *
 * This is the only place the number lives (Issue #2026): `verifiedAgainst` was
 * removed from slash-commands-catalog.json, so the stamp cannot drift away from
 * the set it stands for, and `catalog:refresh --write` cannot bump a version on
 * a human's behalf — a version move is part of re-attesting, by hand.
 */
export function attestedVersions(attestations: CatalogAttestation[]): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const entry of attestations) versions[entry.tool] = entry.version;
  return versions;
}

/** The tools a catalog entry serves; an entry naming none is Claude-only. */
export function toolsOfCommand(command: ToolScopedCommand): readonly string[] {
  return command.cliTools && command.cliTools.length > 0 ? command.cliTools : [IMPLICIT_TOOL];
}

/**
 * The names the catalog must ship for `tool`: everything the source enumerated,
 * minus what a human decided to keep out.
 *
 * The subtraction is what keeps a curation decision from reading as a lost
 * command: /schedule is real on claude, deliberately absent from the catalog,
 * and attested — so it is a legitimate absence rather than a missing command.
 */
export function attestedCatalogNames(
  attestation: CatalogAttestation,
  exclusions: CatalogExclusion[] = DEFAULT_EXCLUSIONS
): string[] {
  const index = buildExclusionIndex(exclusions);
  return attestation.commands.filter((name) => !findExclusion(index, name, attestation.tool));
}

/** Minimal shape the comparison needs — both SlashCommand and CatalogCommandEntry fit. */
export interface ToolScopedCommand {
  name: string;
  cliTools?: readonly string[];
}

/**
 * How a catalog entry and the attestations disagree.
 *
 *  - `unattested-tool`  the catalog serves a tool no attestation covers, so
 *                       nothing at all is reviewing that tool's set.
 *  - `unattested`       the catalog ships a name the source never enumerated
 *                       (an unreviewed `--write`, or a phantom from a docs stub).
 *  - `excluded`         the catalog ships a name a human excluded for that tool.
 *  - `missing`          the source enumerated a name the catalog does not ship,
 *                       and no exclusion explains the absence.
 */
export type AttestationViolationKind = 'unattested-tool' | 'unattested' | 'excluded' | 'missing';

export interface AttestationViolation {
  kind: AttestationViolationKind;
  tool: string;
  /** Command name; absent only for `unattested-tool`. */
  name?: string;
}

export interface AttestationComparisonOptions {
  attestations?: CatalogAttestation[];
  exclusions?: CatalogExclusion[];
}

/**
 * Compare a catalog against the attestations: every disagreement, in a stable
 * order (tool as attested, then command name).
 *
 * Deliberately *not* derived from the catalog on either side — the expected set
 * is `attested \ excluded`, both of which are hand-written data. Deriving the
 * expectation from the catalog would make the check tautological, which is the
 * failure mode #2024 rejected when it refused to compute the count pins from
 * STANDARD_COMMANDS.
 */
export function findAttestationViolations(
  commands: readonly ToolScopedCommand[],
  options: AttestationComparisonOptions = {}
): AttestationViolation[] {
  const attestations = options.attestations ?? DEFAULT_ATTESTATIONS;
  const exclusions = options.exclusions ?? DEFAULT_EXCLUSIONS;
  const exclusionIndex = buildExclusionIndex(exclusions);

  const catalogByTool = new Map<string, Set<string>>();
  for (const command of commands) {
    for (const tool of toolsOfCommand(command)) {
      let names = catalogByTool.get(tool);
      if (!names) {
        names = new Set();
        catalogByTool.set(tool, names);
      }
      names.add(command.name);
    }
  }

  const violations: AttestationViolation[] = [];

  for (const attestation of attestations) {
    const shipped = catalogByTool.get(attestation.tool) ?? new Set<string>();
    const expected = new Set(attestedCatalogNames(attestation, exclusions));

    for (const name of [...shipped].sort()) {
      if (expected.has(name)) continue;
      violations.push({
        kind: findExclusion(exclusionIndex, name, attestation.tool) ? 'excluded' : 'unattested',
        tool: attestation.tool,
        name,
      });
    }
    for (const name of [...expected].sort()) {
      if (!shipped.has(name)) {
        violations.push({ kind: 'missing', tool: attestation.tool, name });
      }
    }
  }

  const attested = new Set(attestations.map((a) => a.tool));
  for (const tool of [...catalogByTool.keys()].sort()) {
    if (!attested.has(tool)) violations.push({ kind: 'unattested-tool', tool });
  }

  return violations;
}

/** One-line rendering, used in assertion messages and `--check` notices. */
export function describeAttestationViolation(violation: AttestationViolation): string {
  switch (violation.kind) {
    case 'unattested-tool':
      return `[${violation.tool}] no attestation covers this tool`;
    case 'unattested':
      return `[${violation.tool}] /${violation.name} is in the catalog but not attested`;
    case 'excluded':
      return `[${violation.tool}] /${violation.name} is in the catalog although it is excluded`;
    default:
      return `[${violation.tool}] /${violation.name} is attested but missing from the catalog`;
  }
}

/** True when this drift row says something a human has to act on. */
export function hasAttestationDrift(drift: AttestationDrift): boolean {
  return !drift.attested || drift.unattested.length > 0 || drift.vanished.length > 0;
}

/** One-line rendering of a drift row for the `--check` report. */
export function describeAttestationDrift(drift: AttestationDrift): string {
  if (!drift.attested) {
    return `[${drift.tool}] no attestation covers this tool — the source is enumerating a set nobody has reviewed`;
  }
  const parts: string[] = [];
  if (drift.unattested.length > 0) {
    parts.push(`source now lists ${drift.unattested.map((n) => `/${n}`).join(' ')}`);
  }
  if (drift.vanished.length > 0) {
    parts.push(`source no longer lists ${drift.vanished.map((n) => `/${n}`).join(' ')}`);
  }
  return `[${drift.tool}] ${parts.join('; ')}`;
}

/**
 * Compare one tool's attested set against the names a source enumerated.
 *
 * `sourceNames` is the source's *active canonical* set — the same rows the
 * engine would consider adding — so a history row or an alias row never reads as
 * an arrival. Excluded names are NOT subtracted: the attestation records what
 * the source said, and a curation decision is a separate fact about the catalog.
 */
export function compareAttestationToSource(
  tool: string,
  sourceNames: readonly string[],
  attestations: CatalogAttestation[] = DEFAULT_ATTESTATIONS
): AttestationDrift {
  const attestation = buildAttestationIndex(attestations).get(tool);
  const source = new Set(sourceNames);
  if (!attestation) {
    return { tool, attested: false, unattested: [...source].sort(), vanished: [] };
  }
  const attested = new Set(attestation.commands);
  return {
    tool,
    attested: true,
    unattested: [...source].filter((name) => !attested.has(name)).sort(),
    vanished: [...attested].filter((name) => !source.has(name)).sort(),
  };
}
