/**
 * The per-instance server password of OpenCode V2 (Issue #2934, decision D3).
 *
 * `opencode2 serve` authenticates every request by default (Basic, user
 * `opencode`). Started without `OPENCODE_SERVER_PASSWORD` it invents a password
 * and PRINTS it on stdout, which in a tmux pane means onto the screen
 * CommandMate renders; started with the variable, it uses that value and prints
 * nothing (measured on 2.0.18, #2370 Phase 0 (a)). So CommandMate generates a
 * fresh value per launch and hands it over through a file:
 *
 *  - `~/.commandmate/opencode-v2/<composite key>.pw`, the file 0600 and the
 *    directory 0700, so only the same OS user can read it;
 *  - `scripts/opencode-v2/launch.sh` reads it and exports it to the serve and
 *    TUI processes as `OPENCODE_SERVER_PASSWORD` and nowhere else;
 *  - the SSE subscription (`./client`) reads it for its `Authorization` header.
 *
 * What is deliberately NOT a carrier: `AgentLaunchPlan.env` and `command` (the
 * line typed into the pane, readable by `ps` and echoed on the terminal — pinned
 * by `tests/unit/lib/agent-launch-plan-secrets-1933.test.ts`), the tmux screen,
 * and every log line this module and its callers write (they name the PATH at
 * most, never the value).
 *
 * Accepted, and written down so nobody has to rediscover it: the serve and TUI
 * processes hold the password in their environment, and so does every shell
 * tool the agent runs, because those inherit the TUI's environment. The server
 * listens on 127.0.0.1 only, so what the password guards never leaves the
 * machine, and anyone who can read another process's environment is already the
 * same OS user.
 *
 * The file is deleted by `killSession` and, at CommandMate startup, for every
 * instance whose tmux session is gone (`./reattach`).
 *
 * @module lib/hooks/sources/opencode-v2/secrets
 */

import { randomBytes } from 'crypto';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { resolveSafeDirectory } from '@/config/safe-directory';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { AgentInstanceRef } from '../types';

/** Environment variable that relocates the whole OpenCode V2 state directory. */
export const OPENCODE_V2_DIR_ENV = 'CM_OPENCODE_V2_DIR';

/** Bytes of entropy per password. D3 asks for at least 32. */
export const OPENCODE_V2_PASSWORD_BYTES = 32;

/** Suffix of a password file. */
export const OPENCODE_V2_PASSWORD_SUFFIX = '.pw';

/**
 * Where OpenCode V2's per-instance state (passwords, port assignments) lives.
 *
 * `~/.commandmate/opencode-v2`, or `$CM_OPENCODE_V2_DIR`. Resolved on every call
 * so a test that points `HOME` or the variable somewhere else is honoured.
 */
export function getOpencodeV2StateDir(): string {
  const fallback = join(homedir(), '.commandmate', 'opencode-v2');
  return resolveSafeDirectory(process.env[OPENCODE_V2_DIR_ENV], fallback, OPENCODE_V2_DIR_ENV);
}

/**
 * Create the state directory with owner-only access.
 *
 * `mkdirSync`'s `mode` is filtered by the umask and ignored for a directory that
 * already exists, so the permission is set explicitly afterwards.
 */
export function ensureOpencodeV2StateDir(): string {
  const dir = getOpencodeV2StateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** The composite key of an instance, as the rest of CommandMate spells it. */
export function opencodeV2KeyOf(target: AgentInstanceRef): string {
  return buildCompositeKey(target.worktreeId, target.cliToolId, target.instanceId);
}

/**
 * The file name a composite key is stored under.
 *
 * The key's `:` separators are kept (they are legal in a POSIX file name and the
 * file then reads as the key it belongs to); anything that could leave the
 * directory — a `/`, a `..` — is percent-encoded.
 */
export function opencodeV2FileStem(key: string): string {
  return encodeURIComponent(key).replace(/%3A/gi, ':').replace(/\./g, '%2E');
}

/** The inverse of {@link opencodeV2FileStem}, or null for a name it never wrote. */
export function opencodeV2KeyOfFileStem(stem: string): string | null {
  try {
    return decodeURIComponent(stem);
  } catch {
    return null;
  }
}

/** Absolute path of an instance's password file. */
export function getOpencodeV2PasswordFilePath(target: AgentInstanceRef): string {
  return join(
    getOpencodeV2StateDir(),
    `${opencodeV2FileStem(opencodeV2KeyOf(target))}${OPENCODE_V2_PASSWORD_SUFFIX}`
  );
}

/** A new password: {@link OPENCODE_V2_PASSWORD_BYTES} random bytes, URL-safe base64. */
export function generateOpencodeV2Password(): string {
  return randomBytes(OPENCODE_V2_PASSWORD_BYTES).toString('base64url');
}

/**
 * Generate a fresh password for one launch and write it to the instance's file.
 *
 * Always a new value: a relaunch must not reuse the previous server's password,
 * and an old file left behind by a crash is overwritten rather than trusted.
 *
 * @returns The file's path. The value itself is not returned on purpose — the
 *   launch path has no business holding it.
 */
export function writeOpencodeV2Password(target: AgentInstanceRef): string {
  ensureOpencodeV2StateDir();
  const path = getOpencodeV2PasswordFilePath(target);
  // Removed first so `mode` applies: `writeFileSync` only honours it when it
  // creates the file.
  rmSync(path, { force: true });
  writeFileSync(path, `${generateOpencodeV2Password()}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  return path;
}

/** The instance's password, or null when it has no (readable, non-empty) file. */
export function readOpencodeV2Password(target: AgentInstanceRef): string | null {
  try {
    const value = readFileSync(getOpencodeV2PasswordFilePath(target), 'utf8').split('\n')[0];
    return value !== undefined && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Delete the instance's password file. A missing file is not an error. */
export function removeOpencodeV2Password(target: AgentInstanceRef): void {
  rmSync(getOpencodeV2PasswordFilePath(target), { force: true });
}

/** Delete a password file by its composite key (the startup sweep's form). */
export function removeOpencodeV2PasswordByKey(key: string): void {
  rmSync(
    join(getOpencodeV2StateDir(), `${opencodeV2FileStem(key)}${OPENCODE_V2_PASSWORD_SUFFIX}`),
    { force: true }
  );
}

/** The composite keys that currently have a password file. */
export function listOpencodeV2PasswordKeys(): string[] {
  let names: string[];
  try {
    names = readdirSync(getOpencodeV2StateDir());
  } catch {
    return [];
  }
  const keys: string[] = [];
  for (const name of names) {
    if (!name.endsWith(OPENCODE_V2_PASSWORD_SUFFIX)) continue;
    const key = opencodeV2KeyOfFileStem(name.slice(0, -OPENCODE_V2_PASSWORD_SUFFIX.length));
    if (key !== null && key.length > 0) keys.push(key);
  }
  return keys;
}
