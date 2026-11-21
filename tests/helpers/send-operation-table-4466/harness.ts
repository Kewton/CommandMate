/**
 * Issue #4466 PR0: the driving side of the table — the new route's loader, the CLI run
 * with its exit / stderr / stdout, and a free port. No server is started: the routes are
 * called in-process, and the port only fills `CM_PORT` (no fixed number, other lanes run
 * their tests on the same machine).
 */

import fs from 'fs';
import net from 'net';
import path from 'path';
import { vi } from 'vitest';
import type { Command } from 'commander';
import type { NextRequest } from 'next/server';

export type RouteHandler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** Where PR1b puts the new route (design §4.1). */
export const SEND_OPERATION_ROUTE_FILE = path.resolve(
  process.cwd(),
  'src/app/api/worktrees/[id]/send-operation/route.ts'
);

/** The message of the (i) rows' failure until PR1b: the route is not there. */
export const SEND_OPERATION_ROUTE_MISSING = '#4466 PR1b: POST /api/worktrees/:id/send-operation does not exist yet';

/**
 * The new route's handlers. Throws {@link SEND_OPERATION_ROUTE_MISSING} until PR1b adds
 * the file — the reason every (i) row is `it.fails` in PR0. Loaded by path at run time, so
 * this file typechecks without it.
 */
export async function loadSendOperationRoute(): Promise<{ POST: RouteHandler }> {
  if (!fs.existsSync(SEND_OPERATION_ROUTE_FILE)) throw new Error(SEND_OPERATION_ROUTE_MISSING);
  const loaded = (await import(/* @vite-ignore */ SEND_OPERATION_ROUTE_FILE)) as { POST?: RouteHandler };
  if (typeof loaded.POST !== 'function') throw new Error(`${SEND_OPERATION_ROUTE_FILE} has no POST`);
  return { POST: loaded.POST };
}

/**
 * The new route for the CLI's dispatch, or null while it does not exist (the dispatch then
 * answers 404, as a server without the route would).
 */
export async function loadSendOperationRouteIfPresent(): Promise<{ POST: RouteHandler } | null> {
  return fs.existsSync(SEND_OPERATION_ROUTE_FILE) ? loadSendOperationRoute() : null;
}

export interface CliResult {
  code: number;
  stderr: string[];
  stdout: string[];
}

class ExitSignal extends Error {}

/**
 * A line of the server's logger (`src/lib/logger.ts`). The routes run in this process, so
 * their log reaches the same console; a real CLI's stdout / stderr never holds it.
 */
const SERVER_LOG_LINE = /^\[\d{4}-\d{2}-\d{2}T[^\]]*\] \[(DEBUG|INFO|WARN|ERROR)\] /;
const keep = (lines: string[]) => (line: unknown): void => {
  const text = String(line);
  if (!SERVER_LOG_LINE.test(text)) lines.push(text);
};

/** Run a CLI command as `commandmate <args>`: exit, stderr and stdout lines (console and process.stdout). */
export async function runCli(command: Command, args: readonly string[]): Promise<CliResult> {
  const stderr: string[] = [];
  const stdout: string[] = [];
  const exits: number[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation(keep(stdout));
  const warn = vi.spyOn(console, 'warn').mockImplementation(keep(stderr));
  const error = vi.spyOn(console, 'error').mockImplementation(keep(stderr));
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    keep(stdout)(chunk);
    return true;
  }) as never);
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0);
    throw new ExitSignal(String(code));
  }) as never);
  try {
    await command.parseAsync(['node', 'cli', ...args]);
  } catch (signal) {
    if (!(signal instanceof ExitSignal)) throw signal;
  } finally {
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
    write.mockRestore();
    exit.mockRestore();
  }
  return { code: exits[0] ?? 0, stderr, stdout };
}

/** A port nobody listens on now (bound to 0 and closed). */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
