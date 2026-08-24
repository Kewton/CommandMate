/**
 * A route module may only export what Next.js accepts (Issue #1946).
 *
 * ## What happened
 *
 * PR #1943 (Issue #1925) added `export const SERVER_CAPABILITIES = [...]` to
 * `src/app/api/capabilities/route.ts` and broke develop's build:
 *
 *     Type error: Route "src/app/api/capabilities/route.ts" does not match the
 *     required types of a Next.js Route.
 *       "SERVER_CAPABILITIES" is not a valid Route export field.
 *
 * `wait --verify` had returned exit 0 on every declared gate. It could not have
 * done otherwise: Next writes the type-guard file that produces this error while
 * `next build` runs (`next/dist/build/webpack/plugins/next-types-plugin`), so
 * `lint`, `tsc --noEmit` and `test:unit` never see it, and
 * `.commandmate/verify.yaml` declares no build gate. `/orchestrate` judges a
 * worker from that exit code, so the defect walked into develop unopposed.
 *
 * ## What this file pins
 *
 * `scripts/check-route-exports.mjs` restates that one property statically. Three
 * things about it can rot, and each has its own section below:
 *
 *   1. **The allow-list can fall behind Next.** It is a hand-written constant,
 *      because the CI job runs with no `node_modules` (see section 3). So the
 *      list is re-derived HERE from `node_modules/next` itself — the same shape
 *      as `tests/unit/scripts/check-token-discipline.test.ts` re-deriving the
 *      Tailwind palette from `theme.css` (#1892). A Next upgrade that changes
 *      the route contract turns this suite red at upgrade time instead of
 *      leaving the guard quietly wrong in either direction.
 *   2. **The scanner can go vacuous.** A guard that silently parses nothing
 *      passes forever. Every syntactic form it must catch, and every one it must
 *      ignore, has a fixture; the #1943 mutation itself is one of them; and the
 *      real scan asserts it reached 100+ route entries and pulled real handlers
 *      out of them.
 *   3. **The script can acquire a dependency.** The CI job is a checkout plus
 *      one `run:` with no install step, so an `import` of anything outside
 *      Node's own modules would make the job fail on a machine where it happens
 *      to work locally.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import {
  ALLOWED_ROUTE_EXPORTS,
  APP_DIR,
  ROUTE_HTTP_METHOD_EXPORTS,
  ROUTE_SEGMENT_CONFIG_EXPORTS,
  UNSUPPORTED_ROUTE_BASENAMES,
  collectRouteFiles,
  extractRuntimeExports,
  findRouteExportViolations,
  formatRouteExportViolation,
  tokenize,
} from '../../../scripts/check-route-exports.mjs';

const REPO_ROOT = process.cwd();
const GUARD_SCRIPT = join(REPO_ROOT, 'scripts', 'check-route-exports.mjs');
const require_ = createRequire(import.meta.url);

/** Every runtime export name the extractor pulls out of a source snippet. */
const namesIn = (source: string): string[] =>
  (extractRuntimeExports(source) as { name: string }[]).map((entry) => entry.name);

// ---------------------------------------------------------------------------
// 1. The allow-list, re-derived from the installed Next
// ---------------------------------------------------------------------------

const NEXT_ROOT = dirname(require_.resolve('next/package.json'));

/**
 * Blank out every `${…}` interpolation in a template-literal body.
 *
 * The generated type-guard file is written as one big template, and the fields
 * that are PAGE-ONLY (`metadata`, `generateMetadata`, `viewport`,
 * `generateViewport`, `experimental_ppr`) live inside
 * `${options.type === 'route' ? '' : `…`}`. Dropping the interpolations is
 * exactly what leaves the fields a ROUTE gets.
 */
function stripInterpolations(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '$' && text[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') depth -= 1;
        i += 1;
      }
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/** `HTTP_METHODS` as `next-types-plugin` maps over it to emit the handler slots. */
function nextHttpMethods(): string[] {
  const source = readFileSync(join(NEXT_ROOT, 'dist', 'server', 'web', 'http.js'), 'utf-8');
  const declaration = /const HTTP_METHODS = \[([\s\S]*?)\]/.exec(source);
  if (!declaration) throw new Error('next/dist/server/web/http.js: HTTP_METHODS not found');
  return [...declaration[1].matchAll(/'([A-Z]+)'/g)].map((match) => match[1]);
}

/**
 * The non-handler fields of the `Base` type in the generated route type-guard.
 *
 * That `Base` is the whole contract: `Diff<Base, TEntry, ''>` is
 * `Omit<TEntry, keyof Base>`, and `checkFields<_ extends { [k in keyof any]: never }>`
 * rejects whatever is left. "Not a valid Route export field" IS that rejection.
 */
function nextRouteConfigFields(): string[] {
  const source = readFileSync(
    join(NEXT_ROOT, 'dist', 'build', 'webpack', 'plugins', 'next-types-plugin', 'index.js'),
    'utf-8'
  );
  const start = source.indexOf('checkFields<Diff<{');
  const end = source.indexOf(", TEntry, ''>>()", start);
  if (start === -1 || end === -1) {
    throw new Error('next-types-plugin: the entry checkFields<Diff<{…}, TEntry, ""'.concat('>> block moved'));
  }
  const fields = stripInterpolations(source.slice(start, end));
  return [...fields.matchAll(/^[ \t]*([A-Za-z_$][\w$]*)\?:/gm)].map((match) => match[1]);
}

describe('the allow-list matches the installed Next', () => {
  it('reads a Next that still has the two files the derivation depends on', () => {
    // Anti-vacuity: every assertion below is a comparison against something read
    // out of node_modules. If the read silently produced nothing, they would all
    // compare empty to empty.
    expect(require_('next/package.json').version).toMatch(/^15\./);
    expect(nextHttpMethods().length).toBeGreaterThanOrEqual(7);
    expect(nextRouteConfigFields().length).toBeGreaterThanOrEqual(5);
  });

  it('declares exactly the HTTP methods Next emits handler slots for', () => {
    expect([...ROUTE_HTTP_METHOD_EXPORTS].sort()).toEqual([...nextHttpMethods()].sort());
  });

  it('declares exactly the route segment config fields Next accepts', () => {
    expect([...ROUTE_SEGMENT_CONFIG_EXPORTS].sort()).toEqual([...nextRouteConfigFields()].sort());
  });

  it('does not smuggle in the page-only fields', () => {
    // These are inside the `options.type !== 'route'` branch of the same
    // template. `default` is the page/layout entry point and has no route slot
    // at all — which is why `export default` is a violation here, not an
    // oversight.
    for (const pageOnly of [
      'default',
      'metadata',
      'generateMetadata',
      'viewport',
      'generateViewport',
      'experimental_ppr',
    ]) {
      expect(ALLOWED_ROUTE_EXPORTS.has(pageOnly), `${pageOnly} is page-only`).toBe(false);
    }
  });

  it('keeps `config`, which the Issue text left out', () => {
    // Recorded because it is the one place the Issue's estimated list and the
    // measured one disagree in the permissive direction: Next really does put
    // `config?: {}` in the route Base, legacy though it is.
    expect(ALLOWED_ROUTE_EXPORTS.has('config')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. The scanner: what it must catch, and what it must leave alone
// ---------------------------------------------------------------------------

describe('the scanner catches every export form', () => {
  const caught: [string, string, string[]][] = [
    ['a const', "export const SERVER_CAPABILITIES = ['a'];", ['SERVER_CAPABILITIES']],
    ['a let', 'export let counter = 0;', ['counter']],
    ['a var', 'export var legacy = 1;', ['legacy']],
    ['an annotated const', 'export const x: readonly string[] = [];', ['x']],
    ['a function', 'export function helper() {}', ['helper']],
    ['an async function', 'export async function GET() {}', ['GET']],
    ['a generator', 'export function* gen() {}', ['gen']],
    ['a class', 'export class Thing {}', ['Thing']],
    ['an abstract class', 'export abstract class Base {}', ['Base']],
    ['an enum', 'export enum Mode { A }', ['Mode']],
    ['a const enum', 'export const enum Mode { A }', ['Mode']],
    ['an ambient const', 'export declare const injected: string;', ['injected']],
    ['a default export', 'export default function handler() {}', ['default']],
    ['a default expression', 'export default 42;', ['default']],
    ['a named list', 'export { helper, other };', ['helper', 'other']],
    ['a renamed export', 'export { helper as GET };', ['GET']],
    ['a string-renamed export', 'export { helper as "weird name" };', ['weird name']],
    ['a re-export', "export { helper } from './helpers';", ['helper']],
    ['a star re-export', "export * from './helpers';", ['*']],
    ['a namespaced star re-export', "export * as helpers from './helpers';", ['helpers']],
    ['several declarators', 'export const a = 1, b = 2;', ['a', 'b']],
    ['object destructuring', 'export const { a, b: c } = thing;', ['a', 'c']],
    ['a rest element', 'export const { a, ...rest } = thing;', ['a', 'rest']],
    ['array destructuring', 'export const [first, , third] = tuple;', ['first', 'third']],
    ['a defaulted binding', 'export const { a = 1, b } = thing;', ['a', 'b']],
  ];

  it.each(caught)('%s', (_label, source, expected) => {
    expect(namesIn(source)).toEqual(expected);
  });

  it('finds every export in a file with several', () => {
    expect(
      namesIn(
        [
          "import { db } from '@/lib/db';",
          'export const dynamic = "force-dynamic";',
          'export async function GET() { return Response.json({}); }',
          'export async function POST() { return Response.json({}); }',
          'export const SERVER_CAPABILITIES = [1, 2, 3];',
        ].join('\n')
      )
    ).toEqual(['dynamic', 'GET', 'POST', 'SERVER_CAPABILITIES']);
  });
});

describe('the scanner leaves non-exports alone', () => {
  const ignored: [string, string][] = [
    ['a type alias', 'export type SkillUpdateResult = { ok: boolean };'],
    ['an interface', 'export interface UpdateResponse { ok: boolean }'],
    ['a type-only re-export', "export type { Foo } from './types';"],
    ['a type-only specifier', 'export { type Foo };'],
    ['a type-only renamed specifier', 'export { type Foo as Bar };'],
    ['an ambient type', 'export declare type Injected = string;'],
    ['a line comment', '// export const SERVER_CAPABILITIES = [];'],
    ['a block comment', '/* export const SERVER_CAPABILITIES = []; */'],
    ['a JSDoc example', '/**\n * export const SERVER_CAPABILITIES = [];\n */'],
    ['a single-quoted string', "const doc = 'export const SERVER_CAPABILITIES = [];';"],
    ['a double-quoted string', 'const doc = "export const SERVER_CAPABILITIES = [];";'],
    ['a template literal', 'const doc = `export const SERVER_CAPABILITIES = [];`;'],
    [
      'a template interpolation',
      'const doc = `prefix ${JSON.stringify({ note: "export const X = 1" })} suffix`;',
    ],
    ['a regex literal', 'const re = /export const [A-Z]+ = /;'],
    ['a regex holding a quote', 'const re = /["\']export const/;'],
    ['a nested export inside a function', 'function f() { const exported = 1; return exported; }'],
    ['a property named export', 'const config = {}; config.export = true;'],
    ['an optional property named export', 'const value = config?.export;'],
    ['an import', "import { SERVER_CAPABILITIES } from '@/lib/capabilities';"],
    ['a bare module marker', 'export {};'],
  ];

  it.each(ignored)('%s', (_label, source) => {
    expect(namesIn(source)).toEqual([]);
  });

  it('does not treat a nested `export` inside a declared module as top level', () => {
    // `export` is only legal at a module's top level, so anything the lexer sees
    // at depth > 0 is either inside `declare module` or inside a string the
    // lexer failed to consume. Either way it must not be reported.
    expect(namesIn('declare module "x" {\n  export const inner: number;\n}')).toEqual([]);
  });
});

describe('the scanner reports what it cannot classify', () => {
  it('flags an export form it does not understand rather than skipping it', () => {
    expect(namesIn("export import Legacy = require('./legacy');")).toEqual([
      '<unrecognized export form>',
    ]);
  });

  it('throws on source it cannot lex', () => {
    // A guard that could not read the file must not report "clean".
    expect(() => tokenize("const s = 'unterminated")).toThrow(/unterminated string/);
    expect(() => tokenize('/* unterminated')).toThrow(/unterminated block comment/);
  });

  it('keeps line numbers usable', () => {
    const source = ['// a comment', '', 'export const SERVER_CAPABILITIES = [];'].join('\n');
    expect(extractRuntimeExports(source)).toEqual([
      { name: 'SERVER_CAPABILITIES', line: 3, form: 'variable' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The #1943 mutation itself
// ---------------------------------------------------------------------------

describe('the PR #1943 regression', () => {
  /** Shortened, but the same shape and the same name as the export that landed. */
  const OFFENDING_ROUTE = [
    "import { NextResponse } from 'next/server';",
    '',
    "export const dynamic = 'force-dynamic';",
    '',
    'export const SERVER_CAPABILITIES = [',
    "  'agent-instances',",
    "  'verification-gates',",
    '] as const;',
    '',
    'export async function GET() {',
    '  return NextResponse.json({ capabilities: SERVER_CAPABILITIES });',
    '}',
  ].join('\n');

  it('is a violation, and the legitimate exports beside it are not', () => {
    const offenders = (extractRuntimeExports(OFFENDING_ROUTE) as { name: string }[])
      .map((entry) => entry.name)
      .filter((name) => !ALLOWED_ROUTE_EXPORTS.has(name));
    expect(offenders).toEqual(['SERVER_CAPABILITIES']);
  });

  it('is addressable in the report', () => {
    expect(
      formatRouteExportViolation({
        file: 'src/app/api/capabilities/route.ts',
        line: 5,
        name: 'SERVER_CAPABILITIES',
        form: 'variable',
      })
    ).toBe('src/app/api/capabilities/route.ts:5: SERVER_CAPABILITIES (variable)');
  });
});

// ---------------------------------------------------------------------------
// The scan over the real repository
// ---------------------------------------------------------------------------

describe('the scan of this repository', () => {
  it('reaches the route entries it is supposed to be guarding', () => {
    const files = collectRouteFiles(REPO_ROOT) as string[];
    // Anti-vacuity floors, well under the real counts (128 at the time of
    // writing) so adding or deleting a route does not touch them.
    expect(files.length).toBeGreaterThanOrEqual(100);
    expect(files).toContain('src/app/api/capabilities/route.ts');
    // Not only `src/app/api`: Next type-checks every App Router entry, and this
    // one lives outside the api tree. The Issue scoped the guard to
    // `src/app/api/**`; the guard covers all of `src/app` because the build does.
    expect(files).toContain('src/app/proxy/[...path]/route.ts');
    expect(files.every((file) => file.startsWith(`${APP_DIR}/`))).toBe(true);
  });

  it('actually extracts handlers rather than parsing to nothing', () => {
    // The check below ("no violations") is also satisfied by an extractor that
    // returns [] for every file. This is the control that says it does not.
    const files = collectRouteFiles(REPO_ROOT) as string[];
    const names = files.flatMap((file) =>
      (extractRuntimeExports(readFileSync(join(REPO_ROOT, file), 'utf-8')) as { name: string }[]).map(
        (entry) => entry.name
      )
    );
    expect(names.length).toBeGreaterThanOrEqual(150);
    expect(names.filter((name) => name === 'GET').length).toBeGreaterThanOrEqual(50);
    expect(names.filter((name) => name === 'dynamic').length).toBeGreaterThanOrEqual(10);
    // The ~30 `export type` / `export interface` in src/app/api/skills/** are
    // erased before emit, so Next never sees them and neither must this.
    expect(names).not.toContain('SkillUpdateResult');
    expect(names).not.toContain('InstalledSkillDto');
  });

  it('finds no violation on this branch', () => {
    // `npm run build` is exit 0 on develop, so a finding here would be a false
    // positive in the guard, not a defect in a route (Issue #1946 acceptance).
    const { violations } = findRouteExportViolations(REPO_ROOT) as {
      violations: { file: string; line: number; name: string; form: string }[];
    };
    expect(violations.map(formatRouteExportViolation)).toEqual([]);
  });

  it('refuses to silently skip a JSX route entry', () => {
    // There are none, and the guard throws rather than skipping if one appears.
    expect(UNSUPPORTED_ROUTE_BASENAMES).toEqual(['route.tsx', 'route.jsx']);
    const files = collectRouteFiles(REPO_ROOT) as string[];
    expect(files.some((file) => file.endsWith('.tsx') || file.endsWith('.jsx'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. The script stays runnable with nothing but Node
// ---------------------------------------------------------------------------

describe('the guard script has no dependencies', () => {
  it('imports only Node built-ins', () => {
    // The CI job (`route-exports` in ci-pr.yml) is a checkout plus one `run:`
    // and never installs anything — `static-guard-single-source.test.ts` pins it
    // to exactly that. An import of a package would pass locally and fail there.
    const source = readFileSync(GUARD_SCRIPT, 'utf-8');
    const specifiers = [...source.matchAll(/^import[\s\S]*?from '([^']+)';$/gm)].map(
      (match) => match[1]
    );
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(
        ['fs', 'path', 'url'].includes(specifier) || specifier.startsWith('node:'),
        `${specifier} is not a Node built-in`
      ).toBe(true);
    }
  });
});
