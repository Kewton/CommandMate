/**
 * The CLI has no way to approve, confirm or reconcile a promote (Issue #4225, D9,
 * design §4.2). The routes of `/api/repositories/:id/mem/decisions/**` that write are
 * the screen's; this keeps the CLI from growing one: nothing under `src/cli/` names
 * those routes next to a write, or a promote sub-command.
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

/** Why a CLI source would let an agent approve a promote, or null. */
export function promoteWriteFinding(source: string): string | null {
  if (/mem\/decisions/.test(source) && /\.(put|delete|patch|post)\s*[<(]|method:\s*['"](?:POST|PUT|PATCH|DELETE)/i.test(source)) {
    return 'writes the promote routes';
  }
  if (/\.command\(\s*['"](?:promote|approve|confirm-reflected|reconcile)\b/.test(source)) return 'adds a promote sub-command';
  if (/x-commandmate-client/i.test(source)) return 'names the screen mark header';
  return null;
}

describe('the CLI cannot approve a promote', () => {
  it('flags a client that writes the promote routes, a promote sub-command, or the mark (positive control)', () => {
    expect(promoteWriteFinding("client.post('/api/repositories/r/mem/decisions/i/approve', {})")).not.toBeNull();
    expect(promoteWriteFinding("fetch(`/api/repositories/${r}/mem/decisions/${i}/approve`, { method: 'POST' })")).not.toBeNull();
    expect(promoteWriteFinding("mem.command('approve <item>')")).not.toBeNull();
    expect(promoteWriteFinding("headers: { 'X-CommandMate-Client': 'screen' }")).not.toBeNull();
  });

  it('(control) a read of the decisions, or another sub-command, is not flagged', () => {
    expect(promoteWriteFinding("client.get('/api/repositories/r/mem/decisions?branch=main')")).toBeNull();
    expect(promoteWriteFinding("mem.command('list')")).toBeNull();
  });

  it('finds the CLI sources at all', () => {
    expect(files(CLI_DIR).some((file) => file.endsWith('commands/mem.ts'))).toBe(true);
  });

  it('no file under src/cli writes the promote routes', () => {
    const findings = files(CLI_DIR)
      .map((file) => [relative(process.cwd(), file), promoteWriteFinding(readFileSync(file, 'utf-8'))] as const)
      .filter(([, finding]) => finding !== null);
    expect(findings).toEqual([]);
  });
});
