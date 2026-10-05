/**
 * Issue #3300: hold the CLI's copy of the `current-output` response to the
 * server's type — the top-level field NAMES and whether each is OPTIONAL.
 *
 * `CurrentOutputResponse` (src/cli/types/api-responses.ts) is a hand-written
 * copy of `CurrentOutputResponseBody` (src/lib/session/current-output-types.ts).
 * It has to be one: the server type's import graph was 137 modules when this
 * was written, 59 of them importing through `@/`, and `tsconfig.cli.json` sets
 * `"paths": {}`. The copy had drifted in both directions at once:
 *
 *  - thirteen fields the server omits for a session that is not running were
 *    required on the copy, so `output.autoYes.enabled` compiled and was a
 *    TypeError on a stopped session;
 *  - three fields the server sends (`agentMode`, `composerText`,
 *    `composerState`) were not on the copy at all.
 *
 * ## What is compared, and how
 *
 * Both types are read with the TypeScript compiler — a `Program` over the two
 * files under the root tsconfig's module resolution, then
 * `checker.getPropertiesOfType`, so an inherited member and a mapped type are
 * read the way `tsc` reads them. No regular expression cuts the source.
 *
 * Three rules, and one list:
 *
 *  1. the two types name the same top-level fields;
 *  2. a field the server may omit is optional on the copy — no exceptions,
 *     because this is the #3300 defect;
 *  3. a field the server always sends may still be optional on the copy, but
 *     only when {@link OLDER_DAEMON_FIELDS} says why. The copy describes every
 *     daemon the CLI can dial, not only this build's (`npm i -g` does not
 *     restart a running server), so "this build always sends it" and "the copy
 *     says optional" are both true for most fields.
 *
 * The list is held to the types as well: an entry that no longer differs fails,
 * so it cannot grow into a place where drift is parked.
 *
 * ## What this does NOT compare
 *
 * Nested shapes (`autoYes.lastSuppression`, `structuredEvents.*`) and value
 * types. The copy is deliberately looser there — wire strings instead of
 * unions, so a newer server's vocabulary is not a parse failure (Issue #1843).
 *
 * @vitest-environment node
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import ts from 'typescript';
import { FIELDS_ABSENT_WHEN_NOT_RUNNING } from './current-output-stopped-fields-3300';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SERVER_FILE = path.join(REPO_ROOT, 'src/lib/session/current-output-types.ts');
const CLI_FILE = path.join(REPO_ROOT, 'src/cli/types/api-responses.ts');

/** What the route answers: the builder's payload plus what the route attaches. */
const SERVER_TYPE = 'CurrentOutputResponseBody';
/** The interface `SERVER_TYPE` inherits most of its fields from. */
const SERVER_BASE_TYPE = 'CurrentOutputPayload';
const CLI_TYPE = 'CurrentOutputResponse';

/**
 * Fields this build's server always sends and the copy still declares optional.
 *
 * One reason covers all of them — a daemon older than the field sends no such
 * key, and the CLI is routinely newer than the daemon it dials — so each entry
 * names the Issue that introduced the field, which is the version boundary a
 * reader of the copy has to survive.
 */
const OLDER_DAEMON_FIELDS: Readonly<Record<string, string>> = {
  cliToolId: 'optional on the copy since #518; `wait` falls back to `claude` / "agent" without it',
  sessionName: '#2886: an older daemon sends none, and the reader rebuilds the legacy name',
  sessionStatus: '#520: an older daemon sends no merged status',
  sessionStatusReason: '#520: published with sessionStatus',
  statusEvidence: '#1926: absent is "this server does not say", which is not `positive`',
  lastKnownStatus: '#1926: published with statusEvidence',
  lastKnownStatusAt: '#1926: published with statusEvidence',
  lastStopEventAt: '#1549: an older daemon records no structured stop event',
  structuredEvents: '#1722: an older daemon publishes no lifecycle events',
  model: '#1785: absent is normalised to the null a tool with no model publishes',
  reasoningEffort: '#1785: published with model',
  promptDedup: '#1695: absent is "this server predates the field", not "nothing was skipped"',
  upstreamFault: '#1839: an older daemon matches no fault signatures',
  paneObstruction: '#2095: an older daemon reads no pane layout',
  composerText: '#1879: an older daemon extracts no composer text',
  composerState: '#1879: published with composerText',
  agentMode: '#2592: an older daemon reads no permission mode',
};

/** Top-level field name -> whether it is optional. */
type FieldMap = Map<string, boolean>;

const COMPILER_OPTIONS: ts.CompilerOptions = {
  // The root tsconfig's resolution, so `@/…` imports resolve as `tsc` resolves
  // them. Nothing is emitted and no diagnostics are asked for: only the two
  // declared types are read.
  baseUrl: REPO_ROOT,
  paths: { '@/*': ['./src/*'] },
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.es2022.d.ts'],
  jsx: ts.JsxEmit.Preserve,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  types: [],
};

/** Parsed files shared by every program below; an overridden file is never cached. */
const parsedFiles = new Map<string, ts.SourceFile>();
let baselineProgram: ts.Program | undefined;

/**
 * A program over the two files, with `overrides` standing in for the text on
 * disk. Every other file is parsed once and reused, so a control that edits one
 * file costs one parse rather than the whole graph.
 */
function createProgram(overrides: Readonly<Record<string, string>> = {}): ts.Program {
  const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
  const readFromDisk = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
    const override = overrides[path.resolve(fileName)];
    if (override !== undefined) {
      return ts.createSourceFile(fileName, override, languageVersionOrOptions, true);
    }
    const cached = parsedFiles.get(fileName);
    if (cached) return cached;
    const parsed = readFromDisk(fileName, languageVersionOrOptions, onError, shouldCreate);
    if (parsed) parsedFiles.set(fileName, parsed);
    return parsed;
  };
  return ts.createProgram({
    rootNames: [SERVER_FILE, CLI_FILE],
    options: COMPILER_OPTIONS,
    host,
    oldProgram: baselineProgram,
  });
}

/** The top-level fields of an exported type, inherited and mapped members included. */
function readFields(program: ts.Program, fileName: string, typeName: string): FieldMap {
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) throw new Error(`not in the program: ${fileName}`);
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) throw new Error(`not a module: ${fileName}`);
  const exported = checker.getExportsOfModule(moduleSymbol).find((s) => s.getName() === typeName);
  if (!exported) throw new Error(`${typeName} is not exported from ${fileName}`);
  const type = checker.getDeclaredTypeOfSymbol(exported);
  return new Map(
    checker
      .getPropertiesOfType(type)
      .map((property) => [property.getName(), (property.flags & ts.SymbolFlags.Optional) !== 0]),
  );
}

interface MirrorFields {
  server: FieldMap;
  cli: FieldMap;
}

function readMirror(overrides: Readonly<Record<string, string>> = {}): MirrorFields {
  const program = createProgram(overrides);
  return {
    server: readFields(program, SERVER_FILE, SERVER_TYPE),
    cli: readFields(program, CLI_FILE, CLI_TYPE),
  };
}

/**
 * Every way the copy disagrees with the server type, one line each. Empty means
 * the three rules in the file header hold.
 */
function describeDrift(
  { server, cli }: MirrorFields,
  olderDaemonFields: Readonly<Record<string, string>> = OLDER_DAEMON_FIELDS,
): string[] {
  const drift: string[] = [];
  for (const [name, serverOptional] of server) {
    const cliOptional = cli.get(name);
    if (cliOptional === undefined) {
      drift.push(`${name}: on the server type, missing from the CLI copy`);
      continue;
    }
    const listed = Object.prototype.hasOwnProperty.call(olderDaemonFields, name);
    if (serverOptional && !cliOptional) {
      drift.push(`${name}: the server may omit it, but the CLI copy requires it`);
    } else if (!serverOptional && cliOptional && !listed) {
      drift.push(`${name}: required on the server, optional on the CLI copy, and not in OLDER_DAEMON_FIELDS`);
    }
    if (listed && !(!serverOptional && cliOptional)) {
      drift.push(`${name}: in OLDER_DAEMON_FIELDS, but the two types no longer differ on it`);
    }
  }
  for (const name of cli.keys()) {
    if (!server.has(name)) drift.push(`${name}: on the CLI copy, not on the server type`);
  }
  for (const name of Object.keys(olderDaemonFields)) {
    if (!server.has(name)) drift.push(`${name}: in OLDER_DAEMON_FIELDS, but not a field of the server type`);
  }
  return drift;
}

// ---------------------------------------------------------------------------
// Source edits for the positive controls. Positions come from the parsed tree,
// and each edit throws when it would change nothing — a control that silently
// left the source alone would pass for the wrong reason.
// ---------------------------------------------------------------------------

function findInterface(sourceFile: ts.SourceFile, name: string): ts.InterfaceDeclaration {
  const found = sourceFile.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  );
  if (!found) throw new Error(`interface ${name} not found in ${sourceFile.fileName}`);
  return found;
}

function findField(
  sourceFile: ts.SourceFile,
  interfaceNames: readonly string[],
  field: string,
): ts.PropertySignature {
  for (const interfaceName of interfaceNames) {
    const member = findInterface(sourceFile, interfaceName).members.find(
      (candidate): candidate is ts.PropertySignature =>
        ts.isPropertySignature(candidate) && candidate.name.getText(sourceFile) === field,
    );
    if (member) return member;
  }
  throw new Error(`field ${field} not found on ${interfaceNames.join(' / ')}`);
}

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true);
}

/** `source` with one more member appended to `interfaceName`. */
function withField(fileName: string, source: string, interfaceName: string, member: string): string {
  const at = findInterface(parse(fileName, source), interfaceName).members.end;
  return `${source.slice(0, at)}\n  ${member}${source.slice(at)}`;
}

/** `source` with `field` made required. */
function withRequired(
  fileName: string,
  source: string,
  interfaceNames: readonly string[],
  field: string,
): string {
  const sourceFile = parse(fileName, source);
  const token = findField(sourceFile, interfaceNames, field).questionToken;
  if (!token) throw new Error(`${field} is already required`);
  return source.slice(0, token.getStart(sourceFile)) + source.slice(token.getEnd());
}

/** `source` with `field` made optional. */
function withOptional(
  fileName: string,
  source: string,
  interfaceNames: readonly string[],
  field: string,
): string {
  const member = findField(parse(fileName, source), interfaceNames, field);
  if (member.questionToken) throw new Error(`${field} is already optional`);
  const at = member.name.getEnd();
  return `${source.slice(0, at)}?${source.slice(at)}`;
}

const SERVER_SOURCE = readFileSync(SERVER_FILE, 'utf8');
const CLI_SOURCE = readFileSync(CLI_FILE, 'utf8');
const SERVER_INTERFACES = [SERVER_TYPE, SERVER_BASE_TYPE] as const;
const CLI_INTERFACES = [CLI_TYPE] as const;

// A cold program reads the server type's whole import graph. Measured at well
// under a second; the bound is for a machine that is running other suites.
const PROGRAM_TIMEOUT_MS = 120_000;

let actual: MirrorFields;

beforeAll(() => {
  baselineProgram = createProgram();
  actual = {
    server: readFields(baselineProgram, SERVER_FILE, SERVER_TYPE),
    cli: readFields(baselineProgram, CLI_FILE, CLI_TYPE),
  };
}, PROGRAM_TIMEOUT_MS);

describe('[#3300] reading the two types', { timeout: PROGRAM_TIMEOUT_MS }, () => {
  // Positive control for the reader itself: every comparison below is only
  // meaningful if it sees inherited members, required fields and optional ones.
  it('sees inherited and directly declared fields, required and optional', () => {
    // Declared on CurrentOutputPayload, reached through `extends`.
    expect(actual.server.get('isRunning')).toBe(false);
    expect(actual.server.get('autoYes')).toBe(true);
    // Declared on CurrentOutputResponseBody itself.
    expect(actual.server.get('agentMode')).toBe(false);
    expect(actual.server.get('detector')).toBe(true);
    expect(actual.cli.get('isRunning')).toBe(false);
    expect(actual.cli.get('promptAnswerable')).toBe(true);
  });

  it('resolves the server type\'s `@/` imports, as tsc does', () => {
    // Reached only through `@/lib/detection/composer-text` from the server
    // file. Without the root tsconfig's `paths` the graph would stop at the two
    // files, and a field inherited from another module would go unseen.
    const viaAlias = path.join(REPO_ROOT, 'src/lib/detection/composer-text.ts');
    expect(baselineProgram?.getSourceFile(viaAlias)).toBeDefined();
  });

  it('refuses a type that is not there', () => {
    const program = createProgram();
    expect(() => readFields(program, CLI_FILE, 'NoSuchResponseType')).toThrow(/not exported/);
  });
});

describe('[#3300] CurrentOutputResponse mirrors CurrentOutputResponseBody', () => {
  it('names the same fields, and requires none the server may omit', () => {
    expect(describeDrift(actual)).toEqual([]);
  });

  it.each(FIELDS_ABSENT_WHEN_NOT_RUNNING)(
    'declares %s optional — a stopped session answers without it',
    (field) => {
      expect(actual.server.get(field)).toBe(true);
      expect(actual.cli.get(field)).toBe(true);
    },
  );

  it.each(['agentMode', 'composerText', 'composerState'])('declares %s, optional', (field) => {
    expect(actual.cli.get(field)).toBe(true);
  });

  it('requires only what every response carries', () => {
    const required = [...actual.cli].filter(([, optional]) => !optional).map(([name]) => name);
    expect(required.sort()).toEqual(['content', 'isRunning', 'lineCount']);
  });

  it('gives a reason for every intended difference', () => {
    for (const reason of Object.values(OLDER_DAEMON_FIELDS)) {
      expect(reason.trim().length).toBeGreaterThan(10);
    }
  });
});

describe('[#3300] positive controls: each kind of drift is reported', { timeout: PROGRAM_TIMEOUT_MS }, () => {
  it('a field added to the server type only', () => {
    const drift = describeDrift(
      readMirror({
        [SERVER_FILE]: withField(SERVER_FILE, SERVER_SOURCE, SERVER_BASE_TYPE, 'onlyOnTheServer3300: string | null;'),
      }),
    );
    expect(drift).toEqual(['onlyOnTheServer3300: on the server type, missing from the CLI copy']);
  });

  it('a field added to the route-attached part of the server type only', () => {
    const drift = describeDrift(
      readMirror({
        [SERVER_FILE]: withField(SERVER_FILE, SERVER_SOURCE, SERVER_TYPE, 'attachedByTheRoute3300?: string;'),
      }),
    );
    expect(drift).toEqual(['attachedByTheRoute3300: on the server type, missing from the CLI copy']);
  });

  it('a field added to the CLI copy only', () => {
    const drift = describeDrift(
      readMirror({
        [CLI_FILE]: withField(CLI_FILE, CLI_SOURCE, CLI_TYPE, 'onlyOnTheCli3300?: string;'),
      }),
    );
    expect(drift).toEqual(['onlyOnTheCli3300: on the CLI copy, not on the server type']);
  });

  // The defect itself: the copy as it stood before #3300, one field at a time.
  it.each(FIELDS_ABSENT_WHEN_NOT_RUNNING)('the CLI copy requiring %s again', (field) => {
    const drift = describeDrift(
      readMirror({ [CLI_FILE]: withRequired(CLI_FILE, CLI_SOURCE, CLI_INTERFACES, field) }),
    );
    expect(drift).toEqual([`${field}: the server may omit it, but the CLI copy requires it`]);
  });

  it('the server starting to omit a field both sides require', () => {
    const drift = describeDrift(
      readMirror({
        [SERVER_FILE]: withOptional(SERVER_FILE, SERVER_SOURCE, SERVER_INTERFACES, 'content'),
      }),
    );
    expect(drift).toEqual(['content: the server may omit it, but the CLI copy requires it']);
  });

  it('the server starting to always send a field the copy has optional, with no reason listed', () => {
    const drift = describeDrift(
      readMirror({
        [SERVER_FILE]: withRequired(SERVER_FILE, SERVER_SOURCE, SERVER_INTERFACES, 'autoYes'),
      }),
    );
    expect(drift).toEqual([
      'autoYes: required on the server, optional on the CLI copy, and not in OLDER_DAEMON_FIELDS',
    ]);
  });

  it('the CLI copy loosening a field both sides require, with no reason listed', () => {
    const drift = describeDrift(
      readMirror({ [CLI_FILE]: withOptional(CLI_FILE, CLI_SOURCE, CLI_INTERFACES, 'content') }),
    );
    expect(drift).toEqual([
      'content: required on the server, optional on the CLI copy, and not in OLDER_DAEMON_FIELDS',
    ]);
  });

  it('a listed difference that the CLI copy closed', () => {
    const drift = describeDrift(
      readMirror({ [CLI_FILE]: withRequired(CLI_FILE, CLI_SOURCE, CLI_INTERFACES, 'model') }),
    );
    expect(drift).toEqual(['model: in OLDER_DAEMON_FIELDS, but the two types no longer differ on it']);
  });

  it('a listed difference that the server closed', () => {
    const drift = describeDrift(
      readMirror({
        [SERVER_FILE]: withOptional(SERVER_FILE, SERVER_SOURCE, SERVER_INTERFACES, 'model'),
      }),
    );
    expect(drift).toEqual(['model: in OLDER_DAEMON_FIELDS, but the two types no longer differ on it']);
  });

  it('a listed field that is no longer on the server type', () => {
    const drift = describeDrift(actual, { ...OLDER_DAEMON_FIELDS, retiredField3300: 'was published once' });
    expect(drift).toEqual(['retiredField3300: in OLDER_DAEMON_FIELDS, but not a field of the server type']);
  });

  it('the edit helpers refuse an edit that would change nothing', () => {
    expect(() => withRequired(CLI_FILE, CLI_SOURCE, CLI_INTERFACES, 'isRunning')).toThrow(/already required/);
    expect(() => withOptional(CLI_FILE, CLI_SOURCE, CLI_INTERFACES, 'promptAnswerable')).toThrow(
      /already optional/,
    );
    expect(() => withRequired(CLI_FILE, CLI_SOURCE, CLI_INTERFACES, 'noSuchField')).toThrow(/not found/);
  });
});
