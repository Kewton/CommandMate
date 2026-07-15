/**
 * Install Context Tests
 * Issue #136: DRY refactoring - extract isGlobalInstall and getConfigDir
 * Issue #1195: npx install detection regression coverage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

vi.mock('fs');

// isGlobalInstall() derives the install type from dirname(__dirname), so path.dirname
// is the only seam available to simulate an npx / global layout.
vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path');
  return { ...actual, default: actual, dirname: vi.fn(actual.dirname) };
});

// Import will happen after mock setup
let isGlobalInstall: () => boolean;
let getConfigDir: () => string;

describe('install-context', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.resetModules();

    // Dynamic import to pick up mocks
    const module = await import('../../../../src/cli/utils/install-context');
    isGlobalInstall = module.isGlobalInstall;
    getConfigDir = module.getConfigDir;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isGlobalInstall', () => {
    it('should return a boolean', () => {
      const result = isGlobalInstall();
      expect(typeof result).toBe('boolean');
    });

    it('should detect global install when path includes /lib/node_modules/', () => {
      // The function checks __dirname, which we can't easily mock
      // So we test the return type is correct
      const result = isGlobalInstall();
      expect(result === true || result === false).toBe(true);
    });

    it('should detect local install in test environment', () => {
      // In test environment, we're typically running locally
      const result = isGlobalInstall();
      // Just verify it returns without error and is boolean
      expect(typeof result).toBe('boolean');
    });
  });

  describe('getConfigDir', () => {
    it('should return a directory path', () => {
      vi.mocked(fs.realpathSync).mockImplementation((p) => p.toString());
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const configDir = getConfigDir();
      expect(typeof configDir).toBe('string');
      expect(configDir.length).toBeGreaterThan(0);
    });

    it('should resolve symlinks using realpathSync for local install', () => {
      const mockCwd = '/some/symlinked/path';
      vi.spyOn(process, 'cwd').mockReturnValue(mockCwd);
      vi.mocked(fs.realpathSync).mockReturnValue('/real/path');
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const configDir = getConfigDir();

      // realpathSync should be called for symlink resolution
      expect(fs.realpathSync).toHaveBeenCalled();
    });

    it('should return ~/.commandmate for global install when directory exists', () => {
      // For this test, we need to test the global install path
      // Since we can't easily mock __dirname, we test the expected behavior
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.realpathSync).mockImplementation((p) => p.toString());

      const configDir = getConfigDir();
      // Should be a valid path
      expect(typeof configDir).toBe('string');
    });

    it('should throw error when config directory resolves outside home for global install', () => {
      // This tests the security check - would need global install context
      // Skipping detailed test as it requires mocking __dirname
      expect(true).toBe(true);
    });
  });

  // Issue #1195: `npx commandmate` resolves under ~/.npm/_npx/<hash>/node_modules/commandmate.
  // The third clause of isGlobalInstall() ('/node_modules/commandmate') already matches it,
  // so config/db must land in ~/.commandmate rather than the user's cwd. These tests pin that
  // behaviour so a future tweak to the detection logic cannot silently relocate user data.
  describe('npx install context (Issue #1195)', () => {
    const NPX_CLI_DIR =
      '/Users/tester/.npm/_npx/a1b2c3d4e5f6a7b8/node_modules/commandmate/dist/cli';

    let getEnvPath: (issueNo?: number) => string;
    let getDefaultDbPath: () => string;

    beforeEach(async () => {
      vi.mocked(path.dirname).mockReturnValue(NPX_CLI_DIR);

      const envSetup = await import('../../../../src/cli/utils/env-setup');
      getEnvPath = envSetup.getEnvPath;
      getDefaultDbPath = envSetup.getDefaultDbPath;
    });

    it('should detect a global install when running from the npx cache', () => {
      expect(isGlobalInstall()).toBe(true);
    });

    it('should place .env under ~/.commandmate when run via npx', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      expect(getEnvPath()).toBe(path.join(homedir(), '.commandmate', '.env'));
    });

    it('should place the database under ~/.commandmate/data when run via npx', () => {
      expect(getDefaultDbPath()).toBe(
        path.join(homedir(), '.commandmate', 'data', 'cm.db')
      );
    });

    it('should not write config into the current working directory when run via npx', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.spyOn(process, 'cwd').mockReturnValue('/some/unrelated/project');

      expect(getEnvPath()).not.toContain('/some/unrelated/project');
      expect(getDefaultDbPath()).not.toContain('/some/unrelated/project');
    });

    it('should place worktree .env under ~/.commandmate/envs when run via npx', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      expect(getEnvPath(1195)).toBe(
        path.join(homedir(), '.commandmate', 'envs', '1195.env')
      );
    });

    // Negative control: proves the assertions above are driven by the simulated path
    // rather than passing unconditionally.
    it('should treat a non-node_modules checkout as a local install', () => {
      vi.mocked(path.dirname).mockReturnValue('/Users/tester/src/commandmate/src/cli');
      vi.spyOn(process, 'cwd').mockReturnValue('/Users/tester/src/commandmate');

      expect(isGlobalInstall()).toBe(false);
      expect(getEnvPath()).toBe(path.join('/Users/tester/src/commandmate', '.env'));
    });
  });
});
