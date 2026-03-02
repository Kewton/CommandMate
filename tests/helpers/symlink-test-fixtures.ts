/**
 * Shared test fixtures for symlink traversal tests [SEC-394]
 *
 * Creates isolated temp directories with:
 * - testRoot/src/file.ts (or configurable internal files)
 * - externalDir/secret.txt (or configurable external files)
 * - testRoot/evil-link -> external file (symlink pointing outside root)
 *
 * Used by: path-validator.test.ts, file-operations-symlink.test.ts
 */

import path from 'path';
import { mkdirSync, rmSync, writeFileSync, symlinkSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';

export interface SymlinkTestFixture {
  /** Worktree root directory (temp) */
  testRoot: string;
  /** External directory outside worktree root (temp) */
  externalDir: string;
}

export interface SymlinkFixtureOptions {
  /** Prefix for testRoot temp directory name (default: 'symlink-test-root-') */
  rootPrefix?: string;
  /** Prefix for externalDir temp directory name (default: 'symlink-test-ext-') */
  externalPrefix?: string;
  /** Internal files to create (relative to testRoot). Directories are auto-created. */
  internalFiles?: Record<string, string>;
  /** External files to create (relative to externalDir) */
  externalFiles?: Record<string, string>;
  /** Symlinks to create: key = link name (relative to testRoot), value = target (absolute path) */
  symlinks?: Record<string, string>;
}

/**
 * Create a symlink test fixture with isolated temp directories.
 *
 * @param options - Configuration for the fixture
 * @returns Fixture with testRoot and externalDir paths
 */
export function createSymlinkFixture(options: SymlinkFixtureOptions = {}): SymlinkTestFixture {
  const {
    rootPrefix = 'symlink-test-root-',
    externalPrefix = 'symlink-test-ext-',
    internalFiles = { 'src/file.ts': 'content' },
    externalFiles = { 'secret.txt': 'secret' },
    symlinks = {},
  } = options;

  const testRoot = mkdtempSync(path.join(tmpdir(), rootPrefix));
  const externalDir = mkdtempSync(path.join(tmpdir(), externalPrefix));

  // Create internal files
  for (const [relativePath, content] of Object.entries(internalFiles)) {
    const fullPath = path.join(testRoot, relativePath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }

  // Create external files
  for (const [relativePath, content] of Object.entries(externalFiles)) {
    const fullPath = path.join(externalDir, relativePath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }

  // Create symlinks
  for (const [linkName, target] of Object.entries(symlinks)) {
    symlinkSync(target, path.join(testRoot, linkName));
  }

  return { testRoot, externalDir };
}

/**
 * Clean up a symlink test fixture.
 *
 * @param fixture - The fixture to clean up
 */
export function cleanupSymlinkFixture(fixture: SymlinkTestFixture): void {
  rmSync(fixture.testRoot, { recursive: true, force: true });
  rmSync(fixture.externalDir, { recursive: true, force: true });
}
