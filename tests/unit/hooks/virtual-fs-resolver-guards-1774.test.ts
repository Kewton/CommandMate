/**
 * Every configured path that reaches a recursive mkdir goes through the guard
 * (Issue #1774).
 *
 * ## What this file pins, and how it avoids re-creating the bug
 *
 * Five settings end at a `mkdir(…, {recursive:true})`, and on Linux such a call
 * does not fail for a path under `/proc`, `/sys` or `/dev` — it spins forever
 * inside C++ with the event loop stopped (synchronous form) or holds a libuv
 * threadpool thread with a promise that never settles (asynchronous form).
 * Neither logs anything and neither can be caught. So this file must never put
 * one of those paths into the environment variables it exercises:
 * `tests/unit/guards/no-procfs-env-fixtures.test.ts` bans that mechanically,
 * for exactly the reason PR #1773's CI job ran 5h31m.
 *
 * The way round it is to make the *predicate* answer for a harmless sentinel
 * path. That gives a genuine end-to-end run — real resolver, real
 * `resolveSafeDirectory`, real warning — over a path no `mkdir` would object to
 * even if the guard were removed.
 *
 * The other half of the chain, "the real predicate answers true for a real
 * `/proc` path", is pinned with plain string arguments in
 * `tests/unit/config/system-directories.test.ts` and
 * `tests/unit/config/safe-directory.test.ts`, and end-to-end through the
 * argument-taking entry points in `virtual-fs-refusal-1774.test.ts`. Together
 * the three cover the composition without either half touching a real mkdir.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';

/**
 * A path the mocked predicate calls virtual. Deliberately not a real virtual
 * filesystem, so nothing in this file can hang even if the guard regresses.
 */
const SENTINEL = '/commandmate-1774-sentinel-fs';

vi.mock('@/config/system-directories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/system-directories')>();
  return {
    ...actual,
    isVirtualFilesystemPath: vi.fn((candidate: string) => candidate.startsWith(SENTINEL)),
  };
});

// `vi.hoisted` so the mock exists by the time `vi.mock` is lifted to the top.
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  },
}));
mockLogger.withContext.mockReturnValue(mockLogger);

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

import { resetSafeDirectoryWarnings } from '@/config/safe-directory';
import { getLogDir } from '@/config/log-config';
import { getHookSettingsDirectory } from '@/lib/hooks/hook-settings-generator';
import { getCodexHome } from '@/lib/hooks/sources/codex/hooks-config';
import { getCopilotHomeDirectory } from '@/lib/hooks/sources/copilot/hook-settings';
import { getOpencodePortFilePath } from '@/lib/hooks/sources/opencode/ports';
import { getOpencodeLaunchSettingsFilePath } from '@/lib/hooks/sources/opencode/launch-settings';
import { writeJsonObjectFile } from '@/lib/hooks/sources/gemini/shared-config-tree';

/** One row per setting that can reach a recursive mkdir. */
interface GuardedSetting {
  /** Name in the warning, and the environment variable when there is one. */
  readonly name: string;
  /** The value the resolver falls back to when the candidate is refused. */
  readonly fallback: () => string;
  /** Resolve with the setting unset / set to `value`. */
  readonly resolve: (value?: string) => string;
  /** An ordinary value that must pass straight through. */
  readonly ordinary: () => string;
}

const ENV_SETTINGS: readonly GuardedSetting[] = [
  {
    name: 'CM_AGENT_HOOKS_DIR',
    fallback: () => join(homedir(), '.commandmate', 'hooks'),
    resolve: (value) => {
      setEnv('CM_AGENT_HOOKS_DIR', value);
      return getHookSettingsDirectory();
    },
    ordinary: () => join(tmpdir(), 'cmate-hooks'),
  },
  {
    name: 'CM_LOG_DIR',
    fallback: () => join(process.cwd(), 'data', 'logs'),
    resolve: (value) => {
      setEnv('CM_LOG_DIR', value);
      return getLogDir();
    },
    ordinary: () => join(tmpdir(), 'cmate-logs'),
  },
  {
    name: 'CODEX_HOME',
    fallback: () => join(homedir(), '.codex'),
    resolve: (value) => {
      setEnv('CODEX_HOME', value);
      return getCodexHome();
    },
    ordinary: () => join(tmpdir(), 'cmate-codex-home'),
  },
  {
    name: 'COPILOT_HOME',
    fallback: () => join(homedir(), '.copilot'),
    resolve: (value) => {
      setEnv('COPILOT_HOME', value);
      return getCopilotHomeDirectory();
    },
    ordinary: () => join(tmpdir(), 'cmate-copilot-home'),
  },
  {
    name: 'CM_OPENCODE_PORT_FILE',
    fallback: () => join(homedir(), '.commandmate', 'opencode-ports.json'),
    resolve: (value) => {
      setEnv('CM_OPENCODE_PORT_FILE', value);
      return getOpencodePortFilePath();
    },
    ordinary: () => join(tmpdir(), 'cmate-opencode-ports.json'),
  },
  // Issue #2048: the launcher's mirror of the opencode instance settings. Same
  // shape and same hazard as the port file above — the write does a recursive
  // mkdir on this path's directory.
  {
    name: 'CM_OPENCODE_LAUNCH_SETTINGS_FILE',
    fallback: () => join(homedir(), '.commandmate', 'opencode-launch-settings.json'),
    resolve: (value) => {
      setEnv('CM_OPENCODE_LAUNCH_SETTINGS_FILE', value);
      return getOpencodeLaunchSettingsFilePath();
    },
    ordinary: () => join(tmpdir(), 'cmate-opencode-launch-settings.json'),
  },
];

const savedEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('virtual filesystem guard on every configured path (Issue #1774)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSafeDirectoryWarnings();
  });

  afterEach(() => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    savedEnv.clear();
  });

  describe.each(ENV_SETTINGS.map((setting) => [setting.name, setting] as const))(
    '%s',
    (_name, setting) => {
      it('falls back to the default when it points into a virtual filesystem', () => {
        expect(setting.resolve(`${SENTINEL}/cmate`)).toBe(setting.fallback());
      });

      it('warns, naming the setting and the value', () => {
        setting.resolve(`${SENTINEL}/cmate`);

        expect(mockLogger.warn).toHaveBeenCalledWith(
          'virtual-filesystem-path-rejected',
          expect.objectContaining({
            source: setting.name,
            candidate: `${SENTINEL}/cmate`,
            fallback: setting.fallback(),
          })
        );
      });

      it('passes an ordinary value straight through', () => {
        const ordinary = setting.ordinary();

        expect(setting.resolve(ordinary)).toBe(ordinary);
        expect(mockLogger.warn).not.toHaveBeenCalled();
      });

      it('returns the default when unset, unchanged by this guard', () => {
        expect(setting.resolve(undefined)).toBe(setting.fallback());
        expect(mockLogger.warn).not.toHaveBeenCalled();
      });
    }
  );

  describe('the option arguments that bypass the environment variable', () => {
    it('refuses HookSettingsOptions.directory', () => {
      expect(getHookSettingsDirectory({ directory: `${SENTINEL}/cmate` })).toBe(
        join(homedir(), '.commandmate', 'hooks')
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'virtual-filesystem-path-rejected',
        expect.objectContaining({ source: 'HookSettingsOptions.directory' })
      );
    });

    it('refuses CodexHookOptions.codexHome', () => {
      expect(getCodexHome({ codexHome: `${SENTINEL}/codex` })).toBe(join(homedir(), '.codex'));
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'virtual-filesystem-path-rejected',
        expect.objectContaining({ source: 'CodexHookOptions.codexHome' })
      );
    });

    it('still lets an explicit option win over the environment variable', () => {
      // The precedence this guard is layered onto must not change.
      const explicit = join(tmpdir(), 'cmate-explicit-hooks');
      setEnv('CM_AGENT_HOOKS_DIR', join(tmpdir(), 'cmate-env-hooks'));

      expect(getHookSettingsDirectory({ directory: explicit })).toBe(explicit);
    });
  });

  describe('writeJsonObjectFile (the ~/.gemini tree shared with antigravity)', () => {
    it('throws before touching the filesystem, because there is no default to use', () => {
      // Its callers pass one specific file and already treat a throw as
      // "launch without hooks", so refusing is the fail-open answer here.
      expect(() => writeJsonObjectFile(`${SENTINEL}/config/hooks.json`, {})).toThrow(
        /virtual filesystem/i
      );
    });

    it('writes an ordinary path as before', () => {
      const root = mkdtempSync(join(tmpdir(), 'cmate-1774-gemini-'));
      try {
        const target = join(root, 'config', 'hooks.json');
        writeJsonObjectFile(target, { hooks: { a: 1 } });
        expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ hooks: { a: 1 } });
      } finally {
        removeTempDir(root);
      }
    });
  });
});
