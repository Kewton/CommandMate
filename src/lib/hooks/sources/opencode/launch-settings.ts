/**
 * The opencode settings one instance is launched and prompted with (#2048).
 *
 * Issue #2048 adds three per-instance settings — persona, model and variant.
 * The database holds them (`opencode_instance_settings`, migration v59) because
 * they belong to a worktree and have to follow its renames and its deletion.
 * This module is the **launcher's copy** of the same values, and it exists for
 * the reason `../../../session/opencode-session-store` spells out for the resume
 * flag, applied to a second value:
 *
 *  1. **The reader is the launcher.** `prepareOpencodeLaunch` builds a command
 *     line synchronously, from an `AgentLaunchContext` that five other tools
 *     share and that has nowhere to hand settings through; and
 *     `src/lib/cli-tools/opencode.ts` is deliberately outside `better-sqlite3`'s
 *     import graph. Reading the row here would either pull that graph into the
 *     launcher or make the launch path `await` a dynamic import — measured, that
 *     second option is not free: the three launch tests in
 *     `tests/unit/cli-tools/opencode.test.ts` drive `startSession` under fake
 *     timers, and a dynamic import does not resolve on the timer queue, so the
 *     command line was never composed at all.
 *  2. **It is read on the send path too**, once per prompt, where an extra
 *     database round trip would sit in front of the operator's message.
 *
 * So: same shape as `./ports`, same `~/.commandmate` directory, same "never
 * throws, a bad file means none" contract. `GET`/`PUT
 * /api/worktrees/:id/instances/opencode` writes both — the row and this mirror —
 * and the `GET` reconciles the mirror from the row, so opening the settings pane
 * repairs a mirror that a worktree rename or a restored database left stale.
 * The database is the source of truth; this is a cache with a file behind it.
 *
 * ## What the settings may and may not do
 *
 * Measured on opencode 1.18.22 (`docs/design/opencode-server-live-verification.md`
 * §20): the TUI takes `--agent` and `-m provider/model` and has **no
 * `--variant`** — passing one makes opencode print its usage and exit, so the
 * pane would come up empty. {@link opencodeLaunchArguments} therefore never
 * emits a variant, and the variant travels on the prompt instead
 * ({@link opencodePromptSelection}), which is the one channel measured to apply
 * it.
 *
 * @module lib/hooks/sources/opencode/launch-settings
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { resolveSafeDirectory } from '@/config/safe-directory';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import { createLogger } from '@/lib/logger';
import { shellQuote } from '@/lib/hooks/hook-settings-generator';
import {
  EMPTY_OPENCODE_INSTANCE_SETTINGS,
  hasOpencodeInstanceSettings,
  normalizeOpencodeInstanceSettings,
  opencodeModelReference,
  type OpencodeInstanceSettings,
} from '@/types/opencode-instance-settings';
import type { AgentInstanceRef } from '../types';
import type { OpencodePromptSelection } from './client';

const logger = createLogger('lib/hooks/sources/opencode/launch-settings');

/**
 * compositeKey -> the settings this instance launches with.
 *
 * Through `globalThis` for the reason every shared map in this codebase is
 * (Issue #1736): under `next dev` each route is bundled separately, so a
 * module-scoped map would let the launcher and the settings API hold different
 * copies of a value the operator just changed.
 */
declare global {
  // eslint-disable-next-line no-var
  var __opencodeLaunchSettings: Map<string, OpencodeInstanceSettings> | undefined;
}

const cache = (globalThis.__opencodeLaunchSettings ??= new Map<
  string,
  OpencodeInstanceSettings
>());

function keyOf(target: AgentInstanceRef): string {
  return buildCompositeKey(target.worktreeId, target.cliToolId, target.instanceId);
}

/**
 * Where the mirror lives. `CM_OPENCODE_LAUNCH_SETTINGS_FILE` overrides.
 *
 * Guarded exactly as `getOpencodePortFilePath` is (Issue #1774): the write below
 * creates this file's directory with a recursive mkdir, and for a path inside
 * `/proc`, `/sys` or `/dev` that call does not throw — it spins the event loop
 * forever, so the `try/catch` around it never runs. `resolveSafeDirectory`
 * refuses such an override and hands back the default.
 */
export function getOpencodeLaunchSettingsFilePath(): string {
  const fallback = join(homedir(), '.commandmate', 'opencode-launch-settings.json');
  return resolveSafeDirectory(
    process.env.CM_OPENCODE_LAUNCH_SETTINGS_FILE,
    fallback,
    'CM_OPENCODE_LAUNCH_SETTINGS_FILE'
  );
}

/** Read the mirror. Never throws — a bad file means "nothing is configured". */
export function readPersistedOpencodeLaunchSettings(): Record<string, OpencodeInstanceSettings> {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(getOpencodeLaunchSettingsFilePath(), 'utf8')
    );
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, OpencodeInstanceSettings> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // Re-validated on the way out as well as in: this file is writable by
      // anything running as the user, and `agent` / `model` end up on a shell
      // command line.
      const settings = normalizeOpencodeInstanceSettings(value);
      if (hasOpencodeInstanceSettings(settings)) result[key] = settings;
    }
    return result;
  } catch {
    // Absent on a first run, unreadable if somebody edited it. Both mean the
    // same thing to a caller: nothing is configured.
    return {};
  }
}

/** Write the mirror back. Never throws — losing it costs one launch's flags. */
function writePersistedOpencodeLaunchSettings(
  all: Record<string, OpencodeInstanceSettings>
): void {
  const path = getOpencodeLaunchSettingsFilePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    logger.warn('opencode-launch-settings-write-failed', {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The settings this instance should launch with.
 *
 * **Synchronous, and that is the requirement** — {@link prepareOpencodeLaunch}
 * calls it while composing a command line. Memory first, then the file, then
 * all-unset, which is the state every instance is in until somebody opens the
 * settings pane.
 */
export function getOpencodeLaunchSettings(target: AgentInstanceRef): OpencodeInstanceSettings {
  const key = keyOf(target);
  const live = cache.get(key);
  if (live) return live;
  const persisted = readPersistedOpencodeLaunchSettings()[key];
  if (!persisted) return { ...EMPTY_OPENCODE_INSTANCE_SETTINGS };
  cache.set(key, persisted);
  return persisted;
}

/**
 * Record what this instance should launch with, in memory and on disk.
 *
 * An all-unset write **removes** the entry rather than storing four nulls: the
 * two are indistinguishable to every reader, and the removal keeps the file to
 * the instances somebody actually configured.
 *
 * @returns The normalised settings that were stored
 */
export function rememberOpencodeLaunchSettings(
  target: AgentInstanceRef,
  settings: OpencodeInstanceSettings | null | undefined
): OpencodeInstanceSettings {
  const key = keyOf(target);
  const normalized = normalizeOpencodeInstanceSettings(settings ?? {});
  const all = readPersistedOpencodeLaunchSettings();

  if (!hasOpencodeInstanceSettings(normalized)) {
    cache.delete(key);
    if (key in all) {
      delete all[key];
      writePersistedOpencodeLaunchSettings(all);
    }
    return normalized;
  }

  cache.set(key, normalized);
  all[key] = normalized;
  writePersistedOpencodeLaunchSettings(all);
  return normalized;
}

/** Drop one instance's settings from memory and disk. */
export function forgetOpencodeLaunchSettings(target: AgentInstanceRef): void {
  rememberOpencodeLaunchSettings(target, EMPTY_OPENCODE_INSTANCE_SETTINGS);
}

/** Drop every in-memory entry. Test seam; production only ever writes or forgets one. */
export function resetOpencodeLaunchSettings(): void {
  cache.clear();
}

/**
 * The flags these settings add to an opencode launch line, or `''`.
 *
 * **`--variant` is deliberately absent and must stay absent.** The TUI does not
 * declare it (`opencode --help`, 1.18.22): yargs answers an unknown option by
 * printing the usage banner and exiting, so a launch line carrying it starts no
 * agent at all — measured twice, once inside tmux and once directly (§20.3).
 * `opencode run --variant` does exist, which is exactly the trap: the flag is
 * real, on a different subcommand.
 *
 * Both values are shell-quoted even though {@link normalizeOpencodeInstanceSettings}
 * has already refused everything with a metacharacter in it. The quoting is the
 * second of two independent guards, and it is the cheaper one to keep.
 *
 * @param settings - The instance's settings; all-unset yields `''`
 * @returns A string starting with a space, or `''` when nothing is configured
 */
export function opencodeLaunchArguments(
  settings: OpencodeInstanceSettings | null | undefined
): string {
  const normalized = normalizeOpencodeInstanceSettings(settings ?? {});
  const parts: string[] = [];
  if (normalized.agent) parts.push(`--agent ${shellQuote(normalized.agent)}`);
  const model = opencodeModelReference(normalized);
  if (model) parts.push(`--model ${shellQuote(model)}`);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/**
 * The `prompt_async` keys these settings contribute, or null.
 *
 * Null — send nothing extra — when nothing is configured, so an unconfigured
 * instance's request body is byte-identical to the pre-#2048 one. That matters
 * more than it looks: a body with **no** `agent` runs the turn as `build` even
 * on a pane launched `--agent plan` (§20.5), so the choice between "omit" and
 * "send" is a behavioural one and the omission is only correct while the
 * operator has expressed no preference.
 *
 * The model is sent alongside the variant rather than left to the launch flag
 * because the two have to agree: a variant names an entry in one model's own
 * `variants` map, and sending `high` against whichever model the pane happens to
 * be on would be asserting something about a model the operator did not choose.
 */
export function opencodePromptSelection(
  settings: OpencodeInstanceSettings | null | undefined
): OpencodePromptSelection | null {
  const normalized = normalizeOpencodeInstanceSettings(settings ?? {});
  const selection: OpencodePromptSelection = {};
  if (normalized.agent) selection.agent = normalized.agent;
  if (normalized.providerId && normalized.modelId) {
    selection.model = { providerID: normalized.providerId, modelID: normalized.modelId };
  }
  if (normalized.variant) selection.variant = normalized.variant;
  return Object.keys(selection).length > 0 ? selection : null;
}
