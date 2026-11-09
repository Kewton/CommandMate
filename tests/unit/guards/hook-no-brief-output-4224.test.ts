/**
 * K4 (Issue #4224, D2 design §6.3): the hooks CommandMate installs never put a brief into
 * an agent's context. A `SessionStart` hook that prints one has to use
 * `commandmate brief --session-start`, which stays silent when the send path briefs the
 * conversation; the relay script CommandMate's hooks call writes nothing to stdout.
 *
 * Read off the generators' and the scripts' text: every `commandmate brief` they name
 * carries `--session-start`, and the relay's `curl` goes to /dev/null. The positive
 * control is a file under `os.tmpdir()` that names the plain command.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const ROOT = process.cwd();
const HOOK_SOURCES = [path.join(ROOT, 'src/lib/hooks'), path.join(ROOT, 'scripts/hooks')];
const RELAY_SCRIPT = path.join(ROOT, 'scripts/hooks/cmate-agent-event.sh');

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) filesUnder(full, out);
    else if (/\.(ts|sh|mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

/** Lines naming `commandmate brief` without `--session-start`. */
export function plainBriefCalls(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => /commandmate\s+brief\b/.test(line) && !/--session-start/.test(line))
    .map((line) => `${path.relative(ROOT, file)}: ${line.trim()}`);
}

let scratch: string | null = null;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

describe('K4 CommandMate’s hooks print no brief', () => {
  it('no generator or script names the plain `commandmate brief`', () => {
    const files = HOOK_SOURCES.flatMap((dir) => filesUnder(dir));
    expect(files.length).toBeGreaterThan(5);
    expect(files.flatMap(plainBriefCalls)).toEqual([]);
  });

  it('the relay script discards what the server answers (its stdout is not the agent’s context)', () => {
    const script = readFileSync(RELAY_SCRIPT, 'utf8');
    const curls = script.split('\n').filter((line) => /^\s*curl\b/.test(line) || /\bcurl "\$@"/.test(line));
    expect(curls.length).toBeGreaterThan(0);
    for (const line of curls) expect(line).toMatch(/>\s*\/dev\/null/);
  });

  it('positive control: a hook that runs the plain command is found; with --session-start it is not', () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'hook-brief-4224-'));
    const plain = path.join(scratch, 'hooks-config.ts');
    writeFileSync(plain, "export const SESSION_START = 'commandmate brief --worktree $W --instance $I';\n");
    expect(plainBriefCalls(plain)).toHaveLength(1);
    const flagged = path.join(scratch, 'flagged.ts');
    writeFileSync(flagged, "export const SESSION_START = 'commandmate brief --session-start';\n");
    expect(plainBriefCalls(flagged)).toEqual([]);
  });
});
