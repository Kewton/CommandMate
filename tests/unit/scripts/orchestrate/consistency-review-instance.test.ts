/**
 * scripts/orchestrate/consistency-review.mjs — `--instance` (Issue #3618).
 * Everything is under os.tmpdir(); `git` / the CLI are injected.
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
let calls: { command: string; args: string[] }[];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-consistency-instance-'));
  runDir = path.join(tmp, 'runs', '2026-10-12');
  fs.writeFileSync(path.join(tmp, 'brief.txt'), '機能追加です。\n');
  calls = [];
  heldLocks = [];
  resolveUrls = [];
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const run = (command: string, args: string[]) => {
  calls.push({ command, args });
  if (command === 'git') return { status: 0, stdout: args.includes('--abbrev-ref') ? 'feature/x\n' : `${HEAD}\n`, stderr: '' };
  if (command === 'curl') {
    // The server's resolve-target: an exact id or the primary first, then a case-folded alias.
    const url = new URL(args[args.length - 1]);
    resolveUrls.push(url.pathname + url.search);
    const selector = url.searchParams.get('instance') ?? '';
    const table: Record<string, string> = { codex: 'codex', 'codex-2': 'codex-2', reviewer: 'codex-2', 'レビュー 担当': 'codex-2' };
    const id = table[selector] ?? table[selector.toLowerCase()];
    return id
      ? { status: 0, stdout: `${JSON.stringify({ instanceId: id })}\n200`, stderr: '' }
      : { status: 0, stdout: `${JSON.stringify({ error: 'Invalid' })}\n404`, stderr: '' };
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
    expect(calls.map((c) => c.command)).toEqual(['curl']);
  });

  it('negative control: without --instance everything stays on codex', () => {
    expect(parseArgs(argv()).options?.instance).toBe('codex');
    expect(go()).toBe(0);
    expect(instancesOf('capture')).toEqual(['codex', 'codex', 'codex']);
    expect(instancesOf('ask')).toEqual(['codex']);
    expect(readRecords(runDir, '3618').records.find((r) => r.stage === 'review')).toMatchObject({ agent: 'codex' });
  });

  it('rejects an instance id that is not an id', () => {
    expect(parseArgs(argv(['--instance', 'a/x'])).error).toMatch(/--instance/);
  });
});
