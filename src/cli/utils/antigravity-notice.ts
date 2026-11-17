/**
 * The Antigravity usage notice on the CLI (Issue #4438, G4).
 *
 * The web UI shows the notice once per browser (the browser remembers it, keyed
 * by the terms' check date). The CLI's unit is "once per CLI environment": a
 * small file in CommandMate's config directory (`getConfigDir()`, where
 * `remote.json` lives) holds the check date the notice was shown for. A new
 * date, a missing, unreadable or malformed file shows it again.
 *
 * It is written to stderr only (never stdout, never `--json`): through
 * `clientWarning`, so on `send` / `ask` / `respond` it comes after a tool-policy
 * refusal's lines (the reason stays stderr's first line, I7d). Failing to read
 * or write the record changes nothing else: it shows the notice and goes on.
 * Only CommandMate's own config directory is written.
 *
 * Under vitest the record is off unless `CM_ANTIGRAVITY_NOTICE_DIR` names a
 * directory (the suite must not write into a real config directory or into the
 * checkout); that variable also relocates the file for a user who wants it.
 *
 * @module cli/utils/antigravity-notice
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import {
  ANTIGRAVITY_FAQ_URL,
  ANTIGRAVITY_TERMS_CHECKED_AT,
  ANTIGRAVITY_TERMS_URL,
  USAGE_DECLARATION_ENV,
} from '../../lib/tool-policy/policy';
import { ensureConfigDir, getConfigDir } from './install-context';
import { clientWarning } from './tool-policy-failure';

/** File name inside the config directory. */
export const ANTIGRAVITY_NOTICE_FILE_NAME = 'antigravity-notice.json';

/** Names a directory for the record instead of the config directory. */
export const ANTIGRAVITY_NOTICE_DIR_ENV = 'CM_ANTIGRAVITY_NOTICE_DIR';

/** The notice, one stderr line each. */
export function antigravityNoticeLines(): string[] {
  return [
    'Notice [antigravity]: Section 6 of the Google Antigravity Additional Terms of Service and the official FAQ restrict using Antigravity through third-party software or coding agents on consumer plans (Free, Google AI Plus, Pro and Ultra). A breach can lead to account suspension. With a consumer-plan sign-in, do not send tasks to agy from another AI agent (send, ask, relays, /orchestrate), run agy from Schedules or the daily summary, or turn on Auto-Yes for agy.',
    'There is no explicit confirmation from Google on whether starting agy and typing into it yourself is within the terms.',
    `For automation, use a Gemini API key or Gemini Enterprise, and set the server's environment variable ${USAGE_DECLARATION_ENV} to api-key or enterprise (then restart the server). CommandMate does not read or forward agy's credentials.`,
    `Terms: ${ANTIGRAVITY_TERMS_URL}  FAQ: ${ANTIGRAVITY_FAQ_URL}  (as of ${ANTIGRAVITY_TERMS_CHECKED_AT}; not legal advice). Shown once per CLI environment; it shows again when the check date changes.`,
  ];
}

/** The directory of the record, or null when the record is off (under vitest, unnamed). */
function recordDir(forWrite: boolean): string | null {
  const named = process.env[ANTIGRAVITY_NOTICE_DIR_ENV];
  if (named) return named;
  if (process.env.VITEST) return null;
  return forWrite ? ensureConfigDir() : getConfigDir();
}

/** Whether the record says the notice was shown for the current check date. */
function alreadyShown(): boolean {
  try {
    const dir = recordDir(false);
    if (dir === null) return true;
    const parsed: unknown = JSON.parse(readFileSync(join(dir, ANTIGRAVITY_NOTICE_FILE_NAME), 'utf8'));
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { termsCheckedAt?: unknown }).termsCheckedAt === ANTIGRAVITY_TERMS_CHECKED_AT
    );
  } catch {
    return false;
  }
}

function record(): void {
  try {
    const dir = recordDir(true);
    if (dir === null) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, ANTIGRAVITY_NOTICE_FILE_NAME);
    writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, termsCheckedAt: ANTIGRAVITY_TERMS_CHECKED_AT })}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    // Not recorded: the notice shows again next time. Nothing else changes.
  }
}

/**
 * Say the notice (stderr) when `cliToolId` is antigravity and it has not been said
 * for the current check date in this CLI environment; record that it was. Any other
 * tool: nothing is said and nothing is written. Returns whether it was said.
 */
export function noteAntigravityNotice(
  cliToolId: string | undefined,
  emit: (line: string) => void = clientWarning,
): boolean {
  if (cliToolId !== 'antigravity') return false;
  try {
    if (alreadyShown()) return false;
    for (const line of antigravityNoticeLines()) emit(line);
    record();
    return true;
  } catch {
    return false;
  }
}
