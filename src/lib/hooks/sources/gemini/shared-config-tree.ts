/**
 * Non-destructive JSON config writing for the `~/.gemini` tree that gemini and
 * antigravity share (Issue #1762).
 *
 * ## Why this is one module rather than two
 *
 * `~/.gemini/` is gemini's directory, and antigravity squats in it. On a machine
 * with both installed it holds, at once:
 *
 * ```
 * ~/.gemini/settings.json          gemini, user scope
 * ~/.gemini/oauth_creds.json       gemini, the credentials a session needs
 * ~/.gemini/config/hooks.json      antigravity, the ONLY file it reads (#1757 P8)
 * ~/.gemini/antigravity/           antigravity 2.0 state
 * ~/.gemini/antigravity-cli/       agy state, incl. its own settings.json
 * ```
 *
 * So "write the config file" is a sentence with a blast radius here that it does
 * not have for Claude or codex: a generator that rewrites a file wholesale takes
 * out the *other* tool's configuration, and a generator that redirects the tree
 * (a `HOME` or `GEMINI_CLI_HOME` swap) takes out gemini's OAuth credentials and
 * leaves the user staring at a login screen. Both failures are silent at the
 * moment they happen.
 *
 * Everything in this module therefore does exactly one thing: **read what is
 * there, put CommandMate's own key back, and write the rest through untouched.**
 * A file CommandMate has never seen keeps every byte it had except the one key
 * that is ours. Both directions are pinned by
 * `tests/unit/hooks/sources/shared-config-tree-1762.test.ts`.
 *
 * It lives under `gemini/` because the tree is gemini's; `antigravity/` imports
 * it rather than growing a second copy, which is the point — one merge
 * implementation means "we do not clobber" is one thing to get right and one
 * thing to test, instead of two that can drift.
 *
 * @module lib/hooks/sources/gemini/shared-config-tree
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { isPlainObject } from '../event-mapper';

/**
 * Read a JSON object from disk, or null when there is nothing usable there.
 *
 * Null covers three different situations on purpose — absent, unreadable, and
 * "parsed fine but is not an object" — because the caller's response to all
 * three is the same: treat the file as empty and write a config that has only
 * CommandMate's key in it.
 *
 * It deliberately does **not** cover "parsed fine and is an object we do not
 * recognise". That case returns the object, and the merge preserves it. A user's
 * `settings.json` is full of keys this codebase has never heard of.
 *
 * @param path - Absolute path to the file
 * @returns The parsed object, or null
 */
export function readJsonObjectFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    // A hand-edited file with a trailing comma is not something to fail a
    // session over. Injection is an enhancement; the session starts either way.
    return null;
  }
}

/**
 * Write a JSON object, creating the directory when it is missing.
 *
 * The mode arguments apply only when the entry is *created*: an existing file
 * keeps the permissions the user gave it, which matters because these files are
 * theirs and not CommandMate's. A new one is 0600 and a new directory 0700 — the
 * same posture `hook-settings-generator` takes, and for the same reason (the
 * contents name every worktree and instance on the machine).
 *
 * @param path - Absolute path to the file
 * @param value - The object to serialise
 */
export function writeJsonObjectFile(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
