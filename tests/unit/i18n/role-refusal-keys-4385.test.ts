/**
 * Issue #4385 (A4 差し戻し): the sentences the screen shows for a send refused because of the role
 * are in ja and en, one per reason the screen names, with the same placeholders (none), and say
 * the same as the CLI — nothing was sent, and what to do next.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SEND_ROLE_REFUSAL_KEYS } from '@/components/worktree/role-refusal-notice';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');

function load(locale: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'worktree.json'), 'utf-8'));
}

function resolve(dict: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], dict);
}

const placeholders = (text: string): string[] => (text.match(/\{\w+\}/g) ?? []).sort();

describe('[#4385 A4] role refusal wording', () => {
  it.each(Object.entries(SEND_ROLE_REFUSAL_KEYS))('%s → %s is in ja and en', (_reason, key) => {
    const ja = resolve(load('ja'), key);
    const en = resolve(load('en'), key);
    expect(ja).toBeTypeOf('string');
    expect(en).toBeTypeOf('string');
    expect(placeholders(ja as string)).toEqual(placeholders(en as string));
  });

  it('ja and en hold the same keys under conversation.roleRefusal', () => {
    const ja = resolve(load('ja'), 'conversation.roleRefusal') as Record<string, string>;
    const en = resolve(load('en'), 'conversation.roleRefusal') as Record<string, string>;
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(en).sort()).toEqual(Object.values(SEND_ROLE_REFUSAL_KEYS).map((k) => k.split('.').pop()).sort());
  });

  it('each says nothing was sent, and the agy refusals say to stop and start the session again', () => {
    for (const key of Object.values(SEND_ROLE_REFUSAL_KEYS)) {
      expect(resolve(load('en'), key)).toMatch(/nothing was sent/i);
      expect(resolve(load('ja'), key)).toContain('送信していません');
    }
    for (const key of [SEND_ROLE_REFUSAL_KEYS['not-applied'], SEND_ROLE_REFUSAL_KEYS['not-confirmed']]) {
      expect(resolve(load('en'), key)).toContain('Stop the session and start it again.');
      expect(resolve(load('ja'), key)).toContain('セッションを停止して起動し直してください');
    }
  });

  it('not-applied says nothing about whether the agent runs (it also covers a stopped agy)', () => {
    // 再指示 1: `not-applied` also stands for agy stopped on an unknown tool and agy not in the pane.
    expect(resolve(load('en'), SEND_ROLE_REFUSAL_KEYS['not-applied'])).not.toMatch(/runs without|running/i);
    expect(resolve(load('ja'), SEND_ROLE_REFUSAL_KEYS['not-applied'])).not.toMatch(/動いて/);
  });
});
