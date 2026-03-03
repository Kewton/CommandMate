/**
 * File Operations Symlink Traversal Tests [SEC-394]
 *
 * Verifies that all file operation functions reject paths
 * that resolve through symlinks pointing outside the worktree root.
 *
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { symlinkSync } from 'fs';

import {
  readFileContent,
  updateFileContent,
  deleteFileOrDirectory,
  createFileOrDirectory,
  renameFileOrDirectory,
  writeBinaryFile,
} from '@/lib/file-operations';
import {
  createSymlinkFixture,
  cleanupSymlinkFixture,
  SymlinkTestFixture,
} from '@tests/helpers/symlink-test-fixtures';

describe('File Operations - Symlink Traversal Protection [SEC-394]', () => {
  let fixture: SymlinkTestFixture;
  let testRoot: string;
  let externalDir: string;

  beforeEach(() => {
    fixture = createSymlinkFixture({
      rootPrefix: 'fo-symlink-root-',
      externalPrefix: 'fo-symlink-ext-',
      internalFiles: { 'src/internal.md': '# Internal' },
      externalFiles: {
        'secret.txt': 'SECRET DATA',
        'image.png': 'fake-png-data',
        'video.mp4': 'fake-mp4-data',
      },
      symlinks: {},
    });
    testRoot = fixture.testRoot;
    externalDir = fixture.externalDir;

    // Create additional symlinks specific to this test suite
    symlinkSync(
      path.join(externalDir, 'secret.txt'),
      path.join(testRoot, 'evil-link.md')
    );
    symlinkSync(externalDir, path.join(testRoot, 'evil-dir'));
  });

  afterEach(() => {
    cleanupSymlinkFixture(fixture);
  });

  it('should reject readFileContent via external symlink', async () => {
    const result = await readFileContent(testRoot, 'evil-link.md');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PATH');
  });

  it('should reject updateFileContent via external symlink', async () => {
    const result = await updateFileContent(testRoot, 'evil-link.md', 'hacked');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PATH');
  });

  it('should reject deleteFileOrDirectory via external symlink', async () => {
    const result = await deleteFileOrDirectory(testRoot, 'evil-link.md');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PATH');
  });

  it('should reject createFileOrDirectory under external symlink directory', async () => {
    const result = await createFileOrDirectory(
      testRoot,
      'evil-dir/newfile.txt',
      'file',
      'content'
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PATH');
  });

  it('should reject renameFileOrDirectory with external symlink source', async () => {
    const result = await renameFileOrDirectory(
      testRoot,
      'evil-link.md',
      'renamed.md'
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PATH');
  });

  it('should reject writeBinaryFile under external symlink directory', async () => {
    const buffer = Buffer.from('binary data');
    const result = await writeBinaryFile(
      testRoot,
      'evil-dir/uploaded.bin',
      buffer
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PATH');
  });

  it('should allow readFileContent via internal path (regression)', async () => {
    const result = await readFileContent(testRoot, 'src/internal.md');
    expect(result.success).toBe(true);
    expect(result.content).toBe('# Internal');
  });

  it('should reject image extension symlink traversal (.png)', async () => {
    // Create a symlink to an external "image" file
    symlinkSync(
      path.join(externalDir, 'image.png'),
      path.join(testRoot, 'evil-image.png')
    );
    const result = await readFileContent(testRoot, 'evil-image.png');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PATH');
  });

  it('should reject video extension symlink traversal (.mp4)', async () => {
    // Create a symlink to an external "video" file
    symlinkSync(
      path.join(externalDir, 'video.mp4'),
      path.join(testRoot, 'evil-video.mp4')
    );
    const result = await readFileContent(testRoot, 'evil-video.mp4');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PATH');
  });
});
