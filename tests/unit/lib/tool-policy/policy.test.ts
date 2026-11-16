/**
 * Issue #4436 L0 (design D2 for #4437): tool policy invariants I1–I7.
 */
import fs from 'fs';
import path from 'path';
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

  describe('I6: policy.ts stays pure (source scan)', () => {
    const FORBIDDEN_IMPORT =
      /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](?:node:[^'"]+|fs|fs\/promises|os|path|child_process|better-sqlite3|[^'"]*\/db(?:\/[^'"]*)?|\.\/declaration)['"]/;
    const src = fs.readFileSync(path.join(MODULE_DIR, 'policy.ts'), 'utf-8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    it('does not import declaration.ts, the DB, fs or node built-ins', () => {
      expect(FORBIDDEN_IMPORT.test(code)).toBe(false);
    });
    it('does not reference process.env', () => {
      expect(code).not.toMatch(/process\s*\.\s*env/);
    });
    it('imports only the CLIToolType type', () => {
      const imports = code.split('\n').filter((l) => /^\s*import\b/.test(l));
      expect(imports).toEqual(["import type { CLIToolType } from '../cli-tools/types';"]);
    });
    it('control: the scanner catches what it forbids', () => {
      for (const bad of [
        "import fs from 'fs';",
        "import { homedir } from 'node:os';",
        "import { readUsageDeclaration } from './declaration';",
        "import { getDb } from '@/lib/db';",
        "import Database from 'better-sqlite3';",
      ]) {
        expect(FORBIDDEN_IMPORT.test(bad), bad).toBe(true);
      }
      expect(FORBIDDEN_IMPORT.test("import type { CLIToolType } from '../cli-tools/types';")).toBe(false);
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
