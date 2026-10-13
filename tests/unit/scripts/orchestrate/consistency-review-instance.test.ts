/**
 * scripts/orchestrate/consistency-review.mjs — `--instance` (Issue #3618).
 * Everything is under os.tmpdir(); `git` / the CLI are injected.
 *
 * #3633 A: the lookup goes through `--cli` (`reply --json`) like capture and
 * ask, so it reaches the server the CLI decides on (`.env`, CM_BIND, HTTPS),
 * not one built from `process.env`. The fake CLI below decides its server from
 * a `.env` in its cwd, and every request records the host it went to.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, parseArgs } from '../../../../scripts/orchestrate/consistency-review.mjs';
import { readRecords } from '../../../../scripts/orchestrate/run-log.mjs';

const HEAD = 'c0ffee1' + '0'.repeat(33);
const REPLY = JSON.stringify({ reply: '指摘なし\n\nDONE: 指摘なし' });

let tmp: string;
let runDir: string;
let heldLocks: string[];
let resolveUrls: string[];
let hosts: string[];
let calls: { command: string; args: string[] }[];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-consistency-instance-'));
  runDir = path.join(tmp, 'runs', '2026-10-12');
  fs.writeFileSync(path.join(tmp, 'brief.txt'), '機能追加です。\n');
  calls = [];
  heldLocks = [];
  resolveUrls = [];
  hosts = [];
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The server the fake CLI talks to: `.env` in its cwd (CM_BIND / CM_PORT), else localhost:3000 — as server-url.ts decides. */
const cliServer = (cwd?: string) => {
  const env = cwd && fs.existsSync(path.join(cwd, '.env')) ? fs.readFileSync(path.join(cwd, '.env'), 'utf8') : '';
  const value = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(env)?.[1];
  return `${value('CM_BIND') ?? 'localhost'}:${value('CM_PORT') ?? '3000'}`;
};

const run = (command: string, args: string[], opts: { cwd?: string } = {}) => {
  calls.push({ command, args });
  if (command === 'git') return { status: 0, stdout: args.includes('--abbrev-ref') ? 'feature/x\n' : `${HEAD}\n`, stderr: '' };
  if (command === 'curl') {
    // The pre-#3633 lookup: a URL built from process.env.
    hosts.push(new URL(args[args.length - 1]).host);
    return { status: 0, stdout: `${JSON.stringify({ instanceId: 'codex-2' })}\n200`, stderr: '' };
  }
  hosts.push(cliServer(opts.cwd));
  if (args[0] === 'reply') {
    // The server's resolve-target, through the CLI: an exact id or the primary first, then a case-folded alias.
    const selector = args[args.indexOf('--instance') + 1];
    resolveUrls.push(`/api/worktrees/${args[1]}/resolve-target?instance=${encodeURIComponent(selector)}`);
    const table: Record<string, string> = { codex: 'codex', 'codex-2': 'codex-2', reviewer: 'codex-2', 'レビュー 担当': 'codex-2', 'a/x': 'codex-2' };
    const id = table[selector] ?? table[selector.toLowerCase()];
    return id
      ? { status: 0, stdout: JSON.stringify({ worktreeId: args[1], instanceId: id, cliToolId: 'codex', reply: null }), stderr: '' }
      : { status: 2, stdout: '', stderr: `Error: Instance '${selector}' not found` };
  }
  if (args[0] === 'capture') {
    const dir = path.join(tmp, 'workspace', 'proposals', '2026-10-12');
    heldLocks.push(...(fs.existsSync(dir) ? fs.readdirSync(dir) : []));
  }
  if (args[0] === 'capture') {
    return { status: 0, stdout: JSON.stringify({ sessionStatus: 'ready' }), stderr: '' };
  }
  if (args[0] === 'ask') return { status: 0, stdout: REPLY, stderr: '' };
  throw new Error(`unexpected call: ${command} ${args.join(' ')}`);
};
const argv = (extra: string[] = []) => [
  '--run-dir', runDir, '--issues', '3618', '--issue', '3618', '--head', HEAD.slice(0, 7),
  '--brief', path.join(tmp, 'brief.txt'), '--worktree', path.join(tmp, 'wt'), '--cli', 'cmd-fake', ...extra,
];
const go = (extra: string[] = []) =>
  main(argv(extra), { run, sleep: () => {}, now: () => new Date(Date.UTC(2026, 9, 12)), cwd: tmp, log: () => {}, error: () => {} });
const instancesOf = (verb: string) => calls.filter((c) => c.args[0] === verb).map((c) => c.args[c.args.indexOf('--instance') + 1]);

describe('--instance', () => {
  it('sends capture, ask and the run record to the given instance', () => {
    expect(go(['--instance', 'codex-2'])).toBe(0);
    expect(instancesOf('capture')).toEqual(['codex-2', 'codex-2', 'codex-2']);
    expect(instancesOf('ask')).toEqual(['codex-2']);
    expect(readRecords(runDir, '3618').records.find((r) => r.stage === 'review')).toMatchObject({ result: 'ok', agent: 'codex-2' });
  });

  it('takes a lock named after the instance (and releases it)', () => {
    const lock = path.join(tmp, 'workspace', 'proposals', '2026-10-12');
    expect(go(['--instance', 'codex-2'])).toBe(0);
    expect(fs.existsSync(path.join(lock, '.lock-codex-2'))).toBe(false);
    // A held codex lock does not block codex-2: the sessions are independent.
    fs.mkdirSync(path.join(lock, '.lock'), { recursive: true });
    expect(go(['--instance', 'codex-2'])).toBe(0);
  });

  it('resolves an alias to the real instance id for lock, ask and record', () => {
    expect(go(['--instance', 'reviewer'])).toBe(0);
    expect(instancesOf('capture')).toEqual(['codex-2', 'codex-2', 'codex-2']);
    expect(instancesOf('ask')).toEqual(['codex-2']);
    expect(readRecords(runDir, '3618').records.find((r) => r.stage === 'review')).toMatchObject({ agent: 'codex-2' });
    // alias and id share one lock: the lock taken for the alias is `.lock-codex-2`
    expect(heldLocks).toEqual(['.lock-codex-2', '.lock-codex-2', '.lock-codex-2']);
  });

  it('asks the server, so primary-over-alias, case and non-ASCII aliases follow its rules', () => {
    expect(go(['--instance', 'Reviewer'])).toBe(0);
    expect(go(['--instance', 'レビュー 担当'])).toBe(0);
    expect(resolveUrls[0]).toBe('/api/worktrees/mycodebranchdesk/resolve-target?instance=Reviewer');
    expect(resolveUrls[1]).toContain('instance=%E3%83%AC');
    expect(instancesOf('ask')).toEqual(['codex-2', 'codex-2']);
  });

  it('a name that is both a primary and an alias is whatever the server answers (primary first)', () => {
    // `codex` is also an alias of nothing here; the server answers the primary.
    expect(go(['--instance', 'codex'])).toBe(0);
    expect(instancesOf('ask')).toEqual(['codex']);
    expect(readRecords(runDir, '3618').records.find((r) => r.stage === 'review')).toMatchObject({ agent: 'codex' });
  });

  it('an unknown instance exits 2 and sends nothing', () => {
    expect(go(['--instance', 'nobody'])).toBe(2);
    expect(calls.map((c) => c.args[0])).toEqual(['reply']);
  });

  it('negative control: without --instance everything stays on codex', () => {
    expect(parseArgs(argv()).options?.instance).toBe('codex');
    expect(go()).toBe(0);
    expect(instancesOf('capture')).toEqual(['codex', 'codex', 'codex']);
    expect(instancesOf('ask')).toEqual(['codex']);
    expect(readRecords(runDir, '3618').records.find((r) => r.stage === 'review')).toMatchObject({ agent: 'codex' });
  });

  // #3633 A: the same condition as the CLI's isInstanceSelector and resolve-target (an alias is free text).
  it('rejects an instance id that is not an id', () => {
    expect(parseArgs(argv(['--instance', 'a\u0007x'])).error).toMatch(/--instance/);
    expect(parseArgs(argv(['--instance', ''])).error).toMatch(/--instance/);
    expect(parseArgs(argv(['--instance', 'レ'.repeat(51)])).error).toMatch(/--instance/);
  });

  it('accepts what the CLI accepts: an alias with / or \\, and a 64-character id (#3633)', () => {
    expect(parseArgs(argv(['--instance', 'a/x'])).error).toBeUndefined();
    expect(parseArgs(argv(['--instance', 'a\\x'])).error).toBeUndefined();
    expect(parseArgs(argv(['--instance', 'i'.repeat(64)])).error).toBeUndefined();
  });

  it('an alias with / locks by the resolved id, never by the alias (#3633)', () => {
    expect(go(['--instance', 'a/x'])).toBe(0);
    expect(heldLocks).toEqual(['.lock-codex-2', '.lock-codex-2', '.lock-codex-2']);
  });
});

describe('the lookup goes to the server the CLI decides on (#3633 A)', () => {
  const saved = { CM_PORT: process.env.CM_PORT, CM_API_BASE: process.env.CM_API_BASE, CM_AUTH_TOKEN: process.env.CM_AUTH_TOKEN };
  beforeEach(() => {
    delete process.env.CM_PORT;
    delete process.env.CM_API_BASE;
    delete process.env.CM_AUTH_TOKEN;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('a port set only in .env: the lookup, capture and ask all reach that server', () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'CM_BIND=127.0.0.1\nCM_PORT=3107\n');
    expect(go(['--instance', 'reviewer'])).toBe(0);
    expect(calls.map((c) => c.command)).not.toContain('curl');
    expect(calls.filter((c) => c.command !== 'git').every((c) => c.command === 'cmd-fake')).toBe(true);
    expect(new Set(hosts)).toEqual(new Set(['127.0.0.1:3107']));
  });

  it('negative control: no .env — every request still goes to one server (the default)', () => {
    expect(go(['--instance', 'reviewer'])).toBe(0);
    expect(new Set(hosts)).toEqual(new Set(['localhost:3000']));
  });
});
