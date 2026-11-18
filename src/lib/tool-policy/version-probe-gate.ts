/**
 * Which tools' `--version` may be run without the user aiming at them (Issue #4452).
 *
 * Running `agy --version` starts the Antigravity binary. Under the 2026-11-16 decision
 * (Antigravity terms §6, consumer plans) CommandMate does not start agy on a path the
 * user did not aim at antigravity: server start, health, the agents version list
 * (`GET /api/agents/versions`, `GET /api/asks/capabilities`), the slash-command
 * catalog's staleness probe. antigravity's version is read only when
 *
 *  - the user declared an API-key or enterprise plan (`CM_ANTIGRAVITY_USAGE`), or
 *  - antigravity was used in this server process (a launch or a send).
 *
 * Every other tool is always allowed: their probes are unchanged.
 *
 * The "used" mark lives on `globalThis`, because Next.js route bundles and the custom
 * server can load this module more than once; one process must have one answer.
 *
 * @module lib/tool-policy/version-probe-gate
 */

import { readUsageDeclaration } from './declaration';

/** Tool id whose version probe is gated. */
const GATED_TOOL = 'antigravity';

const USED_KEY = Symbol.for('commandmate.issue4452.antigravityUsed');

type UseHolder = { [USED_KEY]?: boolean };

/** Whether antigravity was launched or sent to in this process. */
export function hasAntigravityBeenUsed(): boolean {
  return (globalThis as UseHolder)[USED_KEY] === true;
}

/** Record that the user used antigravity (a launch or a send) in this process. */
export function noteAntigravityUse(): void {
  (globalThis as UseHolder)[USED_KEY] = true;
}

/** Forget the use mark. Test-only. */
export function resetAntigravityUseForTest(): void {
  delete (globalThis as UseHolder)[USED_KEY];
}

/**
 * Whether `tool`'s installed version may be probed now. Only antigravity is gated: it
 * is allowed with the usage declaration or after a use in this process.
 */
export function mayProbeToolVersion(
  tool: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (tool !== GATED_TOOL) return true;
  if (readUsageDeclaration(env) !== 'personal') return true;
  return hasAntigravityBeenUsed();
}
