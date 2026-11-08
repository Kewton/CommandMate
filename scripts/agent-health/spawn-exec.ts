/**
 * An asynchronous `spawn` for sends under the Claude 3 reservation (Issue #4243):
 * unlike `spawnSync`, the child's pid is known while it runs, so the reservation
 * can record it (design docs/design/claude3-dispatch-exclusion-4243.md §3.5).
 */

import { spawn } from 'child_process';

export interface SpawnExecResult {
  status: number | null;
  stdout: string;
}

/** Runs a command without a shell; never rejects (a missing binary is status null). */
export type SpawnExec = (command: string, args: readonly string[], onChild?: (pid: number) => void) => Promise<SpawnExecResult>;

/** The child is killed after this, like `spawnSync`'s `timeout` in dispatch-main. */
export const SPAWN_TIMEOUT_MS = 300_000;

export const defaultSpawnExec: SpawnExec = (command, args, onChild) =>
  new Promise((resolve) => {
    let stdout = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve({ status: null, stdout: '' });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), SPAWN_TIMEOUT_MS);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    if (typeof child.pid === 'number') onChild?.(child.pid);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ status: null, stdout });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout });
    });
  });

/** A synchronous exec (a test stub) as a SpawnExec: no child pid is reported. */
export function spawnExecFromSync(exec: (command: string, args: readonly string[]) => SpawnExecResult): SpawnExec {
  return async (command, args) => exec(command, args);
}
