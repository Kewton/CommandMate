/**
 * Browser Launch Tests
 * Issue #1195: Guided quickstart for `npx commandmate`
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'child_process';
import { shouldOpenBrowser, openBrowser } from '../../../../src/cli/utils/browser';

vi.mock('child_process');

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

// NODE_ENV is required by the Next.js ProcessEnv augmentation
function makeEnv(vars: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...vars, NODE_ENV: 'test' };
}

interface MockChild {
  unref: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

function mockSpawnedChild(options: { emitError?: boolean } = {}): MockChild {
  const child: MockChild = {
    unref: vi.fn(),
    on: vi.fn((event: string, handler: (error: Error) => void) => {
      if (options.emitError && event === 'error') {
        handler(new Error('spawn ENOENT'));
      }
      return child;
    }),
  };
  vi.mocked(childProcess.spawn).mockReturnValue(child as unknown as childProcess.ChildProcess);
  return child;
}

describe('browser', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('shouldOpenBrowser', () => {
    it('should return false when CI is true', () => {
      setPlatform('darwin');

      expect(shouldOpenBrowser(makeEnv({ CI: 'true' }))).toBe(false);
    });

    it('should return true when CI is set to a non-true value', () => {
      setPlatform('darwin');

      expect(shouldOpenBrowser(makeEnv({ CI: 'false' }))).toBe(true);
    });

    it('should return false when BROWSER is none', () => {
      setPlatform('darwin');

      expect(shouldOpenBrowser(makeEnv({ BROWSER: 'none' }))).toBe(false);
    });

    it('should return false when SSH_CONNECTION is set', () => {
      setPlatform('darwin');

      expect(shouldOpenBrowser(makeEnv({ SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' }))).toBe(false);
    });

    it('should return false on linux without DISPLAY and WAYLAND_DISPLAY', () => {
      setPlatform('linux');

      expect(shouldOpenBrowser(makeEnv())).toBe(false);
    });

    it('should return true on linux with DISPLAY', () => {
      setPlatform('linux');

      expect(shouldOpenBrowser(makeEnv({ DISPLAY: ':0' }))).toBe(true);
    });

    it('should return true on linux with WAYLAND_DISPLAY', () => {
      setPlatform('linux');

      expect(shouldOpenBrowser(makeEnv({ WAYLAND_DISPLAY: 'wayland-0' }))).toBe(true);
    });

    it('should return false on linux with DISPLAY when CI is true', () => {
      setPlatform('linux');

      expect(shouldOpenBrowser(makeEnv({ DISPLAY: ':0', CI: 'true' }))).toBe(false);
    });

    it('should return true on darwin with an empty environment', () => {
      setPlatform('darwin');

      expect(shouldOpenBrowser(makeEnv())).toBe(true);
    });

    it('should not require DISPLAY on darwin', () => {
      setPlatform('darwin');

      expect(shouldOpenBrowser(makeEnv({ SHELL: '/bin/zsh' }))).toBe(true);
    });

    it('should fall back to process.env when env is omitted', () => {
      setPlatform('darwin');
      vi.stubEnv('CI', 'true');

      expect(shouldOpenBrowser()).toBe(false);
    });
  });

  describe('openBrowser', () => {
    it('should spawn open with the url on darwin', () => {
      setPlatform('darwin');
      const child = mockSpawnedChild();

      openBrowser('http://127.0.0.1:3000');

      expect(childProcess.spawn).toHaveBeenCalledWith(
        'open',
        ['http://127.0.0.1:3000'],
        { stdio: 'ignore', detached: true }
      );
      expect(child.unref).toHaveBeenCalled();
    });

    it('should spawn xdg-open with the url on linux', () => {
      setPlatform('linux');
      const child = mockSpawnedChild();

      openBrowser('http://127.0.0.1:3000');

      expect(childProcess.spawn).toHaveBeenCalledWith(
        'xdg-open',
        ['http://127.0.0.1:3000'],
        { stdio: 'ignore', detached: true }
      );
      expect(child.unref).toHaveBeenCalled();
    });

    it('should do nothing on unsupported platforms', () => {
      setPlatform('win32');
      mockSpawnedChild();

      openBrowser('http://127.0.0.1:3000');

      expect(childProcess.spawn).not.toHaveBeenCalled();
    });

    it('should never enable shell interpretation', () => {
      setPlatform('darwin');
      mockSpawnedChild();

      openBrowser('http://127.0.0.1:3000');

      const options = vi.mocked(childProcess.spawn).mock.calls[0][2] as childProcess.SpawnOptions;
      expect(options.shell).toBeUndefined();
    });

    it('should pass the url as a separate argument rather than in the command', () => {
      setPlatform('darwin');
      mockSpawnedChild();

      openBrowser('http://127.0.0.1:3000; rm -rf /');

      const [command, args] = vi.mocked(childProcess.spawn).mock.calls[0];
      expect(command).toBe('open');
      expect(args).toEqual(['http://127.0.0.1:3000; rm -rf /']);
    });

    it('should not throw when the child emits an error', () => {
      setPlatform('darwin');
      mockSpawnedChild({ emitError: true });

      expect(() => openBrowser('http://127.0.0.1:3000')).not.toThrow();
    });

    it('should register an error handler on the child', () => {
      setPlatform('darwin');
      const child = mockSpawnedChild();

      openBrowser('http://127.0.0.1:3000');

      expect(child.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should not throw when spawn throws synchronously', () => {
      setPlatform('linux');
      vi.mocked(childProcess.spawn).mockImplementation(() => {
        throw new Error('spawn failed');
      });

      expect(() => openBrowser('http://127.0.0.1:3000')).not.toThrow();
    });
  });
});
