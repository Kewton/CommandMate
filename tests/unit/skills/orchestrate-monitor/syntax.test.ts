import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPTS_DIR = path.join(
  process.cwd(),
  '.claude/skills/orchestrate-monitor/scripts',
);

const shellScripts = readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.sh'));

describe('orchestrate-monitor scripts pass bash -n (bash 3.2 syntax gate)', () => {
  it('finds the shell scripts to check', () => {
    // Guard against an empty glob silently passing the whole suite.
    expect(shellScripts.length).toBeGreaterThanOrEqual(5);
  });

  it.each(shellScripts)('bash -n %s', (file) => {
    // Throws (non-zero exit) if the script has a syntax error.
    execFileSync('bash', ['-n', path.join(SCRIPTS_DIR, file)], {
      encoding: 'utf8',
    });
  });
});
