#!/usr/bin/env node
/**
 * Guards the semantic-token discipline of the migrated UI directories.
 *
 * TWO checks run here, and both must pass:
 *
 *   1. ABSENCE of raw palette utilities (#1082 / #1116) — `bg-sky-50` and
 *      friends must not reappear in a directory that already uses tokens.
 *   2. EXISTENCE of the token being referenced (#1889) — `bg-info-subtle` is
 *      only legal because `--color-info-subtle` is declared in
 *      `src/app/globals.css`. `bg-surface-elevated-typo` is not.
 *
 * Check 2 exists because check 1 alone is satisfied by a typo. Tailwind drops
 * a class it cannot resolve without a word of complaint, so the element simply
 * renders with no background / an inherited text color — a purely visual
 * failure that lint, tsc and the unit suite are all blind to, because a class
 * name is just a string to them. PR #1881 replaced `sky-*` with `info` tints,
 * check 1 went green, and a human grepping `globals.css` by hand is what
 * actually established that the tint tokens existed. This is that grep.
 *
 * [Issue #1082 / #1116] Migrated directories use tokens, not raw palette steps:
 *   - gray/slate  → neutral tokens (foreground / muted / muted-foreground /
 *                   border / surface / input / ring). (#1082, #1061)
 *   - chromatic (red/green/yellow/amber/orange/purple/violet/sky/blue)
 *                 → status tint tokens (bg-{status}-subtle /
 *                   border-{status}-border / text-{status}-foreground /
 *                   bg-{status}, status = success|warning|danger|info). (#1116)
 * Fix violations with the tokens in docs/design-system.md, NOT by widening the
 * lists below.
 *
 * [Issue #1882] This file is the SINGLE authority for the pattern, the guarded
 * directory list and the exclusions. `.github/workflows/ci-pr.yml` (job
 * `token-discipline`) and `.commandmate/verify.yaml` (gate `token-discipline`)
 * both run this script and hold no copy of the check, because the same guard
 * written twice is a guard that gets updated in one place and quietly diverges
 * in the other. Same shape as `scripts/check-control-chars.mjs`, which was
 * already the correct precedent in this repository.
 *
 * ---------------------------------------------------------------------------
 * WHY AN ALLOW-LIST RATHER THAN ASKING TAILWIND (Issue #1889)
 * ---------------------------------------------------------------------------
 * The authoritative way to answer "does `bg-foo` resolve?" is to hand the
 * candidate to Tailwind and see whether it emits a rule. That is not available
 * here: the CI job is a checkout plus ONE `run:` step and performs no
 * `npm install` (`tests/unit/guards/static-guard-single-source.test.ts` pins
 * the job to exactly that one step), so this script has to keep working with
 * nothing but Node and the repository. Importing `tailwindcss` would make the
 * guard depend on `node_modules` being present in a job that never populates
 * it.
 *
 * So a candidate `(bg|text|border|ring)-<rest>` is accepted when `<rest>` is
 * one of three things, and rejected otherwise:
 *
 *   a. a Tailwind BUILT-IN NON-COLOR utility  (`text-xs`, `border-b-2`,
 *      `bg-gradient-to-br`, `ring-offset-2`, `border-dashed`, …) — the tables
 *      below;
 *   b. a Tailwind BUILT-IN COLOR (`white` / `black` / `transparent` /
 *      `current` / `inherit`, or `<family>-<step>`) — deliberately accepted
 *      here because raw palette usage is check 1's business, not check 2's,
 *      and `text-white` / `bg-black` are explicitly out of scope for #1889;
 *   c. a project token, i.e. a `--color-<rest>` declared in
 *      `src/app/globals.css`.
 *
 * The cost of the allow-list is that a utility Tailwind adds in a future
 * release is unknown to this script until the table is extended. That failure
 * is LOUD (a false positive that fails CI and says which class it choked on),
 * never silent, which is the direction a guard should fail in.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHECK 2 CANNOT SEE (recorded deliberately; also in docs/design-system.md)
 * ---------------------------------------------------------------------------
 *   - DYNAMIC class names. `` `bg-${tone}-subtle` ``, `'bg-' + name`, or a
 *     lookup table keyed at runtime never produces a literal candidate, so no
 *     check happens. (Tailwind cannot see these either — it would not emit the
 *     class in the first place — but the guard should not be read as proof
 *     that a component's computed classes resolve.)
 *   - ARBITRARY VALUES: `bg-[#123456]`, `text-[11px]`, `border-[var(--x)]` are
 *     skipped. They bypass the token layer by definition and check 1 does not
 *     look at them either (out of scope for #1889).
 *   - COLOR UTILITIES OUTSIDE the four prefixes. `from-` / `via-` / `to-` /
 *     `divide-` / `outline-` / `fill-` / `stroke-` / `decoration-` /
 *     `placeholder-` / `caret-` / `accent-` / `shadow-` also take colors and
 *     are NOT checked, matching check 1's `(bg|text|border|ring)` surface.
 *   - COMMENTS. Comment bodies are stripped before scanning, so a token name
 *     misspelled in prose or in a JSDoc example is not reported. Without this
 *     an ordinary English comment ("a text-entry context", "the border-trick
 *     spinner") becomes a CI failure — measured on this repository, that was
 *     every single false positive.
 *   - Anything the shared exclusions drop: test files, `*Terminal*` files and
 *     `src/app/worktrees/**` (see below), plus files whose extension is not in
 *     `SCANNED_EXTENSIONS`.
 *   - EXISTENCE ONLY. That `--color-info-subtle` is declared says nothing
 *     about whether it is the semantically right token, nor about whether the
 *     RGB channel triplet it references is defined in `@layer base`.
 *
 * Usage: node scripts/check-token-discipline.mjs [repoRoot]
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** Raw palette utilities that must not appear in a migrated directory. */
export const TOKEN_DISCIPLINE_PATTERN =
  '(bg|text|border|ring)-(gray|slate|red|green|yellow|amber|orange|purple|violet|sky|blue)-[0-9]';

/**
 * WHITELIST (guarded) = directories already migrated to semantic tokens.
 * #1061 added worktree/mobile/external-apps; #1116 added error/ + auth/.
 *
 * EXCLUDED: `src/app/worktrees/**` — the worktree detail route / terminal page,
 * including the CLI brand colors bg-purple-600 / bg-blue-600 / bg-green-600.
 */
export const GUARDED_PATHSPECS = [
  'src/app',
  'src/components/ui',
  'src/components/layout',
  'src/components/home',
  'src/components/review',
  'src/components/repository',
  'src/components/common',
  'src/components/sidebar',
  'src/components/providers',
  'src/components/worktree',
  'src/components/mobile',
  'src/components/external-apps',
  'src/components/error',
  'src/components/auth',
  ':(exclude)src/app/worktrees',
];

/**
 * Test files are excluded because they assert on concrete class strings: a
 * suite that pins `bg-sky-50` as the expected output of something is not a
 * violation, it is the assertion.
 */
export const TEST_FILE_EXCLUDE = /\.test\.|\.spec\.|__tests__/;

/**
 * `*Terminal*` source files are excluded (incl. error/TerminalErrorFallback.tsx).
 *
 * DO NOT REMOVE. The terminal output surfaces stay dark in BOTH themes, matching
 * the fixed xterm theme (#1079) — they use raw dark utilities on purpose. Drop
 * this and every terminal component in the repository turns into a violation.
 *
 * Anchored at the start and stopped at the first `:` so it only ever inspects
 * the PATH field of a `path:line:content` grep line — a file whose *content*
 * mentions "Terminal" is not exempt.
 */
export const TERMINAL_FILE_EXCLUDE = /^[^:]*Terminal[^:]*:/;

/**
 * Apply the two exclusions to raw `git grep -n` output lines.
 *
 * Split out from the git call so the exclusions can be asserted directly:
 * `tests/unit/scripts/check-token-discipline.test.ts` feeds this synthetic lines
 * and checks that a `*Terminal*` path survives and a plain one does not.
 */
export function filterGitGrepLines(lines) {
  return lines.filter(
    (line) =>
      line.length > 0 && !TEST_FILE_EXCLUDE.test(line) && !TERMINAL_FILE_EXCLUDE.test(line)
  );
}

/**
 * The same two exclusions, expressed over a bare repository-relative path.
 *
 * Check 2 walks files rather than grep lines, and both exclusion regexes are
 * written against the `path:` field of a grep line, so the `:` terminator is
 * appended here instead of loosening the regexes — `TERMINAL_FILE_EXCLUDE` in
 * particular relies on that `:` to stop at the path.
 */
export function isExcludedPath(file) {
  const asGrepPath = `${file}:`;
  return TEST_FILE_EXCLUDE.test(asGrepPath) || TERMINAL_FILE_EXCLUDE.test(asGrepPath);
}

/**
 * @param root repository root to scan (defaults to this repository)
 * @returns the offending `path:line:content` lines, empty when clean
 * @throws when `git grep` itself failed (exit > 1) — a guard that could not run
 *         must not report "clean"
 */
export function findTokenDisciplineViolations(root) {
  const result = spawnSync(
    'git',
    ['grep', '-nE', TOKEN_DISCIPLINE_PATTERN, '--', ...GUARDED_PATHSPECS],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.error) {
    throw new Error(`git grep could not be spawned: ${result.error.message}`);
  }
  // git grep: 0 = matches, 1 = no matches, >1 = failure.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `git grep exited ${result.status}: ${(result.stderr || '').trim() || 'no stderr'}`
    );
  }
  return filterGitGrepLines((result.stdout || '').split('\n'));
}

/* ==========================================================================
 * Check 2 (Issue #1889): the token being referenced has to exist.
 * ========================================================================== */

/** Where the project's color tokens are declared. */
export const TOKEN_SOURCE_FILE = 'src/app/globals.css';

/** Extensions worth scanning for class names; `src/app` also holds PNGs. */
export const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css'];

/**
 * `--color-<name>:` at the start of a declaration.
 *
 * Anchored to the line start so a *use* such as
 * `border-color: var(--color-gray-200, currentcolor)` (globals.css does this)
 * is not mistaken for a definition.
 */
const COLOR_TOKEN_DEFINITION = /^[ \t]*--color-([a-z0-9-]+)[ \t]*:/gm;

/**
 * Read the declared color tokens out of `src/app/globals.css`.
 *
 * @throws when the file is unreadable or yields no tokens — if the theme block
 *         is ever moved or renamed, this guard must stop rather than declare
 *         every class in the repository unknown or (worse) everything fine.
 */
export function readColorTokens(root) {
  const file = path.join(root, TOKEN_SOURCE_FILE);
  let css;
  try {
    css = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`${TOKEN_SOURCE_FILE} could not be read: ${error.message}`);
  }
  const tokens = new Set();
  for (const match of css.matchAll(COLOR_TOKEN_DEFINITION)) tokens.add(match[1]);
  if (tokens.size === 0) {
    throw new Error(`${TOKEN_SOURCE_FILE} declares no --color-* tokens; the guard cannot judge`);
  }
  return tokens;
}

/** Tailwind's built-in palette families. Steps are 50 / 100…900 / 950. */
export const TAILWIND_PALETTE_FAMILIES =
  'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone';

/**
 * A color Tailwind ships itself. Accepted by check 2 on purpose: policing raw
 * palette usage is check 1's job (and `text-white` / `bg-black` are out of
 * scope for #1889), so check 2 only ever asks "does this name resolve".
 */
const TAILWIND_BUILTIN_COLOR = new RegExp(
  `^(inherit|current|transparent|black|white|(${TAILWIND_PALETTE_FAMILIES})-(50|[1-9]00|950))$`
);

const NUMERIC = /^\d+(\.\d+)?$/;

/**
 * Built-in NON-color utilities, per prefix, as the part after `<prefix>-`.
 *
 * Only suffixes starting with a letter need an entry: a candidate whose
 * suffix starts with a digit (`text-2xl`, `border-2`, `ring-4`) is never
 * extracted in the first place — see UTILITY_CANDIDATE. The numeric-looking
 * alternatives kept below (`[2-9]xl`, the `NUMERIC` branches) document the
 * shape of the utility family rather than doing work.
 */
const TAILWIND_BUILTIN_NON_COLOR = {
  bg: [
    /^(fixed|local|scroll)$/, // background-attachment
    /^clip-(border|padding|content|text)$/,
    /^origin-(border|padding|content)$/,
    // background-position, v3 (`bg-left-top`) and v4 (`bg-top-left`) spellings
    /^(bottom|center|left|right|top|(left|right)-(top|bottom)|(top|bottom)-(left|right))$/,
    /^position-.+$/,
    /^(repeat|no-repeat|repeat-(x|y|round|space))$/,
    /^(auto|cover|contain)$/, // background-size
    /^size-.+$/,
    /^none$/, // background-image: none
    /^gradient-to-(t|tr|r|br|b|bl|l|tl)$/, // v3 spelling, still used here
    /^linear-(to-(t|tr|r|br|b|bl|l|tl)|\d+)$/, // v4 spelling
    /^(radial|conic)(-.+)?$/,
    /^blend-(normal|multiply|screen|overlay|darken|lighten|color-dodge|color-burn|hard-light|soft-light|difference|exclusion|hue|saturation|color|luminosity)$/,
  ],
  text: [
    /^(xs|sm|base|lg|xl|[2-9]xl)$/, // font-size
    /^(left|center|right|justify|start|end)$/, // text-align
    /^(ellipsis|clip)$/, // text-overflow
    /^(wrap|nowrap|balance|pretty)$/, // text-wrap
    /^shadow-(2xs|xs|sm|md|lg|none)$/, // text-shadow (Tailwind 4.1)
    /^opacity-\d+$/, // deprecated, kept so it reads as "known", not "typo"
  ],
  border: [
    /^(solid|dashed|dotted|double|hidden|none)$/, // border-style
    /^(collapse|separate)$/, // border-collapse
    /^spacing(-(x|y))?-.+$/,
    /^opacity-\d+$/,
  ],
  ring: [/^inset$/, /^opacity-\d+$/],
};

/** border-<side>-… : `border-t-2`, `border-b-0`, `border-l-danger`. */
const BORDER_SIDE = /^(x|y|t|r|b|l|s|e)$/;
const BORDER_STYLE = /^(solid|dashed|dotted|double|hidden|none)$/;

/**
 * Verdict for one candidate utility.
 *
 * @param utility e.g. `bg-info-subtle`, `border-b-2`, `ring-offset-background`
 * @param tokens  the `--color-*` names declared by the project
 * @returns `'builtin'` (a Tailwind non-color utility), `'palette'` (a Tailwind
 *          built-in color), `'token'` (a project token), `'unknown'` (nothing
 *          resolves it — a violation), or `'skip'` (not a candidate at all)
 */
export function classifyColorUtility(utility, tokens) {
  const parsed = /^(bg|text|border|ring)-(.+)$/.exec(utility);
  if (!parsed) return 'skip';
  const [, prefix, rest] = parsed;

  const isColor = (name) =>
    TAILWIND_BUILTIN_COLOR.test(name) ? 'palette' : tokens.has(name) ? 'token' : 'unknown';

  if (TAILWIND_BUILTIN_NON_COLOR[prefix].some((pattern) => pattern.test(rest))) return 'builtin';

  if (prefix === 'ring') {
    // `ring-offset-2` is a width; `ring-offset-background` is a color.
    if (rest.startsWith('offset-')) {
      const offset = rest.slice('offset-'.length);
      return NUMERIC.test(offset) ? 'builtin' : isColor(offset);
    }
    if (NUMERIC.test(rest)) return 'builtin';
    return isColor(rest);
  }

  if (prefix === 'border') {
    if (NUMERIC.test(rest)) return 'builtin';
    const separator = rest.indexOf('-');
    const head = separator === -1 ? rest : rest.slice(0, separator);
    if (BORDER_SIDE.test(head)) {
      const tail = separator === -1 ? '' : rest.slice(separator + 1);
      if (tail === '' || NUMERIC.test(tail) || BORDER_STYLE.test(tail)) return 'builtin';
      return isColor(tail);
    }
    return isColor(rest);
  }

  return isColor(rest);
}

/**
 * Blank out comment bodies, line by line, keeping the line count intact so
 * reported line numbers stay usable.
 *
 * Deliberately naive, and biased towards under-stripping in exactly one
 * direction: a construct it misreads costs a MISSED check, never a false
 * report on prose. It does not track string state, because the alternative —
 * a real tokenizer — trips over things like the glob `'**\/*.tsx'`, whose
 * `/*` would swallow the rest of the file.
 */
export function stripComments(text) {
  let inBlockComment = false;
  return text.split('\n').map((line) => {
    const trimmed = line.trim();
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end === -1) return '';
      inBlockComment = false;
      return line.slice(end + 2);
    }
    // A line that opens a block comment (`/*`, `/**`, JSX `{/*`) without
    // closing it: everything up to the closing `*/` is prose.
    if (/^\{?\s*\/\*/.test(trimmed) && !trimmed.includes('*/')) {
      inBlockComment = true;
      return '';
    }
    if (/^(\/\/|\*)/.test(trimmed)) return '';
    return line.replace(/\/\*.*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/, '$1');
  });
}

/**
 * A literal `(bg|text|border|ring)-…` occurrence.
 *
 * The lookbehind rejects a match glued to a preceding word character, which is
 * what stops `bring-back` from reading as `ring-back` and `plain-text-only` as
 * `text-only`. `/` is in there for the same reason: a URL path segment
 * (`https://example.com/docs/text-formatting`) is not a class name, and `/` is
 * a legal *trailing* character (the opacity modifier `bg-muted/50`) rather than
 * a leading one. `:` is intentionally NOT in the set, so a variant (`hover:`,
 * `dark:`, `data-[state=active]:`) simply ends before the match and the
 * candidate arrives already stripped of it.
 *
 * The suffix must start with a LETTER: `text-2xl` / `border-2` / `ring-4` are
 * numeric built-ins with nothing to verify, and skipping them keeps the
 * allow-list to the shapes that could plausibly be a token name.
 */
const UTILITY_CANDIDATE = /(?<![A-Za-z0-9_$/-])(bg|text|border|ring)-[A-Za-z][A-Za-z0-9./[\]_-]*/g;

/**
 * Pull the checkable class-name candidates out of one file's text.
 *
 * @returns `{ line, utility }` per occurrence, 1-indexed lines
 */
export function extractUtilityCandidates(text) {
  const found = [];
  stripComments(text).forEach((line, index) => {
    for (const match of line.matchAll(UTILITY_CANDIDATE)) {
      const raw = match[0];
      // `text-align: left;` — a CSS declaration, not a class. A Tailwind
      // variant is written BEFORE the utility, so a candidate is never
      // legitimately followed by `:`.
      if (line[match.index + raw.length] === ':') continue;
      // `` `text-input-${groupName}` `` — a dynamically completed name (and,
      // here, an element id rather than a class at all).
      if (raw.endsWith('-')) continue;
      const utility = raw.split('/')[0]; // drop the opacity modifier: bg-muted/50
      if (utility.includes('[')) continue; // arbitrary value — out of scope
      found.push({ line: index + 1, utility });
    }
  });
  return found;
}

/** Format one unknown-token violation as an addressable `path:line: class`. */
export function formatUnknownTokenViolation(violation) {
  return `${violation.file}:${violation.line}: ${violation.utility}`;
}

/**
 * @param root repository root to scan (defaults to this repository)
 * @returns `{ file, line, utility }` for every class naming a token that does
 *          not exist, empty when clean
 * @throws when the file list or the token list could not be produced — a guard
 *         that could not run must not report "clean"
 */
export function findUnknownTokenViolations(root) {
  const tokens = readColorTokens(root);
  const listed = spawnSync('git', ['ls-files', '-z', '--', ...GUARDED_PATHSPECS], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.error) {
    throw new Error(`git ls-files could not be spawned: ${listed.error.message}`);
  }
  if (listed.status !== 0) {
    throw new Error(
      `git ls-files exited ${listed.status}: ${(listed.stderr || '').trim() || 'no stderr'}`
    );
  }

  const files = (listed.stdout || '')
    .split('\0')
    .filter((file) => file.length > 0)
    .filter((file) => SCANNED_EXTENSIONS.includes(path.extname(file)))
    .filter((file) => !isExcludedPath(file));

  const violations = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const { line, utility } of extractUtilityCandidates(text)) {
      if (classifyColorUtility(utility, tokens) === 'unknown') {
        violations.push({ file, line, utility });
      }
    }
  }
  return violations;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let rawPalette;
  let unknownTokens;
  try {
    rawPalette = findTokenDisciplineViolations(root);
    unknownTokens = findUnknownTokenViolations(root);
  } catch (error) {
    console.error(`::error::Token discipline guard could not run — ${error.message}`);
    process.exit(2);
  }
  let failed = false;
  if (rawPalette.length > 0) {
    failed = true;
    console.error(
      '::error::Raw gray/slate or chromatic color utilities found in migrated directories (Issue #1082 / #1116). Replace with semantic tokens — see docs/design-system.md.'
    );
    for (const line of rawPalette) console.error(line);
  }
  if (unknownTokens.length > 0) {
    failed = true;
    console.error(
      '::error::Color utilities naming a token that does not exist in src/app/globals.css (Issue #1889). Tailwind drops these silently, so the element renders unstyled. Use a token listed in docs/design-system.md.'
    );
    for (const violation of unknownTokens) console.error(formatUnknownTokenViolation(violation));
  }
  if (failed) process.exit(1);
  console.log(
    'Token discipline: no raw gray/slate or chromatic utilities, and every color token referenced exists.'
  );
}
