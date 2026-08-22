#!/usr/bin/env node
/**
 * Fails when an App Router route file exports something Next.js will not accept.
 *
 * [Issue #1946] PR #1943 added `export const SERVER_CAPABILITIES` to
 * `src/app/api/capabilities/route.ts` and broke `npm run build` on develop:
 *
 *     Type error: Route "src/app/api/capabilities/route.ts" does not match the
 *     required types of a Next.js Route.
 *       "SERVER_CAPABILITIES" is not a valid Route export field.
 *
 * Next generates the type-guard file that produces this error inside
 * `next build` (`next/dist/build/webpack/plugins/next-types-plugin`), which
 * writes it to a `route.ts` under `.next/types/app`, and `.commandmate/verify.yaml`
 * declares no build gate — so the defect walked straight through
 * `wait --verify`'s exit code into develop.
 *
 * Measured on this branch, because the Issue's "lint / tsc --noEmit / test:unit
 * all miss it" is true only in the case that matters and it is worth being
 * precise about which one. `tsconfig.json` includes the generated `.next/types`
 * tree, so with the mutation applied:
 *
 *   .next present (a worktree that has built before)   tsc --noEmit  exit 2
 *   .next absent  (fresh checkout, fresh worktree)     tsc --noEmit  exit 0
 *   either way                                         npm run lint  exit 0
 *   either way                                         this guard    exit 1
 *
 * CI's `Type Check` job and a `wait --verify` in a newly created worktree are
 * both the second row, which is why nothing stopped #1943. And even the first
 * row only holds for routes that already existed at the last build: a brand-new
 * `route.ts` has no generated type-guard file yet, so `.next` being present is
 * not a substitute for this check.
 *
 * This guard is the cheap half of that hole: it re-states, statically, the ONE
 * property of a route module a fresh `tsc --noEmit` cannot see — which names the
 * module exports. It is not a build; it says nothing about types, imports or
 * anything else `next build` checks.
 *
 * [Issue #1882] This file is the SINGLE authority for the allow-list.
 * `.github/workflows/ci-pr.yml` (job `route-exports`) and
 * `.commandmate/verify.yaml` (gate `route-exports`) both run this script and
 * hold no copy of the list, because the same guard written twice is a guard that
 * gets updated in one place and quietly diverges in the other. Same shape as
 * `scripts/check-control-chars.mjs` / `check-claudemd-size.mjs` /
 * `check-token-discipline.mjs`.
 *
 * ---------------------------------------------------------------------------
 * WHY A HAND-WRITTEN SCANNER RATHER THAN `typescript` OR `@typescript-eslint`
 * ---------------------------------------------------------------------------
 * The CI job is a checkout plus ONE `run:` step and performs no `npm install`
 * (`tests/unit/guards/static-guard-single-source.test.ts` pins the job to
 * exactly that one step), so this script has to keep working with nothing but
 * Node and the repository. Importing a parser would make the guard depend on
 * `node_modules` being present in a job that never populates it.
 *
 * A string `grep` is not an option either: this repository has been burned by
 * grep-shaped guards matching inside comments and string literals. So the
 * middle path is a real LEXER — comments, string literals, template literals
 * (including nested `${}`) and regex literals are consumed as units, brace /
 * paren / bracket depth is tracked, and only an `export` keyword at depth 0
 * that is not preceded by `.` is treated as an export. That is not a full
 * parser, but it is "syntax" rather than "text": no comment, no string and no
 * regex body can produce a finding, and no `export` inside a nested scope can
 * be missed by an indentation assumption.
 *
 * Failure direction: when the scanner meets something it cannot classify it
 * REPORTS it (`<unrecognized export form>`) or throws (exit 2), never shrugs.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT CHECKED
 * ---------------------------------------------------------------------------
 *   - TYPE exports. `export type X` / `export interface X` / `export { type A }`
 *     are erased before emit and are NOT properties of `typeof import('./route')`,
 *     so Next never sees them. There are ~30 of them in this repository's route
 *     files (`src/app/api/skills/**`); reporting them would be a false positive
 *     on green code.
 *   - The TYPES of the exports. `export const dynamic = 'nope'` is a build error
 *     Next reports separately (`Expected "auto" | ... got "nope"`), and checking
 *     it needs the compiler. This guard only answers "is this NAME allowed".
 *   - `page.tsx` / `layout.tsx` / `default.tsx`. They have a different, larger
 *     allow-list and they contain JSX, which this lexer does not handle (see
 *     UNSUPPORTED_ROUTE_BASENAMES — a `route.tsx` makes the guard throw rather
 *     than skip).
 *   - Anything outside `src/app`. Next only type-checks App Router entries.
 *
 * Usage: node scripts/check-route-exports.mjs [repoRoot]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/* ==========================================================================
 * The allow-list — derived from Next 15.5.20, not from memory.
 * ========================================================================== */

/**
 * The HTTP verbs a route module may export as handlers.
 *
 * Source: `HTTP_METHODS` in `node_modules/next/dist/server/web/http.js`, which
 * is what `next-types-plugin` maps over when it writes `${method}?: Function`
 * into the generated type-guard file.
 */
export const ROUTE_HTTP_METHOD_EXPORTS = [
  'GET',
  'HEAD',
  'OPTIONS',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
];

/**
 * The non-handler fields the generated type-guard's `Base` type declares for a
 * route (`options.type === 'route'`), read out of
 * `node_modules/next/dist/build/webpack/plugins/next-types-plugin/index.js`:
 *
 *     checkFields<Diff<{
 *       GET?: Function … PATCH?: Function      // <- ROUTE_HTTP_METHOD_EXPORTS
 *       config?: {}
 *       generateStaticParams?: Function
 *       revalidate?: RevalidateRange<TEntry> | false
 *       dynamic?: 'auto' | 'force-dynamic' | 'error' | 'force-static'
 *       dynamicParams?: boolean
 *       fetchCache?: …
 *       preferredRegion?: …
 *       runtime?: 'nodejs' | 'experimental-edge' | 'edge'
 *       maxDuration?: number
 *     }, TEntry, ''>>()
 *
 * Everything the module exports beyond `keyof Base` is what `Diff` leaves
 * behind, and `checkFields<_ extends { [k in keyof any]: never }>` then rejects
 * it — that is the "is not a valid Route export field" error, verbatim.
 *
 * `config` is in the list because Next puts it there, even though it is the
 * legacy Pages-Router shape and nothing here uses it. Two entries in the
 * template are PAGE-ONLY and therefore absent here: `default`, and the
 * `metadata` / `generateMetadata` / `viewport` / `generateViewport` /
 * `experimental_ppr` block that the template emits only when
 * `options.type !== 'route'`.
 *
 * `tests/unit/guards/route-export-allowlist.test.ts` re-derives both lists from
 * those two files in `node_modules/next` and asserts they equal these arrays, so
 * a Next upgrade that changes the shape turns the unit suite RED at upgrade time
 * instead of leaving this guard quietly wrong in either direction.
 */
export const ROUTE_SEGMENT_CONFIG_EXPORTS = [
  'config',
  'generateStaticParams',
  'revalidate',
  'dynamic',
  'dynamicParams',
  'fetchCache',
  'preferredRegion',
  'runtime',
  'maxDuration',
];

/** Every name a route module is allowed to export at runtime. */
export const ALLOWED_ROUTE_EXPORTS = new Set([
  ...ROUTE_HTTP_METHOD_EXPORTS,
  ...ROUTE_SEGMENT_CONFIG_EXPORTS,
]);

/* ==========================================================================
 * Lexer
 * ========================================================================== */

/**
 * Keywords after which a `/` opens a REGEX rather than being division.
 *
 * The rest of the rule is positional (see `regexAllowed`): after a value —
 * identifier, literal, `)`, `]`, `}`, `++`, `--` — a `/` is division; after any
 * other punctuator it opens a regex.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

const IDENT_START = /[A-Za-z_$\u0080-\uFFFF]/;
const IDENT_PART = /[A-Za-z0-9_$\u0080-\uFFFF]/;

/** @returns true when a `/` at this position starts a regex literal. */
function regexAllowed(prev) {
  if (!prev) return true;
  if (prev.kind === 'word') return REGEX_PRECEDING_KEYWORDS.has(prev.value);
  if (prev.kind !== 'punct') return false; // number / string / template / regex are values
  return !(
    prev.value === ')' ||
    prev.value === ']' ||
    prev.value === '}' ||
    prev.value === '++' ||
    prev.value === '--'
  );
}

/**
 * Split TypeScript source into significant tokens.
 *
 * Comments are dropped. Strings, template literals and regex literals are
 * consumed whole and emitted as ONE token each, which is what makes an `export`
 * written inside a comment or a string invisible to the caller. Every token
 * carries `depth`, the `{` / `(` / `[` nesting it sits inside — an opener and
 * its matching closer both report the OUTER depth.
 *
 * @throws on an unterminated comment / string / template / regex, so a file this
 *         scanner cannot read becomes an error rather than "no exports found".
 */
export function tokenize(text) {
  const tokens = [];
  /** `{` `(` `[` for brackets, `T` for a template-literal body. */
  const stack = [];
  const bracketDepth = () => stack.filter((entry) => entry !== 'T').length;
  let i = 0;
  let line = 1;
  let prev = null;

  const emit = (kind, value, at) => {
    prev = { kind, value, line: at, depth: bracketDepth() };
    tokens.push(prev);
  };
  const fail = (what) => {
    throw new Error(`${what} at line ${line}`);
  };

  while (i < text.length) {
    // --- inside a template literal body -----------------------------------
    if (stack[stack.length - 1] === 'T') {
      const c = text[i];
      if (c === '\\') {
        if (text[i + 1] === '\n') line += 1;
        i += 2;
        continue;
      }
      if (c === '\n') {
        line += 1;
        i += 1;
        continue;
      }
      if (c === '`') {
        stack.pop();
        emit('template', '`', line);
        i += 1;
        continue;
      }
      if (c === '$' && text[i + 1] === '{') {
        emit('punct', '${', line);
        stack.push('{');
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    const c = text[i];

    if (c === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
      i += 1;
      continue;
    }

    // --- comments ---------------------------------------------------------
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      for (;;) {
        if (i >= text.length) fail('unterminated block comment');
        if (text[i] === '*' && text[i + 1] === '/') break;
        if (text[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }

    // --- regex literal ----------------------------------------------------
    if (c === '/' && regexAllowed(prev)) {
      const startLine = line;
      let j = i + 1;
      let inClass = false;
      for (;;) {
        if (j >= text.length || text[j] === '\n') fail('unterminated regex literal');
        const d = text[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        j += 1;
      }
      j += 1;
      while (j < text.length && /[a-z]/i.test(text[j])) j += 1;
      emit('regex', text.slice(i, j), startLine);
      i = j;
      continue;
    }

    // --- string literal ---------------------------------------------------
    if (c === "'" || c === '"') {
      const startLine = line;
      let j = i + 1;
      for (;;) {
        if (j >= text.length || text[j] === '\n') fail('unterminated string literal');
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === c) break;
        j += 1;
      }
      j += 1;
      emit('string', text.slice(i, j), startLine);
      i = j;
      continue;
    }

    // --- template literal opener -----------------------------------------
    if (c === '`') {
      emit('punct', '`', line);
      stack.push('T');
      i += 1;
      continue;
    }

    // --- identifier / keyword --------------------------------------------
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < text.length && IDENT_PART.test(text[j])) j += 1;
      emit('word', text.slice(i, j), line);
      i = j;
      continue;
    }

    // --- number (scanned loosely; only its extent matters here) -----------
    if (c >= '0' && c <= '9') {
      let j = i + 1;
      while (j < text.length && /[0-9a-zA-Z_.]/.test(text[j])) {
        if (/[eE]/.test(text[j]) && /[+-]/.test(text[j + 1] ?? '')) j += 1;
        j += 1;
      }
      emit('number', text.slice(i, j), line);
      i = j;
      continue;
    }

    // --- brackets ---------------------------------------------------------
    if (c === '{' || c === '(' || c === '[') {
      emit('punct', c, line);
      stack.push(c);
      i += 1;
      continue;
    }
    if (c === '}' || c === ')' || c === ']') {
      if (stack.length === 0) fail(`unbalanced '${c}'`);
      stack.pop();
      emit('punct', c, line);
      i += 1;
      continue;
    }

    // --- the two punctuators the regex heuristic needs to see whole -------
    if ((c === '+' && text[i + 1] === '+') || (c === '-' && text[i + 1] === '-')) {
      emit('punct', c + c, line);
      i += 2;
      continue;
    }

    emit('punct', c, line);
    i += 1;
  }

  if (stack.length > 0) fail('unbalanced brackets at end of file');
  return tokens;
}

/* ==========================================================================
 * Export extraction
 * ========================================================================== */

/** Modifiers that may sit between `export` and the declaration keyword. */
const DECLARATION_MODIFIERS = new Set(['declare', 'abstract', 'async']);

/** Tokens that end a top-level declarator without opening anything. */
const isDepth0 = (token, kind, value) =>
  token !== undefined && token.depth === 0 && token.kind === kind && token.value === value;

const unquote = (raw) => raw.slice(1, -1);

/**
 * Names bound by a destructuring pattern whose opener is `tokens[start]`.
 *
 * `{ a, b: c, d = 1, ...rest }` binds a / c / d / rest; `[x, , y]` binds x / y.
 * A name followed by `:` is a KEY, so the binding is whatever comes after it.
 *
 * @returns `{ names, end }` — `end` is the index of the matching closer.
 */
function collectPatternNames(tokens, start) {
  const base = tokens[start].depth;
  const names = [];
  let j = start + 1;

  while (j < tokens.length) {
    const token = tokens[j];
    if (token.kind === 'punct' && (token.value === '}' || token.value === ']') && token.depth === base) {
      break;
    }
    if (token.depth === base + 1) {
      if (token.kind === 'punct' && (token.value === '{' || token.value === '[')) {
        const nested = collectPatternNames(tokens, j);
        names.push(...nested.names);
        j = nested.end + 1;
        continue;
      }
      if (token.kind === 'word') {
        const next = tokens[j + 1];
        if (next && next.kind === 'punct' && next.value === ':') {
          j += 2; // a key; the binding follows
          continue;
        }
        names.push({ name: token.value, line: token.line });
        // Skip a default value (`a = expr`) up to this pattern's next comma.
        j += 1;
        while (
          j < tokens.length &&
          !(tokens[j].depth === base + 1 && tokens[j].kind === 'punct' && tokens[j].value === ',') &&
          !(tokens[j].depth === base && tokens[j].kind === 'punct' && (tokens[j].value === '}' || tokens[j].value === ']'))
        ) {
          j += 1;
        }
        continue;
      }
    }
    j += 1;
  }
  return { names, end: j };
}

/**
 * Names introduced by `const` / `let` / `var`, starting at the first binding.
 *
 * Handles several declarators (`export const A = 1, B = 2`) and destructuring.
 * A declarator's type annotation and initializer are skipped up to the next
 * depth-0 `,` or `;`; a depth-0 `export` also stops the scan so a file written
 * without semicolons cannot make one declaration swallow the next.
 */
function collectDeclaratorNames(tokens, start) {
  const names = [];
  let j = start;

  for (;;) {
    const token = tokens[j];
    if (!token) break;
    if (token.kind === 'punct' && (token.value === '{' || token.value === '[')) {
      const pattern = collectPatternNames(tokens, j);
      names.push(...pattern.names);
      j = pattern.end + 1;
    } else if (token.kind === 'word') {
      names.push({ name: token.value, line: token.line });
      j += 1;
    } else {
      break;
    }
    while (
      j < tokens.length &&
      !isDepth0(tokens[j], 'punct', ',') &&
      !isDepth0(tokens[j], 'punct', ';') &&
      !isDepth0(tokens[j], 'word', 'export')
    ) {
      j += 1;
    }
    if (!isDepth0(tokens[j], 'punct', ',')) break;
    j += 1;
  }
  return names;
}

/**
 * Names in an `export { … }` clause, skipping `type`-modified specifiers.
 *
 * `export { A, B as C, type D, x as "str" }` exports A / C / str.
 */
function collectNamedExportList(tokens, start) {
  const base = tokens[start].depth;
  const names = [];
  let j = start + 1;

  while (j < tokens.length) {
    const token = tokens[j];
    if (token.kind === 'punct' && token.value === '}' && token.depth === base) break;
    if (token.kind === 'punct' && token.value === ',') {
      j += 1;
      continue;
    }

    let isTypeOnly = false;
    if (
      token.kind === 'word' &&
      token.value === 'type' &&
      tokens[j + 1] &&
      (tokens[j + 1].kind === 'word' || tokens[j + 1].kind === 'string') &&
      tokens[j + 1].value !== 'as'
    ) {
      isTypeOnly = true;
      j += 1;
    }

    const local = tokens[j];
    if (!local || (local.kind !== 'word' && local.kind !== 'string')) {
      j += 1;
      continue;
    }
    let name = local.kind === 'string' ? unquote(local.value) : local.value;
    let atLine = local.line;
    j += 1;

    if (tokens[j] && tokens[j].kind === 'word' && tokens[j].value === 'as') {
      const exported = tokens[j + 1];
      if (exported && (exported.kind === 'word' || exported.kind === 'string')) {
        name = exported.kind === 'string' ? unquote(exported.value) : exported.value;
        atLine = exported.line;
        j += 2;
      } else {
        j += 1;
      }
    }

    if (!isTypeOnly) names.push({ name, line: atLine });
  }
  return names;
}

/**
 * Every RUNTIME export a module declares, with the syntactic form it used.
 *
 * Type-only exports (`export type` / `export interface` / `export { type X }`)
 * are absent by design: they are not properties of `typeof import('./route')`,
 * so Next's route check never sees them.
 *
 * `default` and `*` come back as exports named `default` and `*`. Neither is a
 * valid route field, and `export *` additionally cannot be resolved without
 * following the module graph — reporting it is the honest answer.
 *
 * @returns `{ name, line, form }[]`
 */
export function extractRuntimeExports(text) {
  const tokens = tokenize(text);
  const found = [];

  for (let k = 0; k < tokens.length; k += 1) {
    const token = tokens[k];
    if (token.kind !== 'word' || token.value !== 'export' || token.depth !== 0) continue;
    const before = tokens[k - 1];
    if (before && before.kind === 'punct' && before.value === '.') continue; // `obj.export`

    let j = k + 1;
    const at = () => tokens[j];
    const isWord = (value) => at() !== undefined && at().kind === 'word' && at().value === value;
    const isPunct = (value) => at() !== undefined && at().kind === 'punct' && at().value === value;
    const push = (name, form, line) => found.push({ name, line: line ?? token.line, form });

    if (at() === undefined) {
      push('<unrecognized export form>', 'unrecognized');
      continue;
    }

    // `export default …` — a route module has no `default` slot in Next (the
    // generated Base declares `default: Function` only when the entry is a page
    // or a layout). Verified against the build: adding
    // `export default async function handler()` to a route.ts fails
    // `npm run build` with `"handler" is not a valid Route export field`. Next
    // names it by the local binding, this guard names the export slot; both
    // point at the same line.
    if (isWord('default')) {
      push('default', 'default', at().line);
      continue;
    }

    while (at() !== undefined && at().kind === 'word' && DECLARATION_MODIFIERS.has(at().value)) {
      j += 1;
    }

    // Type-only: erased before emit, invisible to Next.
    if (isWord('type') || isWord('interface')) continue;

    if (isPunct('*')) {
      j += 1;
      if (isWord('as') && tokens[j + 1] && tokens[j + 1].kind === 'word') {
        push(tokens[j + 1].value, 'star-as', tokens[j + 1].line);
      } else {
        push('*', 'star', token.line);
      }
      continue;
    }

    if (isPunct('{')) {
      for (const entry of collectNamedExportList(tokens, j)) {
        push(entry.name, 'named', entry.line);
      }
      continue;
    }

    if (isWord('function')) {
      j += 1;
      if (isPunct('*')) j += 1;
      if (at() && at().kind === 'word') push(at().value, 'function', at().line);
      else push('<unrecognized export form>', 'unrecognized');
      continue;
    }

    if (isWord('class') || isWord('enum') || isWord('namespace') || isWord('module')) {
      const form = at().value;
      j += 1;
      if (at() && (at().kind === 'word' || at().kind === 'string')) {
        const name = at().kind === 'string' ? unquote(at().value) : at().value;
        push(name, form, at().line);
      } else {
        push('<unrecognized export form>', 'unrecognized');
      }
      continue;
    }

    if (isWord('const') || isWord('let') || isWord('var')) {
      j += 1;
      if (isWord('enum')) {
        // `export const enum X` — still a value in `typeof import()`.
        j += 1;
        if (at() && at().kind === 'word') push(at().value, 'enum', at().line);
        else push('<unrecognized export form>', 'unrecognized');
        continue;
      }
      const names = collectDeclaratorNames(tokens, j);
      if (names.length === 0) push('<unrecognized export form>', 'unrecognized');
      for (const entry of names) push(entry.name, 'variable', entry.line);
      continue;
    }

    push('<unrecognized export form>', 'unrecognized');
  }

  return found;
}

/* ==========================================================================
 * File enumeration
 * ========================================================================== */

/** Next resolves an App Router route entry from any of these basenames. */
export const ROUTE_FILE_BASENAMES = ['route.ts', 'route.mts', 'route.cts', 'route.js', 'route.mjs', 'route.cjs'];

/**
 * Route entries this scanner refuses to judge.
 *
 * Next accepts `route.tsx` / `route.jsx`, but the lexer above reads `<` as an
 * operator, so JSX would desynchronise it. There are none in this repository
 * (a route returns a `Response`, not an element). If one ever appears the guard
 * THROWS — silently skipping a file Next does type-check is the one outcome a
 * guard must never produce.
 */
export const UNSUPPORTED_ROUTE_BASENAMES = ['route.tsx', 'route.jsx'];

/** The App Router directory. Everything Next type-checks as a Route lives here. */
export const APP_DIR = 'src/app';

/**
 * @returns repository-relative paths of every App Router route entry, sorted
 * @throws when a `route.tsx` / `route.jsx` is present (see above)
 */
export function collectRouteFiles(root) {
  const appDir = path.join(root, APP_DIR);
  if (!fs.existsSync(appDir)) {
    throw new Error(`${APP_DIR} does not exist under ${root}`);
  }

  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(full);
        continue;
      }
      if (UNSUPPORTED_ROUTE_BASENAMES.includes(entry.name)) {
        throw new Error(
          `${path.relative(root, full)} is a JSX route entry; this guard cannot lex JSX and must not skip it silently`
        );
      }
      if (ROUTE_FILE_BASENAMES.includes(entry.name)) {
        files.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };
  walk(appDir);
  return files.sort();
}

/**
 * @param root repository root to scan (defaults to this repository)
 * @returns `{ scanned, violations }` — one violation per disallowed export name
 * @throws when the scan could not be performed; a guard that could not run must
 *         not report "clean"
 */
export function findRouteExportViolations(root) {
  const files = collectRouteFiles(root);
  if (files.length === 0) {
    throw new Error(`no route entries found under ${APP_DIR}; the guard has nothing to judge`);
  }

  const violations = [];
  for (const file of files) {
    let exported;
    try {
      exported = extractRuntimeExports(fs.readFileSync(path.join(root, file), 'utf8'));
    } catch (error) {
      throw new Error(`${file}: ${error.message}`);
    }
    for (const entry of exported) {
      if (ALLOWED_ROUTE_EXPORTS.has(entry.name)) continue;
      violations.push({ file, ...entry });
    }
  }
  return { scanned: files.length, violations };
}

/** Format one violation as an addressable `path:line: name (form)`. */
export function formatRouteExportViolation(violation) {
  return `${violation.file}:${violation.line}: ${violation.name} (${violation.form})`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let result;
  try {
    result = findRouteExportViolations(root);
  } catch (error) {
    console.error(`::error::Route export guard could not run — ${error.message}`);
    process.exit(2);
  }
  if (result.violations.length > 0) {
    console.error(
      '::error::App Router route files export names Next.js does not accept (Issue #1946). `next build` fails these with "is not a valid Route export field"; lint, tsc --noEmit and the unit suite are all blind to them. Move the value to a module the route imports.'
    );
    for (const violation of result.violations) {
      console.error(
        `::error file=${violation.file},line=${violation.line}::${violation.name} is not a valid Route export field`
      );
      console.error(formatRouteExportViolation(violation));
    }
    console.error(
      `\nAllowed route exports: ${[...ALLOWED_ROUTE_EXPORTS].join(' ')} (plus any \`export type\` / \`export interface\`).`
    );
    process.exit(1);
  }
  console.log(
    `Route exports: ${result.scanned} App Router route entries export only fields Next.js accepts.`
  );
}
