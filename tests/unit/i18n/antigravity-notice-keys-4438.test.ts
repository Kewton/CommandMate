/**
 * Issue #4438 (stage B): the Antigravity usage notice is in ja and en, with the same
 * keys and placeholders, says there is no explicit confirmation from Google, and says
 * the declaration is a server environment variable that needs a restart.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ANTIGRAVITY_NOTICE_KEYS } from '@/components/worktree/antigravity-usage-notice';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');

function load(locale: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'worktree.json'), 'utf-8'));
}

function resolve(dict: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], dict);
}

const placeholders = (text: string): string[] => (text.match(/\{\w+\}/g) ?? []).sort();

describe('[#4438] antigravity usage notice wording', () => {
  it('ja and en hold the same keys under antigravityNotice, and the component uses all of them', () => {
    const ja = resolve(load('ja'), 'antigravityNotice') as Record<string, string>;
    const en = resolve(load('en'), 'antigravityNotice') as Record<string, string>;
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(en).sort()).toEqual(Object.values(ANTIGRAVITY_NOTICE_KEYS).map((k) => k.split('.').pop()).sort());
  });

  it.each(Object.values(ANTIGRAVITY_NOTICE_KEYS))('%s is a string in ja and en with the same placeholders', (key) => {
    const ja = resolve(load('ja'), key);
    const en = resolve(load('en'), key);
    expect(ja).toBeTypeOf('string');
    expect(en).toBeTypeOf('string');
    expect(placeholders(ja as string)).toEqual(placeholders(en as string));
  });

  it('says there is no explicit confirmation from Google (not "being confirmed")', () => {
    const ja = JSON.stringify(resolve(load('ja'), 'antigravityNotice'));
    const en = JSON.stringify(resolve(load('en'), 'antigravityNotice'));
    expect(ja).toContain('Google による明示の確認はありません');
    expect(ja).not.toContain('確認中');
    expect(en).toMatch(/no explicit confirmation from Google/);
    expect(en).not.toMatch(/being confirmed/i);
  });

  it('says the declaration is the server environment variable and needs a restart', () => {
    const ja = resolve(load('ja'), ANTIGRAVITY_NOTICE_KEYS.declaration) as string;
    const en = resolve(load('en'), ANTIGRAVITY_NOTICE_KEYS.declaration) as string;
    expect(ja).toContain('{env}');
    expect(ja).toMatch(/サーバーの環境変数[\s\S]*再起動/);
    expect(en).toContain('{env}');
    expect(en).toMatch(/server's environment variable[\s\S]*restart/);
  });
});
