/**
 * Issue #3046: scripts/agent-health/release-report-main.ts writes the HTML
 * whatever is missing. git / gh / npm go through an injected `exec` stub;
 * every file lives under os.tmpdir() and is removed after each test.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type Exec } from '../../../../scripts/agent-health/release-report-main';

let root: string;
let stateDir: string;
let runsDir: string;
let out: string;
let lines: string[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-release-report-'));
  stateDir = path.join(root, 'state');
  runsDir = path.join(root, 'runs');
  out = path.join(root, 'out', 'release-readiness.html');
  lines = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const failAll: Exec = () => ({ status: null, stdout: '' });

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function run(argv: string[], exec: Exec = failAll): Promise<{ code: number; html: string }> {
  const code = await main(
    ['--date', '2026-10-01', '--out', out, '--state-dir', stateDir, '--runs-dir', runsDir, ...argv],
    {
      exec,
      now: () => new Date('2026-10-01T10:00:00Z'),
      env: {} as NodeJS.ProcessEnv,
      homedir: path.join(root, 'home'),
      repoDir: root,
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    }
  );
  return { code, html: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '' };
}

describe('release-report main', () => {
  it('writes the HTML as "依頼なし" when nothing exists and no command works', async () => {
    const { code, html } = await run(['--no-audit']);
    expect(code).toBe(0);
    expect(html).toContain('依頼なし');
    expect(html).toContain('<section class="banner hold"');
    expect(html).toContain('取得できなかった事実');
    expect(lines.join('\n')).toMatch(/RELEASE_READINESS date=2026-10-01 verdict=hold dispatched=0/);
    expect(fs.existsSync(path.join(root, 'home'))).toBe(false);
  });

  it('treats a broken dispatch record as none', async () => {
    write(path.join(stateDir, 'dispatch', '2026-10-01.json'), '{ broken');
    const { code, html } = await run(['--no-gh', '--no-audit']);
    expect(code).toBe(0);
    expect(html).toContain('依頼なし');
  });

  it('exits 2 on bad arguments without writing', async () => {
    const code = await main(['--date', 'x'], { stdout: () => {}, stderr: (l) => lines.push(l) });
    expect(code).toBe(2);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('assembles gh, git, run files and metrics into a verdict', async () => {
    write(
      path.join(stateDir, 'dispatch', '2026-10-01.json'),
      JSON.stringify({
        schemaVersion: 1,
        date: '2026-10-01',
        status: 'sent',
        sentAt: '2026-10-01T00:30:00Z',
        issues: [
          { number: 3050, kind: 'bug', title: 'codex screen-idle' },
          { number: 3051, kind: 'metrics', title: 'file-size' },
        ],
        deferred: [],
      })
    );
    const metrics = (value: number) =>
      JSON.stringify({
        schemaVersion: 1,
        startedAt: '',
        completedAt: '',
        metrics: [{ metricId: 'npm-audit', category: 'security', status: 'pass', value, summary: '', candidates: [] }],
      });
    write(path.join(stateDir, 'metrics', '2026-10-01.json'), metrics(1));
    write(path.join(stateDir, 'metrics', '2026-09-30.json'), metrics(1));
    write(
      path.join(stateDir, 'reports', '2026-10-02.json'),
      JSON.stringify({
        completedAt: '2026-10-01T23:00:00Z',
        tools: [{ tool: 'codex', checks: [{ checkId: 'screen-idle', status: 'pass' }] }],
      })
    );
    write(path.join(runsDir, '2026-10-01', 'tasks-3050-3051.tsv'), '3050\tcommandmate-issue-3050\tclaude\tid\topus\n');
    write(path.join(runsDir, '2026-10-01', 'wait-3050.log'), 'GATE lint PASS\nRESULT passed\n');
    write(path.join(runsDir, '2026-10-01', 'summary.md'), '## 結果\n- 2 件マージ\n');
    const findings = path.join(root, 'findings.md');
    write(findings, '- 所見: 問題なし\n');

    const green = [{ __typename: 'CheckRun', name: 'Unit', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }];
    const exec: Exec = (command, args) => {
      const key = `${command} ${args.join(' ')}`;
      if (key.startsWith('git rev-parse --verify')) return { status: 0, stdout: 'x\n' };
      if (key === 'git rev-parse origin/develop') return { status: 0, stdout: 'b104f8e74b2e47230cd9e428ef95126d45af531a\n' };
      if (key.startsWith('git describe')) return { status: 0, stdout: 'v0.43.0\n' };
      if (key.startsWith('git rev-list --count')) return { status: 0, stdout: '4\n' };
      if (key.startsWith('git log -1')) return { status: 0, stdout: '2026-09-30T22:58:02+09:00\n' };
      if (key.startsWith('git ls-tree')) return { status: 0, stdout: 'changelog.d/README.md\nchangelog.d/3050.md\n' };
      if (key.startsWith('git show')) return { status: 0, stdout: '<!-- ### Fixed -->\n- **fix: y** (#3050): z\n' };
      if (key.startsWith('gh run list')) {
        return { status: 0, stdout: JSON.stringify([{ workflowName: 'CI', status: 'completed', conclusion: 'success' }]) };
      }
      if (key.startsWith('gh pr list')) {
        return {
          status: 0,
          stdout: JSON.stringify([
            { number: 3060, title: 'fix: y (#3050)', url: 'https://github.com/o/r/pull/3060', state: 'MERGED', headRefName: 'fix/3050-y', baseRefName: 'develop', mergedAt: '2026-10-01T03:00:00Z', mergeCommit: { oid: 'aaaaaaaa1111' }, headRefOid: 'bbbb', body: '' },
            { number: 3061, title: 'refactor: split (#3051)', url: 'https://github.com/o/r/pull/3061', state: 'MERGED', headRefName: 'refactor/3051-s', baseRefName: 'develop', mergedAt: '2026-10-01T04:00:00Z', mergeCommit: { oid: 'cccccccc2222' }, headRefOid: 'dddd', body: '' },
          ]),
        };
      }
      if (key.startsWith('gh pr view')) return { status: 0, stdout: JSON.stringify({ statusCheckRollup: green }) };
      if (key.startsWith('gh issue list')) {
        return { status: 0, stdout: JSON.stringify([{ number: 3055, title: 'open one', url: 'https://github.com/o/r/issues/3055', labels: [{ name: 'agent-health' }] }]) };
      }
      if (key.startsWith('gh issue view 3050')) return { status: 0, stdout: JSON.stringify({ body: 'id agent-health:codex:screen-idle' }) };
      if (key.startsWith('git rev-parse --path-format')) return { status: 0, stdout: `${root}/.git\n` };
      return { status: 1, stdout: '' };
    };

    const { code, html } = await run(['--findings', findings], exec);
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('verdict=go dispatched=2');
    expect(html).toContain('<div class="verdict">GO</div>');
    expect(html).toContain('claude (opus)');
    expect(html).toContain('aaaaaaaa');
    expect(html).toContain('develop で pass');
    expect(html).toContain('exit 0');
    expect(html).toContain('3050.md');
    expect(html).not.toContain('README.md');
    expect(html).toContain('#3055');
    expect(html).toContain('所見: 問題なし');
    expect(html).toContain('summary.md');
    expect(html).toContain('npm-audit');
    expect(html).not.toContain('取得できなかった事実');
  });
});

describe('release-report main with a runSuffix (#3045)', () => {
  it('reads only the run files of the dispatched run', async () => {
    write(
      path.join(stateDir, 'dispatch', '2026-10-01.json'),
      JSON.stringify({
        schemaVersion: 1,
        date: '2026-10-01',
        status: 'sent',
        issues: [{ number: 3050, kind: 'bug', title: 'x' }],
        deferred: [],
        runSuffix: '3050',
      })
    );
    const day = path.join(runsDir, '2026-10-01');
    write(path.join(day, 'summary-3050.md'), '- mine\n');
    write(path.join(day, 'summary-9000-9001.md'), '- another run\n');
    write(path.join(day, 'summary.md'), '- unsuffixed\n');
    write(path.join(day, 'tasks-3050.tsv'), '3050\tcommandmate-issue-3050\tclaude\tid\topus\n');
    write(path.join(day, 'tasks-9000-9001.tsv'), '3050\tcommandmate-issue-3050\tcodex\tid\tgpt\n');
    const { code, html } = await run(['--no-gh', '--no-audit']);
    expect(code).toBe(0);
    expect(html).toContain('summary-3050.md');
    expect(html).not.toContain('another run');
    expect(html).not.toContain('unsuffixed');
    expect(html).toContain('claude (opus)');
    expect(html).not.toContain('codex (gpt)');
  });
});

describe('release-report main open Issues (#3173)', () => {
  it('lists catalog-drift Issues and shows a multi-label Issue once', async () => {
    const item = (number: number, labels: string[]) => ({
      number,
      title: `issue ${number}`,
      url: `https://github.com/o/r/issues/${number}`,
      labels: labels.map((name) => ({ name })),
    });
    const byLabel: Record<string, unknown[]> = {
      'agent-health': [item(4001, ['agent-health']), item(4004, ['agent-health', 'catalog-drift'])],
      'catalog-drift': [item(4002, ['catalog-drift']), item(4004, ['agent-health', 'catalog-drift'])],
      metrics: [item(4003, ['metrics'])],
    };
    const exec: Exec = (command, args) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        const label = args[args.indexOf('--label') + 1];
        return { status: 0, stdout: JSON.stringify(byLabel[label] ?? []) };
      }
      return { status: null, stdout: '' };
    };
    const { code, html } = await run(['--no-audit'], exec);
    expect(code).toBe(0);
    for (const n of [4001, 4002, 4003, 4004]) expect(html).toContain(`#${n}`);
    expect(html.split('issues/4004"').length - 1).toBe(1);
  });
});
