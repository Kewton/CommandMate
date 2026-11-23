/**
 * Issue #4548: roles-sync.mjs compares the role bodies in the database with their
 * canon in docs/orchestrate/roles, reading only.
 *
 * Every case runs against a canon directory and a CLI made under os.tmpdir(): the
 * CLI is a function given to `main` (and, once, a node script spawned for real), so
 * no real `commandmate`, server or database is touched.
 *
 * @vitest-environment node
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CANON_ROLES,
  EXIT_MISMATCH,
  EXIT_OK,
  EXIT_UNREADABLE,
  EXIT_USAGE,
  MAX_ROLE_BODY_BYTES,
  SPAWN_TIMEOUT_MS,
  classifyRoles,
  fileFingerprint,
  main,
  readCanon,
} from '../../../../scripts/orchestrate/roles-sync.mjs';
import { MAX_ROLE_BODY_BYTES as TS_MAX_ROLE_BODY_BYTES } from '../../../../src/types/agent-roles';

const SCRIPT = path.resolve(__dirname, '../../../../scripts/orchestrate/roles-sync.mjs');

const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const bodyOf = (name: string): string => `# ${name}\n\nrole text of ${name}\n\n`;

let tmp: string;
let dir: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-roles-sync-4548-'));
  dir = path.join(tmp, 'roles');
  fs.mkdirSync(dir);
  for (const name of CANON_ROLES) fs.writeFileSync(path.join(dir, `${name}.md`), bodyOf(name));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

type Answer = { status: number; stdout: string; stderr?: string };

/** A CLI answering by verb; records the calls. */
function fakeCli(answers: { roles?: Answer; instances?: Record<string, Answer> }) {
  const calls: string[][] = [];
  const spawn = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    let a: Answer | undefined;
    if (args[0] === 'roles') a = answers.roles;
    if (args[0] === 'instances') a = answers.instances?.[args[1]];
    a ??= { status: 1, stdout: '', stderr: 'no answer' };
    return { status: a.status, stdout: Buffer.from(a.stdout), stderr: Buffer.from(a.stderr ?? '') };
  };
  return { spawn, calls };
}

/** Rows of `roles list --json` whose fingerprints are the given bodies'. */
function dbRows(bodies: Record<string, string> = Object.fromEntries(CANON_ROLES.map((n) => [n, bodyOf(n)]))) {
  return Object.entries(bodies).map(([name, body], i) => ({
    id: `r${i}`,
    name,
    bodyVersion: i + 2,
    bodyFingerprint: sha(body),
    bodyBytes: Buffer.byteLength(body),
    createdAt: 1,
    updatedAt: 2,
  }));
}
const listAnswer = (roles: unknown[], extra: Record<string, unknown> = {}): Answer => ({
  status: 0,
  stdout: JSON.stringify({ success: true, roles, ...extra }),
});

function run(argv: string[], cli: ReturnType<typeof fakeCli> | null, extra: { timeoutMs?: number } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, {
    ...(cli ? { spawn: cli.spawn } : {}),
    ...extra,
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
  });
  return { code, out, err };
}

/** A node script under tmp standing in for the CLI, run for real (no shell). */
function scriptCli(name: string, body: string): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}
const check = (cli: ReturnType<typeof fakeCli>, ...more: string[]) => run(['check', '--dir', dir, '--cli', 'fake-cm', ...more], cli);
const stateOf = (out: string[], name: string) => out.find((l) => l.startsWith(`ROLE ${name} `))?.split(' ')[2];

describe('roles-sync check (#4548)', () => {
  it('R1: every canon file matches its bodyFingerprint → exit 0, RESULT ok 4/4', () => {
    const cli = fakeCli({ roles: listAnswer(dbRows()) });
    const r = check(cli);
    expect(r.code).toBe(EXIT_OK);
    expect(r.out.at(-1)).toBe('RESULT ok 4/4');
    expect(cli.calls).toEqual([['fake-cm', 'roles', 'list', '--json']]);
    expect(r.out[0]).toMatch(/^ROLE project-manager ok v=2 db=[0-9a-f]{12} file=[0-9a-f]{12} bytes=\d+\/\d+$/);
  });

  /** R2's assertion, kept as a function so the positive control can run it against a broken comparison. */
  function expectR2(roles: Array<{ name: string; state: string }>) {
    expect(roles.find((r) => r.name === 'judge')?.state).toBe('differs');
    expect(roles.filter((r) => r.state !== 'ok').map((r) => r.name)).toEqual(['judge']);
  }

  it('R2: one file lost a trailing \\n (\\n\\n → \\n) → exit 1, only that role differs', () => {
    const body = bodyOf('judge');
    fs.writeFileSync(path.join(dir, 'judge.md'), body.slice(0, -1));
    const cli = fakeCli({ roles: listAnswer(dbRows()) });
    const r = check(cli);
    expect(r.code).toBe(EXIT_MISMATCH);
    expect(stateOf(r.out, 'judge')).toBe('differs');
    expect(r.out.at(-1)).toBe('RESULT mismatch 3/4');
    expectR2(classifyRoles({ roles: dbRows() }, readCanon(dir)));
  });

  it('R2 positive control: a comparison that always says "same" turns R2 red', () => {
    fs.writeFileSync(path.join(dir, 'judge.md'), bodyOf('judge').slice(0, -1));
    const broken = classifyRoles({ roles: dbRows() }, readCanon(dir), { same: () => true });
    expect(() => expectR2(broken)).toThrow();
  });

  it('R3: a CRLF copy that reads the same → exit 1 (no newline normalisation)', () => {
    fs.writeFileSync(path.join(dir, 'enabler.md'), bodyOf('enabler').replace(/\n/g, '\r\n'));
    const r = check(fakeCli({ roles: listAnswer(dbRows()) }));
    expect(r.code).toBe(EXIT_MISMATCH);
    expect(stateOf(r.out, 'enabler')).toBe('differs');
  });

  it('R4: a missing file → exit 1, missing-file', () => {
    fs.rmSync(path.join(dir, 'dev-leader.md'));
    const r = check(fakeCli({ roles: listAnswer(dbRows()) }));
    expect(r.code).toBe(EXIT_MISMATCH);
    expect(stateOf(r.out, 'dev-leader')).toBe('missing-file');
    expect(r.out.find((l) => l.startsWith('ROLE dev-leader'))).toContain('file=- bytes=');
  });

  it('R5: a role missing from the database / two rows of one name → missing-role / ambiguous-role', () => {
    const rows = dbRows().filter((row) => row.name !== 'judge');
    rows.push({ ...rows[0], id: 'dup' });
    const r = check(fakeCli({ roles: listAnswer(rows) }));
    expect(r.code).toBe(EXIT_MISMATCH);
    expect(stateOf(r.out, 'judge')).toBe('missing-role');
    expect(stateOf(r.out, 'project-manager')).toBe('ambiguous-role');
    expect(stateOf(r.out, 'dev-leader')).toBe('ok');
  });

  it.each<[string, Answer]>([
    ['the CLI exits 1 (no server)', { status: 1, stdout: '', stderr: 'server not running' }],
    ['the answer is not JSON', { status: 0, stdout: 'Roles:\n  judge v4\n' }],
    ['success is false', { status: 0, stdout: JSON.stringify({ success: false, error: 'x' }) }],
    ['success is true but roles is not a list', { status: 0, stdout: JSON.stringify({ success: true, roles: { judge: {} } }) }],
  ])('R6: %s → exit 3, neither 0 nor 1', (_label, answer) => {
    const r = check(fakeCli({ roles: answer }));
    expect(r.code).toBe(EXIT_UNREADABLE);
    expect(r.out.some((l) => l.startsWith('RESULT'))).toBe(false);
    expect(r.err.join('\n')).toContain('cannot compare');
  });

  it('R7: a role outside the canon (marketing-lead) is neither printed nor counted', () => {
    const rows = [...dbRows(), { ...dbRows()[0], id: 'm', name: 'marketing-lead', bodyFingerprint: 'f'.repeat(64) }];
    const r = check(fakeCli({ roles: listAnswer(rows) }));
    expect(r.code).toBe(EXIT_OK);
    expect(r.out.join('\n')).not.toContain('marketing-lead');
    expect(r.out.at(-1)).toBe('RESULT ok 4/4');
  });

  it('R8: a file over the body limit → exit 1, too-large; the limit equals MAX_ROLE_BODY_BYTES', () => {
    expect(MAX_ROLE_BODY_BYTES).toBe(TS_MAX_ROLE_BODY_BYTES);
    const big = 'x'.repeat(MAX_ROLE_BODY_BYTES + 1);
    fs.writeFileSync(path.join(dir, 'project-manager.md'), big);
    const r = check(fakeCli({ roles: listAnswer(dbRows({ ...Object.fromEntries(CANON_ROLES.map((n) => [n, bodyOf(n)])), 'project-manager': big })) }));
    expect(r.code).toBe(EXIT_MISMATCH);
    expect(stateOf(r.out, 'project-manager')).toBe('too-large');
    // Exactly at the limit is fine.
    const atLimit = 'y'.repeat(MAX_ROLE_BODY_BYTES);
    fs.writeFileSync(path.join(dir, 'project-manager.md'), atLimit);
    const r2 = check(fakeCli({ roles: listAnswer(dbRows({ ...Object.fromEntries(CANON_ROLES.map((n) => [n, bodyOf(n)])), 'project-manager': atLimit })) }));
    expect(r2.code).toBe(EXIT_OK);
  });

  it('R9: --json has the keys of §3.2', () => {
    const r = check(fakeCli({ roles: listAnswer(dbRows()) }), '--json');
    expect(r.code).toBe(EXIT_OK);
    const parsed = JSON.parse(r.out.join('\n'));
    expect(Object.keys(parsed).sort()).toEqual(['result', 'roles']);
    expect(parsed.result).toBe('ok');
    expect(parsed.roles.map((x: { name: string }) => x.name)).toEqual([...CANON_ROLES]);
    for (const row of parsed.roles) {
      expect(Object.keys(row).sort()).toEqual(
        ['bodyVersion', 'dbBytes', 'dbFingerprint', 'fileBytes', 'fileFingerprint', 'name', 'state'].sort(),
      );
    }
  });

  it('--roles narrows the roles compared', () => {
    const r = check(fakeCli({ roles: listAnswer(dbRows()) }), '--roles', 'judge');
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toHaveLength(2);
    expect(r.out.at(-1)).toBe('RESULT ok 1/1');
  });

  it('fileFingerprint is the sha256 of the bytes on disk', () => {
    const file = path.join(dir, 'judge.md');
    expect(fileFingerprint(file)).toBe(sha(fs.readFileSync(file)));
  });

  it('a CLI that outlives the timeout → exit 3 (the timeout is injectable; the default is a constant)', () => {
    expect(SPAWN_TIMEOUT_MS).toBe(60_000);
    const slow = scriptCli('slow-cm.mjs', 'setTimeout(() => {}, 30_000);');
    const started = Date.now();
    const r = run(['check', '--dir', dir, '--cli', slow], null, { timeoutMs: 300 });
    expect(r.code).toBe(EXIT_UNREADABLE);
    expect(r.err.join('\n')).toContain('cannot compare');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('a CLI killed by a signal → exit 3', () => {
    const killed = scriptCli('killed-cm.mjs', "process.kill(process.pid, 'SIGKILL');");
    const r = run(['check', '--dir', dir, '--cli', killed], null);
    expect(r.code).toBe(EXIT_UNREADABLE);
    expect(r.err.join('\n')).toContain('SIGKILL');
  });

  it('started through a symlinked path, it still runs main (bogus → exit 2, not a silent 0)', () => {
    const link = path.join(tmp, 'linked-orchestrate');
    fs.symlinkSync(path.dirname(SCRIPT), link, 'dir');
    const r = spawnSync(process.execPath, [path.join(link, 'roles-sync.mjs'), 'bogus'], { encoding: 'utf8', timeout: 15_000 });
    expect(r.status).toBe(EXIT_USAGE);
    expect(r.stderr).toContain('unknown subcommand: bogus');
  });

  it('runs as a script: a fake CLI spawned without a shell, exit code passed through', () => {
    const fake = path.join(tmp, 'fake-cm.mjs');
    fs.writeFileSync(
      fake,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ success: true, roles: dbRows() }))});\n`,
    );
    fs.chmodSync(fake, 0o755);
    const r = spawnSync(process.execPath, [SCRIPT, 'check', '--cli', fake, '--dir', dir], { encoding: 'utf8', timeout: 15_000 });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(EXIT_OK);
    expect(r.stdout.trim().split('\n').at(-1)).toBe('RESULT ok 4/4');
  });
});

describe('roles-sync launched (#4548)', () => {
  const canonFp = (name: string) => sha(bodyOf(name));
  const row = (instanceId: string, running: boolean, role: Record<string, unknown> | undefined) => ({
    instanceId,
    cliTool: 'claude',
    running,
    ...(role ? { role } : {}),
  });
  const withRole = (name: string, launchedFp: string | null) => ({
    stored: { state: 'role', roleId: 'x', roleName: name },
    effectiveNext: { kind: 'role', source: 'instance', role: { id: 'x', name } },
    launched: launchedFp === null ? null : { roleName: name, bodyVersion: 3, bodyFingerprint: launchedFp },
    requested: null,
    restartPending: 'no',
  });
  const instances = (rows: unknown[]): Answer => ({ status: 0, stdout: JSON.stringify(rows) });
  const launched = (cli: ReturnType<typeof fakeCli>, wts = 'wt1', ...more: string[]) =>
    run(['launched', '--worktrees', wts, '--dir', dir, '--cli', 'fake-cm', ...more], cli);
  const stateIn = (out: string[], id: string) => out.find((l) => l.split(' ')[2] === id)?.split(' ')[4];

  it('L1: running and launched with the canon body → current, exit 0', () => {
    const cli = fakeCli({ instances: { wt1: instances([row('claude', true, withRole('project-manager', canonFp('project-manager')))]) } });
    const r = launched(cli);
    expect(r.code).toBe(EXIT_OK);
    expect(stateIn(r.out, 'claude')).toBe('current');
    expect(cli.calls).toEqual([['fake-cm', 'instances', 'wt1', 'list', '--require-roles', '--json']]);
  });

  it('L2: running with an older body → stale, exit 1', () => {
    const r = launched(fakeCli({ instances: { wt1: instances([row('claude-8', true, withRole('dev-leader', 'a'.repeat(64)))]) } }));
    expect(r.code).toBe(EXIT_MISMATCH);
    expect(stateIn(r.out, 'claude-8')).toBe('stale');
  });

  it('L3: running with no launch record → unknown, exit 1', () => {
    const r = launched(fakeCli({ instances: { wt1: instances([row('claude-4', true, withRole('enabler', null))]) } }));
    expect(r.code).toBe(EXIT_MISMATCH);
    expect(stateIn(r.out, 'claude-4')).toBe('unknown');
  });

  it('L4: stopped with an older body → stopped, exit 0', () => {
    const r = launched(fakeCli({ instances: { wt1: instances([row('claude-6', false, withRole('judge', 'b'.repeat(64)))]) } }));
    expect(r.code).toBe(EXIT_OK);
    expect(stateIn(r.out, 'claude-6')).toBe('stopped');
  });

  it('L5: a role outside the canon, no role, none and inherit-without-role are not counted', () => {
    const rows = [
      row('a', true, withRole('marketing-lead', 'c'.repeat(64))),
      row('b', true, undefined),
      row('c', true, { stored: { state: 'none' }, effectiveNext: { kind: 'none' }, launched: null }),
      row('d', true, { stored: { state: 'inherit' }, effectiveNext: { kind: 'none' }, launched: null }),
    ];
    const r = launched(fakeCli({ instances: { wt1: instances(rows) } }));
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toEqual(['RESULT ok 0/0']);
  });

  it('inherit that resolves to a canon role is counted by effectiveNext', () => {
    const role = { stored: { state: 'inherit' }, effectiveNext: { kind: 'role', role: { name: 'judge' } }, launched: null };
    const r = launched(fakeCli({ instances: { wt1: instances([row('codex-3', true, role)]) } }));
    expect(r.code).toBe(EXIT_MISMATCH);
    expect(stateIn(r.out, 'codex-3')).toBe('unknown');
  });

  it('reads every worktree given in --worktrees, and only those', () => {
    const cli = fakeCli({
      instances: {
        wt1: instances([row('claude', true, withRole('project-manager', canonFp('project-manager')))]),
        wt2: instances([row('claude', true, withRole('judge', canonFp('judge')))]),
      },
    });
    const r = launched(cli, 'wt1,wt2', '--json');
    expect(r.code).toBe(EXIT_OK);
    expect(cli.calls.map((c) => c[2])).toEqual(['wt1', 'wt2']);
    const parsed = JSON.parse(r.out.join('\n'));
    expect(parsed.worktrees.map((w: { worktree: string }) => w.worktree)).toEqual(['wt1', 'wt2']);
  });

  it('a canon file missing under --dir → exit 3, and no worktree is asked', () => {
    fs.rmSync(path.join(dir, 'judge.md'));
    const cli = fakeCli({ instances: { wt1: instances([]) } });
    const r = launched(cli);
    expect(r.code).toBe(EXIT_UNREADABLE);
    expect(r.err.join('\n')).toContain('judge');
    expect(cli.calls).toEqual([]);
  });

  it.each<[string, Answer]>([
    ['the CLI exits 1', { status: 1, stdout: '' }],
    ['not JSON', { status: 0, stdout: 'table' }],
    ['not a list', { status: 0, stdout: JSON.stringify({ success: false }) }],
  ])('a worktree that cannot be read (%s) → exit 3', (_label, answer) => {
    const r = launched(fakeCli({ instances: { wt1: answer } }));
    expect(r.code).toBe(EXIT_UNREADABLE);
  });
});

describe('roles-sync arguments (#4548)', () => {
  it.each<[string, string[]]>([
    ['no subcommand', []],
    ['an unknown subcommand', ['apply']],
    ['launched without --worktrees', ['launched']],
    ['launched with an empty --worktrees', ['launched', '--worktrees', ',']],
    ['an unknown option', ['check', '--write']],
    ['--cli without a value', ['check', '--cli']],
  ])('A1: %s → exit 2 and no CLI call', (_label, argv) => {
    const cli = fakeCli({});
    const r = run(argv, cli);
    expect(r.code).toBe(EXIT_USAGE);
    expect(cli.calls).toEqual([]);
  });

  it('the script calls only read verbs of the CLI (no edit, default or set-role)', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    const calls = [...source.matchAll(/readJson\(spawn, o\.cli, \[([^\]]*)\]/g)].map((m) => m[1]);
    expect(calls).toEqual(["'roles', 'list', '--json'", "'instances', wt, 'list', '--require-roles', '--json'"]);
    expect(source).toContain('shell: false');
  });
});
