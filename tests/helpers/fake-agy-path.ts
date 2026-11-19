/**
 * A private `PATH` holding fake `agy` / `claude` / `codex` that record every call
 * (Issue #4452).
 *
 * Each fake is a `/bin/sh` script that appends `"<name> <argv>"` to a calls log and
 * prints a version banner. `PATH` is set to the fake directory alone and `HOME` to a
 * private directory, so the real agy cannot be resolved and `~/.gemini` is never
 * read (I4). `CM_ANTIGRAVITY_USAGE` is unset; `restore()` puts all three back and
 * removes the sandbox.
 *
 * Issue #4480: `extraBinaries` adds more fakes beside the three (e.g. a `tmux`
 * that answers `list-sessions`), each recording its calls in the same log and
 * then running the given `/bin/sh` body.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export const FAKE_CLI_BANNERS: Readonly<Record<string, string>> = {
  agy: '1.1.18',
  claude: '2.1.0 (Claude Code)',
  codex: 'codex-cli 0.100.0',
};

const SAVED_KEYS = ['PATH', 'HOME', 'CM_ANTIGRAVITY_USAGE'] as const;

export interface FakeAgyPath {
  /** Sandbox root (under `os.tmpdir()`). */
  readonly root: string;
  /** Every recorded call of one fake binary, as `"<name> <argv>"` lines. */
  callsOf(name: string): string[];
  /** Restore `PATH` / `HOME` / `CM_ANTIGRAVITY_USAGE` and remove the sandbox. */
  restore(): void;
}

/** Options of {@link installFakeAgyPath}. */
export interface FakeAgyPathOptions {
  /** More fake binaries: name → `/bin/sh` body run after the call is recorded. */
  extraBinaries?: Readonly<Record<string, string>>;
}

export function installFakeAgyPath(options: FakeAgyPathOptions = {}): FakeAgyPath {
  const saved: Record<string, string | undefined> = {};
  for (const key of SAVED_KEYS) saved[key] = process.env[key];

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4452-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  const logPath = path.join(root, 'calls.log');
  for (const [name, banner] of Object.entries(FAKE_CLI_BANNERS)) {
    fs.writeFileSync(
      path.join(bin, name),
      `#!/bin/sh\necho "${name} $*" >> '${logPath}'\necho '${banner}'\n`,
      { mode: 0o755 }
    );
  }
  for (const [name, body] of Object.entries(options.extraBinaries ?? {})) {
    fs.writeFileSync(
      path.join(bin, name),
      `#!/bin/sh\necho "${name} $*" >> '${logPath}'\n${body}\n`,
      { mode: 0o755 }
    );
  }

  process.env.PATH = bin;
  process.env.HOME = home;
  delete process.env.CM_ANTIGRAVITY_USAGE;

  return {
    root,
    callsOf(name: string): string[] {
      if (!fs.existsSync(logPath)) return [];
      return fs
        .readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line) => line.split(' ')[0] === name);
    },
    restore(): void {
      for (const key of SAVED_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Let background probes started by a snapshot finish (child processes included). */
export async function settleBackgroundProbes(ms = 400): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
