/**
 * Slash Command Catalog reconcile — opencode provider (Issue #2036)
 *
 * The source is `GET /command` on the opencode server the session already runs
 * (`#1758 §5.1.2`: every TUI listens on one), so an opencode enumeration stops
 * being "a human scrolled a palette" and becomes a document a machine can fetch
 * twice and diff.
 *
 * ## What `GET /command` actually enumerates — measured, not assumed
 *
 * Issue #2036 asked for the `/catalog-reconcile` opencode source to be
 * *replaced* by this endpoint. Measured on **opencode 1.18.22** (isolated HOME,
 * `docs/design/opencode-server-live-verification.md` §4 harness, 2026-08-25)
 * that replacement is only half possible, and the half that is not possible is
 * the half the catalog is made of:
 *
 * | palette row                                    | in `GET /command`? |
 * |------------------------------------------------|--------------------|
 * | `/init`, `/review`                              | **yes** (`source: "command"`) |
 * | `/agents` `/connect` `/debug` `/diff` `/editor` `/exit` `/help` `/mcps` `/models` `/move` `/new` `/sessions` `/skills` `/status` `/themes` `/variants` | **no** |
 *
 * The 16 rows the endpoint does not carry are TUI-client commands; they are
 * compiled into the terminal UI and the server has never heard of them. So
 * `GET /command` is authoritative for *what this project adds* — markdown
 * commands under `.opencode/commands/` and every discovered Skill — and says
 * nothing about the built-in set that 16 of the 18 attested names come from.
 * `slash-commands-attestations.json` therefore still records a palette reading
 * for those, and this provider covers the other two plus everything a project
 * contributes. The Issue text is left as-is on purpose; the measurement is the
 * record (see the same file's `$comment`).
 *
 * Two further measured properties shape the parser below:
 *
 *  - entries carry `source: "command" | "skill"`. A Skill is listed here, and it
 *    is **not** offered in the slash palette (typing its full name shows "No
 *    matching items") — the two axes Issue #2037 measures separately.
 *  - the server caches the scan at boot. Planting a command file and re-reading
 *    `GET /command` on the same process returns the old list; a restarted server
 *    returns the new one. Callers that want freshness restart or re-launch, they
 *    do not poll harder.
 *
 * ## Why the fetch is not `fetchAllowedText`
 *
 * That helper is HTTPS + public-host allowlist, which is right for the claude
 * docs page and the codex raw URL and wrong here: this source is a loopback
 * port on the operator's own machine. The host is therefore *hardcoded* to
 * 127.0.0.1 (never derived from an argument) and only the port number is
 * caller-supplied, which is the same SSRF posture `opencodeBaseUrl` takes in the
 * hooks client.
 */

import { sanitizeProviderCommands } from '../sanitize';
import type { ProviderCommand, ProviderResult } from '../types';

/** Catalog tool id this provider enumerates. */
export const OPENCODE_TOOL_ID = 'opencode';

/** Loopback host. Hardcoded, never derived from an argument (SSRF). */
export const OPENCODE_COMMAND_HOST = '127.0.0.1';

/** Path of the command registry document. */
export const OPENCODE_COMMAND_PATH = '/command';

/** Per-request timeout. Short: this sits behind a palette open. */
export const OPENCODE_COMMAND_TIMEOUT_MS = 2_000;

/**
 * Cap on entries read back from one document.
 *
 * The list grows with the operator's own `.opencode/commands` and every Skill
 * root opencode scans (six of them, measured), so it is not bounded by anything
 * CommandMate controls.
 */
export const MAX_OPENCODE_COMMANDS = 256;

/** Description length cap, matching the Skill loader's (Issue #343). */
export const MAX_OPENCODE_DESCRIPTION_LENGTH = 500;

/**
 * Accepted command name shape.
 *
 * Looser than `COMMAND_NAME_PATTERN` (which is lowercase-kebab, the shape every
 * *built-in* has) because these names come from directory and file names the
 * operator chose. Still narrow enough that a name can never be read as a path
 * segment or an i18n key separator: no `/`, no whitespace, no `..`.
 */
export const OPENCODE_LIVE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** What one row of `GET /command` says, after validation. */
export interface OpencodeLiveCommand {
  /** Command name without the leading '/'. */
  name: string;
  /** One-line description as the server reports it, or '' when absent. */
  description: string;
  /**
   * `'command'` for a markdown command (built-in or `.opencode/commands/*.md`),
   * `'skill'` for a discovered Agent Skill. Any other string the server invents
   * is carried through verbatim rather than coerced.
   */
  source: string;
  /** Argument placeholders the template declares (`['$ARGUMENTS']`), possibly empty. */
  hints: string[];
  /** The agent the command pins itself to, or null. */
  agent: string | null;
  /** Whether opencode runs the command as a subtask. */
  subtask: boolean;
}

/** ASCII control characters (C0 range plus DEL). */
// eslint-disable-next-line no-control-regex
const OPENCODE_CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `name` is a well-formed live command name. */
export function isValidOpencodeLiveName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    OPENCODE_LIVE_NAME_PATTERN.test(name) &&
    !name.includes('..')
  );
}

/** Collapse whitespace, strip control characters, cap length. */
function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const stripped = value.replace(OPENCODE_CONTROL_CHARS, ' ');
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_OPENCODE_DESCRIPTION_LENGTH
    ? collapsed.slice(0, MAX_OPENCODE_DESCRIPTION_LENGTH)
    : collapsed;
}

/**
 * Parse a `GET /command` body into validated rows.
 *
 * Pure and total: any shape at all comes back as a list (possibly empty). Rows
 * whose name fails the allowlist are dropped rather than coerced, and a repeated
 * name keeps its first occurrence — the same contract `sanitizeProviderCommands`
 * has, for the same reason (this document comes off a process CommandMate did
 * not start).
 */
export function parseOpencodeCommandDocument(body: unknown): OpencodeLiveCommand[] {
  if (!Array.isArray(body)) return [];

  const seen = new Set<string>();
  const commands: OpencodeLiveCommand[] = [];

  for (const raw of body) {
    if (commands.length >= MAX_OPENCODE_COMMANDS) break;
    if (!isPlainObject(raw)) continue;
    if (!isValidOpencodeLiveName(raw.name)) continue;
    if (seen.has(raw.name)) continue;
    seen.add(raw.name);

    const hints = Array.isArray(raw.hints)
      ? raw.hints.filter((hint): hint is string => typeof hint === 'string').map(cleanText)
      : [];

    commands.push({
      name: raw.name,
      description: cleanText(raw.description),
      source: typeof raw.source === 'string' ? cleanText(raw.source) : '',
      hints: hints.filter((hint) => hint.length > 0),
      agent: typeof raw.agent === 'string' && raw.agent.length > 0 ? cleanText(raw.agent) : null,
      subtask: raw.subtask === true,
    });
  }

  return commands;
}

/** `http://127.0.0.1:<port>/command`. */
export function opencodeCommandUrl(port: number): string {
  return `http://${OPENCODE_COMMAND_HOST}:${port}${OPENCODE_COMMAND_PATH}`;
}

/** True when `port` is a usable TCP port number. */
export function isUsableOpencodePort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536;
}

export interface FetchOpencodeOptions {
  /** Loopback port the opencode server listens on. */
  port: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type OpencodeLiveFetch =
  | { ok: true; commands: OpencodeLiveCommand[] }
  | { ok: false; warning: string };

/**
 * Read `GET /command` off a loopback opencode server, fail-soft.
 *
 * Never throws and never rejects: a dead port, a timeout, a squatter answering
 * HTML, or a body that is not an array all come back as `{ ok: false }`. The
 * palette falls back to the bundled catalog in every one of those cases, which
 * is the whole reason the catalog is still shipped.
 */
export async function fetchOpencodeLiveCommands(
  options: FetchOpencodeOptions
): Promise<OpencodeLiveFetch> {
  if (!isUsableOpencodePort(options.port)) {
    return { ok: false, warning: `invalid opencode port: ${String(options.port)}` };
  }

  const url = opencodeCommandUrl(options.port);
  const doFetch = options.fetchImpl ?? fetch;

  try {
    const response = await doFetch(url, {
      // A 3xx must land here rather than at its target: something that redirects
      // is not the opencode server, and following it would leave the loopback
      // guarantee this provider rests on.
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? OPENCODE_COMMAND_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, warning: `http ${response.status} for ${url}` };
    }
    const contentType = response.headers?.get?.('content-type');
    if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
      return { ok: false, warning: `unexpected content-type for ${url}: ${String(contentType)}` };
    }
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) {
      return { ok: false, warning: `${url} did not answer a command array` };
    }
    return { ok: true, commands: parseOpencodeCommandDocument(body) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, warning: `fetch failed for ${url}: ${message}` };
  }
}

/**
 * Enumerate opencode commands for the reconcile engine.
 *
 * Only rows the endpoint is authoritative for are handed on. `source: "skill"`
 * rows are **excluded**: a Skill is a per-project file, not a property of the
 * CLI, and letting one into the bundled catalog would ship one developer's
 * `.agents/skills` directory to everybody — exactly the phantom shape #1503
 * purged. `source: "command"` rows survive; on a bare project that is `/init`
 * and `/review`, which are the two attested names this endpoint can reproduce.
 *
 * `sourceVersion` is deliberately not set: the document carries no version, and
 * the server's `/global/health` version stamps the *server*, not this list.
 */
export async function fetchOpencodeCommands(
  options: FetchOpencodeOptions | false = false
): Promise<ProviderResult> {
  if (options === false) {
    return {
      tool: OPENCODE_TOOL_ID,
      ok: false,
      commands: [],
      warnings: [
        'opencode provider skipped: no loopback port given ' +
          '(pass { port } — the TUI built-ins are not in GET /command, see the module docblock)',
      ],
    };
  }

  const fetched = await fetchOpencodeLiveCommands(options);
  if (!fetched.ok) {
    return { tool: OPENCODE_TOOL_ID, ok: false, commands: [], warnings: [fetched.warning] };
  }

  const provider: ProviderCommand[] = fetched.commands
    .filter((command) => command.source === 'command')
    .map((command) => ({
      name: command.name,
      ...(command.description.length > 0 ? { description: command.description } : {}),
      status: 'active' as const,
    }));

  return {
    tool: OPENCODE_TOOL_ID,
    ok: true,
    commands: sanitizeProviderCommands(provider),
    warnings: [
      'opencode GET /command carries markdown commands and Skills only; ' +
        'the 16 TUI built-ins (/agents … /variants) are client-side and must still be ' +
        'attested from a palette reading (measured on 1.18.22, Issue #2036)',
    ],
  };
}
