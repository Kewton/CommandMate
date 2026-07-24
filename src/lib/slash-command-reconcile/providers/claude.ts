/**
 * Slash Command Catalog reconcile — claude provider (Issue #1489)
 *
 * Authoritative source: the public Claude Code commands reference, served as
 * Markdown at code.claude.com/docs/en/commands.md. It lists every built-in
 * command (including ones the bundled snapshot lags on, e.g. `/loop`) in a
 * `| Command | Purpose |` table.
 *
 * The name column is reliable; the purpose column is prose (multi-line, links,
 * bold "Skill"/"Workflow" markers, and `{/* min-version: X.Y.Z *​/}` notes), so
 * description extraction is heuristic and best-effort — the release PR diff is
 * the human safety gate for the prose (Issue #1489 risk note).
 *
 * The docs carry no single catalog-wide version, so this provider never reports
 * a `sourceVersion`; `verifiedAgainst.claude` is therefore left untouched by the
 * engine (we only stamp what was collated against a pinned version).
 */

import { fetchAllowedText, type FetchTextOptions } from '../fetch';
import { sanitizeProviderCommands } from '../sanitize';
import type { ProviderCommand, ProviderResult } from '../types';

/** The single allowlisted claude docs URL. */
export const CLAUDE_COMMANDS_DOC_URL = 'https://code.claude.com/docs/en/commands.md';

/** Extracts `min-version: X.Y.Z` from a `{/* ... *​/}` doc note. */
const MIN_VERSION_RE = /min-version:\s*(\d+\.\d+\.\d+)/;
/** Strips `{/* ... *​/}` MDX comment notes. */
const MDX_COMMENT_RE = /\{\/\*[\s\S]*?\*\/\}/g;
/** Matches a Markdown link `[text](url)` → keeps `text`. */
const MD_LINK_RE = /\[([^\]]+)\]\([^)]*\)/g;
/** Leading bold badge like `**[Skill](...)** ` or `**Skill.** `. */
const LEADING_BADGE_RE = /^\*\*[^*]+\*\*\.?\s*/;
/** Sentinel standing in for an escaped table pipe during cell splitting. */
const PIPE_SENTINEL = "\u0000PIPE\u0000";

/** Pull the first backtick-wrapped token out of the Command cell. */
function extractName(commandCell: string): string | null {
  const backtick = commandCell.match(/`([^`]+)`/);
  const token = (backtick ? backtick[1] : commandCell).trim();
  if (!token.startsWith('/')) return null;
  // `/code-review [low|high]` → `code-review`; stop at space / arg bracket.
  const name = token.slice(1).split(/[\s[<]/)[0].trim();
  return name.length > 0 ? name : null;
}

/** Turn a purpose cell into (description, minVersion). */
function extractPurpose(purposeCell: string): { description?: string; minVersion?: string } {
  const minMatch = purposeCell.match(MIN_VERSION_RE);
  const minVersion = minMatch ? minMatch[1] : undefined;

  let text = purposeCell.replace(MDX_COMMENT_RE, ' ');
  text = text.replace(LEADING_BADGE_RE, '');
  text = text.replace(MD_LINK_RE, '$1');
  // Un-escape the escaped pipes used inside table cells (`\|` → `|`).
  text = text.replace(/\\\|/g, '|');
  text = text.replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();

  // First sentence only (period followed by space / end), keep it short.
  const firstSentence = text.split(/\.\s/)[0].replace(/\.$/, '').trim();
  const description = firstSentence.length > 0 ? firstSentence : undefined;
  return { description, minVersion };
}

/**
 * Parse the claude docs Markdown into commands.
 *
 * Scans for the `| Command | Purpose |` table and reads every data row. Rows
 * that are the header, the `---` separator, or that lack a `/name` token are
 * skipped. Never throws on odd input — a malformed table yields fewer rows.
 */
export function parseClaudeCommandsDoc(markdown: string): ProviderCommand[] {
  const commands: ProviderCommand[] = [];
  let inTable = false;

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) {
      // A blank / non-table line ends the current table region.
      if (inTable && line.length === 0) inTable = false;
      continue;
    }

    // Split table cells, dropping the empty edges from leading/trailing pipes.
    // Escaped pipes (`\|`) inside a cell must not split — mask them first.
    const cells = line
      .replace(/\\\|/g, PIPE_SENTINEL)
      .split("|")
      .map((c) => c.split(PIPE_SENTINEL).join("|").trim());
    // Leading & trailing empties from the outer pipes.
    if (cells.length >= 2 && cells[0] === '') cells.shift();
    if (cells.length >= 1 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length < 2) continue;

    const [commandCell, purposeCell] = cells;

    // Header row: "Command | Purpose".
    if (/^command$/i.test(commandCell)) {
      inTable = true;
      continue;
    }
    // Separator row: ":---" / "---".
    if (/^:?-{2,}/.test(commandCell)) continue;
    if (!inTable) continue;

    const name = extractName(commandCell);
    if (!name) continue;

    const { description, minVersion } = extractPurpose(purposeCell);
    const command: ProviderCommand = { name };
    if (description) command.description = description;
    if (minVersion) command.minVersion = minVersion;
    commands.push(command);
  }

  return sanitizeProviderCommands(commands);
}

/**
 * Fetch and parse the claude built-in command list. Fail-soft: any fetch or
 * parse problem yields `ok: false` with a warning and no commands.
 */
export async function fetchClaudeCommands(
  options: FetchTextOptions = {}
): Promise<ProviderResult> {
  const fetched = await fetchAllowedText(CLAUDE_COMMANDS_DOC_URL, options);
  if (!fetched.ok) {
    return { tool: 'claude', ok: false, commands: [], warnings: [fetched.warning] };
  }

  const commands = parseClaudeCommandsDoc(fetched.text);
  if (commands.length === 0) {
    return {
      tool: 'claude',
      ok: false,
      commands: [],
      warnings: ['claude docs parsed to zero commands (format drift?)'],
    };
  }
  return { tool: 'claude', ok: true, commands, warnings: [] };
}
