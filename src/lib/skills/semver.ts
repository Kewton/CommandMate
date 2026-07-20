/**
 * SemVer 2.0 handling for the Skills distribution contract (Issue #1228)
 *
 * `src/lib/version-checker.ts` intentionally compares only `major.minor.patch`
 * of CommandMate's own release tags and tolerates a `v` prefix. The Skill
 * contract needs full SemVer 2.0 precedence (prerelease ordering, build
 * metadata ignored) and rejects the `v` prefix, so it gets its own strict
 * implementation instead of loosening the update-check semantics.
 *
 * The range grammar is deliberately a small, total subset of npm's: a
 * space-separated AND list of comparators. `||`, `x`-ranges, `*` and hyphen
 * ranges are rejected so a range always has one unambiguous reading.
 *
 * @module lib/skills/semver
 */

/** Strict SemVer 2.0 grammar. No `v` prefix, no leading zeroes. */
export const SEMVER_2_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Maximum accepted length of a version string. */
export const SEMVER_MAX_LENGTH = 64;

/** Maximum accepted length of a range expression. */
export const VERSION_RANGE_MAX_LENGTH = 100;

/** Maximum number of comparators in one range. */
export const VERSION_RANGE_MAX_COMPARATORS = 4;

/** A parsed SemVer 2.0 version. */
export interface ParsedSemVer {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers, empty when the version is a release. */
  prerelease: readonly string[];
  /** Build metadata identifiers. Ignored for precedence. */
  build: readonly string[];
}

/** Operators accepted in a range comparator. */
export type SkillVersionOperator = '=' | '>' | '>=' | '<' | '<=';

/** One desugared comparator: `^`/`~` expand into `>=` plus `<`. */
export interface SkillVersionComparator {
  operator: SkillVersionOperator;
  version: ParsedSemVer;
}

/** Parse a strict SemVer 2.0 string. Returns null when invalid. */
export function parseSemVer(version: string): ParsedSemVer | null {
  if (typeof version !== 'string' || version.length > SEMVER_MAX_LENGTH) return null;
  const match = SEMVER_2_PATTERN.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
    build: match[5] ? match[5].split('.') : [],
  };
}

/** True when the string is a strict SemVer 2.0 version. */
export function isValidSemVer(version: string): boolean {
  return parseSemVer(version) !== null;
}

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  // A release outranks any prerelease of the same major.minor.patch.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const left = a[i];
    const right = b[i];
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return Number(left) < Number(right) ? -1 : 1;
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return left < right ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/** Compare two parsed versions by SemVer 2.0 precedence. Build metadata is ignored. */
export function compareParsedSemVer(a: ParsedSemVer, b: ParsedSemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Compare two SemVer 2.0 strings.
 *
 * @returns -1, 0 or 1; null when either input is not valid SemVer 2.0.
 */
export function compareSemVer(a: string, b: string): number | null {
  const left = parseSemVer(a);
  const right = parseSemVer(b);
  if (!left || !right) return null;
  return compareParsedSemVer(left, right);
}

function samePrecedenceTuple(a: ParsedSemVer, b: ParsedSemVer): boolean {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}

function caretUpperBound(v: ParsedSemVer): ParsedSemVer {
  if (v.major > 0) return { major: v.major + 1, minor: 0, patch: 0, prerelease: [], build: [] };
  if (v.minor > 0) return { major: 0, minor: v.minor + 1, patch: 0, prerelease: [], build: [] };
  return { major: 0, minor: 0, patch: v.patch + 1, prerelease: [], build: [] };
}

function tildeUpperBound(v: ParsedSemVer): ParsedSemVer {
  return { major: v.major, minor: v.minor + 1, patch: 0, prerelease: [], build: [] };
}

/**
 * Parse a range into desugared comparators combined with AND.
 *
 * Accepted tokens: `x.y.z`, `=x.y.z`, `>x.y.z`, `>=x.y.z`, `<x.y.z`, `<=x.y.z`,
 * `^x.y.z`, `~x.y.z`. Returns null for anything else.
 */
export function parseSkillVersionRange(range: string): SkillVersionComparator[] | null {
  if (typeof range !== 'string') return null;
  const trimmed = range.trim();
  if (trimmed.length === 0 || trimmed.length > VERSION_RANGE_MAX_LENGTH) return null;
  if (trimmed.includes('||')) return null;

  const tokens = trimmed.split(/\s+/);
  if (tokens.length > VERSION_RANGE_MAX_COMPARATORS) return null;

  const comparators: SkillVersionComparator[] = [];
  for (const token of tokens) {
    const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token);
    if (!match) return null;
    const operator = match[1] ?? '=';
    const version = parseSemVer(match[2]);
    if (!version) return null;

    if (operator === '^' || operator === '~') {
      const upper = operator === '^' ? caretUpperBound(version) : tildeUpperBound(version);
      comparators.push({ operator: '>=', version });
      comparators.push({ operator: '<', version: upper });
      continue;
    }
    comparators.push({ operator: operator as SkillVersionOperator, version });
  }

  if (comparators.length > VERSION_RANGE_MAX_COMPARATORS * 2) return null;
  return comparators;
}

/** True when the range is expressible in the supported grammar. */
export function isValidSkillVersionRange(range: string): boolean {
  return parseSkillVersionRange(range) !== null;
}

function satisfiesComparator(version: ParsedSemVer, comparator: SkillVersionComparator): boolean {
  const cmp = compareParsedSemVer(version, comparator.version);
  switch (comparator.operator) {
    case '=':
      return cmp === 0;
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
  }
}

/**
 * Test a version against a range.
 *
 * A prerelease version only satisfies a range when some comparator names the
 * same `major.minor.patch` *and* itself carries a prerelease. Without this rule
 * `>=1.0.0` would silently accept `2.0.0-alpha.1`.
 *
 * @returns false for an invalid version or an unparsable range (fail closed).
 */
export function satisfiesSkillVersionRange(version: string, range: string): boolean {
  const parsed = parseSemVer(version);
  const comparators = parseSkillVersionRange(range);
  if (!parsed || !comparators) return false;

  if (parsed.prerelease.length > 0) {
    const allowed = comparators.some(
      (c) => c.version.prerelease.length > 0 && samePrecedenceTuple(parsed, c.version)
    );
    if (!allowed) return false;
  }

  return comparators.every((c) => satisfiesComparator(parsed, c));
}
