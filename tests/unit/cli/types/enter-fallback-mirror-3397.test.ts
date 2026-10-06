/**
 * Issue #3397: `autoYes.lastEnterFallback` on the `current-output` response —
 * the server publishes it, and the CLI's hand-written copy of the response
 * (`src/cli/types/api-responses.ts`) describes it.
 *
 * `current-output-mirror-3300.test.ts` holds the copy to the server type at the
 * top level only, by name and optionality. This file goes one level deeper for
 * the new record, and further:
 *
 *  1. field NAMES are the same on both types;
 *  2. OPTIONALITY is the same (a field the server may omit must be optional on
 *     the copy, and the copy may not loosen one the server always sends);
 *  3. the WIRE TYPE is the same — `string` / `number` / `boolean`, with the
 *     server's literal unions read as the `string` the copy declares on purpose
 *     (a newer server may name an outcome this CLI has not heard of, #1843);
 *  4. a REAL response — `buildCurrentOutput` over a frame, with a record in the
 *     store — carries exactly the copy's fields, each of the copy's type.
 *
 * Both types are read with the TypeScript compiler, as in the #3300 test.
 *
 * @vitest-environment node
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type Database from 'better-sqlite3';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null) }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ getSessionName: () => 'mcbd-test-session', isRunning: vi.fn().mockResolvedValue(true) }),
    }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-3397:claude'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import {
  clearEnterFallbacks,
  enterFallbackScreenKey,
  recordEnterFallbackNoEffect,
  recordEnterFallbackSent,
} from '@/lib/polling/auto-yes-enter-fallback';
import { buildClaude1000RowPermissionFrame } from '../../../fixtures/claude-1000-row-prompt';
import type { PromptData } from '@/types/models';
import {
  stopAllAutoYesPolling,
  stopAutoYesPolling,
  validatePollingContext,
  type AutoYesPollerState,
} from '@/lib/auto-yes-poller';
import { buildCompositeKey, clearAllAutoYesStates, disableAutoYes } from '@/lib/auto-yes-state';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SERVER_FILE = path.join(REPO_ROOT, 'src/lib/session/current-output-types.ts');
const CLI_FILE = path.join(REPO_ROOT, 'src/cli/types/api-responses.ts');

const COMPILER_OPTIONS: ts.CompilerOptions = {
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

type WireKind = 'string' | 'number' | 'boolean' | 'other';

interface FieldShape {
  optional: boolean;
  /** The JSON kinds the field's non-null value can take, sorted. */
  kinds: WireKind[];
  /** Whether `null` is part of the declared type. */
  nullable: boolean;
}

type Shape = Map<string, FieldShape>;

let baseline: ts.Program | undefined;

function createProgram(overrides: Readonly<Record<string, string>> = {}): ts.Program {
  const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
  const readFromDisk = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const override = overrides[path.resolve(fileName)];
    if (override !== undefined) return ts.createSourceFile(fileName, override, languageVersion, true);
    return readFromDisk(fileName, languageVersion, onError, shouldCreate);
  };
  return ts.createProgram({
    rootNames: [SERVER_FILE, CLI_FILE],
    options: COMPILER_OPTIONS,
    host,
    oldProgram: baseline,
  });
}

function wireKinds(checker: ts.TypeChecker, type: ts.Type): { kinds: WireKind[]; nullable: boolean } {
  const members = type.isUnion() ? type.types : [type];
  const kinds = new Set<WireKind>();
  let nullable = false;
  for (const member of members) {
    const flags = member.flags;
    if (flags & ts.TypeFlags.Null) nullable = true;
    else if (flags & ts.TypeFlags.Undefined) continue;
    else if (flags & ts.TypeFlags.StringLike) kinds.add('string');
    else if (flags & ts.TypeFlags.NumberLike) kinds.add('number');
    else if (flags & ts.TypeFlags.BooleanLike) kinds.add('boolean');
    else kinds.add('other');
  }
  void checker;
  return { kinds: [...kinds].sort(), nullable };
}

/** The fields of `<typeName>.autoYes.lastEnterFallback` (null and undefined removed). */
function readShape(program: ts.Program, fileName: string, typeName: string): Shape {
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) throw new Error(`not in the program: ${fileName}`);
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile)!;
  const exported = checker.getExportsOfModule(moduleSymbol).find((s) => s.getName() === typeName);
  if (!exported) throw new Error(`${typeName} is not exported from ${fileName}`);
  const root = checker.getDeclaredTypeOfSymbol(exported);

  const step = (type: ts.Type, name: string): ts.Type => {
    const property = checker.getPropertyOfType(checker.getNonNullableType(type), name);
    if (!property) throw new Error(`${name} not found on ${typeName}`);
    return checker.getTypeOfSymbol(property);
  };
  const record = checker.getNonNullableType(step(step(root, 'autoYes'), 'lastEnterFallback'));

  return new Map(
    checker.getPropertiesOfType(record).map((property) => {
      const { kinds, nullable } = wireKinds(checker, checker.getTypeOfSymbol(property));
      return [
        property.getName(),
        { optional: (property.flags & ts.SymbolFlags.Optional) !== 0, kinds, nullable },
      ];
    }),
  );
}

function describeDrift(server: Shape, cli: Shape): string[] {
  const drift: string[] = [];
  for (const [name, s] of server) {
    const c = cli.get(name);
    if (!c) {
      drift.push(`${name}: on the server, missing from the CLI copy`);
      continue;
    }
    if (s.optional !== c.optional) drift.push(`${name}: optional ${s.optional} on the server, ${c.optional} on the copy`);
    if (s.nullable !== c.nullable) drift.push(`${name}: nullable ${s.nullable} on the server, ${c.nullable} on the copy`);
    if (s.kinds.join('|') !== c.kinds.join('|')) {
      drift.push(`${name}: ${s.kinds.join('|')} on the server, ${c.kinds.join('|')} on the copy`);
    }
  }
  for (const name of cli.keys()) {
    if (!server.has(name)) drift.push(`${name}: on the CLI copy, not on the server`);
  }
  return drift;
}

const PROGRAM_TIMEOUT_MS = 120_000;
let server: Shape;
let cli: Shape;

beforeAll(() => {
  baseline = createProgram();
  server = readShape(baseline, SERVER_FILE, 'CurrentOutputPayload');
  cli = readShape(baseline, CLI_FILE, 'CurrentOutputResponse');
}, PROGRAM_TIMEOUT_MS);

describe('[#3397] the CLI copy of autoYes.lastEnterFallback', { timeout: PROGRAM_TIMEOUT_MS }, () => {
  it('reads both types (non-vacuous)', () => {
    expect([...server.keys()].sort()).toEqual(['at', 'currentPrompt', 'outcome', 'promptType', 'refusalReason', 'sentAt']);
    expect(cli.get('currentPrompt')).toEqual({ optional: false, kinds: ['boolean'], nullable: false });
  });

  it('matches the server: names, optionality and wire types', () => {
    expect(describeDrift(server, cli)).toEqual([]);
  });

  describe('positive controls: each kind of drift is reported', () => {
    const CLI_SOURCE = readFileSync(CLI_FILE, 'utf8');
    const cliWith = (from: string, to: string): Shape => {
      if (!CLI_SOURCE.includes(from)) throw new Error(`not in the copy: ${from}`);
      return readShape(createProgram({ [CLI_FILE]: CLI_SOURCE.replace(from, to) }), CLI_FILE, 'CurrentOutputResponse');
    };

    it('a field dropped from the copy', () => {
      expect(describeDrift(server, cliWith('      currentPrompt: boolean;\n', ''))).toEqual([
        'currentPrompt: on the server, missing from the CLI copy',
      ]);
    });

    it('a field made optional on the copy', () => {
      expect(describeDrift(server, cliWith('      sentAt: number;', '      sentAt?: number;'))).toEqual([
        'sentAt: optional false on the server, true on the copy',
      ]);
    });

    it('a field of another type on the copy', () => {
      expect(describeDrift(server, cliWith('      currentPrompt: boolean;', '      currentPrompt: string;'))).toEqual([
        'currentPrompt: boolean on the server, string on the copy',
      ]);
    });
  });
});

describe('[#3397] a real response carries what the copy declares', () => {
  const WT = 'wt-3397';

  beforeEach(() => {
    vi.clearAllMocks();
    clearEnterFallbacks();
    vi.mocked(captureSessionOutput).mockResolvedValue(buildClaude1000RowPermissionFrame());
  });

  afterEach(() => clearEnterFallbacks());

  /** The prompt the status chain reads off the frame the payload is built from. */
  function promptOnFrame(): PromptData {
    const promptData = detectSessionStatus(buildClaude1000RowPermissionFrame(), 'claude').promptDetection.promptData;
    if (!promptData) throw new Error('the fixture frame carries no prompt');
    return promptData;
  }

  it('null when Auto-Yes never sent its Enter', async () => {
    const payload = await buildCurrentOutput({} as Database.Database, WT, 'claude');
    expect(payload.autoYes?.lastEnterFallback).toBeNull();
  });

  it('every field the copy declares, of the copy\'s type, and nothing else', async () => {
    recordEnterFallbackSent(WT, 'claude', undefined, {
      promptType: 'multiple_choice',
      refusalReason: 'unsupported_dialog_layout',
      screenKey: enterFallbackScreenKey(promptOnFrame()),
    }, 1_000);

    const payload = await buildCurrentOutput({} as Database.Database, WT, 'claude');
    // Over the wire, as the CLI receives it.
    const wire = JSON.parse(JSON.stringify(payload)) as {
      autoYes: { lastEnterFallback: Record<string, unknown> | null };
    };
    const record = wire.autoYes.lastEnterFallback;
    expect(record).not.toBeNull();

    expect(Object.keys(record!).sort()).toEqual([...cli.keys()].sort());
    for (const [name, shape] of cli) {
      if (!shape.optional) expect(record).toHaveProperty(name);
      const value = record![name];
      if (value === null) expect(shape.nullable).toBe(true);
      else expect(shape.kinds).toContain(typeof value);
    }
    expect(record).toEqual({
      outcome: 'sent',
      promptType: 'multiple_choice',
      refusalReason: 'unsupported_dialog_layout',
      sentAt: 1_000,
      at: 1_000,
      currentPrompt: true,
    });
  });

  it('currentPrompt is false for a record about another screen', async () => {
    recordEnterFallbackSent(WT, 'claude', undefined, {
      promptType: 'multiple_choice',
      refusalReason: 'prompt_no_longer_active',
      screenKey: 'multiple_choice:Some other question?',
    });
    const payload = await buildCurrentOutput({} as Database.Database, WT, 'claude');
    expect(payload.autoYes?.lastEnterFallback?.currentPrompt).toBe(false);
  });

  it('`no-effect` is published as such', async () => {
    const screenKey = enterFallbackScreenKey(promptOnFrame());
    recordEnterFallbackSent(WT, 'claude', undefined, {
      promptType: 'multiple_choice',
      refusalReason: 'unsupported_dialog_layout',
      screenKey,
    }, 1_000);
    recordEnterFallbackNoEffect(WT, 'claude', undefined, screenKey, 20_000);
    const payload = await buildCurrentOutput({} as Database.Database, WT, 'claude');
    expect(payload.autoYes?.lastEnterFallback).toMatchObject({ outcome: 'no-effect', sentAt: 1_000, at: 20_000 });
  });

  it('another instance\'s record is not published', async () => {
    recordEnterFallbackSent(WT, 'claude', 'claude-2', {
      promptType: 'multiple_choice',
      refusalReason: 'unsupported_dialog_layout',
      screenKey: enterFallbackScreenKey(promptOnFrame()),
    });
    const payload = await buildCurrentOutput({} as Database.Database, WT, 'claude');
    expect(payload.autoYes?.lastEnterFallback).toBeNull();
  });

  describe('the record does not outlive the poller (review finding 3)', () => {
    function recordForThisFrame(): void {
      recordEnterFallbackSent(WT, 'claude', undefined, {
        promptType: 'multiple_choice',
        refusalReason: 'unsupported_dialog_layout',
        screenKey: enterFallbackScreenKey(promptOnFrame()),
      });
    }

    afterEach(() => clearAllAutoYesStates());

    it('control: with the record in place, it is published for this prompt', async () => {
      recordForThisFrame();
      const payload = await buildCurrentOutput({} as Database.Database, WT, 'claude');
      expect(payload.autoYes?.lastEnterFallback?.currentPrompt).toBe(true);
    });

    it('stopAutoYesPolling (kill-session, the disable route) → null', async () => {
      recordForThisFrame();
      stopAutoYesPolling(buildCompositeKey(WT, 'claude'));
      const payload = await buildCurrentOutput({} as Database.Database, WT, 'claude');
      expect(payload.autoYes?.lastEnterFallback).toBeNull();
    });

    it('Auto-Yes disabled or expired, seen by the poller → null', async () => {
      recordForThisFrame();
      disableAutoYes(WT, 'claude');
      const state = { cliToolId: 'claude', instanceId: 'claude' } as AutoYesPollerState;
      expect(validatePollingContext(buildCompositeKey(WT, 'claude'), state)).toBe('expired');
      const payload = await buildCurrentOutput({} as Database.Database, WT, 'claude');
      expect(payload.autoYes?.lastEnterFallback).toBeNull();
    });

    it('server shutdown (stopAllAutoYesPolling) → null', async () => {
      recordForThisFrame();
      stopAllAutoYesPolling();
      const payload = await buildCurrentOutput({} as Database.Database, WT, 'claude');
      expect(payload.autoYes?.lastEnterFallback).toBeNull();
    });
  });
});
