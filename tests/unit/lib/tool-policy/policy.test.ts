/**
 * Issue #4436 L0 (design D2 for #4437): tool policy invariants I1–I7.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import {
  ANTIGRAVITY_CONSUMER_TERMS,
  ANTIGRAVITY_FAQ_URL,
  ANTIGRAVITY_TERMS_CHECKED_AT,
  ANTIGRAVITY_TERMS_URL,
  RELAY_TOOL_POLICY_DENIED,
  RUN_ORIGIN_ENV,
  TOOL_POLICY_DENIED,
  TOOL_POLICY_DENIED_MESSAGE,
  USAGE_DECLARATION_ENV,
  decideToolPolicy,
  formatToolPolicyDenial,
  parseSendOrigin,
  type SendOrigin,
  type ToolOperation,
  type ToolPolicyDecision,
  type UsageDeclaration,
} from '@/lib/tool-policy/policy';
import { readUsageDeclaration } from '@/lib/tool-policy/declaration';

const OPERATIONS: readonly ToolOperation[] = ['send', 'ask', 'respond', 'relay', 'schedule', 'auto-yes'];
const ORIGINS: readonly SendOrigin[] = ['legacy', 'terminal', 'session', 'agent', 'schedule', 'unknown', 'relay', 'timer'];
const DECLARATIONS: readonly UsageDeclaration[] = ['personal', 'api-key', 'enterprise'];

/*
 * I6 (policy.ts stays pure) — 脅威の範囲: うっかり足したら落ちる試験。意図的な難読化
 * （変数経由の連結・eval 相当・文字列からのコード生成など）はレビューの範囲。
 * Scope: a test that fails when a dependency is added by accident. Deliberate obfuscation
 * (concatenation through variables, eval equivalents, generating code from strings, etc.)
 * is for review to catch.
 *
 * Allow-list invariant (Issue #4436 L0, reviews l0 / l0b):
 * (a) every identifier reference (value and type) resolves, through the type checker
 *     (aliases followed), to a declaration in policy.ts, to `CLIToolType` in
 *     src/lib/cli-tools/types.ts, or to a standard global in ALLOWED_GLOBALS declared in a
 *     lib.*.d.ts. Anything else — or an identifier that does not resolve — is a violation.
 * (b) syntax that reaches out is refused: `import('x')` types, `import.meta`, dynamic import,
 *     non-type / side-effect imports, `export … from`, `export *`, `import x = require()`, and
 *     access to `constructor` / `__proto__` / `prototype` (dot or string element access).
 * (c) positions that are not references are not judged: property names (`obj.process`,
 *     `{ process: 1 }`) and a destructuring `propertyName` (`{ process: p }`); a shorthand
 *     property is judged by the value it refers to.
 */
const POLICY_PATH = path.resolve(__dirname, '../../../../src/lib/tool-policy/policy.ts');
const CLI_TOOL_TYPES_PATH = path.resolve(__dirname, '../../../../src/lib/cli-tools/types.ts');
const ALLOWED_IMPORT_SPECIFIER = '../cli-tools/types';
const ALLOWED_IMPORTED_NAMES = new Set(['CLIToolType']);
/** Standard globals policy.ts actually uses (lib.*.d.ts declarations only). `undefined` is the intrinsic. */
const ALLOWED_GLOBALS = new Set(['Object', 'Readonly', 'Record', 'undefined']);
const FORBIDDEN_PROPERTY_NAMES = new Set(['constructor', '__proto__', 'prototype']);

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2020,
  lib: ['lib.es2020.d.ts'],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
};
const sourceFileCache = new Map<string, ts.SourceFile | undefined>();

function createProgramFor(sourceText: string): ts.Program {
  const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  const baseReadFile = host.readFile.bind(host);
  const isPolicy = (f: string): boolean => path.resolve(f) === POLICY_PATH;
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    if (isPolicy(fileName)) return ts.createSourceFile(fileName, sourceText, languageVersion, true, ts.ScriptKind.TS);
    if (!sourceFileCache.has(fileName)) {
      sourceFileCache.set(fileName, baseGetSourceFile(fileName, languageVersion, onError, shouldCreate));
    }
    return sourceFileCache.get(fileName);
  };
  host.readFile = (fileName) => (isPolicy(fileName) ? sourceText : baseReadFile(fileName));
  return ts.createProgram({ rootNames: [POLICY_PATH], options: COMPILER_OPTIONS, host });
}

/**
 * I6-k: strip parentheses, `as`, `satisfies`, `<T>` assertions and `!` (what the compiler's
 * internal `skipOuterExpressions` does for these kinds; it is not in the public API).
 */
function skipOuterExpressions(expr: ts.Expression): ts.Expression {
  let e = expr;
  for (;;) {
    if (
      ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isTypeAssertionExpression(e) ||
      ts.isNonNullExpression(e)
    ) {
      e = e.expression;
    } else {
      return e;
    }
  }
}

/**
 * Positions that name a property (or a destructured property) or a label rather than refer
 * to a binding.
 */
function isNonReferencePosition(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
  if (ts.isConstTypeReference(parent)) return true; // `as const`
  // I6-l: statement labels and the labels of break / continue
  if (ts.isLabeledStatement(parent) && parent.label === node) return true;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) return true;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  return false;
}

/** Violations of the I6 allow-list invariant for `sourceText` placed at policy.ts's path. */
function checkPurity(sourceText: string): string[] {
  const program = createProgramFor(sourceText);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(POLICY_PATH);
  if (!sf) return ['policy.ts could not be loaded'];
  const violations: string[] = [];
  const at = (n: ts.Node): string => {
    const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    return `${line + 1}:${character + 1}`;
  };

  // (b) module-level syntax
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const spec = ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : '?';
      const clause = stmt.importClause;
      if (!clause) violations.push(`${at(stmt)} side-effect import '${spec}'`);
      else if (!clause.isTypeOnly) violations.push(`${at(stmt)} non-type import '${spec}'`);
      else if (spec !== ALLOWED_IMPORT_SPECIFIER) violations.push(`${at(stmt)} import from '${spec}'`);
    } else if (ts.isImportEqualsDeclaration(stmt)) {
      violations.push(`${at(stmt)} import = require(...)`);
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier !== undefined) {
      violations.push(`${at(stmt)} export … from another module`);
    }
  }

  const judgeReference = (id: ts.Identifier): void => {
    let symbol = ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
      ? checker.getShorthandAssignmentValueSymbol(id.parent)
      : checker.getSymbolAtLocation(id);
    if (!symbol) {
      violations.push(`${at(id)} '${id.text}' does not resolve`);
      return;
    }
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const decls = symbol.declarations ?? [];
    if (decls.length === 0) {
      if (symbol.escapedName === 'undefined' && ALLOWED_GLOBALS.has('undefined')) return;
      violations.push(`${at(id)} '${id.text}' resolves to a symbol without a declaration`);
      return;
    }
    const ok = decls.every((d) => {
      const file = d.getSourceFile();
      if (path.resolve(file.fileName) === POLICY_PATH) return true;
      if (path.resolve(file.fileName) === CLI_TOOL_TYPES_PATH) return ALLOWED_IMPORTED_NAMES.has(symbol!.name);
      if (program.isSourceFileDefaultLibrary(file)) return ALLOWED_GLOBALS.has(symbol!.name);
      return false;
    });
    if (!ok) {
      const where = path.basename(decls[0].getSourceFile().fileName);
      violations.push(`${at(id)} '${id.text}' resolves outside the allow-list (${where})`);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportTypeNode(node)) violations.push(`${at(node)} import('…') type`);
    if (ts.isMetaProperty(node)) violations.push(`${at(node)} ${node.getText(sf)}`);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      violations.push(`${at(node)} dynamic import(...)`);
    }
    if (ts.isPropertyAccessExpression(node) && FORBIDDEN_PROPERTY_NAMES.has(node.name.text)) {
      violations.push(`${at(node)} access to '${node.name.text}'`);
    }
    if (ts.isElementAccessExpression(node)) {
      const key = skipOuterExpressions(node.argumentExpression);
      if (ts.isStringLiteralLike(key) && FORBIDDEN_PROPERTY_NAMES.has(key.text)) {
        violations.push(`${at(node)} access to '${key.text}'`);
      }
    }
    if (ts.isIdentifier(node) && !isNonReferencePosition(node)) judgeReference(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

/** Oracle written independently of the implementation's table (design D2 §1.3). */
function expectedAllowed(tool: string, op: ToolOperation, origin: SendOrigin, decl: UsageDeclaration): boolean {
  if (tool !== 'antigravity') return true;
  if (decl === 'api-key' || decl === 'enterprise') return true;
  if (op === 'schedule' || op === 'auto-yes') return false;
  return origin === 'legacy' || origin === 'terminal';
}

describe('tool-policy (#4436)', () => {
  it('exposes the fixed constants', () => {
    expect(USAGE_DECLARATION_ENV).toBe('CM_ANTIGRAVITY_USAGE');
    expect(RUN_ORIGIN_ENV).toBe('CM_RUN_ORIGIN');
    expect(TOOL_POLICY_DENIED).toBe('TOOL_POLICY_DENIED');
    expect(RELAY_TOOL_POLICY_DENIED).toBe('RELAY_TOOL_POLICY_DENIED');
    expect(ANTIGRAVITY_CONSUMER_TERMS).toBe('ANTIGRAVITY_CONSUMER_TERMS');
    expect(ANTIGRAVITY_TERMS_URL).toBe('https://antigravity.google/terms');
    expect(ANTIGRAVITY_FAQ_URL).toBe('https://antigravity.google/docs/faq');
    expect(ANTIGRAVITY_TERMS_CHECKED_AT).toBe('2026-11-16');
    expect(TOOL_POLICY_DENIED_MESSAGE).toMatch(/antigravity/);
    expect(TOOL_POLICY_DENIED_MESSAGE).toMatch(/Nothing was typed/);
  });

  it('I1: every tool × operation × origin × declaration matches the table', () => {
    let count = 0;
    for (const tool of CLI_TOOL_IDS) {
      for (const operation of OPERATIONS) {
        for (const origin of ORIGINS) {
          for (const declaration of DECLARATIONS) {
            const got = decideToolPolicy({ tool, operation, origin, declaration });
            expect(got.allowed, `${tool}/${operation}/${origin}/${declaration}`).toBe(
              expectedAllowed(tool, operation, origin, declaration),
            );
            count++;
          }
        }
      }
    }
    expect(count).toBe(CLI_TOOL_IDS.length * OPERATIONS.length * ORIGINS.length * DECLARATIONS.length);
  });

  it('I1 (positive control): personal antigravity is refused at least once per operation', () => {
    for (const operation of OPERATIONS) {
      expect(decideToolPolicy({ tool: 'antigravity', operation, origin: 'session', declaration: 'personal' }).allowed).toBe(false);
    }
  });

  it('I2: every tool other than antigravity is allowed for every combination', () => {
    for (const tool of CLI_TOOL_IDS) {
      if (tool === 'antigravity') continue;
      for (const operation of OPERATIONS) {
        for (const origin of ORIGINS) {
          for (const declaration of DECLARATIONS) {
            expect(decideToolPolicy({ tool, operation, origin, declaration })).toEqual({ allowed: true });
          }
        }
      }
    }
  });

  it('I3: a refusal carries code, reason, links and the inputs', () => {
    const got = decideToolPolicy({ tool: 'antigravity', operation: 'ask', origin: 'agent', declaration: 'personal' });
    expect(got).toEqual({
      allowed: false,
      code: TOOL_POLICY_DENIED,
      reason: ANTIGRAVITY_CONSUMER_TERMS,
      tool: 'antigravity',
      operation: 'ask',
      origin: 'agent',
      declaration: 'personal',
      links: { terms: ANTIGRAVITY_TERMS_URL, faq: ANTIGRAVITY_FAQ_URL },
    });
  });

  describe('I4: parseSendOrigin', () => {
    it('undefined → legacy', () => expect(parseSendOrigin(undefined)).toBe('legacy'));
    it.each(['terminal', 'session', 'agent', 'schedule', 'unknown'])('%s → itself', (v) => {
      expect(parseSendOrigin(v)).toBe(v);
    });
    it.each(['relay', 'timer', 'legacy', 'human', '', 'TERMINAL', ' terminal'])('%j → unknown', (v) => {
      expect(parseSendOrigin(v)).toBe('unknown');
    });
    it.each([null, 1, true, {}, ['terminal']])('%j → invalid', (v) => {
      expect(parseSendOrigin(v)).toBe('invalid');
    });
  });

  describe('I5: readUsageDeclaration', () => {
    const personalCases: Array<string | undefined> = [
      undefined, '', '  ', 'PERSONAL', 'apikey', 'yes', 'true', 'API-KEY', 'Enterprise', 'personal',
    ];
    for (const value of personalCases) {
      it(`${JSON.stringify(value)} → personal`, () => {
        const env = value === undefined ? {} : { [USAGE_DECLARATION_ENV]: value };
        expect(readUsageDeclaration(env)).toBe('personal');
      });
    }
    it('trims surrounding whitespace', () => {
      expect(readUsageDeclaration({ CM_ANTIGRAVITY_USAGE: ' api-key ' })).toBe('api-key');
      expect(readUsageDeclaration({ CM_ANTIGRAVITY_USAGE: '\tenterprise\n' })).toBe('enterprise');
    });
    it('accepts enterprise', () => {
      expect(readUsageDeclaration({ CM_ANTIGRAVITY_USAGE: 'enterprise' })).toBe('enterprise');
    });
    it('defaults to process.env', () => {
      const prev = process.env.CM_ANTIGRAVITY_USAGE;
      try {
        process.env.CM_ANTIGRAVITY_USAGE = 'api-key';
        expect(readUsageDeclaration()).toBe('api-key');
        delete process.env.CM_ANTIGRAVITY_USAGE;
        expect(readUsageDeclaration()).toBe('personal');
      } finally {
        if (prev === undefined) delete process.env.CM_ANTIGRAVITY_USAGE;
        else process.env.CM_ANTIGRAVITY_USAGE = prev;
      }
    });
  });

  describe('I6: policy.ts reaches nothing outside its allow-list (type checker + syntax)', () => {
    const src = fs.readFileSync(POLICY_PATH, 'utf-8');

    it('the current policy.ts has no violation', () => {
      expect(checkPurity(src)).toEqual([]);
    });
    it.each([
      'const o = { process: 1 }; void o.process;',
      'const { process: p } = { process: 1 }; void p;',
      'const { process } = { process: 1 }; void process;',
      "const k = 'a'; const o = { [k]: 1 }; void o;",
      "import type { CLIToolType } from '../cli-tools/types'; export const t: CLIToolType = 'claude';",
    ])('control (allowed): %s', (good) => {
      expect(checkPurity(good)).toEqual([]);
    });
    it.each([
      "void require('crypto');",
      "void process['env'];",
      'const e = globalThis.process; void e;',
      "export async function f(): Promise<unknown> { return await import('fs'); }",
      "import 'fs';",
      "export * from './declaration';",
      "export { x } from 'node:os';",
      "import { CLIToolType } from '../cli-tools/types'; export const t: CLIToolType = 'claude';",
      "import type { CLIToolType } from '../cli-tools/types'; import fs from 'fs'; export const t: CLIToolType = 'claude'; void fs;",
      "export type X = import('node:fs').Stats;",
      'void import.meta.url;',
      "void Reflect.construct(Object.constructor, ['return this'])().process.env;",
      'void Buffer;',
      "import type { CLI_TOOL_IDS } from '../cli-tools/types'; export type T = typeof CLI_TOOL_IDS;",
      'void Object["prototype"];',
      'const f = new Function("return 1"); void f;',
    ])('control (refused): %s', (bad) => {
      expect(checkPurity(bad).length).toBeGreaterThan(0);
    });
    it.each([
      "void Object[('prototype')];",
      "void Object['prototype' as const];",
      'void Object[`prototype`];',
      "void Object[<const>'prototype'];",
      "void Object[('prototype' satisfies string)];",
      "void Object[(('__proto__'))];",
      "void Object['constructor'!];",
    ])('I6-k: a forbidden key is judged after unwrapping parentheses / assertions: %s', (bad) => {
      expect(checkPurity(bad).some((v) => /access to '(?:prototype|__proto__|constructor)'/.test(v))).toBe(true);
    });
    it.each([
      'export function f(): void { done: { break done; } }',
      'export function g(): void { outer: for (let i = 0; i < 2; i++) { for (let j = 0; j < 2; j++) { if (j) continue outer; } } }',
    ])('I6-l: labels are not references: %s', (good) => {
      expect(checkPurity(good)).toEqual([]);
    });
  });

  describe('I7: formatToolPolicyDenial', () => {
    const denied = decideToolPolicy({ tool: 'antigravity', operation: 'schedule', origin: 'schedule', declaration: 'personal' });
    for (const locale of ['ja', 'en'] as const) {
      it(`${locale} contains both URLs, the env var name and the values`, () => {
        const text = formatToolPolicyDenial(denied, locale);
        expect(text).toContain(ANTIGRAVITY_TERMS_URL);
        expect(text).toContain(ANTIGRAVITY_FAQ_URL);
        expect(text).toContain(USAGE_DECLARATION_ENV);
        expect(text).toContain('api-key');
        expect(text).toContain('enterprise');
      });
    }
    it('ja and en differ', () => {
      expect(formatToolPolicyDenial(denied, 'ja')).not.toBe(formatToolPolicyDenial(denied, 'en'));
    });
    it('an allowed decision formats to an empty string', () => {
      const ok: ToolPolicyDecision = { allowed: true };
      expect(formatToolPolicyDenial(ok, 'ja')).toBe('');
      expect(formatToolPolicyDenial(ok, 'en')).toBe('');
    });
  });
});
