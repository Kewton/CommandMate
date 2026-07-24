/**
 * Slash Command Catalog reconcile — name allowlist + sanitization (Issue #1489)
 *
 * Every command pulled from an external, network-fetched source passes through
 * here before it can touch the catalog. The whole point is to keep a malicious or
 * malformed source entry (control chars, path-ish names, novel-length blobs)
 * from being written into the bundled catalog and locale dictionaries.
 */

import type { ProviderCommand } from './types';

/**
 * Allowed built-in command name shape.
 *
 * Lowercase letters, digits and hyphens; must start alphanumeric; 1–64 chars.
 * This matches how every real claude/codex built-in name looks (kebab-case) and
 * rejects `/`, `..`, whitespace, and anything that could be interpreted as a
 * path segment or i18n-key separator.
 */
export const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Description length cap (matches the reused skill limit, Issue #343). */
export const MAX_DESCRIPTION_LENGTH = 500;

/** Version string shape used for min-version / source-version fields. */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** ASCII control characters (C0 range plus DEL). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/** True when `name` is a well-formed built-in command name. */
export function isValidCommandName(name: unknown): name is string {
  return typeof name === 'string' && COMMAND_NAME_PATTERN.test(name);
}

/** Collapse whitespace, strip control chars, and cap length. */
function cleanDescription(value: string): string {
  const stripped = value.replace(CONTROL_CHARS, ' ');
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_DESCRIPTION_LENGTH
    ? collapsed.slice(0, MAX_DESCRIPTION_LENGTH)
    : collapsed;
}

/**
 * Validate and normalize one raw provider command.
 *
 * Returns null when the name fails the allowlist — the entry is dropped rather
 * than coerced, so a bad source line can never invent a catalog command. A
 * malformed description is cleaned (not a reason to drop the whole command).
 */
export function sanitizeProviderCommand(raw: ProviderCommand): ProviderCommand | null {
  if (!isValidCommandName(raw.name)) return null;

  const command: ProviderCommand = { name: raw.name };

  if (typeof raw.description === 'string') {
    const description = cleanDescription(raw.description);
    if (description.length > 0) command.description = description;
  }

  if (typeof raw.minVersion === 'string' && VERSION_PATTERN.test(raw.minVersion)) {
    command.minVersion = raw.minVersion;
  }

  return command;
}

/**
 * Sanitize and de-duplicate a list of provider commands by name (first wins).
 * A source that lists the same command twice yields one catalog entry.
 */
export function sanitizeProviderCommands(raw: ProviderCommand[]): ProviderCommand[] {
  const seen = new Set<string>();
  const result: ProviderCommand[] = [];
  for (const entry of raw) {
    const clean = sanitizeProviderCommand(entry);
    if (!clean) continue;
    if (seen.has(clean.name)) continue;
    seen.add(clean.name);
    result.push(clean);
  }
  return result;
}
