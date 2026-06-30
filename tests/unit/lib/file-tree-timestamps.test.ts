/**
 * readDirectory() birthtime field Unit Tests
 * [CO-001] birthtime field in TreeItem
 *
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { readDirectory } from '@/lib/file-tree';

describe('readDirectory birthtime', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `tree-time-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('file birthtime', () => {
    it('should include birthtime for files', async () => {
      writeFileSync(join(testDir, 'test.txt'), 'content');

      const result = await readDirectory(testDir, '');

      const file = result.items.find(item => item.name === 'test.txt');
      expect(file).toBeDefined();
      expect(file?.birthtime).toBeDefined();
      expect(typeof file?.birthtime).toBe('string');
    });

    it('should return birthtime as valid ISO 8601 string', async () => {
      writeFileSync(join(testDir, 'test.txt'), 'content');

      const result = await readDirectory(testDir, '');

      const file = result.items.find(item => item.name === 'test.txt');
      expect(file?.birthtime).toBeDefined();

      // Verify it is a valid date string
      const date = new Date(file!.birthtime!);
      expect(date.getTime()).not.toBeNaN();
    });

    it('should return a recent birthtime for a newly created file', async () => {
      const beforeCreation = new Date();
      writeFileSync(join(testDir, 'recent.txt'), 'content');

      const result = await readDirectory(testDir, '');

      const file = result.items.find(item => item.name === 'recent.txt');
      expect(file?.birthtime).toBeDefined();

      const birthtime = new Date(file!.birthtime!);
      // birthtime should be within a reasonable range of creation
      expect(birthtime.getTime()).toBeGreaterThanOrEqual(beforeCreation.getTime() - 1000);
      expect(birthtime.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    });
  });

  describe('file mtime [Issue #969]', () => {
    it('should include mtime for files', async () => {
      writeFileSync(join(testDir, 'test.txt'), 'content');

      const result = await readDirectory(testDir, '');

      const file = result.items.find(item => item.name === 'test.txt');
      expect(file).toBeDefined();
      expect(file?.mtime).toBeDefined();
      expect(typeof file?.mtime).toBe('string');
    });

    it('should return mtime as valid ISO 8601 string', async () => {
      writeFileSync(join(testDir, 'test.txt'), 'content');

      const result = await readDirectory(testDir, '');

      const file = result.items.find(item => item.name === 'test.txt');
      const date = new Date(file!.mtime!);
      expect(date.getTime()).not.toBeNaN();
    });

    it('should return a recent mtime for a newly written file', async () => {
      const beforeWrite = new Date();
      writeFileSync(join(testDir, 'recent.txt'), 'content');

      const result = await readDirectory(testDir, '');

      const file = result.items.find(item => item.name === 'recent.txt');
      const mtime = new Date(file!.mtime!);
      expect(mtime.getTime()).toBeGreaterThanOrEqual(beforeWrite.getTime() - 1000);
      expect(mtime.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    });
  });

  describe('directory items', () => {
    it('should NOT include birthtime for directories', async () => {
      mkdirSync(join(testDir, 'subdir'));

      const result = await readDirectory(testDir, '');

      const dir = result.items.find(item => item.name === 'subdir');
      expect(dir).toBeDefined();
      expect(dir?.birthtime).toBeUndefined();
    });

    it('should NOT include mtime for directories [Issue #969]', async () => {
      mkdirSync(join(testDir, 'subdir'));

      const result = await readDirectory(testDir, '');

      const dir = result.items.find(item => item.name === 'subdir');
      expect(dir).toBeDefined();
      expect(dir?.mtime).toBeUndefined();
    });
  });

  describe('backward compatibility', () => {
    it('should still include all existing fields for files', async () => {
      writeFileSync(join(testDir, 'test.ts'), 'const x = 1;');

      const result = await readDirectory(testDir, '');

      const file = result.items.find(item => item.name === 'test.ts');
      expect(file).toBeDefined();
      expect(file?.type).toBe('file');
      expect(file?.size).toBeDefined();
      expect(file?.extension).toBe('ts');
      // birthtime is an addition, not a replacement
      expect(file?.birthtime).toBeDefined();
    });

    it('should still include all existing fields for directories', async () => {
      mkdirSync(join(testDir, 'mydir'));

      const result = await readDirectory(testDir, '');

      const dir = result.items.find(item => item.name === 'mydir');
      expect(dir).toBeDefined();
      expect(dir?.type).toBe('directory');
      expect(dir?.itemCount).toBeDefined();
    });
  });
});
