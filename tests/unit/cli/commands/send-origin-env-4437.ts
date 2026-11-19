/**
 * Issue #4437 (I10): the CLI puts who is sending (`origin` / `originEvidence`) on a
 * request that may reach a tool the policy restricts — antigravity, or no tool named
 * (the server picks the default). Tests that pin such a body exactly fix the caller
 * first, so the body does not depend on the shell vitest runs in: no tmux (so tmux is
 * never asked), no CommandMate session, no agent marker, no terminal. That caller is
 * `unknown` / `no-tty`, and {@link PINNED_ORIGIN} is what the body carries.
 */

import { afterEach, beforeEach } from 'vitest';

/** What the body carries for the pinned caller. */
export const PINNED_ORIGIN = { origin: 'unknown', originEvidence: 'no-tty' } as const;

/** The variables `send-origin.ts` reads. */
const ORIGIN_ENV = [
  'TMUX',
  'CLAUDECODE',
  'CM_RUN_ORIGIN',
  'CM_WORKTREE_ID',
  'CM_AGENT_WORKTREE_ID',
  'CM_INSTANCE_ID',
  'CM_AGENT_INSTANCE_ID',
  'CM_CLI_TOOL',
  'CM_AGENT_TOOL',
] as const;

/** Set stdin's `isTTY` (undefined: not a terminal). */
export function setStdinTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true, writable: true });
}

/** Pin the caller for every test of the file this is called in; each value is put back after. */
export function pinSendOriginEnv(): void {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const name of ORIGIN_ENV) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
    setStdinTTY(undefined);
  });
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    saved.clear();
    if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  });
}
