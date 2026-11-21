/**
 * A `hooks.json` CommandMate cannot parse is the user's file, not an empty one
 * (Issue #4505, P2-2).
 *
 * `readJsonObjectFile` answers null for "absent", "not JSON" and "JSON but not
 * an object" alike, and `writeAntigravityHooksConfig` used to read that null as
 * "nothing here" and write a file holding only CommandMate's key — silently
 * deleting every hook the user had in the one machine-wide file agy reads.
 *
 * The decision (PM) is: write nothing, warn, and let the session start without
 * hooks. So the file's bytes must be untouched, no `.bak` and no relay copy may
 * appear beside it, and the call answers null.
 *
 * Every write goes to a temporary directory; `os.homedir()` and the developer's
 * own `~/.gemini` are never involved.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import {
  ANTIGRAVITY_HOOK_NAME,
  writeAntigravityHooksConfig,
} from '@/lib/hooks/sources/antigravity/hooks-config';

const dirs: string[] = [];
let root: string;
let configPath: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cmate-4505-broken-')));
  dirs.push(root);
  configPath = join(root, '.gemini', 'config', 'hooks.json');
  mkdirSync(dirname(configPath), { recursive: true });
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '1');
  vi.stubEnv('CM_UAT_ISOLATION', 'off');
  mockLogger.warn.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) removeTempDir(dir);
  }
});

/** Payloads that are one of the three shapes the writer must refuse to touch. */
const BROKEN: ReadonlyArray<[string, string]> = [
  ['a trailing comma', '{\n  "lint-checker": {"Stop": []},\n}\n'],
  ['a JSON array', '[]\n'],
  ['a JSON string', '"hooks"\n'],
  ['a JSONC comment', '{\n  // my own hooks\n  "lint-checker": {}\n}\n'],
];

describe('a hooks.json CommandMate cannot parse', () => {
  it.each(BROKEN)('leaves %s byte-identical, writes nothing, and warns once', (_label, body) => {
    writeFileSync(configPath, body);
    const before = readFileSync(configPath);

    expect(writeAntigravityHooksConfig({ path: configPath })).toBeNull();

    expect(readFileSync(configPath).equals(before)).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith('antigravity-hooks-config-invalid', {
      path: configPath,
    });
    // No `.bak`, no staging file, no relay copy: the directory holds only the
    // file the user came with.
    expect(readdirSync(dirname(configPath))).toEqual(['hooks.json']);
  });

  it('does not break the session that asked: no throw, just null', () => {
    writeFileSync(configPath, '{\n');
    expect(() => writeAntigravityHooksConfig({ path: configPath })).not.toThrow();
  });
});

describe('a hooks.json CommandMate can parse', () => {
  const USER_CONFIG = {
    'lint-checker': {
      PostToolUse: [
        { matcher: 'run_command', hooks: [{ type: 'command', command: './scripts/lint.sh' }] },
      ],
    },
    'safety-gate': {
      Stop: [{ type: 'command', command: './scripts/safety.sh', timeout: 5 }],
    },
    theme: 'dark',
  };

  it('keeps the user’s named hooks and top-level keys, and adds CommandMate’s', () => {
    writeFileSync(configPath, `${JSON.stringify(USER_CONFIG, null, 2)}\n`);

    expect(writeAntigravityHooksConfig({ path: configPath })).toBe(configPath);

    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(written['lint-checker']).toEqual(USER_CONFIG['lint-checker']);
    expect(written['safety-gate']).toEqual(USER_CONFIG['safety-gate']);
    expect(written.theme).toBe('dark');
    expect(written[ANTIGRAVITY_HOOK_NAME]).toBeDefined();
    expect(Object.keys(written)).toEqual(['lint-checker', 'safety-gate', 'theme', ANTIGRAVITY_HOOK_NAME]);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('still creates the file when there is none', () => {
    expect(writeAntigravityHooksConfig({ path: configPath })).toBe(configPath);

    expect(existsSync(configPath)).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(configPath, 'utf8')))).toEqual([
      ANTIGRAVITY_HOOK_NAME,
    ]);
  });
});
