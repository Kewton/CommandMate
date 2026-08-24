/**
 * Env Manager — masking (Issue #1968).
 *
 * "値がデフォルトでマスク表示され" is an acceptance criterion, and this is the
 * function the pane calls to satisfy it. The specific property worth pinning is
 * that the mask does NOT preserve length: a length-preserving mask leaks how
 * long every secret is to anyone looking at the screen.
 */

import { describe, it, expect } from 'vitest';
import { ENV_MASK, maskEnvRawText, maskEnvValue } from '@/lib/env-manager/env-masking';
import { parseEnvContent } from '@/lib/env-manager/env-parser';

describe('maskEnvValue', () => {
  it('replaces a value with the fixed mask', () => {
    expect(maskEnvValue('hunter2')).toBe(ENV_MASK);
  });

  it('does not leak the length of the value', () => {
    const short = maskEnvValue('a');
    const long = maskEnvValue('a'.repeat(200));
    expect(short).toBe(long);
    expect(short).toBe(ENV_MASK);
  });

  it('leaves an empty value empty, so "unset" stays visible as unset', () => {
    expect(maskEnvValue('')).toBe('');
  });

  it('never returns any part of the input', () => {
    const secret = 'sk-live-abcdef';
    const masked = maskEnvValue(secret);
    for (const char of new Set(secret)) {
      expect(masked).not.toContain(char);
    }
  });
});

describe('maskEnvRawText', () => {
  function mask(raw: string): string {
    return maskEnvRawText(raw, parseEnvContent(raw).entries);
  }

  it('masks every value while keeping keys, comments and blank lines', () => {
    const raw = ['# Header', '', 'A=first-secret', 'B=second-secret', '# trailer'].join('\n');
    expect(mask(raw)).toBe(['# Header', '', `A=${ENV_MASK}`, `B=${ENV_MASK}`, '# trailer'].join('\n'));
  });

  it('keeps an `export ` prefix', () => {
    expect(mask('export TOKEN=abc')).toBe(`export TOKEN=${ENV_MASK}`);
  });

  it('collapses a multi-line quoted value to one masked line', () => {
    const raw = 'PEM="-----BEGIN-----\nsecret-body\n-----END-----"\nAFTER=1';
    expect(mask(raw)).toBe(`PEM=${ENV_MASK}\nAFTER=${ENV_MASK}`);
  });

  it('leaves a malformed line alone rather than dropping it', () => {
    const raw = 'not an assignment\nA=1';
    expect(mask(raw)).toBe(`not an assignment\nA=${ENV_MASK}`);
  });

  it('contains none of the secret text', () => {
    const raw = '# note\nDB_PASSWORD=correct-horse-battery-staple\nexport TOKEN="sk-live-xyz"\n';
    const masked = mask(raw);
    expect(masked).not.toContain('correct-horse-battery-staple');
    expect(masked).not.toContain('sk-live-xyz');
    // The keys are still there — that is the point of masking rather than hiding.
    expect(masked).toContain('DB_PASSWORD=');
    expect(masked).toContain('export TOKEN=');
  });
});
