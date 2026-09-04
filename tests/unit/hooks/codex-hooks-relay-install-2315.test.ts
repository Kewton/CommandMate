/**
 * Issue #2315 (R1): `$CODEX_HOME/hooks.json` no longer names a checkout, so
 * several servers on one machine stop eating each other's hook trust.
 *
 * ## The measurement this file is written against
 *
 * codex keys hook trust by the hash of the handler and records it in the
 * operator's own `~/.codex/config.toml`. `hooks.json` is ONE file for the whole
 * machine, so it has to be byte-identical whoever wrote it — and it was not.
 * `buildCodexEventHookCommand` named `resolveRelayScriptPath()`, which resolves
 * against `process.cwd()`. Taken on the reporting machine on 2026-09-04, with 22
 * worktrees registered and several dev servers running:
 *
 * ```
 * $ grep -o "'[^']*cmate-agent-event.sh'" ~/.codex/hooks.json
 * '/Users/…/MyCodeBranchDesk/scripts/hooks/cmate-agent-event.sh'
 * $ pwd    # a worktree server, whose next launch rewrites that line
 * /Users/…/commandmate-issue-2315
 * ```
 *
 * Every rewrite invalidated the hash the human had trusted, and the next codex
 * opened on `Trust  Modified since last trusted - review required`. That is the
 * "度々" of the Issue, and no amount of robustness in the launch handler removes
 * it — the file has to stop moving.
 *
 * So the tests below drive the generator from two DIFFERENT working directories,
 * which is the shape of the bug rather than a proxy for it.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, mkdtempSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import {
  buildCodexEventHookCommand,
  getCodexHooksPath,
  resolveCodexRelayCommandPath,
  writeCodexHookSettings,
} from '@/lib/hooks/sources/codex/hooks-config';
import {
  CODEX_RELAY_INSTALL_BASENAME,
  CODEX_RELAY_INSTALL_DIRNAME,
  getCodexRelayInstallPath,
  getInstalledCodexRelayPath,
  installCodexRelayScript,
} from '@/lib/hooks/sources/codex/relay-install';

const MANAGED_ENV = ['CODEX_HOME', 'CM_AGENT_HOOKS_INJECT', 'CM_PORT', 'MCBD_PORT'] as const;

let home: string;
let checkoutA: string;
let checkoutB: string;
let saved: Record<string, string | undefined>;
let originalCwd: string;

/** A fake checkout: a directory holding its own copy of the shipped relay. */
function makeCheckout(label: string, body: string): string {
  const root = mkdtempSync(join(tmpdir(), `codex-checkout-${label}-`));
  const dir = join(root, 'scripts', 'hooks');
  mkdirSync(dir, { recursive: true });
  const script = join(dir, CODEX_RELAY_INSTALL_BASENAME);
  writeFileSync(script, body);
  chmodSync(script, 0o755);
  return root;
}

beforeEach(() => {
  originalCwd = process.cwd();
  saved = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
  for (const key of MANAGED_ENV) delete process.env[key];
  home = mkdtempSync(join(tmpdir(), 'codex-relay-home-'));
  process.env.CODEX_HOME = home;
  checkoutA = makeCheckout('a', '#!/bin/sh\n# checkout A\nexit 0\n');
  // Deliberately DIFFERENT bytes: two servers on two versions of the script
  // must still agree on one `hooks.json`, because codex trusts the command
  // string and cannot see what that string executes.
  checkoutB = makeCheckout('b', '#!/bin/sh\n# checkout B, a later version\nexit 0\n');
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const key of MANAGED_ENV) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  removeTempDir(home);
  removeTempDir(checkoutA);
  removeTempDir(checkoutB);
});

describe('installing the relay under $CODEX_HOME', () => {
  it('copies the shipped script to a path derived from $CODEX_HOME alone', () => {
    const source = join(checkoutA, 'scripts', 'hooks', CODEX_RELAY_INSTALL_BASENAME);
    const installed = installCodexRelayScript(home, source);

    expect(installed).toBe(join(home, CODEX_RELAY_INSTALL_DIRNAME, CODEX_RELAY_INSTALL_BASENAME));
    expect(installed).toBe(getCodexRelayInstallPath(home));
    expect(readFileSync(installed!, 'utf8')).toBe(readFileSync(source, 'utf8'));
    // Executable, because codex runs it through a shell as a command.
    expect(statSync(installed!).mode & 0o100).toBe(0o100);
  });

  it('does not rewrite the copy when the bytes already match', () => {
    const source = join(checkoutA, 'scripts', 'hooks', CODEX_RELAY_INSTALL_BASENAME);
    const installed = installCodexRelayScript(home, source)!;
    const before = statSync(installed).mtimeMs;

    expect(installCodexRelayScript(home, source)).toBe(installed);
    expect(statSync(installed).mtimeMs).toBe(before);
  });

  it('keeps the copy that is there when this server cannot find its own', () => {
    // A global install whose `process.cwd()` is the user's shell directory has
    // no `scripts/hooks/` to copy from. Falling back to the inline `curl` shape
    // would give the shared file a THIRD form to drift between; using the copy
    // a previous server installed keeps it byte-identical.
    const source = join(checkoutA, 'scripts', 'hooks', CODEX_RELAY_INSTALL_BASENAME);
    const installed = installCodexRelayScript(home, source)!;

    expect(installCodexRelayScript(home, null)).toBe(installed);
    expect(readFileSync(installed, 'utf8')).toContain('checkout A');
  });

  it('answers null, rather than throwing, when there is nothing installed', () => {
    expect(getInstalledCodexRelayPath(home)).toBeNull();
    expect(installCodexRelayScript(home, null)).toBeNull();
    expect(installCodexRelayScript(home, join(checkoutA, 'no-such-script.sh'))).toBeNull();
  });

  it('does not fail a launch when the copy cannot be written', () => {
    // `$CODEX_HOME` pointing at a regular file makes the directory creation fail.
    const blocked = join(home, 'blocked');
    writeFileSync(blocked, 'not a directory');
    const source = join(checkoutA, 'scripts', 'hooks', CODEX_RELAY_INSTALL_BASENAME);

    expect(installCodexRelayScript(join(blocked, 'inner'), source)).toBeNull();
  });
});

describe('the generated hooks.json across two checkouts', () => {
  /** Write the file as a server whose `process.cwd()` is `checkout`. */
  function writeFrom(checkout: string): string {
    process.chdir(checkout);
    return readFileSync(writeCodexHookSettings()!, 'utf8');
  }

  it('is byte-identical from two different working directories', () => {
    // THE regression. Before this Issue these two strings differed by the
    // absolute path of the checkout, and that difference is what codex hashes.
    const fromA = writeFrom(checkoutA);
    const fromB = writeFrom(checkoutB);

    expect(fromB).toBe(fromA);
    expect(fromA).not.toContain(checkoutA);
    expect(fromA).not.toContain(checkoutB);
  });

  it('leaves the file untouched when the other checkout rewrites it', () => {
    // The write is skipped entirely, so the mtime — and with it any chance of
    // getting the bytes wrong — never moves. On the reporting machine this is
    // the difference between one review dialog and one per server restart.
    writeFrom(checkoutA);
    const path = getCodexHooksPath();
    const before = statSync(path).mtimeMs;

    writeFrom(checkoutB);

    expect(statSync(path).mtimeMs).toBe(before);
  });

  it('names the installed copy, and the copy tracks the newest server', () => {
    writeFrom(checkoutA);
    const installed = getCodexRelayInstallPath(home);
    expect(readFileSync(getCodexHooksPath(), 'utf8')).toContain(installed);
    expect(readFileSync(installed, 'utf8')).toContain('checkout A');

    // A second server, on a later version of the script, replaces the script…
    writeFrom(checkoutB);
    expect(readFileSync(installed, 'utf8')).toContain('checkout B');
    // …and still names the same path, which is the only thing codex hashes.
    expect(readFileSync(getCodexHooksPath(), 'utf8')).toContain(installed);
  });

  it('resolves the command path from $CODEX_HOME, not from the working directory', () => {
    process.chdir(checkoutA);
    expect(resolveCodexRelayCommandPath()).toBeNull();

    writeCodexHookSettings();
    expect(resolveCodexRelayCommandPath()).toBe(getCodexRelayInstallPath(home));

    // An explicit value is still honoured verbatim — that is how the suites
    // drive the relay and the inline-`curl` shapes.
    expect(resolveCodexRelayCommandPath({ relayScriptPath: null })).toBeNull();
    expect(resolveCodexRelayCommandPath({ relayScriptPath: '/x/y.sh' })).toBe('/x/y.sh');
  });

  it('keeps the correlation keys in the environment, path change notwithstanding', () => {
    writeFrom(checkoutA);
    const command = buildCodexEventHookCommand('session_start');

    expect(command).toContain(getCodexRelayInstallPath(home));
    expect(command).toContain('$CM_AGENT_WORKTREE_ID');
    expect(command).toContain('$CM_AGENT_INSTANCE_ID');
  });
});
