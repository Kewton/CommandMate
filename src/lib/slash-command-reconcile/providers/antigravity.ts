/**
 * Slash Command Catalog reconcile — antigravity provider (Issue #1489, Phase 2)
 *
 * Interface-only for now. antigravity is closed-source, so there is no code-
 * derived ground truth: Phase 2 will parse the public docs reference sheet
 * (antigravity.google/docs/cli/reference) and fall back to a `/help` PTY capture
 * if the docs prove unparseable. Until then this returns `ok: false`, which the
 * engine treats as fail-soft — antigravity catalog entries are left untouched.
 */

import type { FetchTextOptions } from '../fetch';
import type { ProviderCommand, ProviderResult } from '../types';

/** Public docs reference sheet targeted by Phase 2. */
export const ANTIGRAVITY_DOCS_URL = 'https://antigravity.google/docs/cli/reference';

/**
 * Parse an antigravity docs reference sheet into commands.
 *
 * Placeholder for Phase 2: the docs format is still to be confirmed, so this
 * returns no commands rather than guessing at a shape.
 */
export function parseAntigravityReference(_markup: string): ProviderCommand[] {
  return [];
}

/**
 * Enumerate antigravity built-in commands. Phase 2 stub: always fail-soft so the
 * reconcile keeps working with claude + codex while antigravity is unimplemented.
 */
export async function fetchAntigravityCommands(
  _options: FetchTextOptions = {}
): Promise<ProviderResult> {
  return {
    tool: 'antigravity',
    ok: false,
    commands: [],
    warnings: ['antigravity provider not implemented yet (Issue #1489 Phase 2)'],
  };
}
