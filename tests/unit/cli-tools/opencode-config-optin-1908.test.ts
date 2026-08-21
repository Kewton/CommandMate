/**
 * Issue #1908: CommandMate stops writing `opencode.json` into people's
 * repositories.
 *
 * `ensureOpencodeConfig` used to drop a ~4 KB provider config into the worktree
 * root whenever Ollama or LM Studio answered on localhost. On the reporting
 * machine that was six repositories, CommandMate's own checkout among them,
 * each showing `?? opencode.json` in `git status` from then on. Nobody asked for
 * it and nothing said it had happened.
 *
 * These tests run against a real temp directory rather than a mocked `fs`,
 * because the thing under test is which files exist afterwards. `XDG_CONFIG_HOME`
 * is stubbed in every test so the operator's own `~/.config/opencode/` is never
 * read and never written.
 *
 * The precedence facts the skip list encodes were measured with
 * `opencode debug config` on 1.18.21 under a disposable `HOME`:
 * `opencode.jsonc` and `.opencode/opencode.json(c)` load like the root file,
 * `provider` maps merge across every layer, and a worktree-root `opencode.json`
 * **outranks `$OPENCODE_CONFIG` and the global config** when a key collides.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import {
  ensureOpencodeConfig,
  findOwnedOpencodeConfig,
  opencodeGlobalConfigDir,
  resolveOpencodeConfigMode,
  OPENCODE_LOCAL_PROVIDER_CONFIG_ENV,
  OPENCODE_CONFIG_ENV,
  OLLAMA_API_URL,
  LM_STUDIO_API_URL,
} from '@/lib/cli-tools/opencode-config';

let worktree: string;
let xdgConfigHome: string;
const mockFetch = vi.fn();

/** Both providers answering with one model each, as a live pair would. */
function providersAnswer(): void {
  mockFetch.mockImplementation((url: string) => {
    if (url === OLLAMA_API_URL) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ models: [{ name: 'qwen3:8b' }] })),
      });
    }
    if (url === LM_STUDIO_API_URL) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ data: [{ id: 'gpt-oss-20b' }] })),
      });
    }
    return Promise.reject(new Error(`Unknown URL: ${url}`));
  });
}

/**
 * `validateWorktreePath` canonicalises with `realpathSync` [D4-004], and on
 * macOS `mkdtemp` hands back `/var/...` for `/private/var/...`, so the path the
 * generator reports is the resolved one.
 */
function worktreeConfig(): string {
  return path.join(fs.realpathSync(worktree), 'opencode.json');
}

function globalConfig(): string {
  return path.join(xdgConfigHome, 'opencode', 'opencode.json');
}

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf-8');
}

describe('opencode local-provider config generation (Issue #1908)', () => {
  beforeEach(() => {
    worktree = makeTempDir('opencode-optin-wt-');
    xdgConfigHome = makeTempDir('opencode-optin-xdg-');
    // Never the operator's own config directory.
    vi.stubEnv('XDG_CONFIG_HOME', xdgConfigHome);
    vi.stubEnv(OPENCODE_CONFIG_ENV, '');
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    providersAnswer();
  });

  afterEach(() => {
    removeTempDir(worktree);
    removeTempDir(xdgConfigHome);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  describe('the default', () => {
    it('writes nothing anywhere when the operator has not opted in', async () => {
      // The bug, stated as an assertion. MUTATION CHECK: default
      // `resolveOpencodeConfigMode` to `'worktree'` and this goes red.
      const outcome = await ensureOpencodeConfig(worktree);

      expect(outcome).toEqual({ written: false, configPath: null, reason: 'disabled' });
      expect(fs.readdirSync(worktree)).toEqual([]);
      expect(fs.existsSync(globalConfig())).toBe(false);
    });

    it('does not probe localhost at all', async () => {
      // The two 3-second-timeout fetches were on the launch path of every
      // opencode session, for a file that is no longer written.
      await ensureOpencodeConfig(worktree);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does not touch a file an earlier CommandMate already wrote', async () => {
      // Upgrading must not take anyone's provider list away — the file still
      // loads, so it is left exactly as it is. Cleaning up is the operator's
      // call, not a side effect of an upgrade.
      write(worktreeConfig(), '{"legacy":true}');

      await ensureOpencodeConfig(worktree);

      expect(fs.readFileSync(worktreeConfig(), 'utf-8')).toBe('{"legacy":true}');
    });

    it.each(['off', '0', 'false', 'none', '', '  '])(
      'treats %o as off',
      async (value) => {
        vi.stubEnv(OPENCODE_LOCAL_PROVIDER_CONFIG_ENV, value);

        const outcome = await ensureOpencodeConfig(worktree);

        expect(outcome.reason).toBe('disabled');
      }
    );

    it('treats an unrecognised value as off rather than as the old behaviour', async () => {
      // A typo in an opt-in must not opt anybody in.
      vi.stubEnv(OPENCODE_LOCAL_PROVIDER_CONFIG_ENV, 'wroktree');

      const outcome = await ensureOpencodeConfig(worktree);

      expect(outcome.reason).toBe('disabled');
      expect(fs.readdirSync(worktree)).toEqual([]);
    });
  });

  describe('worktree mode (the pre-#1908 destination, now opt-in)', () => {
    beforeEach(() => {
      vi.stubEnv(OPENCODE_LOCAL_PROVIDER_CONFIG_ENV, 'worktree');
    });

    it('writes the provider config into the worktree root', async () => {
      const outcome = await ensureOpencodeConfig(worktree);

      expect(outcome.written).toBe(true);
      expect(outcome.configPath).toBe(worktreeConfig());
      const config = JSON.parse(fs.readFileSync(worktreeConfig(), 'utf-8'));
      expect(Object.keys(config.provider).sort()).toEqual(['lmstudio', 'ollama']);
    });

    it.each([
      ['opencode.json', 'opencode.json'],
      ['opencode.jsonc', 'opencode.jsonc'],
      ['.opencode/opencode.json', path.join('.opencode', 'opencode.json')],
      ['.opencode/opencode.jsonc', path.join('.opencode', 'opencode.jsonc')],
    ])('stands down when the worktree already has %s', async (_label, relative) => {
      // All four load, measured with `opencode debug config`. Only the first was
      // checked before #1908, so a repository configured with a `.jsonc` got a
      // generated `.json` next to it — and `.jsonc` wins on a collision, which
      // makes the generated file dead weight that still shows in `git status`.
      write(path.join(worktree, relative), '{"provider":{}}');

      const outcome = await ensureOpencodeConfig(worktree);

      expect(outcome.reason).toBe('existing-config');
      expect(outcome.written).toBe(false);
    });

    it('stands down when OPENCODE_CONFIG points somewhere', async () => {
      // Measured: a worktree-root `opencode.json` beats `$OPENCODE_CONFIG` on a
      // key collision. Generating one is the single most effective way to
      // defeat the config the operator explicitly selected, so an explicit
      // selection is treated as "hands off", never as a write target.
      vi.stubEnv(OPENCODE_CONFIG_ENV, path.join(xdgConfigHome, 'chosen.json'));

      const outcome = await ensureOpencodeConfig(worktree);

      expect(outcome.reason).toBe('existing-config');
      expect(fs.existsSync(worktreeConfig())).toBe(false);
    });

    it.each(['opencode.json', 'opencode.jsonc'])(
      'stands down when the operator has a global %s',
      async (name) => {
        // Same reason: the worktree file outranks the global one, so a machine
        // that is already configured would have its `provider.ollama` silently
        // replaced by CommandMate's snapshot.
        write(path.join(xdgConfigHome, 'opencode', name), '{"provider":{}}');

        const outcome = await ensureOpencodeConfig(worktree);

        expect(outcome.reason).toBe('existing-config');
        expect(fs.existsSync(worktreeConfig())).toBe(false);
      }
    );

    it('writes nothing when neither provider has a model', async () => {
      mockFetch.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')));

      const outcome = await ensureOpencodeConfig(worktree);

      expect(outcome.reason).toBe('no-providers');
      expect(fs.readdirSync(worktree)).toEqual([]);
    });

    it('still refuses a path that is not a directory [D4-004]', async () => {
      const file = path.join(worktree, 'a-file');
      fs.writeFileSync(file, 'x');

      await expect(ensureOpencodeConfig(file)).rejects.toThrow('Path is not a directory');
    });
  });

  describe('global mode', () => {
    beforeEach(() => {
      vi.stubEnv(OPENCODE_LOCAL_PROVIDER_CONFIG_ENV, 'global');
    });

    it('writes one machine-wide file and leaves the repository alone', async () => {
      const outcome = await ensureOpencodeConfig(worktree);

      expect(outcome.written).toBe(true);
      expect(outcome.configPath).toBe(globalConfig());
      expect(fs.readdirSync(worktree)).toEqual([]);
      const config = JSON.parse(fs.readFileSync(globalConfig(), 'utf-8'));
      expect(config.$schema).toBe('https://opencode.ai/config.json');
    });

    it('creates the config directory when it does not exist yet', async () => {
      expect(fs.existsSync(path.join(xdgConfigHome, 'opencode'))).toBe(false);

      await ensureOpencodeConfig(worktree);

      expect(fs.existsSync(globalConfig())).toBe(true);
    });

    it('stands down when a global config already exists', async () => {
      write(path.join(xdgConfigHome, 'opencode', 'opencode.jsonc'), '{"provider":{}}');

      const outcome = await ensureOpencodeConfig(worktree);

      expect(outcome.reason).toBe('existing-config');
      expect(fs.existsSync(globalConfig())).toBe(false);
    });

    it('is not blocked by one repository having its own config', async () => {
      // One checkout's `opencode.json` says nothing about the machine, and the
      // global file loses to it inside that checkout anyway.
      write(worktreeConfig(), '{"provider":{}}');

      const outcome = await ensureOpencodeConfig(worktree);

      expect(outcome.written).toBe(true);
      expect(outcome.configPath).toBe(globalConfig());
    });
  });

  describe('resolveOpencodeConfigMode()', () => {
    it.each([
      ['worktree', 'worktree'],
      ['project', 'worktree'],
      ['WORKTREE', 'worktree'],
      [' worktree ', 'worktree'],
      ['global', 'global'],
      ['user', 'global'],
      ['off', 'off'],
      ['nonsense', 'off'],
    ])('maps %o to %o', (value, expected) => {
      expect(
        resolveOpencodeConfigMode({ [OPENCODE_LOCAL_PROVIDER_CONFIG_ENV]: value })
      ).toBe(expected);
    });

    it('is off when the variable is absent', () => {
      expect(resolveOpencodeConfigMode({})).toBe('off');
    });
  });

  describe('findOwnedOpencodeConfig()', () => {
    it('reports OPENCODE_CONFIG ahead of any file', () => {
      write(worktreeConfig(), '{}');

      expect(
        findOwnedOpencodeConfig(worktree, {
          [OPENCODE_CONFIG_ENV]: '/somewhere/else.json',
          XDG_CONFIG_HOME: xdgConfigHome,
        })
      ).toBe(`env:${OPENCODE_CONFIG_ENV}`);
    });

    it('answers null when the operator has configured nothing', () => {
      expect(findOwnedOpencodeConfig(worktree, { XDG_CONFIG_HOME: xdgConfigHome })).toBeNull();
    });

    it('checks only the global layer when handed no worktree', () => {
      write(worktreeConfig(), '{}');

      expect(findOwnedOpencodeConfig(null, { XDG_CONFIG_HOME: xdgConfigHome })).toBeNull();
    });
  });

  describe('opencodeGlobalConfigDir()', () => {
    it('honours XDG_CONFIG_HOME', () => {
      expect(opencodeGlobalConfigDir({ XDG_CONFIG_HOME: xdgConfigHome })).toBe(
        path.join(xdgConfigHome, 'opencode')
      );
    });

    it('falls back to ~/.config/opencode', () => {
      expect(opencodeGlobalConfigDir({})).toBe(
        path.join(require('os').homedir(), '.config', 'opencode')
      );
    });

    it('refuses a virtual-filesystem XDG_CONFIG_HOME [Issue #1774]', () => {
      // A recursive mkdir under /proc never returns on Linux, and this module
      // does one in global mode.
      expect(opencodeGlobalConfigDir({ XDG_CONFIG_HOME: '/proc/self/fd' })).toBe(
        path.join(require('os').homedir(), '.config', 'opencode')
      );
    });
  });
});
