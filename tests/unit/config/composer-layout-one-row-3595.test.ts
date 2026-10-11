/**
 * Issue #3595: the one-row threshold has ONE definition, in
 * `src/config/composer-layout.ts` (plain values, importable by the Playwright
 * specs), and every place that spells it as a Tailwind literal agrees with it.
 *
 * The "no mirror" check is shown on throwaway files under `os.tmpdir()` first
 * (positive: a mirror is found; negative: an import is not), then applied to
 * the real spec.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMPOSER_HINTS_MIN_CONTAINER_PX,
  COMPOSER_ONE_ROW_MIN_CONTAINER_PX,
} from '@/config/composer-layout';

const ROOT = process.cwd();
const MESSAGE_INPUT = path.join(ROOT, 'src/components/worktree/MessageInput.tsx');
const E2E_SPEC = path.join(ROOT, 'tests/e2e/composer-two-row-2598.spec.ts');

/** A spec that writes the threshold down as its own number instead of importing it. */
function mirrorsOneRowThreshold(source: string): boolean {
  return /const\s+\w+\s*=\s*7\d\d\s*;/.test(source) || /ONE_ROW_MIN_ROW_PX\s*=/.test(source);
}

function importsOneRowThreshold(source: string): boolean {
  return /import\s*\{[^}]*COMPOSER_ONE_ROW_MIN_CONTAINER_PX[^}]*\}\s*from\s*'[^']*src\/config\/composer-layout'/.test(source);
}

let tmp: string | null = null;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('[#3595] COMPOSER_ONE_ROW_MIN_CONTAINER_PX lives in composer-layout', () => {
  it('is a plain number above the hints threshold', () => {
    expect(typeof COMPOSER_ONE_ROW_MIN_CONTAINER_PX).toBe('number');
    expect(COMPOSER_ONE_ROW_MIN_CONTAINER_PX).toBeGreaterThan(COMPOSER_HINTS_MIN_CONTAINER_PX);
  });

  it('detects a mirrored value and accepts an import (controls on temp files)', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-3595-'));
    const mirrored = path.join(tmp, 'mirrored.spec.ts');
    const imported = path.join(tmp, 'imported.spec.ts');
    fs.writeFileSync(mirrored, 'const ONE_ROW_MIN_ROW_PX = 760;\n');
    fs.writeFileSync(
      imported,
      "import { COMPOSER_ONE_ROW_MIN_CONTAINER_PX } from '../../src/config/composer-layout';\n",
    );
    expect(mirrorsOneRowThreshold(fs.readFileSync(mirrored, 'utf8'))).toBe(true);
    expect(importsOneRowThreshold(fs.readFileSync(mirrored, 'utf8'))).toBe(false);
    expect(mirrorsOneRowThreshold(fs.readFileSync(imported, 'utf8'))).toBe(false);
    expect(importsOneRowThreshold(fs.readFileSync(imported, 'utf8'))).toBe(true);
  });

  it('is imported, not mirrored, by the e2e spec', () => {
    const source = fs.readFileSync(E2E_SPEC, 'utf8');
    expect(importsOneRowThreshold(source)).toBe(true);
    expect(mirrorsOneRowThreshold(source)).toBe(false);
  });

  it('is imported by MessageInput, which spells the same value in every one-row class', () => {
    const source = fs.readFileSync(MESSAGE_INPUT, 'utf8');
    expect(source).toMatch(/import\s*\{[^}]*COMPOSER_ONE_ROW_MIN_CONTAINER_PX[^}]*\}\s*from\s*'@\/config\/composer-layout'/);
    expect(source).not.toMatch(/export const COMPOSER_ONE_ROW_MIN_CONTAINER_PX/);
    const literals = new Set(Array.from(source.matchAll(/@min-\[(\d+)px\]:/g), m => Number(m[1])));
    literals.delete(COMPOSER_HINTS_MIN_CONTAINER_PX);
    expect([...literals]).toEqual([COMPOSER_ONE_ROW_MIN_CONTAINER_PX]);
  });
});
