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
const MODULE_DIR = path.resolve(__dirname, '../../../../src/lib/tool-policy');

/** The one import policy.ts may have. */
const ALLOWED_IMPORT = { specifier: '../cli-tools/types', names: ['CLIToolType'] };
const FORBIDDEN_IDENTIFIERS = new Set(['process', 'globalThis', 'global', 'require', 'module', 'eval', 'Function']);

/** Is `node` in a position that names a property rather than referring to a binding? */
function isPropertyNamePosition(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
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

/**
 * Violations of "policy.ts reaches the outside world only through `import type { CLIToolType }
 * from '../cli-tools/types'`", judged on the TypeScript AST (Issue #4436 L0, review P2).
 */
function checkPurity(sourceText: string): string[] {
  const sf = ts.createSourceFile('policy.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: string[] = [];
  const where = (n: ts.Node): string => {
    const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    return `${line + 1}:${character + 1}`;
  };
  let allowedImports = 0;

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const spec = ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : '?';
      const clause = stmt.importClause;
      const named = clause?.namedBindings;
      const ok =
        spec === ALLOWED_IMPORT.specifier &&
        clause !== undefined &&
        clause.isTypeOnly &&
        clause.name === undefined &&
        named !== undefined &&
        ts.isNamedImports(named) &&
        named.elements.length === ALLOWED_IMPORT.names.length &&
        named.elements.every((e, i) => e.name.text === ALLOWED_IMPORT.names[i] && e.propertyName === undefined);
      if (ok && allowedImports === 0) allowedImports++;
      else violations.push(`${where(stmt)} import '${spec}' is not the one allowed type import`);
    } else if (ts.isImportEqualsDeclaration(stmt)) {
      violations.push(`${where(stmt)} import = require(...)`);
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier !== undefined) {
      violations.push(`${where(stmt)} re-export from another module`);
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      violations.push(`${where(node)} dynamic import(...)`);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      violations.push(`${where(node)} require(...) call`);
    }
    if (ts.isIdentifier(node) && FORBIDDEN_IDENTIFIERS.has(node.text) && !isPropertyNamePosition(node)) {
      violations.push(`${where(node)} references identifier '${node.text}'`);
    }
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

  describe('I6: policy.ts has no door to the outside except the CLIToolType type import (AST)', () => {
    const src = fs.readFileSync(path.join(MODULE_DIR, 'policy.ts'), 'utf-8');

    it('the current policy.ts has no violation', () => {
      expect(checkPurity(src)).toEqual([]);
    });
    it('control (allowed): property names that look like forbidden identifiers', () => {
      expect(checkPurity("const o = { process: 1 }; o.process;")).toEqual([]);
      expect(checkPurity("import type { CLIToolType } from '../cli-tools/types'; const o = { global: 1, require: 2 }; o.module;")).toEqual([]);
    });
    it.each([
      "void require('crypto');",
      "void process['env'];",
      'const e = globalThis.process;',
      "await import('fs');",
      "import 'fs';",
      "export * from './declaration';",
      "export { x } from 'node:os';",
      "import { CLIToolType } from '../cli-tools/types';",
      "import type { CLIToolType } from '../cli-tools/types'; import fs from 'fs';",
      'const f = new Function("return 1");',
      'eval("1");',
      'const g = global;',
      'module.exports = {};',
      'const { env } = process;',
      "import os = require('os');",
      "import type { Foo } from './declaration';",
    ])('control (refused): %s', (bad) => {
      expect(checkPurity(bad).length).toBeGreaterThan(0);
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
