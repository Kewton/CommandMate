/**
 * Scope glob matching for the built-in `scope` gate (Issue #3647: split out of
 * scope-gate.ts, which re-exports everything public here).
 *
 * @module lib/verification/scope-gate-glob
 */

import type { TaskContractScope } from '@/lib/tasks/contract-parser';

/**
 * Paths that are in scope no matter what the contract says.
 *
 * The contract file lives here, so a contract whose own `allow` list forgot to
 * mention `.commandmate/` would fail the moment it was committed — the scope
 * declaration would make its own storage a violation. The exemption covers the
 * `allow` requirement only; an explicit `deny` still applies, because a deny is
 * a deliberate prohibition and silently ignoring one is worse than the accident
 * this exemption prevents.
 */
export const ALWAYS_ALLOWED_PREFIX = '.commandmate/';

/**
 * Stand-ins for the two ways a path is admitted without matching `allow`.
 *
 * Parenthesised so they cannot be mistaken for a pattern the contract declared:
 * a reader who greps the contract for `(exempt: .commandmate/)` should find
 * nothing, because nothing there put it in scope.
 */
export const SCOPE_EXEMPT_ALWAYS_ALLOWED = `(exempt: ${ALWAYS_ALLOWED_PREFIX})`;
export const SCOPE_EXEMPT_CONTRACT_PATH = '(exempt: contract path)';

/**
 * Why one path was admitted or rejected (#1841).
 *
 * `pattern` is null only for the rejection that no rule names: nothing in
 * `deny` matched, and nothing in `allow` did either.
 */
export type ScopeDecision =
  | { admitted: true; pattern: string }
  | { admitted: false; pattern: string | null };

// =============================================================================
// Glob matching
// =============================================================================

/**
 * Translate a scope glob into an anchored regular expression.
 *
 * Deliberately a small, documented subset rather than a glob library. The
 * semantics are fixed in docs/design/task-contract.md §2.2:
 *
 * - `**` as a whole path segment crosses directory boundaries, including zero of
 *   them: `a/**` matches `a/b` and `a/b/c`, `**\/*.ts` matches `x.ts`.
 * - `*` and `?` never cross `/`. Leading dots are ordinary characters, so
 *   `.github/**` and `*.md` behave the way they read.
 * - `{a,b}` is alternation, nestable. Unbalanced braces are literal, as in a
 *   shell — `src/{a` is a path with a brace in it, not a syntax error.
 * - `[` and `]` are **literal**. This repository routes through
 *   `src/app/proxy/[...path]/`, and treating those as character classes would
 *   make the pattern that names them match nothing at all — a silent no-match is
 *   the failure mode this gate exists to avoid.
 * - A pattern that matches a directory also matches everything beneath it, so
 *   `src/lib`, `src/lib/` and `src/lib/**` all mean the same thing. Without this
 *   rule, `allow: ["src/lib/verification"]` — the way people write a directory —
 *   would put every file inside it out of scope.
 */
function globToRegExp(rawPattern: string): RegExp {
  // A trailing slash carries no information once the rule above applies.
  const pattern = rawPattern.replace(/\/+$/, '');
  const bracesBalanced = hasBalancedBraces(pattern);

  let source = '';
  let depth = 0;
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === '*') {
      let end = i;
      while (pattern[end] === '*') end += 1;
      const isGlobstar = end - i > 1;
      const atSegmentStart = i === 0 || pattern[i - 1] === '/';

      if (isGlobstar && atSegmentStart && pattern[end] === '/') {
        // Consume the following slash too: `a/**/b` has to match `a/b`.
        source += '(?:[^/]*/)*';
        i = end + 1;
        continue;
      }
      if (isGlobstar && atSegmentStart && end === pattern.length) {
        source += '.*';
        i = end;
        continue;
      }
      // `**` that is not a whole segment (`a**b`) cannot mean "cross
      // directories" without also matching `a/x/b`, which the pattern does not
      // say. Collapse it to a single-segment wildcard.
      source += '[^/]*';
      i = end;
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      i += 1;
      continue;
    }
    if (bracesBalanced && char === '{') {
      depth += 1;
      source += '(?:';
      i += 1;
      continue;
    }
    if (bracesBalanced && char === '}' && depth > 0) {
      depth -= 1;
      source += ')';
      i += 1;
      continue;
    }
    if (bracesBalanced && char === ',' && depth > 0) {
      source += '|';
      i += 1;
      continue;
    }

    source += char.replace(/[.*+?^${}()|[\]\\]/, '\\$&');
    i += 1;
  }

  return new RegExp(`^${source}(?:/.*)?$`);
}

function hasBalancedBraces(pattern: string): boolean {
  let depth = 0;
  for (const char of pattern) {
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/** A declared pattern kept next to its regex, so the report can name it (#1841). */
interface CompiledPattern {
  pattern: string;
  regexp: RegExp;
}

function compilePattern(pattern: string): CompiledPattern {
  return { pattern, regexp: globToRegExp(pattern) };
}

/**
 * A scope declaration compiled once per run.
 *
 * Compiling per pattern per file would rebuild the same regexes for every one of
 * potentially thousands of changed paths.
 */
export class ScopeMatcher {
  private readonly allow: CompiledPattern[];
  private readonly deny: CompiledPattern[];

  /**
   * @param contractPath the contract's own path, exempted alongside
   *        {@link ALWAYS_ALLOWED_PREFIX} for contracts kept outside `.commandmate/`
   */
  constructor(
    scope: TaskContractScope,
    private readonly contractPath: string | null = null
  ) {
    this.allow = scope.allow.map(compilePattern);
    this.deny = scope.deny.map(compilePattern);
  }

  /**
   * Which declared rule decided `path`, and which way (#1841).
   *
   * The **first** matching pattern is reported, in the contract's declaration
   * order, on both sides. Reporting the last would name a rule the reader
   * cannot use: `allow: ["src/**", "src/lib/**"]` admits `src/lib/a.ts` under
   * the first entry, and deleting the second changes nothing about the verdict.
   *
   * `path` is a repository-root-relative POSIX path as git reports it.
   */
  classify(path: string): ScopeDecision {
    const denied = this.deny.find((entry) => entry.regexp.test(path));
    if (denied) return { admitted: false, pattern: denied.pattern };
    if (path.startsWith(ALWAYS_ALLOWED_PREFIX)) {
      return { admitted: true, pattern: SCOPE_EXEMPT_ALWAYS_ALLOWED };
    }
    if (path === this.contractPath) {
      return { admitted: true, pattern: SCOPE_EXEMPT_CONTRACT_PATH };
    }
    const allowed = this.allow.find((entry) => entry.regexp.test(path));
    return allowed
      ? { admitted: true, pattern: allowed.pattern }
      : { admitted: false, pattern: null };
  }

  /**
   * Whether `path` is a scope violation.
   *
   * Delegates to {@link classify} rather than repeating the rules: the verdict
   * and the evidence for it must never be able to disagree, and two copies of
   * "deny wins, then the exemptions, then allow" is exactly how they would.
   */
  isViolation(path: string): boolean {
    return !this.classify(path).admitted;
  }
}
