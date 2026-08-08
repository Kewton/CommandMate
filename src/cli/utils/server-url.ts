/**
 * Server URL Resolution
 * Issue #1266: single source of truth for "which URL is the server actually on"
 *
 * dotenv never overwrites a variable the shell already exported, but daemon.ts hands the
 * child `{...process.env, ...parsed}`, so .env wins for the process that actually serves.
 * Resolving a URL from `process.env` alone therefore reports the shell's CM_PORT instead of
 * the port the server listens on. Everything that reports a URL must use these helpers.
 */

import { config as dotenvConfig } from 'dotenv';
import { getEnvPath } from './env-setup';

/**
 * An environment to resolve from. Deliberately looser than NodeJS.ProcessEnv, which Next.js
 * augments with a required NODE_ENV that has nothing to do with resolving a server URL.
 */
export type ServerEnv = Readonly<Record<string, string | undefined>>;

/** The address a running server is reachable at */
export interface ServerEndpoint {
  /** Resolved CM_PORT */
  port: number;
  /** Resolved CM_BIND, as configured (not rewritten for dialing) */
  bind: string;
  protocol: 'http' | 'https';
  /** Dialable URL; a 0.0.0.0 bind is reported as 127.0.0.1 */
  url: string;
}

/**
 * Resolve the endpoint a server started with `env` is reachable at.
 *
 * @param env - The effective environment, built with loadEffectiveEnv()
 */
export function resolveServerEndpoint(env: ServerEnv): ServerEndpoint {
  const port = parseInt(env.CM_PORT || '3000', 10);
  const bind = env.CM_BIND || '127.0.0.1';
  // server.ts:160 upgrades to HTTPS only when both cert and key are present
  const protocol = env.CM_HTTPS_CERT && env.CM_HTTPS_KEY ? 'https' : 'http';
  const host = bind === '0.0.0.0' ? '127.0.0.1' : bind;

  return { port, bind, protocol, url: `${protocol}://${host}:${port}` };
}

/**
 * Build the environment the server process actually runs with, giving .env precedence over
 * exported variables exactly as daemon.start() does when it spawns the child.
 *
 * @param envPath - A worktree .env layered over the main one; omit for the main server
 */
export function loadEffectiveEnv(envPath?: string): NodeJS.ProcessEnv {
  const mainEnvPath = getEnvPath();
  const mainParsed = dotenvConfig({ path: mainEnvPath }).parsed || {};

  // A worktree .env is optional: when absent, parsed is undefined and the main values stand
  const ownParsed =
    envPath === undefined || envPath === mainEnvPath
      ? {}
      : dotenvConfig({ path: envPath }).parsed || {};

  return { ...process.env, ...mainParsed, ...ownParsed };
}

/**
 * Build the environment a *client* resolves its connection target from (Issue #1743).
 *
 * The layering is deliberately the mirror image of loadEffectiveEnv(), because the two
 * answer different questions:
 *
 * - loadEffectiveEnv() answers "where is the server?". It reproduces what daemon.start()
 *   hands the child (`{...process.env, ...parsed}`), so the .env the server actually booted
 *   with outranks whatever this shell happens to export. That is what `status` reports.
 * - loadClientEnv() answers "where should this invocation dial?". An exported CM_PORT is the
 *   caller naming a target for this one command (`CM_PORT=3011 commandmate ls`, documented in
 *   docs/user-guide/cli-operations-guide.md), so it has to outrank a file default. That is
 *   the standard dotenv precedence, and reusing loadEffectiveEnv() here would silently break
 *   that documented usage.
 *
 * What Issue #1743 required of both is that they consult ~/.commandmate/.env at all: ApiClient
 * resolved from `process.env` alone, so with two servers running, every subcommand built on it
 * (ls / send / wait / capture / …) dialled the default port 3000 while `status` correctly
 * reported the .env port.
 *
 * Resolution order: `process.env` > `~/.commandmate/.env` > resolveServerEndpoint() defaults.
 */
export function loadClientEnv(): ServerEnv {
  // quiet: dotenv's "injecting env" banner is written to stdout, where it would corrupt
  //   machine-readable output such as `commandmate ls --json`.
  // processEnv: this is a read-only lookup. Left to its default, dotenv would populate
  //   process.env with every key the file defines, turning file values into "exported"
  //   ones for the rest of the process — the precedence this function exists to avoid.
  const parsed = dotenvConfig({ path: getEnvPath(), processEnv: {}, quiet: true }).parsed ?? {};

  // process.env last: an explicitly exported variable wins over the file (see above)
  return { ...parsed, ...process.env };
}
