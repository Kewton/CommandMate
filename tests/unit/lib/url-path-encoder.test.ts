import { describe, it, expect } from 'vitest';
import { encodePathForUrl } from '@/lib/url-path-encoder';

describe('encodePathForUrl', () => {
  it('空文字列は空文字列を返す', () => {
    expect(encodePathForUrl('')).toBe('');
  });

  it('英数字パスはそのまま返す', () => {
    expect(encodePathForUrl('src/components')).toBe('src/components');
  });

  it('スラッシュを保持しながら各セグメントをエンコード', () => {
    expect(encodePathForUrl('src/my file.ts')).toBe('src/my%20file.ts');
  });

  it('ハッシュ記号をエンコード', () => {
    expect(encodePathForUrl('src/file#1.md')).toBe('src/file%231.md');
  });

  it('クエスチョンマークをエンコード', () => {
    expect(encodePathForUrl('src/file?.ts')).toBe('src/file%3F.ts');
  });

  it('パーセント記号をエンコード', () => {
    expect(encodePathForUrl('src/100%.ts')).toBe('src/100%25.ts');
  });

  it('深いネストのパスも正しくエンコード', () => {
    expect(encodePathForUrl('src/components/Button.tsx')).toBe('src/components/Button.tsx');
  });

  it('スラッシュ自体はエンコードしない', () => {
    const result = encodePathForUrl('a/b/c');
    expect(result).not.toContain('%2F');
    expect(result).toBe('a/b/c');
  });

  it('単一セグメント（スラッシュなし）のパス', () => {
    expect(encodePathForUrl('newdir')).toBe('newdir');
  });

  it('先頭スラッシュを含むパス', () => {
    const result = encodePathForUrl('/src/file');
    expect(result).toBe('/src/file');
  });

  it('末尾スラッシュを含むパス', () => {
    const result = encodePathForUrl('src/');
    expect(result).toBe('src/');
  });
});
