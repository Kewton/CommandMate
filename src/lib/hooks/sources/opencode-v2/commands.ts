/**
 * An OpenCode V2 instance's own commands and Skills, read off its server
 * (Issue #2944).
 *
 * v1's palette learns a project's `.opencode/commands/*.md` and its Skills from
 * `GET /command` (#2036). v2 has no such route; its server answers two:
 *
 *  - `GET /api/command` → `{location, data: [{name, description?}]}`
 *  - `GET /api/skill`   → `{location, data: [{id, name, description?, path, content, autoinvoke?}]}`
 *
 * both behind the instance's Basic auth (`./client`). Measured on 2.0.18
 * (`tests/fixtures/opencode-v2-slash-2944`):
 *
 *  - `/api/command` carries `init`, `review` and the project's markdown
 *    commands (both `.opencode/commands/` and `.opencode/command/`), none of the
 *    TUI's own commands — those are attested from a palette reading;
 *  - `/api/skill` carries every discovered Skill plus two builtins (`opencode`,
 *    `report`, `path: /builtin/…`), each with its whole `content`. The content
 *    is dropped here: the palette needs a name and a line;
 *  - **the command scan is lazy.** The first `/api/command` right after
 *    `server listening` answered `data: []`; the same request a few seconds
 *    later answered all four. `init` and `review` are always registered, so an
 *    empty command list means "not loaded yet", and {@link OpencodeV2LiveFetch}
 *    says so with `complete: false` for the cache to retry.
 *
 * A Skill row is named by its `id` (the directory name), not its `name`: the
 * builtin `opencode` Skill is `name: "OpenCode"`, and `id` is what matches the
 * `/<name>` a user types for a planted Skill.
 *
 * Rows come back in v1's {@link OpencodeLiveCommand} shape so the same palette
 * converter and the same name allowlist apply. Everything here is fail-soft:
 * a dead port, a 401, a timeout, a body that is not the expected object — all
 * come back as `{ ok: false }`, never a throw.
 *
 * @module lib/hooks/sources/opencode-v2/commands
 */

import {
  parseOpencodeCommandDocument,
  isUsableOpencodePort,
  type OpencodeLiveCommand,
} from '@/lib/slash-command-reconcile/providers/opencode';
import { isPlainObject } from '../event-mapper';
import { opencodeV2AuthorizationHeader, opencodeV2BaseUrl } from './client';

/** Per-request timeout. Short: this runs behind a palette open. */
export const OPENCODE_V2_COMMANDS_TIMEOUT_MS = 2_000;

/**
 * Largest body accepted from either route, in characters.
 *
 * `/api/skill` carries each Skill's whole `SKILL.md`; the two builtins alone are
 * ~12 KB each, and the rest grows with whatever the operator has installed.
 */
export const MAX_OPENCODE_V2_COMMANDS_BODY_CHARS = 4 * 1024 * 1024;

/** The two routes, relative to the server's base URL. */
export const OPENCODE_V2_COMMAND_PATH = '/api/command';
export const OPENCODE_V2_SKILL_PATH = '/api/skill';

/** What one read of an instance's server produced. */
export type OpencodeV2LiveFetch =
  | { ok: true; commands: OpencodeLiveCommand[]; complete: boolean }
  | { ok: false; warning: string };

export interface FetchOpencodeV2CommandsOptions {
  /** Loopback port of the instance's server. */
  port: number;
  /** The instance's server password. Goes into a header and nowhere else. */
  password: string;
  /** The worktree, sent as `location[directory]` so the project is unambiguous. */
  directory?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** The `data` array of a `{location, data}` document, or null for any other shape. */
export function readOpencodeV2DataArray(body: unknown): unknown[] | null {
  return isPlainObject(body) && Array.isArray(body.data) ? body.data : null;
}

/**
 * Turn the two documents into palette rows: commands first, then Skills.
 *
 * Pure and total. A command and a Skill sharing a name keep the command (the
 * first occurrence wins in {@link parseOpencodeCommandDocument}), which is also
 * what the TUI runs for `/<name>`.
 */
export function parseOpencodeV2Documents(
  commandData: readonly unknown[],
  skillData: readonly unknown[]
): OpencodeLiveCommand[] {
  const rows: Record<string, unknown>[] = [];
  for (const raw of commandData) {
    if (!isPlainObject(raw)) continue;
    rows.push({ name: raw.name, description: raw.description, source: 'command' });
  }
  for (const raw of skillData) {
    if (!isPlainObject(raw)) continue;
    rows.push({ name: raw.id, description: raw.description, source: 'skill' });
  }
  return parseOpencodeCommandDocument(rows);
}

async function getDocument(
  path: string,
  options: FetchOpencodeV2CommandsOptions
): Promise<{ ok: true; data: unknown[] } | { ok: false; warning: string }> {
  const query = new URLSearchParams();
  if (options.directory) query.set('location[directory]', options.directory);
  const qs = query.toString();
  const suffix = qs.length > 0 ? `?${qs}` : '';
  // The URL names the port and the route only; it never carries the password.
  const label = `${opencodeV2BaseUrl(options.port)}${path}`;
  try {
    const response = await (options.fetchImpl ?? fetch)(`${label}${suffix}`, {
      headers: {
        Accept: 'application/json',
        Authorization: opencodeV2AuthorizationHeader(options.password),
      },
      // Something that redirects is not the instance's server.
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? OPENCODE_V2_COMMANDS_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, warning: `http ${response.status} for ${label}` };
    }
    const contentType = response.headers?.get?.('content-type');
    if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, warning: `unexpected content-type for ${label}: ${String(contentType)}` };
    }
    const text = await response.text();
    if (text.length > MAX_OPENCODE_V2_COMMANDS_BODY_CHARS) {
      return { ok: false, warning: `${label} answered more than ${MAX_OPENCODE_V2_COMMANDS_BODY_CHARS} chars` };
    }
    const data = readOpencodeV2DataArray(JSON.parse(text) as unknown);
    if (data === null) return { ok: false, warning: `${label} did not answer {location, data}` };
    return { ok: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, warning: `fetch failed for ${label}: ${message}` };
  }
}

/**
 * Read `GET /api/command` and `GET /api/skill` off an instance's server.
 *
 * Both must answer for the read to count: a server that answers one and not
 * the other is not one this cache should trust. Never throws.
 */
export async function fetchOpencodeV2LiveCommands(
  options: FetchOpencodeV2CommandsOptions
): Promise<OpencodeV2LiveFetch> {
  if (!isUsableOpencodePort(options.port)) {
    return { ok: false, warning: `invalid opencode-v2 port: ${String(options.port)}` };
  }
  const [commands, skills] = await Promise.all([
    getDocument(OPENCODE_V2_COMMAND_PATH, options),
    getDocument(OPENCODE_V2_SKILL_PATH, options),
  ]);
  if (!commands.ok) return commands;
  if (!skills.ok) return skills;
  return {
    ok: true,
    commands: parseOpencodeV2Documents(commands.data, skills.data),
    complete: commands.data.length > 0,
  };
}
