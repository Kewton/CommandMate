/**
 * tmux は send-keys の引数の末尾の `;` をコマンド区切りとして食う（Issue #2769）
 *
 * `-l` でも `--` の後ろでも、`execFile` でシェルを通していなくても同じ。tmux 3.5a の実測:
 *
 *   'a;'  -> a（`;` が消える。rc 0）   ';'  -> 何も届かない   'a\;' -> a;
 *   'a;' 'C-m' -> `unknown command: C-m` で失敗し、1 バイトも届かない
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { execFileAsyncMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('util', () => ({
  promisify: vi.fn(() => execFileAsyncMock),
}));

import { escapeTrailingSemicolon, keySequenceArgs } from '@/lib/tmux/key-sequence';
import { exactTarget, sendKeys, sendKeySequence } from '@/lib/tmux/tmux';
import { keyStep, literalStep } from '@/types/cli-tool-contracts';

const SESSION = 'mcbd-claude-wt-1';
const TARGET = exactTarget(SESSION);
const BS = '\\';
const argvOf = (call: unknown[]): string[] => call[1] as string[];

beforeEach(() => {
  execFileAsyncMock.mockClear();
});

describe('[#2769] escapeTrailingSemicolon', () => {
  it.each([
    ['a;', `a${BS};`],
    [';', `${BS};`],
    ['a;;', `a;${BS};`],
    ['npm test;', `npm test${BS};`],
    // 本当に `\;` で終わる本文: tmux が消すのは足した 1 本だけなので、`\;` のまま届く。
    [`a${BS};`, `a${BS}${BS};`],
  ])('%j の末尾の `;` の前にバックスラッシュを 1 本足す', (input, expected) => {
    expect(escapeTrailingSemicolon(input)).toBe(expected);
  });

  it.each(['', 'a', 'a;b', '; a', 'a; ', `a${BS}`, 'a；'])('%j は変えない', (input) => {
    expect(escapeTrailingSemicolon(input)).toBe(input);
  });
});

describe('[#2769] literal の経路（keySequenceArgs / sendKeys literal / sendKeySequence）', () => {
  it('keySequenceArgs は literal の本文だけをエスケープする', () => {
    expect(keySequenceArgs(TARGET, literalStep('fix it;'))).toEqual([
      'send-keys', '-t', TARGET, '-l', '--', `fix it${BS};`,
    ]);
    expect(keySequenceArgs(TARGET, literalStep('fix it'))).toEqual([
      'send-keys', '-t', TARGET, '-l', '--', 'fix it',
    ]);
  });

  it('key の step は触らない', () => {
    expect(keySequenceArgs(TARGET, keyStep('Enter'))).toEqual(['send-keys', '-t', TARGET, '--', 'Enter']);
  });

  it('sendKeys({ literal: true }) — ユーザのメッセージ本文の経路', async () => {
    await sendKeys(SESSION, 'fix it;', false, { literal: true });
    expect(argvOf(execFileAsyncMock.mock.calls[0])).toEqual([
      'send-keys', '-t', TARGET, '-l', '--', `fix it${BS};`,
    ]);
  });

  it('sendKeySequence', async () => {
    await sendKeySequence(SESSION, [literalStep('a;'), keyStep('Enter')]);
    expect(execFileAsyncMock.mock.calls.map((call) => argvOf(call).slice(3))).toEqual([
      ['-l', '--', `a${BS};`],
      ['--', 'Enter'],
    ]);
  });
});

describe('[#2769] literal でない経路（sendKeys の既定）', () => {
  it('Enter つき: 本文の末尾の `;` をエスケープし、C-m はそのまま後ろに置く', async () => {
    await sendKeys(SESSION, '/model gpt;', true);
    expect(argvOf(execFileAsyncMock.mock.calls[0])).toEqual([
      'send-keys', '-t', TARGET, `/model gpt${BS};`, 'C-m',
    ]);
  });

  it('Enter なし', async () => {
    await sendKeys(SESSION, 'ok;', false);
    expect(argvOf(execFileAsyncMock.mock.calls[0])).toEqual(['send-keys', '-t', TARGET, `ok${BS};`]);
  });

  it('`;` で終わらない本文と、空文字（Enter だけ送る形）は 1 バイトも変わらない', async () => {
    await sendKeys(SESSION, 'ls -la', true);
    await sendKeys(SESSION, '', true);
    await sendKeys(SESSION, 'y', false);
    expect(execFileAsyncMock.mock.calls.map((call) => argvOf(call))).toEqual([
      ['send-keys', '-t', TARGET, 'ls -la', 'C-m'],
      ['send-keys', '-t', TARGET, '', 'C-m'],
      ['send-keys', '-t', TARGET, 'y'],
    ]);
  });
});
