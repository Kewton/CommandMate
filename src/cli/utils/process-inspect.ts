/**
 * Best-effort process inspection for stop/start (Issue #3087)
 *
 * - Zombies: `kill(pid, 0)` succeeds for a zombie, so without an init process
 *   (a container whose PID 1 never reaps) a stopped server's group looked alive
 *   forever. On Linux, /proc tells a zombie apart; elsewhere nothing is known
 *   and callers keep their signal-based answer.
 * - Listeners: when something answers on the configured port but is not the
 *   server the PID file describes, the user is told which PID holds it.
 *
 * Every function here is read-only and never throws.
 *
 * @module process-inspect
 */

import { execFileSync } from 'child_process';
import { readdirSync, readFileSync, readlinkSync } from 'fs';

/** Process states that are no longer running code: zombie and dead. */
const EXITED_STATES = new Set(['Z', 'X', 'x']);

interface ProcStat {
  state: string;
  pgrp: number;
}

/**
 * Parse `/proc/<pid>/stat`. The command name is parenthesised and may itself
 * contain spaces or parentheses, so fields are read after the LAST `)`.
 */
export function parseProcStat(content: string): ProcStat | null {
  const end = content.lastIndexOf(')');
  if (end === -1) return null;
  const fields = content.slice(end + 1).trim().split(/\s+/);
  // fields[0] = state, fields[1] = ppid, fields[2] = pgrp
  const pgrp = parseInt(fields[2] ?? '', 10);
  if (!fields[0] || Number.isNaN(pgrp)) return null;
  return { state: fields[0], pgrp };
}

function readProcStat(pid: number): ProcStat | null {
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * @returns true when /proc reports the process as a zombie (or dead); false when it is
 *   running, absent, or the platform has no /proc
 */
export function isZombieProcess(pid: number): boolean {
  if (process.platform !== 'linux') return false;
  const stat = readProcStat(pid);
  return stat !== null && EXITED_STATES.has(stat.state);
}

/**
 * States of every process whose process group is `pgid`.
 *
 * @returns the state letters (possibly empty), or null when /proc cannot be read
 *   (non-Linux), in which case nothing is known
 */
export function listProcessGroupStates(pgid: number): string[] | null {
  if (process.platform !== 'linux') return null;
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return null;
  }
  if (!Array.isArray(entries)) return null;

  const states: string[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = readProcStat(parseInt(entry, 10));
    if (stat !== null && stat.pgrp === pgid) {
      states.push(stat.state);
    }
  }
  return states;
}

/** @returns true when a /proc state letter means the process no longer runs */
export function isExitedState(state: string): boolean {
  return EXITED_STATES.has(state);
}

/** Socket inodes listening on `port` per /proc/net/tcp{,6} (state 0A = LISTEN). */
function listeningInodes(port: number): Set<string> {
  const inodes = new Set<string>();
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let content: string;
    try {
      content = readFileSync(table, 'utf-8');
    } catch {
      continue;
    }
    for (const line of String(content).split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      // sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode
      if (fields.length < 10) continue;
      const localPort = fields[1].split(':')[1];
      if (localPort === hexPort && fields[3] === '0A') {
        inodes.add(fields[9]);
      }
    }
  }
  return inodes;
}

function findListeningPidsLinux(port: number): number[] {
  const inodes = listeningInodes(port);
  if (inodes.size === 0) return [];
  const pids: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue; // not ours to read, or gone
    }
    for (const fd of fds) {
      let target: string;
      try {
        target = readlinkSync(`/proc/${entry}/fd/${fd}`);
      } catch {
        continue;
      }
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match && inodes.has(match[1])) {
        pids.push(parseInt(entry, 10));
        break;
      }
    }
  }
  return pids;
}

function findListeningPidsLsof(port: number): number[] {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return [...new Set(String(out).split('\n').map((l) => parseInt(l, 10)).filter((n) => !Number.isNaN(n)))];
  } catch {
    return []; // lsof exits 1 when nothing matches, or is not installed
  }
}

/**
 * PIDs listening on a TCP port: /proc on Linux, `lsof` elsewhere.
 *
 * @returns the PIDs found; empty when none are visible (another user's process, or no tool)
 */
export function findListeningPids(port: number): number[] {
  return process.platform === 'linux' ? findListeningPidsLinux(port) : findListeningPidsLsof(port);
}

/**
 * One-line description of a process for an error message.
 *
 * @returns the command line, or null when it cannot be read
 */
export function describeProcess(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').filter(Boolean).join(' ');
      return cmdline || null;
    }
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * "PID 875 (node dist/server/server.js), PID 876" — or null when no PID is visible.
 */
export function describeListeners(port: number): string | null {
  const pids = findListeningPids(port);
  if (pids.length === 0) return null;
  return pids
    .map((pid) => {
      const command = describeProcess(pid);
      return command ? `PID ${pid} (${command.slice(0, 120)})` : `PID ${pid}`;
    })
    .join(', ');
}
