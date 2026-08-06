/**
 * Slash Command Catalog reconcile — curation exclusions (Issue #1704)
 *
 * Commands a human decided the catalog must not carry, in a form the reconcile
 * can read. Before this file existed, the decision lived only in the assertions
 * of tests/unit/lib/standard-commands.test.ts — and `catalog:refresh` does not
 * read tests. So for as long as the command existed upstream the tool re-proposed
 * it every single run, applying it turned the guard tests red, and a human went
 * back through old issues to re-derive why it had been dropped. v0.21.2, v0.21.3
 * and v0.21.4 each re-proposed the same three commands.
 *
 * The split of responsibilities is deliberate:
 *   - the *intent* lives in data (src/config/slash-commands-exclusions.json),
 *   - the *enforcement* lives in the engine (it stops proposing them),
 *   - the *verification* stays in tests (catalog ∩ exclusions = ∅).
 *
 * Two kinds, never merged into one prose blob, because their re-decision costs
 * differ: a `phantom` settles itself once upstream changes, while an
 * `out-of-scope` can only be reopened by a human.
 */

import { COMMAND_NAME_PATTERN } from './sanitize';
import type { CatalogExclusion, ExclusionKind } from './types';
import exclusionsJson from '../../config/slash-commands-exclusions.json';

/** Every valid `kind` value, in the order the docs introduce them. */
export const EXCLUSION_KINDS: readonly ExclusionKind[] = ['phantom', 'out-of-scope'];

/**
 * Shortest `reason` accepted.
 *
 * The point of the field is that the next reader does not have to open the
 * issue; "no" or "phantom" would satisfy a bare non-empty check while carrying
 * none of the reasoning, so the floor is set where a sentence starts.
 */
export const MIN_EXCLUSION_REASON_LENGTH = 20;

function fail(message: string): never {
  throw new Error(`slash-command exclusions: ${message}`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Validate one raw exclusion row.
 *
 * Every field is required. `cliTools` in particular has no "all tools" spelling:
 * v0.21.2 had to narrow the /vim ban from the name to claude alone because codex
 * 0.146.0 genuinely ships `/vim`, so a name-wide ban was hiding a real command.
 * Forcing the author to name the tools keeps that failure from being the easy
 * default.
 */
function parseExclusion(raw: unknown, index: number): CatalogExclusion {
  const at = `exclusions[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`${at} must be an object`);
  }
  const entry = raw as Record<string, unknown>;

  const name = requireString(entry.name, `${at}.name`);
  if (!COMMAND_NAME_PATTERN.test(name)) {
    fail(`${at}.name "${name}" is not a valid command name`);
  }

  if (!Array.isArray(entry.cliTools) || entry.cliTools.length === 0) {
    fail(`${at}.cliTools must be a non-empty array (name-wide exclusions are not expressible)`);
  }
  const cliTools: string[] = [];
  for (const tool of entry.cliTools) {
    const value = requireString(tool, `${at}.cliTools[]`);
    if (cliTools.includes(value)) fail(`${at}.cliTools lists "${value}" twice`);
    cliTools.push(value);
  }

  const kind = entry.kind;
  if (typeof kind !== 'string' || !EXCLUSION_KINDS.includes(kind as ExclusionKind)) {
    fail(`${at}.kind must be one of ${EXCLUSION_KINDS.join(' | ')}`);
  }

  const reason = requireString(entry.reason, `${at}.reason`);
  if (reason.trim().length < MIN_EXCLUSION_REASON_LENGTH) {
    fail(`${at}.reason is too short to explain the decision (min ${MIN_EXCLUSION_REASON_LENGTH} chars)`);
  }

  const issue = entry.issue;
  if (typeof issue !== 'number' || !Number.isInteger(issue) || issue <= 0) {
    fail(`${at}.issue must be a positive integer`);
  }

  return { name, cliTools, kind: kind as ExclusionKind, reason, issue };
}

/**
 * Parse and validate the exclusions file contents.
 *
 * Throws on any violation rather than skipping the bad row: this file is repo
 * data edited by hand at release time, and a silently dropped exclusion is
 * exactly the failure the mechanism exists to prevent.
 */
export function parseExclusions(raw: unknown): CatalogExclusion[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('file must be a JSON object');
  }
  const list = (raw as Record<string, unknown>).exclusions;
  if (!Array.isArray(list)) {
    fail('"exclusions" must be an array');
  }

  const parsed = list.map(parseExclusion);

  const seen = new Set<string>();
  for (const entry of parsed) {
    for (const tool of entry.cliTools) {
      const key = `${tool}:${entry.name}`;
      if (seen.has(key)) fail(`duplicate exclusion for /${entry.name} on ${tool}`);
      seen.add(key);
    }
  }
  return parsed;
}

/** Curation exclusions bundled with the repo (src/config/slash-commands-exclusions.json). */
export const DEFAULT_EXCLUSIONS: CatalogExclusion[] = parseExclusions(exclusionsJson);

/** Tool-scoped lookup built from a list of exclusions: name → tool → row. */
export type ExclusionIndex = Map<string, Map<string, CatalogExclusion>>;

export function buildExclusionIndex(exclusions: CatalogExclusion[]): ExclusionIndex {
  const index: ExclusionIndex = new Map();
  for (const entry of exclusions) {
    let byTool = index.get(entry.name);
    if (!byTool) {
      byTool = new Map();
      index.set(entry.name, byTool);
    }
    for (const tool of entry.cliTools) byTool.set(tool, entry);
  }
  return index;
}

/** The exclusion covering `name` on `tool`, if any. */
export function findExclusion(
  index: ExclusionIndex,
  name: string,
  tool: string
): CatalogExclusion | undefined {
  return index.get(name)?.get(tool);
}

/** One-line rendering used in `--check` notices. */
export function describeExclusion(exclusion: CatalogExclusion): string {
  return `excluded as ${exclusion.kind} (#${exclusion.issue}): ${exclusion.reason}`;
}
