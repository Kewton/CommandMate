/**
 * File Operations Business Logic Tests
 * [SF-001] Facade pattern for file operations
 * [SEC-SF-003] Rename path validation
 * [SEC-SF-004] Recursive delete safety
 *
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import {
  readFileContent,
  updateFileContent,
  createFileOrDirectory,
  deleteFileOrDirectory,
  renameFileOrDirectory,
  isEditableFile,
  isValidNewName,
  writeBinaryFile,
  createErrorResult,
  readFileLineRange,
  FileOperationResult,
  FileOperationErrorCode,
} from '@/lib/file-operations';
import { VIEWER_CHUNK_LINE_SIZE } from '@/config/file-viewer-config';

describe('File Operations', () => {
  let testDir: string;

  beforeEach(() => {
    // Create a unique test directory
    testDir = join(tmpdir(), `file-ops-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('isEditableFile', () => {
    it('should return true for .md files', () => {
      expect(isEditableFile('readme.md')).toBe(true);
      expect(isEditableFile('docs/guide.md')).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(isEditableFile('README.MD')).toBe(true);
      expect(isEditableFile('Guide.Md')).toBe(true);
    });

    it('should return false for non-.md files', () => {
      expect(isEditableFile('file.txt')).toBe(false);
      expect(isEditableFile('index.ts')).toBe(false);
      expect(isEditableFile('package.json')).toBe(false);
    });
  });

  describe('isValidNewName [SEC-SF-003]', () => {
    it('should accept valid file names', () => {
      expect(isValidNewName('readme.md').valid).toBe(true);
      expect(isValidNewName('my-file.txt').valid).toBe(true);
      expect(isValidNewName('file_name.js').valid).toBe(true);
    });

    it('should reject names with directory separators', () => {
      const result1 = isValidNewName('path/to/file.md');
      expect(result1.valid).toBe(false);
      expect(result1.error).toContain('path');

      const result2 = isValidNewName('path\\to\\file.md');
      expect(result2.valid).toBe(false);
      expect(result2.error).toContain('path');
    });

    it('should reject names with ".."', () => {
      const result = isValidNewName('../file.md');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('..');
    });

    it('should reject empty names', () => {
      const result1 = isValidNewName('');
      expect(result1.valid).toBe(false);

      const result2 = isValidNewName('   ');
      expect(result2.valid).toBe(false);
    });

    // [SEC-004] Upload-specific validation tests
    describe('with forUpload option', () => {
      it('should reject null bytes for upload', () => {
        const result = isValidNewName('file\0name.txt', { forUpload: true });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('control');
      });

      it('should reject control characters for upload', () => {
        const result = isValidNewName('file\x01name.txt', { forUpload: true });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('control');
      });

      it('should reject newline characters for upload', () => {
        const result = isValidNewName('file\nname.txt', { forUpload: true });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('control');
      });

      it('should reject OS forbidden characters for upload', () => {
        const result1 = isValidNewName('file<name>.txt', { forUpload: true });
        expect(result1.valid).toBe(false);
        expect(result1.error).toContain('forbidden');

        const result2 = isValidNewName('file:name.txt', { forUpload: true });
        expect(result2.valid).toBe(false);

        const result3 = isValidNewName('file|name.txt', { forUpload: true });
        expect(result3.valid).toBe(false);

        const result4 = isValidNewName('file?name.txt', { forUpload: true });
        expect(result4.valid).toBe(false);

        const result5 = isValidNewName('file*name.txt', { forUpload: true });
        expect(result5.valid).toBe(false);
      });

      it('should reject trailing space for upload', () => {
        const result = isValidNewName('filename.txt ', { forUpload: true });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('space or dot');
      });

      it('should reject trailing dot for upload', () => {
        const result = isValidNewName('filename.txt.', { forUpload: true });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('space or dot');
      });

      it('should allow normal names for upload', () => {
        const result = isValidNewName('file.txt', { forUpload: true });
        expect(result.valid).toBe(true);
      });

      it('should allow hidden files starting with dot for upload', () => {
        const result = isValidNewName('.gitignore', { forUpload: true });
        expect(result.valid).toBe(true);
      });

      it('should allow names with hyphens and underscores for upload', () => {
        const result1 = isValidNewName('my-file.txt', { forUpload: true });
        expect(result1.valid).toBe(true);

        const result2 = isValidNewName('my_file.txt', { forUpload: true });
        expect(result2.valid).toBe(true);
      });

      it('should allow names with parentheses for upload', () => {
        const result = isValidNewName('file (1).txt', { forUpload: true });
        expect(result.valid).toBe(true);
      });
    });
  });

  describe('readFileContent', () => {
    it('should read file content successfully', async () => {
      const filePath = join(testDir, 'test.md');
      writeFileSync(filePath, '# Test Content');

      const result = await readFileContent(testDir, 'test.md');

      expect(result.success).toBe(true);
      expect(result.content).toBe('# Test Content');
    });

    it('should return error for non-existent file', async () => {
      const result = await readFileContent(testDir, 'nonexistent.md');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('FILE_NOT_FOUND');
    });

    it('should reject path traversal', async () => {
      const result = await readFileContent(testDir, '../etc/passwd');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_PATH');
    });
  });

  describe('updateFileContent', () => {
    it('should update file content successfully', async () => {
      const filePath = join(testDir, 'test.md');
      writeFileSync(filePath, '# Old Content');

      const result = await updateFileContent(testDir, 'test.md', '# New Content');

      expect(result.success).toBe(true);
      expect(readFileSync(filePath, 'utf-8')).toBe('# New Content');
    });

    it('should return error for non-existent file', async () => {
      const result = await updateFileContent(testDir, 'nonexistent.md', 'content');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('FILE_NOT_FOUND');
    });

    it('should reject path traversal', async () => {
      const result = await updateFileContent(testDir, '../etc/passwd', 'malicious');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_PATH');
    });
  });

  describe('createFileOrDirectory', () => {
    it('should create a new file', async () => {
      const result = await createFileOrDirectory(testDir, 'new-file.md', 'file', '# New File');

      expect(result.success).toBe(true);
      expect(existsSync(join(testDir, 'new-file.md'))).toBe(true);
      expect(readFileSync(join(testDir, 'new-file.md'), 'utf-8')).toBe('# New File');
    });

    it('should create a new directory', async () => {
      const result = await createFileOrDirectory(testDir, 'new-dir', 'directory');

      expect(result.success).toBe(true);
      expect(existsSync(join(testDir, 'new-dir'))).toBe(true);
    });

    it('should return error if file already exists', async () => {
      writeFileSync(join(testDir, 'existing.md'), 'content');

      const result = await createFileOrDirectory(testDir, 'existing.md', 'file', 'new content');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('FILE_EXISTS');
    });

    it('should reject path traversal', async () => {
      const result = await createFileOrDirectory(testDir, '../outside/file.md', 'file', 'content');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_PATH');
    });
  });

  describe('deleteFileOrDirectory', () => {
    it('should delete a file', async () => {
      const filePath = join(testDir, 'to-delete.md');
      writeFileSync(filePath, 'content');

      const result = await deleteFileOrDirectory(testDir, 'to-delete.md');

      expect(result.success).toBe(true);
      expect(existsSync(filePath)).toBe(false);
    });

    it('should delete an empty directory', async () => {
      const dirPath = join(testDir, 'empty-dir');
      mkdirSync(dirPath);

      const result = await deleteFileOrDirectory(testDir, 'empty-dir');

      expect(result.success).toBe(true);
      expect(existsSync(dirPath)).toBe(false);
    });

    it('should return error for non-empty directory without recursive flag', async () => {
      const dirPath = join(testDir, 'non-empty-dir');
      mkdirSync(dirPath);
      writeFileSync(join(dirPath, 'file.txt'), 'content');

      const result = await deleteFileOrDirectory(testDir, 'non-empty-dir');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DIRECTORY_NOT_EMPTY');
    });

    it('should delete non-empty directory with recursive flag', async () => {
      const dirPath = join(testDir, 'non-empty-dir');
      mkdirSync(dirPath);
      writeFileSync(join(dirPath, 'file.txt'), 'content');

      const result = await deleteFileOrDirectory(testDir, 'non-empty-dir', true);

      expect(result.success).toBe(true);
      expect(existsSync(dirPath)).toBe(false);
    });

    it('should reject deletion of .git directory [SEC-SF-004]', async () => {
      const gitDir = join(testDir, '.git');
      mkdirSync(gitDir);

      const result = await deleteFileOrDirectory(testDir, '.git', true);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PROTECTED_DIRECTORY');
    });

    it('should reject deletion of .git subdirectory [SEC-SF-004]', async () => {
      const gitDir = join(testDir, '.git', 'objects');
      mkdirSync(gitDir, { recursive: true });

      const result = await deleteFileOrDirectory(testDir, '.git/objects', true);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PROTECTED_DIRECTORY');
    });

    it('should reject path traversal', async () => {
      const result = await deleteFileOrDirectory(testDir, '../etc/passwd');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_PATH');
    });
  });

  describe('renameFileOrDirectory', () => {
    it('should rename a file', async () => {
      writeFileSync(join(testDir, 'old-name.md'), 'content');

      const result = await renameFileOrDirectory(testDir, 'old-name.md', 'new-name.md');

      expect(result.success).toBe(true);
      expect(result.path).toBe('new-name.md');
      expect(existsSync(join(testDir, 'new-name.md'))).toBe(true);
      expect(existsSync(join(testDir, 'old-name.md'))).toBe(false);
    });

    it('should rename a directory', async () => {
      mkdirSync(join(testDir, 'old-dir'));

      const result = await renameFileOrDirectory(testDir, 'old-dir', 'new-dir');

      expect(result.success).toBe(true);
      expect(existsSync(join(testDir, 'new-dir'))).toBe(true);
      expect(existsSync(join(testDir, 'old-dir'))).toBe(false);
    });

    it('should rename file in subdirectory', async () => {
      mkdirSync(join(testDir, 'docs'));
      writeFileSync(join(testDir, 'docs', 'old.md'), 'content');

      const result = await renameFileOrDirectory(testDir, 'docs/old.md', 'new.md');

      expect(result.success).toBe(true);
      expect(result.path).toBe('docs/new.md');
      expect(existsSync(join(testDir, 'docs', 'new.md'))).toBe(true);
    });

    it('should reject newName with path separator [SEC-SF-003]', async () => {
      writeFileSync(join(testDir, 'file.md'), 'content');

      const result = await renameFileOrDirectory(testDir, 'file.md', 'path/to/file.md');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_NAME');
    });

    it('should reject newName with ".." [SEC-SF-003]', async () => {
      writeFileSync(join(testDir, 'file.md'), 'content');

      const result = await renameFileOrDirectory(testDir, 'file.md', '../outside.md');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_NAME');
    });

    it('should return error if target already exists', async () => {
      writeFileSync(join(testDir, 'source.md'), 'source');
      writeFileSync(join(testDir, 'target.md'), 'target');

      const result = await renameFileOrDirectory(testDir, 'source.md', 'target.md');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('FILE_EXISTS');
    });

    it('should reject path traversal in source path', async () => {
      const result = await renameFileOrDirectory(testDir, '../outside.md', 'inside.md');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_PATH');
    });
  });

  describe('[CONS-001] createErrorResult with upload error codes', () => {
    it('should create error result for INVALID_EXTENSION', () => {
      const result = createErrorResult('INVALID_EXTENSION');
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_EXTENSION');
      expect(result.error?.message).toBeDefined();
    });

    it('should create error result for INVALID_MIME_TYPE', () => {
      const result = createErrorResult('INVALID_MIME_TYPE');
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_MIME_TYPE');
    });

    it('should create error result for INVALID_MAGIC_BYTES', () => {
      const result = createErrorResult('INVALID_MAGIC_BYTES');
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_MAGIC_BYTES');
    });

    it('should create error result for FILE_TOO_LARGE', () => {
      const result = createErrorResult('FILE_TOO_LARGE');
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('FILE_TOO_LARGE');
    });

    it('should create error result for INVALID_FILENAME', () => {
      const result = createErrorResult('INVALID_FILENAME');
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_FILENAME');
    });

    it('should create error result for INVALID_FILE_CONTENT', () => {
      const result = createErrorResult('INVALID_FILE_CONTENT');
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_FILE_CONTENT');
    });

    it('should accept custom message', () => {
      const result = createErrorResult('FILE_TOO_LARGE', 'Custom error message');
      expect(result.error?.message).toBe('Custom error message');
    });
  });

  describe('writeBinaryFile', () => {
    it('should write binary file successfully', async () => {
      const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      const result = await writeBinaryFile(testDir, 'test.png', buffer);

      expect(result.success).toBe(true);
      expect(result.path).toBe('test.png');
      expect(result.size).toBe(8);
      expect(existsSync(join(testDir, 'test.png'))).toBe(true);
    });

    it('should create parent directories if needed', async () => {
      const buffer = Buffer.from('text content');
      const result = await writeBinaryFile(testDir, 'nested/dir/file.txt', buffer);

      expect(result.success).toBe(true);
      expect(existsSync(join(testDir, 'nested/dir/file.txt'))).toBe(true);
    });

    it('should return FILE_EXISTS error if file already exists', async () => {
      writeFileSync(join(testDir, 'existing.png'), 'content');
      const buffer = Buffer.from([0x89, 0x50]);

      const result = await writeBinaryFile(testDir, 'existing.png', buffer);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('FILE_EXISTS');
    });

    it('should reject path traversal', async () => {
      const buffer = Buffer.from('malicious');
      const result = await writeBinaryFile(testDir, '../outside/file.txt', buffer);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_PATH');
    });

    it('should return correct size in result', async () => {
      const content = 'Hello, World!';
      const buffer = Buffer.from(content);
      const result = await writeBinaryFile(testDir, 'hello.txt', buffer);

      expect(result.success).toBe(true);
      expect(result.size).toBe(content.length);
    });
  });

  // ==========================================================================
  // [Issue #723] readFileLineRange — line-range chunked reader for the
  // read-only large-file viewer. Uses createReadStream + readline (streaming,
  // not loading entire file in memory).
  // ==========================================================================
  describe('readFileLineRange (Issue #723)', () => {
    /** Helper: build content with N numbered lines. */
    function makeNumberedLines(count: number): string {
      const lines: string[] = [];
      for (let i = 1; i <= count; i++) lines.push(`line ${i}`);
      return lines.join('\n');
    }

    it('returns the requested 1-based inclusive line range with metadata', async () => {
      writeFileSync(join(testDir, 'sample.log'), makeNumberedLines(20));

      const result = await readFileLineRange(testDir, 'sample.log', 3, 5);

      expect(result.success).toBe(true);
      expect(result.content).toBe('line 3\nline 4\nline 5');
      expect(result.totalLines).toBe(20);
      expect(result.totalBytes).toBeGreaterThan(0);
      expect(result.range).toEqual({ start: 3, end: 5 });
      expect(result.encoding).toBe('utf-8');
    });

    it('handles the very first line', async () => {
      writeFileSync(join(testDir, 'first.log'), makeNumberedLines(5));

      const result = await readFileLineRange(testDir, 'first.log', 1, 1);

      expect(result.success).toBe(true);
      expect(result.content).toBe('line 1');
      expect(result.range).toEqual({ start: 1, end: 1 });
    });

    it('returns empty content for an empty file but reports totalLines=0', async () => {
      writeFileSync(join(testDir, 'empty.log'), '');

      const result = await readFileLineRange(testDir, 'empty.log', 1, 5);

      expect(result.success).toBe(true);
      expect(result.content).toBe('');
      expect(result.totalLines).toBe(0);
      expect(result.totalBytes).toBe(0);
      // Range clamped to actual file size (no lines).
      expect(result.range?.start).toBe(1);
    });

    it('handles a file whose last line does not end with newline (EOF no LF)', async () => {
      writeFileSync(join(testDir, 'no-eof.log'), 'line 1\nline 2\nline 3');

      const result = await readFileLineRange(testDir, 'no-eof.log', 1, 3);

      expect(result.success).toBe(true);
      expect(result.content).toBe('line 1\nline 2\nline 3');
      expect(result.totalLines).toBe(3);
      expect(result.range).toEqual({ start: 1, end: 3 });
    });

    it('clamps endLine to file end and still returns 200-compatible success', async () => {
      writeFileSync(join(testDir, 'short.log'), makeNumberedLines(5));

      const result = await readFileLineRange(testDir, 'short.log', 3, 100);

      expect(result.success).toBe(true);
      expect(result.totalLines).toBe(5);
      expect(result.range?.start).toBe(3);
      expect(result.range?.end).toBe(5);
      expect(result.content).toBe('line 3\nline 4\nline 5');
    });

    it('rejects startLine < 1 with INVALID_REQUEST', async () => {
      writeFileSync(join(testDir, 'any.log'), 'a\nb');

      const result = await readFileLineRange(testDir, 'any.log', 0, 5);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_REQUEST');
    });

    it('rejects endLine < startLine with INVALID_REQUEST', async () => {
      writeFileSync(join(testDir, 'any.log'), 'a\nb');

      const result = await readFileLineRange(testDir, 'any.log', 5, 2);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_REQUEST');
    });

    it('rejects ranges wider than VIEWER_CHUNK_LINE_SIZE * 4 with INVALID_REQUEST', async () => {
      writeFileSync(join(testDir, 'any.log'), 'a\nb');

      const tooWide = VIEWER_CHUNK_LINE_SIZE * 4 + 1;
      const result = await readFileLineRange(testDir, 'any.log', 1, 1 + tooWide);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_REQUEST');
    });

    it('rejects path traversal via INVALID_PATH', async () => {
      const result = await readFileLineRange(testDir, '../etc/passwd', 1, 10);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_PATH');
    });

    it('returns FILE_NOT_FOUND when target file is missing', async () => {
      const result = await readFileLineRange(testDir, 'missing.log', 1, 10);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('FILE_NOT_FOUND');
    });

    // [Issue #723] Streaming-memory check — 100MB file must not load fully into RSS.
    // Per Acceptance Criteria: RSS increment < 50MB.
    it('does not load 100MB file fully into memory (RSS increment under 50MB)', async () => {
      const bigFile = join(testDir, 'big.log');
      // Build a ~100MB file with 1_000_000 lines of "line {n}\n" (~10-15 bytes each)
      // Stream-write so the test itself does not blow up memory.
      const { createWriteStream } = await import('fs');
      const ws = createWriteStream(bigFile, { encoding: 'utf-8' });
      await new Promise<void>((resolve, reject) => {
        const TOTAL = 1_000_000;
        let i = 1;
        function pump() {
          let ok = true;
          while (i <= TOTAL && ok) {
            const buf = `line ${i}\n`;
            ok = ws.write(buf);
            i++;
          }
          if (i > TOTAL) ws.end();
          else ws.once('drain', pump);
        }
        ws.on('finish', resolve);
        ws.on('error', reject);
        pump();
      });

      // Force GC if available (vitest --expose-gc); otherwise rely on natural GC.
      const gcFn = (globalThis as { gc?: () => void }).gc;
      if (typeof gcFn === 'function') gcFn();
      const before = process.memoryUsage().rss;

      // Read a small window from the middle of the file.
      const result = await readFileLineRange(testDir, 'big.log', 500_000, 500_010);

      const after = process.memoryUsage().rss;
      const deltaMB = (after - before) / (1024 * 1024);

      expect(result.success).toBe(true);
      expect(result.content?.startsWith('line 500000')).toBe(true);
      // Streaming should keep RSS increment well below 50MB.
      expect(deltaMB).toBeLessThan(50);
    }, 60_000);
  });
});
