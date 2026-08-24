/**
 * Env Manager — value masking (Issue #1968).
 *
 * Masking is what makes this UI safe to open in a room with other people, on a
 * shared screen, or on a phone. It is the DEFAULT in both views, and the user
 * reveals values one at a time.
 *
 * WHAT MASKING IS AND IS NOT
 * --------------------------
 * These functions are a *display* control, not a transport control. The value
 * has to reach the browser for the user to be able to edit it, so masking is
 * about what is painted on the screen, not about what crosses the wire. The
 * transport controls are elsewhere: the app's authentication, the server-side
 * name allow-list, and the path validation in `env-file-service.ts`.
 */

/**
 * The mask, at a FIXED width.
 *
 * Deliberately not `'•'.repeat(value.length)`: a length-preserving mask leaks
 * the length of every secret on the screen, which is exactly the property an
 * attacker looking over a shoulder would want. Eight dots for everything.
 */
export const ENV_MASK = '••••••••';

/**
 * Mask a single value for display.
 *
 * An empty value stays empty — there is nothing to hide, and painting dots over
 * `KEY=` would tell the user their variable has a value when it does not.
 */
export function maskEnvValue(value: string): string {
  return value.length === 0 ? '' : ENV_MASK;
}

/**
 * Mask the values in raw env text while keeping everything else byte-exact.
 *
 * Used by the Raw view, which would otherwise defeat the per-row masking by
 * printing the whole file in the clear. Keys, comments, blank lines, `export `
 * prefixes and line order all survive; only the right-hand side of each `=` is
 * replaced. A value quoted across several physical lines collapses to one
 * masked line, because the continuation lines are part of the value.
 *
 * @param raw - The file text.
 * @param entries - Entries from `parseEnvContent(raw)`. Passed in rather than
 *   re-parsed so the caller's parse (which it already has, for the Key-Value
 *   view) is the single source of truth about where each value lives.
 */
export function maskEnvRawText(
  raw: string,
  entries: ReadonlyArray<{ key: string; value: string; line: number; endLine: number; exported: boolean }>,
): string {
  const lines = raw.split(/\r\n|\n|\r/);
  const byStartLine = new Map<number, (typeof entries)[number]>();
  const continuationLines = new Set<number>();

  for (const entry of entries) {
    byStartLine.set(entry.line, entry);
    for (let line = entry.line + 1; line <= entry.endLine; line += 1) {
      continuationLines.add(line);
    }
  }

  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    if (continuationLines.has(lineNo)) continue;
    const entry = byStartLine.get(lineNo);
    if (!entry) {
      out.push(lines[i]);
      continue;
    }
    out.push(`${entry.exported ? 'export ' : ''}${entry.key}=${maskEnvValue(entry.value)}`);
  }
  return out.join('\n');
}
