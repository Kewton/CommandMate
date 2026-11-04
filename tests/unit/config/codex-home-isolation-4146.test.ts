/**
 * Issue #4146: the suite's `CODEX_HOME` and `COPILOT_HOME` are always temporary
 * paths. Started with a real directory in either variable, `tests/setup.ts` used
 * to keep it, and a test that starts a session would edit that directory.
 *
 * Sets no environment of its own for the first group: what it reads is the
 * process `tests/setup.ts` handed it. The second reads the statements out of
 * `tests/setup.ts` and runs them against a fake environment, so the outer value
 * can be chosen without starting another suite. Read-only: nothing is written to
 * any home, real or temporary.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getCodexHome, getCodexHooksPath } from '@/lib/hooks/sources/codex/hooks-config';
import { resolveCodexHome } from '@/lib/hooks/sources/codex/history';

const SETUP_SOURCE = readFileSync(resolve(process.cwd(), 'tests/setup.ts'), 'utf8');

/** A real directory as the shell would have exported it. Never read or written. */
const OUTER_VALUE = join(homedir(), '.outer-home-4146');

/** The statements of `source` that write `process.env.<name>`, comments left out. */
function statementsWriting(source: string, name: string): string {
  const code = source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  const at = code.indexOf(`process.env.${name} `);
  const start = code.lastIndexOf('\n', at) + 1;
  const guarded = code.startsWith('if (', start);
  const end = code.indexOf(guarded ? '\n}\n' : ';\n', at);
  return code.slice(start, end + (guarded ? 3 : 2));
}

/** What the statements leave in the variable, started from `outer`. */
function valueAfterSetup(statements: string, name: string, outer: string | undefined): string | undefined {
  const fakeProcess = { env: { [name]: outer }, pid: 1 };
  new Function('process', 'join', 'tmpdir', statements)(fakeProcess, join, tmpdir);
  return fakeProcess.env[name];
}

describe('the process tests/setup.ts handed this file', () => {
  it('CODEX_HOME is the temporary path', () => {
    expect(process.env.CODEX_HOME).toBe(join(tmpdir(), 'commandmate-test-codex-home'));
  });

  it('COPILOT_HOME is under the temporary directory', () => {
    expect(process.env.COPILOT_HOME?.startsWith(join(tmpdir(), 'commandmate-test-copilot-home'))).toBe(true);
  });

  it('codex resolves its home and hooks file away from the real ~/.codex', () => {
    const real = join(homedir(), '.codex');
    expect(getCodexHome()).not.toBe(real);
    expect(getCodexHooksPath()).not.toBe(join(real, 'hooks.json'));
    expect(resolveCodexHome()).not.toBe(real);
  });

  it('and the variable is what stands between the suite and the real ~/.codex', () => {
    expect(resolveCodexHome({})).toBe(join(homedir(), '.codex'));
  });
});

describe('a value the suite was started with', () => {
  it.each(['CODEX_HOME', 'COPILOT_HOME'])('%s does not survive tests/setup.ts', (name) => {
    const statements = statementsWriting(SETUP_SOURCE, name);
    const after = valueAfterSetup(statements, name, OUTER_VALUE);
    expect(after).not.toBe(OUTER_VALUE);
    expect(after?.startsWith(tmpdir())).toBe(true);
  });

  it.each(['CODEX_HOME', 'COPILOT_HOME'])('%s is filled in when nothing was set, or a blank', (name) => {
    const statements = statementsWriting(SETUP_SOURCE, name);
    expect(valueAfterSetup(statements, name, undefined)?.startsWith(tmpdir())).toBe(true);
    expect(valueAfterSetup(statements, name, '')?.startsWith(tmpdir())).toBe(true);
  });

  it('positive control: the shapes this replaced keep the outer value, so the reading can tell', () => {
    const oldCodex = "process.env.CODEX_HOME ??= join(tmpdir(), 'commandmate-test-codex-home');";
    expect(valueAfterSetup(statementsWriting(`${oldCodex}\n`, 'CODEX_HOME'), 'CODEX_HOME', OUTER_VALUE)).toBe(OUTER_VALUE);

    const oldCopilot = [
      "if ((process.env.COPILOT_HOME ?? '').trim() === '') {",
      "  process.env.COPILOT_HOME = join(tmpdir(), 'x');",
      '}',
      '',
    ].join('\n');
    expect(valueAfterSetup(statementsWriting(oldCopilot, 'COPILOT_HOME'), 'COPILOT_HOME', OUTER_VALUE)).toBe(OUTER_VALUE);
  });
});
