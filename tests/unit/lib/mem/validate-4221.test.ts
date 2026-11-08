/**
 * Every free field of mem: limits, secret-like strings, control characters and paths
 * (Issue #4221, design §6). Positive (refused) and negative (accepted) controls side by
 * side. Paths are checked in a directory made under `os.tmpdir()`.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  MEM_LIMITS,
  normalizeRepoPath,
  validateEvidence,
  validateItemText,
  validateKey,
  validateMemFields,
  validateNowText,
  validatePromoteTo,
  validateQuote,
  validateQuoteAt,
  validateReason,
} from '@/lib/mem/validate';
import { findSecretRule, MEM_SECRET_RULES } from '@/lib/mem/secret-scan';

const C1 = String.fromCodePoint(0x85);
const RLO = String.fromCodePoint(0x202e);
const BOM = String.fromCodePoint(0xfeff);
const BEL = String.fromCodePoint(0x07);
const GHP = `ghp_${'a'.repeat(36)}`;

/** One sample per rule, each matching that rule. */
const SECRETS: Record<string, string> = {
  'private-key-block': '-----BEGIN RSA PRIVATE KEY-----',
  'authorization-header': 'Authorization: Basic dXNlcjpwYXNzd29yZA==',
  bearer: 'Bearer abcdefghijklmnopqrstuvwx',
  'url-userinfo': 'https://user:hunter2@example.com/x',
  'github-token': GHP,
  'anthropic-key': 'sk-ant-api03-abcdefghij',
  'openai-key': `sk-${'A'.repeat(24)}`,
  'aws-access-key': 'AKIAABCDEFGHIJKLMNOP',
  'slack-token': 'xoxb-1234567890-abc',
  jwt: 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4',
  assignment: 'password=correcthorse',
};

describe('secret-like strings (§6.1)', () => {
  it.each(Object.entries(SECRETS))('refuses %s', (rule, sample) => {
    expect(findSecretRule(`see ${sample} here`)).toBe(rule);
  });

  it('has a sample for every rule', () => {
    expect(Object.keys(SECRETS).sort()).toEqual(MEM_SECRET_RULES.map((rule) => rule.id).sort());
  });

  it('accepts what only looks close: the word token, a short value, a path', () => {
    for (const text of ['token の扱いを決める', 'token=abc', 'password: short', 'sk-short', '/tmp/mem-example', 'Bearer of news']) {
      expect([text, findSecretRule(text)]).toEqual([text, null]);
    }
  });
});

describe('text and other free fields (§6.1)', () => {
  it('now: 100 code points exactly passes, 101 is refused, an emoji counts once', () => {
    expect(validateNowText('あ'.repeat(MEM_LIMITS.nowText))).toEqual({ ok: true, value: 'あ'.repeat(100) });
    expect(validateNowText('あ'.repeat(101))).toEqual({ ok: false, error: { code: 'too_long', field: 'text', limit: 100 } });
    expect(validateNowText('😀'.repeat(100)).ok).toBe(true);
  });

  it('now: folds newlines and C0 like #2427, refuses C1, bidi controls and the BOM', () => {
    expect(validateNowText(`a\nb${BEL}c`)).toEqual({ ok: true, value: 'a b c' });
    for (const bad of [C1, RLO, BOM]) {
      expect(validateNowText(`x${bad}y`)).toEqual({ ok: false, error: { code: 'control_char', field: 'text' } });
    }
  });

  it('text (other kinds): 1000 passes, 1001 is refused, LF and TAB stay, CRLF becomes LF', () => {
    expect(validateItemText('a'.repeat(1000)).ok).toBe(true);
    expect(validateItemText('a'.repeat(1001))).toMatchObject({ ok: false, error: { code: 'too_long', limit: 1000 } });
    expect(validateItemText('a\tb\r\nc')).toEqual({ ok: true, value: 'a\tb\nc' });
    expect(validateItemText(`a${BEL}b`)).toMatchObject({ ok: false, error: { code: 'control_char' } });
    expect(validateItemText(`a${RLO}b`)).toMatchObject({ ok: false, error: { code: 'control_char' } });
  });

  it('a free-text absolute path is kept as written (R11)', () => {
    expect(validateItemText('/tmp/mem-example を見た')).toEqual({ ok: true, value: '/tmp/mem-example を見た' });
    expect(validateNowText('/tmp/mem-example')).toEqual({ ok: true, value: '/tmp/mem-example' });
  });

  it('quote: 500 passes, 501 and a tab are refused; quote_at needs an offset and no future', () => {
    expect(validateQuote('q'.repeat(500)).ok).toBe(true);
    expect(validateQuote('q'.repeat(501))).toMatchObject({ ok: false, error: { code: 'too_long', field: 'quote' } });
    expect(validateQuote('a\tb')).toMatchObject({ ok: false, error: { code: 'control_char' } });
    const now = Date.parse('2026-11-08T00:00:00Z');
    expect(validateQuoteAt('2026-11-08T09:00+09:00', now)).toEqual({ ok: true, value: now });
    expect(validateQuoteAt('2026-11-08T00:00', now).ok).toBe(false);
    expect(validateQuoteAt('2026-11-08T00:06:00Z', now).ok).toBe(false);
    expect(validateQuoteAt('2026-11-08T00:04:00Z', now).ok).toBe(true);
  });

  it('reason: 300 passes, 301 is refused, a secret is refused', () => {
    expect(validateReason('r'.repeat(300)).ok).toBe(true);
    expect(validateReason('r'.repeat(301))).toMatchObject({ ok: false, error: { code: 'too_long', field: 'reason' } });
    expect(validateReason(`leaked ${GHP}`)).toMatchObject({ ok: false, error: { code: 'secret_like', field: 'reason', rule: 'github-token' } });
  });

  it('key: 128 of the charset passes; 129 or another character is refused', () => {
    expect(validateKey('k'.repeat(128)).ok).toBe(true);
    expect(validateKey('k'.repeat(129)).ok).toBe(false);
    expect(validateKey('a b').ok).toBe(false);
  });

  it('every field refuses a secret and says which field and rule, never the value', () => {
    const now = Date.now();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ text: `x ${GHP}` }, 'text'],
      [{ text: 'ok', quote: `x ${GHP}`, quoteAt: new Date(now).toISOString() }, 'quote'],
      [{ text: 'ok', evidence: [`url:https://x/${GHP}`] }, 'evidence'],
      [{ text: 'ok', promoteTo: `issue:#1 ${GHP}` }, 'promoteTo'],
    ];
    for (const [input, field] of cases) {
      const result = validateMemFields('next', input, null, now);
      expect(result).toEqual({ ok: false, error: { code: 'secret_like', field, rule: 'github-token' } });
      expect(JSON.stringify(result)).not.toContain(GHP);
    }
  });
});

describe('structured fields and paths (§6.2)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'mem-4221-'));
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'a.ts'), 'x');
    writeFileSync(path.join(root, '.env'), 'x');
    symlinkSync(path.join(root, 'src'), path.join(root, 'linked'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('accepts a relative path that exists, with a line, normalized', () => {
    expect(validateEvidence(['path:./src/../src/a.ts:12'], root)).toEqual({ ok: true, value: ['path:src/a.ts:12'] });
    expect(validateEvidence(['commit:abcdef1', 'issue:#4221', 'pr:github.com/a/b#2', 'url:https://example.com/x'], root).ok).toBe(true);
  });

  it('refuses absolute, home, backslash, outside, symlink, sensitive and missing paths', () => {
    expect(validateEvidence(['path:/etc/passwd'], root)).toEqual({ ok: false, error: { code: 'absolute_path', field: 'evidence' } });
    expect(validateEvidence(['path:~/x'], root)).toMatchObject({ ok: false, error: { code: 'absolute_path' } });
    expect(validateEvidence(['path:src\\a.ts'], root)).toMatchObject({ ok: false, error: { code: 'absolute_path' } });
    expect(validateEvidence(['path:../x'], root)).toMatchObject({ ok: false, error: { code: 'outside_repository' } });
    expect(validateEvidence(['path:linked/a.ts'], root)).toMatchObject({ ok: false, error: { code: 'symlink' } });
    expect(validateEvidence(['path:.env'], root)).toMatchObject({ ok: false, error: { code: 'sensitive_path' } });
    expect(validateEvidence(['path:src/missing.ts'], root)).toMatchObject({ ok: false, error: { code: 'invalid_evidence' } });
    expect(validateEvidence(['/etc/passwd'], root)).toMatchObject({ ok: false, error: { code: 'absolute_path' } });
  });

  it('evidence: 5 entries of 300 pass, a 6th or 301 is refused, a newline is refused', () => {
    expect(validateEvidence(Array(5).fill('commit:abcdef1'), root).ok).toBe(true);
    expect(validateEvidence(Array(6).fill('commit:abcdef1'), root)).toMatchObject({ ok: false, error: { code: 'too_long', limit: 5 } });
    expect(validateEvidence([`url:https://e.com/${'a'.repeat(300)}`], root)).toMatchObject({ ok: false, error: { code: 'too_long' } });
    expect(validateEvidence(['commit:abcdef1\nx'], root)).toMatchObject({ ok: false, error: { code: 'control_char' } });
  });

  it('promote_to: a path may be new, but not through a symlink nor outside', () => {
    expect(validatePromoteTo('path:docs/new.md', root)).toEqual({ ok: true, value: 'path:docs/new.md' });
    expect(validatePromoteTo('path:linked/new.md', root)).toMatchObject({ ok: false, error: { code: 'symlink' } });
    expect(validatePromoteTo('path:/abs.md', root)).toMatchObject({ ok: false, error: { code: 'absolute_path', field: 'promoteTo' } });
    expect(validatePromoteTo('p'.repeat(301), root)).toMatchObject({ ok: false, error: { code: 'too_long' } });
  });

  it('never answers the absolute path it looked at', () => {
    const result = normalizeRepoPath('src/a.ts', root, 'evidence', true);
    expect(result).toEqual({ ok: true, value: 'src/a.ts' });
    expect(JSON.stringify(result)).not.toContain(root);
  });
});
