/**
 * Issue #4385 PR2 (`docs/design/agy-role-default-4385.md` §8.4): what the
 * generated Antigravity definition carries (D1), the adapter's own version (D5),
 * the switch being gone (D4), and the real `agy agent` child of the listing check
 * (D3) — run against a fake `agy` script under `os.tmpdir()`, never the real one.
 *
 * The driver's side of D3 (where the check runs, what a refusal leaves) runs
 * through the real driver in `tests/unit/cli-tools/antigravity-role-gate-4385.test.ts`.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { parse as parseYaml } from 'yaml';
import {
  agentListNames,
  ANTIGRAVITY_ROLE_TOOLS,
  ANTIGRAVITY_ROLE_TOOLS_VERIFIED_ON,
} from '@/lib/agent-roles/antigravity';
import { computeRoleInjection } from '@/lib/agent-roles/adapters';
import {
  inspectRoleArtifact,
  renderRoleArtifact,
  writeRoleArtifact,
  type ArtifactOptions,
} from '@/lib/agent-roles/artifacts';
import { computeBodyFingerprint, computeFingerprint } from '@/lib/agent-roles/fingerprint';
import { buildSystemRoleDefaults } from '@/lib/agent-roles/management';
import { runMigrations } from '@/lib/db/db-migrations';
import { runAgyAgentList } from '@/lib/cli-tools/antigravity';
import { AGENT_ROLE_CLI_TOOLS } from '@/types/agent-roles';

const ROOT = path.resolve(__dirname, '../../..');
const NAME = 'cm-role-ns-0011223344556677-abababababab';
const EXPECTED_TOOLS = [
  'read_file',
  'run_command',
  'manage_task',
  'send_message',
  'schedule',
  'invoke_subagent',
  'define_subagent',
  'manage_subagents',
  'write_file',
  'edit_file',
  'search_web',
  'run_workflow',
  'ask_question',
];

function frontmatterOf(bytes: Buffer): Record<string, unknown> {
  const text = bytes.toString('utf8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error('no frontmatter');
  return parseYaml(match[1]) as Record<string, unknown>;
}

describe('D1: the tools of the generated definition', () => {
  it('P1 lists the 13 tools verified on agy 1.5.8, in order, without swarm, with subagent: false', () => {
    const data = frontmatterOf(renderRoleArtifact('antigravity', NAME, 'BODY'));
    expect(data.tools).toEqual(EXPECTED_TOOLS);
    expect(data.tools).not.toContain('swarm');
    expect(data.subagent).toBe(false);
    expect(data.name).toBe(NAME);
    expect([...ANTIGRAVITY_ROLE_TOOLS]).toEqual(EXPECTED_TOOLS);
    // The block form agy was measured with: `tools:` then `  - <name>` rows.
    expect(renderRoleArtifact('antigravity', NAME, 'BODY').toString('utf8')).toContain(
      `tools:\n${EXPECTED_TOOLS.map((tool) => `  - ${tool}\n`).join('')}---\n`
    );
  });

  it('P1 (control) only Antigravity names tools: Copilot\'s definition has none', () => {
    expect(frontmatterOf(renderRoleArtifact('copilot', NAME, 'BODY')).tools).toBeUndefined();
  });

  it('P2 the constant says where it was measured: agy 1.5.8 and the record of 2026-11-14', () => {
    expect(ANTIGRAVITY_ROLE_TOOLS_VERIFIED_ON).toBe('1.5.8');
    const source = fs.readFileSync(path.join(ROOT, 'src/lib/agent-roles/antigravity.ts'), 'utf8');
    const comment = source.slice(0, source.indexOf('export const ANTIGRAVITY_ROLE_TOOLS ='));
    const doc = comment.slice(comment.lastIndexOf('/**'));
    expect(doc).toContain('1.5.8');
    expect(doc).toContain('2026-11-14');
    expect(doc).toContain('dev-reports/issue/agy-role-2026-11-14/report.md');
    expect(doc).toContain('evidence/r2-3-tool-registry-probe.txt');
    expect(doc).toContain('evidence/r2-4-dev-tools13.txt');
  });

  describe('P3 a definition whose tools are not the list does not pass the read-back', () => {
    let base: string;
    let options: ArtifactOptions;

    beforeEach(() => {
      base = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-agy-role-enable-4385-'));
      options = {
        dataRoot: path.join(base, 'data'),
        codexHome: path.join(base, 'codex'),
        copilotHome: path.join(base, 'copilot'),
        antigravityAgentsDir: path.join(base, 'gemini', 'config', 'agents'),
        env: {},
      };
    });
    afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

    /** Write the real file, then put `text` in its place (same mode) and read it back. */
    function inspectReplaced(text: string): void {
      const written = writeRoleArtifact({ adapter: 'antigravity', name: NAME, instructions: 'BODY' }, options);
      fs.writeFileSync(written.path, text, { mode: 0o600 });
      inspectRoleArtifact(
        { adapter: 'antigravity', name: NAME, path: written.path, expectedFingerprint: computeFingerprint(Buffer.from(text, 'utf8')) },
        options
      );
    }
    const definition = (tools: string[] | null) =>
      `---\nname: ${NAME}\ndescription: CommandMate role\nsubagent: false\n` +
      (tools === null ? '' : `tools:\n${tools.map((tool) => `  - ${tool}\n`).join('')}`) +
      '---\nBODY';

    it.each([
      ['no tools', null],
      ['one missing', EXPECTED_TOOLS.slice(0, 12)],
      ['one added (swarm)', [...EXPECTED_TOOLS, 'swarm']],
      ['another order', [...EXPECTED_TOOLS].reverse()],
    ])('%s: format-invalid', (_case, tools) => {
      expect(() => inspectReplaced(definition(tools))).toThrow(expect.objectContaining({ code: 'format-invalid' }));
    });

    it('(control) the generated bytes pass', () => {
      expect(() => inspectReplaced(definition(EXPECTED_TOOLS))).not.toThrow();
      const written = writeRoleArtifact({ adapter: 'antigravity', name: NAME, instructions: 'BODY' }, options);
      expect(written.reused).toBe(true);
    });
  });
});

describe('D5: the adapter version moves for Antigravity only', () => {
  const body = 'Review only. Do not edit.';
  const role = { body, bodyFingerprint: computeBodyFingerprint(body) };
  /**
   * N3: the values before this change (develop 47017d1ce), for this role and name.
   * `art` is the sha256 of the generated file's bytes.
   */
  const BEFORE = {
    claude: { fp: '5dce73f64487d882f8938b3a0ae31d117525fdd7a9110119e998b95f6b84e3a1', art: '2c39095941b8385c9b97d363d148e6fcb6366c1df4b6a0858497c9e2334e3308' },
    codex: { fp: '4a1cb4f981148233d86255d3bec05a016499749b257e113a26ef3e205c539bb8', art: '9ce498e7cfc044565d9e9a4ffec837e7c20cb531a9cd5d527a726e4e76477d62' },
    'command-code': { fp: '245101c95f79a25627abffd0664ecc820e642d0c785e469480c95b04debe41fb', art: 'd91dcc213a4afe81afb6b202dde5872ae58132b19e5d67bcd689fa2d2fd798eb' },
    opencode: { fp: '018133f9c408ab6ee4e1ad5fa11f11c85adc24b7c02a2509b88aa97e3c18f7bb', art: '2c39095941b8385c9b97d363d148e6fcb6366c1df4b6a0858497c9e2334e3308' },
    'opencode-v2': { fp: '76c7782c5b9d9cf6b6cff0bcb0e31681a0565110a73fd8fc4cd43d6cdbf92269', art: '30ad5eebc8f536ac1ecc8626cabd9d0e8a188592f1fe1606d6389e952b637701' },
    copilot: { fp: 'bd8fa6e0cc28a87e0853a11aca06d58b2e9e91be505298fdb99da209e6fd6b89', art: '957503b8a05f050e328fc62e109ebf3488ddb265cacd705592060071af7346c5' },
    antigravity: { fp: 'a1340d289d7d2a9c8b46c12703a3be90ca77cf33f96404e7ff9a46f59a1b194a', art: '7b379fd5b1b4232f9e8c025a13aeeec24dc4ceed615881576254267c79d5eda8' },
  } as const;
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

  it.each(['claude', 'codex', 'command-code', 'opencode', 'opencode-v2', 'copilot'] as const)(
    'N3 %s: version 1, the fingerprint and the file bytes as before',
    (adapter) => {
      const injection = computeRoleInjection(adapter, role, {});
      expect(injection.adapterVersion).toBe('1');
      expect(injection.injectionFingerprint).toBe(BEFORE[adapter].fp);
      expect(sha(renderRoleArtifact(adapter, 'cm-role-x', injection.instructions))).toBe(BEFORE[adapter].art);
    }
  );

  it('Antigravity: version 2, and both its fingerprint and its file moved', () => {
    const injection = computeRoleInjection('antigravity', role, {});
    expect(injection.adapterVersion).toBe('2');
    expect(injection.injectionFingerprint).not.toBe(BEFORE.antigravity.fp);
    expect(sha(renderRoleArtifact('antigravity', 'cm-role-x', injection.instructions))).not.toBe(BEFORE.antigravity.art);
  });
});

describe('D4: the switch is gone', () => {
  it('P10 no source, locale, user guide or test names the switch', () => {
    // Built in two pieces so this file does not match itself.
    const pattern = ['CM_AGENT_ROLE_ANTIGRAVITY', '_ENABLED\\|isAgentRoleAdapter', 'Enabled'].join('');
    let out = '';
    try {
      out = execFileSync(
        'git',
        [
          'grep',
          '-n',
          pattern,
          '--',
          'src',
          'locales',
          'docs/user-guide',
          'docs/en',
          'tests',
          // The design's own wording test checks the design names what it removes.
          ':!tests/unit/docs/agy-role-default-design-4385.test.ts',
        ],
        { cwd: ROOT, encoding: 'utf8' }
      );
    } catch (error) {
      // git grep exits 1 when nothing matches.
      if ((error as { status?: number }).status !== 1) throw error;
    }
    expect(out).toBe('');
  });

  it('N6 every tool answers adapterEnabled: true, Antigravity included', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db);
      const defaults = buildSystemRoleDefaults(db);
      expect(defaults.map((entry) => entry.cliToolId)).toEqual([...AGENT_ROLE_CLI_TOOLS]);
      expect(defaults.every((entry) => entry.adapterEnabled === true)).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('D3: the listing compares whole rows', () => {
  it('P9 a name only as a prefix, a suffix or part of a row is not listed', () => {
    expect(agentListNames(`${NAME}x\nx${NAME}\n${NAME}-2\n`, NAME)).toBe(false);
    expect(agentListNames(`cm-hid  ${NAME}\n`, NAME)).toBe(false);
    expect(agentListNames('', NAME)).toBe(false);
    expect(agentListNames(`${NAME}\n`, '')).toBe(false);
  });

  it('(control) a row that is the name is listed, among others and with a CRLF', () => {
    expect(agentListNames(`other\n${NAME}\n`, NAME)).toBe(true);
    expect(agentListNames(`other\r\n  ${NAME}  \r\n`, NAME)).toBe(true);
  });
});

/**
 * The real child: a fake `agy` (a shell script) under `os.tmpdir()`. Real time,
 * with short limits; each run ends on the child's own exit or kill.
 */
describe('D3: runAgyAgentList runs agy agent once and keeps no output of agy\'s', () => {
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-agy-agent-list-4385-'));
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  /** A fake agy that runs `script` (sh) with `$1` = `agent`. */
  function fakeAgy(script: string): string {
    const file = path.join(base, 'agy');
    fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
    return file;
  }
  const run = (command: string, extra: { timeoutMs?: number; maxStdoutBytes?: number; env?: NodeJS.ProcessEnv } = {}) =>
    runAgyAgentList({ command, cwd: base, env: extra.env ?? { ...process.env }, timeoutMs: extra.timeoutMs, maxStdoutBytes: extra.maxStdoutBytes });

  it('lists what agy prints, run as `agy agent` in the given cwd with the given HOME', async () => {
    const home = path.join(base, 'home');
    const agy = fakeAgy('[ "$1" = agent ] || exit 9\necho "$PWD"\necho "$HOME"\necho cm-role-a');
    const outcome = await run(agy, { env: { ...process.env, HOME: home } });
    expect(outcome.kind).toBe('listed');
    const rows = (outcome as { stdout: string }).stdout.split('\n');
    expect(fs.realpathSync(rows[0])).toBe(fs.realpathSync(base));
    expect(rows[1]).toBe(home);
    expect(rows[2]).toBe('cm-role-a');
  });

  it('P6 a non-zero exit: failed, with the exit code and nothing agy said', async () => {
    const outcome = await run(fakeAgy('echo cm-role-a\necho "error: SECRET_ROW" >&2\nexit 3'));
    expect(outcome).toEqual({ kind: 'failed', why: 'exit code 3' });
  });

  it('P6 a timeout: the child is killed, and only the limit is said', async () => {
    const pidFile = path.join(base, 'pid');
    const started = Date.now();
    const outcome = await run(fakeAgy(`echo $$ > '${pidFile}'\nexec sleep 30`), { timeoutMs: 300 });
    expect(outcome).toEqual({ kind: 'failed', why: 'no answer within 0.3 s' });
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    // Killed with SIGKILL: the process is gone once it has been reaped.
    let alive = true;
    for (let i = 0; i < 100 && alive; i += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it('P6 a list over the stdout limit: failed, and the child is stopped', async () => {
    const outcome = await run(fakeAgy('while :; do echo cm-role-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; done'), { maxStdoutBytes: 1024 });
    expect(outcome).toEqual({ kind: 'failed', why: 'the list was longer than 1024 bytes' });
  });

  it('P6 the default limits are 10 s and 64 KiB', async () => {
    const outcome = await run(fakeAgy('head -c 70000 /dev/zero | tr "\\0" "a"'));
    expect(outcome).toEqual({ kind: 'failed', why: 'the list was longer than 65536 bytes' });
  });

  it('P6 agy missing: failed, never a rejection', async () => {
    const outcome = await run(path.join(base, 'no-such-agy'));
    expect(outcome).toEqual({ kind: 'failed', why: 'agy could not be started' });
  });
});
