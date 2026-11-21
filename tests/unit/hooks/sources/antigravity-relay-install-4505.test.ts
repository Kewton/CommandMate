/**
 * The relay `~/.gemini/config/hooks.json` names lives beside it, not in a
 * checkout (Issue #4505, P2-3).
 *
 * The generated file used to name `process.cwd()/scripts/hooks/cmate-agent-event.sh`
 * — the checkout of whichever worktree server wrote it last. One machine-wide
 * hooks file plus several servers therefore meant every server rewrote the
 * shared file with its own checkout, and deleting a feature worktree silently
 * stopped `Stop` / `PostToolUse` delivery for every agy session on the machine.
 *
 * The fix copies the shipped relay to `<hooks.json's directory>/commandmate/`
 * and names that copy, so the file is a function of the hooks-file location
 * alone. Each test runs in its own temporary checkouts and HOME; neither the
 * developer's `~/.gemini` nor the real checkout is touched.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import {
  ANTIGRAVITY_RELAY_INSTALL_BASENAME,
  ANTIGRAVITY_RELAY_INSTALL_DIRNAME,
  getAntigravityRelayInstallPath,
} from '@/lib/hooks/sources/antigravity/relay-install';
import { writeAntigravityHooksConfig } from '@/lib/hooks/sources/antigravity/hooks-config';

const RELAY_A = '#!/bin/sh\n# the relay checkout A ships\nexit 0\n';
const RELAY_B = '#!/bin/sh\n# the relay checkout B ships\nexit 0\n';

const dirs: string[] = [];
let originalCwd: string;
let root: string;
let configPath: string;

/** A checkout that ships a relay at `scripts/hooks/cmate-agent-event.sh`. */
function makeCheckout(prefix: string, body: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  mkdirSync(join(dir, 'scripts', 'hooks'), { recursive: true });
  const shipped = join(dir, 'scripts', 'hooks', ANTIGRAVITY_RELAY_INSTALL_BASENAME);
  writeFileSync(shipped, body);
  chmodSync(shipped, 0o755);
  return dir;
}

/** A directory that is a plausible cwd but ships no relay at all. */
function makeEmptyCheckout(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function hookCommands(config: Record<string, unknown>): string[] {
  const commands: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'command' && typeof child === 'string') commands.push(child);
        else walk(child);
      }
    }
  };
  walk(config);
  return commands;
}

beforeEach(() => {
  originalCwd = process.cwd();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cmate-4505-relay-')));
  dirs.push(root);
  configPath = join(root, 'home', '.gemini', 'config', 'hooks.json');
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '1');
  vi.stubEnv('CM_UAT_ISOLATION', 'off');
  mockLogger.warn.mockClear();
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) removeTempDir(dir);
  }
});

describe('the relay hooks.json names', () => {
  it('is a copy beside hooks.json, and stays one when another checkout writes next', () => {
    const checkoutA = makeCheckout('cmate-4505-checkout-a-', RELAY_A);
    process.chdir(checkoutA);

    expect(writeAntigravityHooksConfig({ path: configPath })).toBe(configPath);

    const installed = join(
      dirname(configPath),
      ANTIGRAVITY_RELAY_INSTALL_DIRNAME,
      ANTIGRAVITY_RELAY_INSTALL_BASENAME
    );
    expect(installed).toBe(getAntigravityRelayInstallPath(configPath));
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, 'utf8')).toBe(RELAY_A);
    // Executable, because agy runs it as a command hook.
    expect(statSync(installed).mode & 0o111).not.toBe(0);

    const first = readFileSync(configPath, 'utf8');
    expect(first).toContain(installed);
    expect(first).not.toContain(checkoutA);

    // A second server, in a different checkout, rewrites the same shared file.
    const checkoutB = makeCheckout('cmate-4505-checkout-b-', RELAY_B);
    process.chdir(checkoutB);
    expect(writeAntigravityHooksConfig({ path: configPath })).toBe(configPath);

    // Only the copy's bytes move; the file that names it does not.
    expect(readFileSync(installed, 'utf8')).toBe(RELAY_B);
    expect(readFileSync(configPath, 'utf8')).toBe(first);

    // The checkout that wrote first disappears; the shared file is unaffected.
    removeTempDir(checkoutA);
    expect(existsSync(installed)).toBe(true);

    const commands = hookCommands(JSON.parse(readFileSync(configPath, 'utf8')));
    // `PreToolUse` is the inline adjudication command by design and names no
    // relay (#1779); the three observation events do.
    const relayCommands = commands.filter((command) =>
      command.includes(ANTIGRAVITY_RELAY_INSTALL_BASENAME)
    );
    expect(relayCommands).toHaveLength(3);
    for (const command of relayCommands) {
      expect(command).toContain(installed);
    }
    for (const command of commands) {
      expect(command).not.toContain(checkoutA);
      expect(command).not.toContain(checkoutB);
    }
  });

  it('does not rewrite the copy when its bytes already match', () => {
    const checkoutA = makeCheckout('cmate-4505-idempotent-', RELAY_A);
    process.chdir(checkoutA);
    writeAntigravityHooksConfig({ path: configPath });

    const installed = getAntigravityRelayInstallPath(configPath);
    const inode = statSync(installed).ino;

    expect(writeAntigravityHooksConfig({ path: configPath })).toBe(configPath);
    expect(statSync(installed).ino).toBe(inode);
  });

  it('uses the copy that is already there when this build cannot find its own', () => {
    const checkoutA = makeCheckout('cmate-4505-shipped-', RELAY_A);
    process.chdir(checkoutA);
    writeAntigravityHooksConfig({ path: configPath });
    const written = readFileSync(configPath, 'utf8');
    const installed = getAntigravityRelayInstallPath(configPath);
    const inode = statSync(installed).ino;

    // A global install whose cwd is the user's shell directory: no relay.
    process.chdir(makeEmptyCheckout('cmate-4505-global-install-'));

    expect(writeAntigravityHooksConfig({ path: configPath })).toBe(configPath);
    expect(readFileSync(configPath, 'utf8')).toBe(written);
    expect(statSync(installed).ino).toBe(inode);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('writes nothing when there is neither a shipped relay nor a copy', () => {
    process.chdir(makeEmptyCheckout('cmate-4505-no-relay-'));

    expect(writeAntigravityHooksConfig({ path: configPath })).toBeNull();

    expect(existsSync(configPath)).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith('antigravity-hook-relay-missing');
  });
});

describe('the read-only UAT policy', () => {
  it('copies nothing and writes nothing', () => {
    process.chdir(makeCheckout('cmate-4505-readonly-', RELAY_A));
    vi.stubEnv('CM_UAT_ISOLATION', '1');

    expect(writeAntigravityHooksConfig({ path: configPath })).toBeNull();

    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(join(dirname(configPath), ANTIGRAVITY_RELAY_INSTALL_DIRNAME))).toBe(false);
  });

  it('reuses a matching file without touching it or the copy', () => {
    process.chdir(makeCheckout('cmate-4505-readonly-reuse-', RELAY_A));
    writeAntigravityHooksConfig({ path: configPath });
    const written = readFileSync(configPath);
    const installed = getAntigravityRelayInstallPath(configPath);
    const inode = statSync(installed).ino;

    vi.stubEnv('CM_UAT_ISOLATION', '1');

    expect(writeAntigravityHooksConfig({ path: configPath })).toBe(configPath);
    expect(readFileSync(configPath).equals(written)).toBe(true);
    expect(statSync(installed).ino).toBe(inode);
  });
});
