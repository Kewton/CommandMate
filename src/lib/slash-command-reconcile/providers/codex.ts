/**
 * Slash Command Catalog reconcile — codex provider (Issue #1489)
 *
 * Authoritative source: the OSS `enum SlashCommand` in
 * openai/codex `codex-rs/tui/src/slash_command.rs`, pinned to a release tag.
 * This is the strongest of the three sources: the variant list is the exact set
 * of built-in commands, each variant carries a `///`-free `description()` arm,
 * and the release tag lets us stamp `verifiedAgainst.codex` with the precise
 * version the enumeration was collated against.
 *
 * Name derivation mirrors strum: the crate declares
 * `#[strum(serialize_all = "kebab-case")]`, so a variant's command name is its
 * `#[strum(to_string = "…")]` if present, else its first `#[strum(serialize =
 * "…")]`, else the kebab-case of the variant identifier.
 */

import { fetchAllowedText, type FetchTextOptions } from '../fetch';
import { sanitizeProviderCommands } from '../sanitize';
import type { ProviderCommand, ProviderResult } from '../types';

export const CODEX_OWNER_REPO = 'openai/codex';
export const CODEX_ENUM_PATH = 'codex-rs/tui/src/slash_command.rs';
export const CODEX_LATEST_RELEASE_URL =
  'https://api.github.com/repos/openai/codex/releases/latest';

/** Release tags must be URL-path safe before being interpolated into a raw URL. */
const SAFE_TAG_PATTERN = /^[A-Za-z0-9._-]+$/;
/** Descriptions explicitly marked internal in the source are not real commands. */
const INTERNAL_DESCRIPTION = 'DO NOT USE';

/** Build the pinned raw URL for the codex slash-command enum at `ref`. */
export function codexEnumRawUrl(ref: string): string {
  return `https://raw.githubusercontent.com/${CODEX_OWNER_REPO}/${ref}/${CODEX_ENUM_PATH}`;
}

/** Extract a `major.minor.patch` from a tag like `rust-v0.145.0`. */
export function versionFromTag(tag: string): string | undefined {
  const match = tag.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : undefined;
}

/** heck-style kebab-case, matching strum's `serialize_all = "kebab-case"`. */
function toKebabCase(identifier: string): string {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/** Return the content between the first `{` at/after `fromIndex` and its match. */
function extractBracedBlock(text: string, fromIndex: number): string | null {
  const open = text.indexOf('{', fromIndex);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/** Resolve the strum name-transform declared for the enum (default kebab-case). */
function resolveTransform(rust: string): (id: string) => string {
  const match = rust.match(/serialize_all\s*=\s*"([^"]+)"/);
  const mode = match ? match[1] : 'kebab-case';
  switch (mode) {
    case 'snake_case':
      return (id) => toKebabCase(id).replace(/-/g, '_');
    case 'lowercase':
      return (id) => id.toLowerCase();
    default:
      return toKebabCase;
  }
}

/** strum name overrides parsed from a `#[strum(...)]` attribute. */
interface StrumOverride {
  /** `to_string = "…"` — the canonical display/serialize form. */
  display?: string;
  /** first `serialize = "…"` — an accepted alias, also Display when no to_string. */
  serialize?: string;
}

/**
 * Pull `to_string` / first `serialize` overrides out of a `#[strum(...)]` attr.
 * Field names deliberately avoid `toString` (which collides with
 * `Object.prototype.toString` and would read as a function on a plain `{}`).
 */
function parseStrumOverride(attr: string): StrumOverride {
  const toStringMatch = attr.match(/to_string\s*=\s*"([^"]+)"/);
  const serializeMatch = attr.match(/serialize\s*=\s*"([^"]+)"/);
  return {
    display: toStringMatch ? toStringMatch[1] : undefined,
    serialize: serializeMatch ? serializeMatch[1] : undefined,
  };
}

interface VariantEntry {
  variant: string;
  name: string;
}

/** Parse the `enum SlashCommand { … }` body into ordered (variant, name) pairs. */
function parseVariants(enumBody: string, transform: (id: string) => string): VariantEntry[] {
  const entries: VariantEntry[] = [];
  let pendingAttr = '';

  for (const rawLine of enumBody.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('//')) continue;
    if (line.startsWith('#[')) {
      pendingAttr += line;
      continue;
    }

    const variantMatch = line.match(/^([A-Z][A-Za-z0-9]*)\s*,?\s*(?:\/\/.*)?$/);
    if (!variantMatch) {
      pendingAttr = '';
      continue;
    }

    const variant = variantMatch[1];
    const override: StrumOverride = pendingAttr ? parseStrumOverride(pendingAttr) : {};
    const name = override.display ?? override.serialize ?? transform(variant);
    entries.push({ variant, name });
    pendingAttr = '';
  }

  return entries;
}

/** Parse the `fn description` match block into a variant → description map. */
function parseDescriptions(rust: string): Map<string, string> {
  const map = new Map<string, string>();
  const fnIndex = rust.indexOf('fn description');
  if (fnIndex === -1) return map;
  const matchIndex = rust.indexOf('match self', fnIndex);
  if (matchIndex === -1) return map;
  const body = extractBracedBlock(rust, matchIndex);
  if (!body) return map;

  const armRe = /((?:SlashCommand::\w+\s*\|?\s*)+?)=>\s*\{?\s*"((?:[^"\\]|\\.)*)"/g;
  let arm: RegExpExecArray | null;
  while ((arm = armRe.exec(body)) !== null) {
    const description = arm[2].replace(/\\"/g, '"').trim();
    const variants = arm[1].match(/SlashCommand::(\w+)/g) ?? [];
    for (const ref of variants) {
      const variant = ref.replace('SlashCommand::', '');
      if (!map.has(variant)) map.set(variant, description);
    }
  }
  return map;
}

/**
 * Parse the codex slash-command Rust source into commands.
 *
 * Drops variants whose description is the internal "DO NOT USE" marker. Never
 * throws: a source whose shape has drifted yields fewer (or zero) commands,
 * which the caller treats as fail-soft.
 */
export function parseCodexSlashCommandEnum(rust: string): ProviderCommand[] {
  const enumIndex = rust.indexOf('enum SlashCommand');
  if (enumIndex === -1) return [];
  const enumBody = extractBracedBlock(rust, enumIndex);
  if (!enumBody) return [];

  const transform = resolveTransform(rust);
  const variants = parseVariants(enumBody, transform);
  const descriptions = parseDescriptions(rust);

  const commands: ProviderCommand[] = [];
  for (const { variant, name } of variants) {
    const description = descriptions.get(variant);
    if (description === INTERNAL_DESCRIPTION) continue;
    const command: ProviderCommand = { name };
    if (description) command.description = description;
    commands.push(command);
  }

  return sanitizeProviderCommands(commands);
}

/**
 * Resolve the latest codex release tag via the GitHub API, fail-soft.
 * Returns null on any fetch/parse problem or an unsafe tag string.
 */
export async function resolveCodexLatestTag(
  options: FetchTextOptions = {}
): Promise<string | null> {
  const headers = { Accept: 'application/vnd.github+json', ...options.headers };
  const fetched = await fetchAllowedText(CODEX_LATEST_RELEASE_URL, { ...options, headers });
  if (!fetched.ok) return null;
  try {
    const parsed = JSON.parse(fetched.text) as { tag_name?: unknown };
    const tag = parsed.tag_name;
    if (typeof tag !== 'string' || !SAFE_TAG_PATTERN.test(tag)) return null;
    return tag;
  } catch {
    return null;
  }
}

export interface FetchCodexOptions extends FetchTextOptions {
  /** Pin to a specific tag instead of resolving the latest release. */
  ref?: string;
}

/**
 * Fetch and parse the codex built-in command list at a release tag. Fail-soft:
 * any resolve/fetch/parse problem yields `ok: false` with a warning.
 */
export async function fetchCodexCommands(
  options: FetchCodexOptions = {}
): Promise<ProviderResult> {
  const tag = options.ref ?? (await resolveCodexLatestTag(options));
  if (!tag || !SAFE_TAG_PATTERN.test(tag)) {
    return {
      tool: 'codex',
      ok: false,
      commands: [],
      warnings: ['could not resolve a codex release tag'],
    };
  }

  const fetched = await fetchAllowedText(codexEnumRawUrl(tag), options);
  if (!fetched.ok) {
    return { tool: 'codex', ok: false, commands: [], warnings: [fetched.warning] };
  }

  const commands = parseCodexSlashCommandEnum(fetched.text);
  if (commands.length === 0) {
    return {
      tool: 'codex',
      ok: false,
      commands: [],
      warnings: [`codex enum parsed to zero commands at ${tag} (format drift?)`],
    };
  }

  return {
    tool: 'codex',
    ok: true,
    commands,
    sourceVersion: versionFromTag(tag),
    warnings: [],
  };
}
