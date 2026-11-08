/**
 * The CLI has no way to change the mem mode (Issue #4221, D3, design §11.2).
 *
 * The mode is written by `/api/repositories/:id/mem-settings*` from the screen only. The
 * server refuses a write without the screen's mark; this keeps the CLI from growing one:
 * nothing under `src/cli/` names the settings route next to a write, or the mark itself.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const CLI_DIR = join(process.cwd(), 'src/cli');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return files(full);
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [full] : [];
  });
}

/** Why a source would let the CLI change the mode, or null. */
export function modeWriteFinding(source: string): string | null {
  if (/x-commandmate-client/i.test(source)) return 'names the screen mark header';
  if (/mem-settings/.test(source) && /\.(put|delete|patch|post)\s*[<(]/.test(source)) return 'writes the mem settings route';
  return null;
}

describe('the CLI cannot change the mem mode', () => {
  it('flags a client that writes the settings or sends the mark (positive control)', () => {
    expect(modeWriteFinding("client.put('/api/repositories/r/mem-settings', {})")).not.toBeNull();
    expect(modeWriteFinding("headers: { 'X-CommandMate-Client': 'screen' }")).not.toBeNull();
    expect(modeWriteFinding("client.get('/api/worktrees/w/mem/mode')")).toBeNull();
  });

  it('finds the CLI sources at all', () => {
    expect(files(CLI_DIR).some((file) => file.endsWith('commands/mem.ts'))).toBe(true);
  });

  it('no file under src/cli writes the settings or names the mark', () => {
    const findings = files(CLI_DIR)
      .map((file) => [relative(process.cwd(), file), modeWriteFinding(readFileSync(file, 'utf-8'))] as const)
      .filter(([, finding]) => finding !== null);
    expect(findings).toEqual([]);
  });
});
