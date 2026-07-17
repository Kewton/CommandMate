/**
 * Process Inspector
 * Issue #1358: verify a PID still belongs to the daemon we started
 *
 * `process.kill(pid, 0)` only proves *some* process owns the PID. On a long-running machine
 * the OS reuses PIDs, so after the daemon crashes the same PID can belong to an unrelated
 * process. Recording the OS-reported start time at launch and comparing it later lets us tell
 * "our daemon is still running" from "the PID was reused".
 */

import { execFileSync } from 'child_process';

/**
 * A function that returns a stable identity signature for a PID, or null when it cannot be
 * determined. Injected into PidManager so tests can supply a deterministic reader.
 */
export type ProcessStartTimeReader = (pid: number) => string | null;

/**
 * Read a process's start time via `ps`, as an absolute wall-clock string.
 *
 * `-o lstart=` prints e.g. "Sat Jul 18 01:03:24 2026" and is stable across invocations (unlike
 * `etime`, which advances), so two reads of the same live process return the same value while a
 * reused PID returns a different one. Works on macOS and Linux; any failure (no `ps`, unknown
 * PID, permission) returns null so callers fall back to best-effort behaviour instead of erroring.
 *
 * @param pid - Process ID to inspect
 * @returns The start-time signature, or null when it cannot be read
 */
export function getProcessStartTime(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
