/**
 * `/orchestrate` splits Claude workers into opus and sonnet (Issue #2770).
 *
 * ## What this pins
 *
 * The runbook is executed by an LLM, so nothing fails when two of its sections
 * disagree — the same reason `orchestrate-merge-gate-consistency.test.ts`
 * exists. Three things here are easy to get half-right and silently wrong:
 *
 *  1. **The model is not an `--instance` value.** `--assign 123=claude-sonnet`
 *     is a way to write assign.tsv; `--instance claude-sonnet` would address a
 *     session that does not exist, and `wait` would sit on it until timeout.
 *  2. **The model is fixed when the session starts.** It is written to the
 *     worktree's `.claude/settings.local.json` BEFORE the first send, and the
 *     only way to raise sonnet to opus is a new session (3-5b). Since #3883 it
 *     is written explicitly for opus too (it used to be deleted, so opus
 *     inherited the operator's global default), by one helper —
 *     scripts/orchestrate/launch-worker.mjs — that 3-1, 3-5 and 3-5b all call,
 *     and a session whose model does not match after one restart is stopped.
 *  3. **`/model` must never be sent to a worker.** Enter on that picker rewrites
 *     the operator's global default (#1495 / #2297).
 *
 * The second half pins the agent definitions. A subagent with `model: opus`
 * runs on opus even inside a sonnet session (measured on claude 2.1.278), which
 * would quietly undo the split; `model: inherit` follows the session. What keeps
 * the review / TDD agents on opus when a sonnet-pinned command calls them is the
 * `(model: opus)` in that command's own sentence — the model passes it to the
 * Task tool — so that sentence is pinned too.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { MODEL_SETTINGS, main as launchWorker, parseArgs as parseLaunchArgs } from '../../../scripts/orchestrate/launch-worker.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const ORCHESTRATE_PATH = '.claude/commands/orchestrate.md';
const COMMANDS_DIR = path.join(REPO_ROOT, '.claude/commands');
const AGENTS_DIR = path.join(REPO_ROOT, '.claude/agents');

const orchestrate = readFileSync(path.join(REPO_ROOT, ORCHESTRATE_PATH), 'utf-8');

// Since #3481 (2 本目) the run-time-optional procedures live in docs/orchestrate/; the body section points there.
/** The `## <heading>` section of docs/orchestrate/<file>, up to the next `## ` heading. */
function docSection(file: string, heading: string): string {
  const doc = readFileSync(path.join(REPO_ROOT, 'docs/orchestrate', file), 'utf-8');
  const start = doc.indexOf(`\n## ${heading}\n`);
  expect(start, `docs/orchestrate/${file} has no \`## ${heading}\``).toBeGreaterThanOrEqual(0);
  const end = doc.indexOf('\n## ', start + 1);
  return doc.slice(start, end === -1 ? undefined : end);
}

/** The body of `### <id>. …`, up to the next `### ` heading. */
function section(id: string): string {
  const lines = orchestrate.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`### ${id}.`));
  expect(start, `${ORCHESTRATE_PATH} has no \`### ${id}.\` heading`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('### '));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n');
  expect(body.trim().length, `section ${id} is empty`).toBeGreaterThan(200);
  return body;
}

const LAUNCHER_PATH = 'scripts/orchestrate/launch-worker.mjs';
const launcher = readFileSync(path.join(REPO_ROOT, LAUNCHER_PATH), 'utf-8');

/**
 * The calls launch-worker.mjs makes for one Claude send whose session reports
 * `reported`, against a fake CLI and git (#3883). Files go under os.tmpdir().
 */
function launchCalls(reported: string): { code: number; calls: string[]; contractAt: number[] } {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'cm-2770-launch-'));
  try {
    const calls: string[] = [];
    /** Where in `calls` the contract went out (the session is started first without it, #3883 N1). */
    const contractAt: number[] = [];
    let running = true;
    const run = (command: string, args: string[]) => {
      if (command === 'git') {
        calls.push(`git ${args.slice(2).join(' ')}`);
        return { status: 0, stdout: '', stderr: '' };
      }
      // The instance is resolved first (`reply --json`, #4238 review); not one of the calls this test reads.
      if (args[0] === 'reply') return { status: 0, stdout: JSON.stringify({ instanceId: 'claude', cliToolId: 'claude', reply: null }), stderr: '' };
      calls.push(args[0] === 'instances' ? `instances ${args[2]}` : args[0]);
      if (args[0] === 'instances' && args[2] === '--json') return { status: 0, stdout: JSON.stringify([{ instanceId: 'claude', running }]), stderr: '' };
      if (args[0] === 'instances' && args[2] === 'kill') running = false;
      if (args[0] === 'send') {
        running = true;
        if (args.includes('--contract')) contractAt.push(calls.length - 1);
        return { status: 0, stdout: args.includes('--contract') ? 'task-1\n' : '', stderr: '' };
      }
      if (args[0] === 'capture') return { status: 0, stdout: JSON.stringify({ model: reported, sessionStatus: 'ready' }), stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const code = launchWorker(
      ['send', '--run-dir', path.join(tmp, 'runs'), '--issue', '2770', '--wt', 'wt-1', '--worktree', path.join(tmp, 'wt'),
        '--instance', 'claude', '--model', 'opus', '--contract', '.commandmate/tasks/issue-2770.yaml'],
      { run, sleep: () => {}, out: () => {}, log: () => {}, error: () => {} }
    );
    return { code, calls, contractAt };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** `model:` from a markdown file's leading `---` block, or null. */
function frontmatterModel(file: string): string | null {
  const text = readFileSync(file, 'utf-8');
  if (!text.startsWith('---\n')) return null;
  const block = text.slice(4, text.indexOf('\n---', 4));
  const match = /^model:\s*(\S+)\s*$/m.exec(block);
  return match ? match[1] : null;
}

describe('/orchestrate 1-2b: three tiers', () => {
  const body = section('1-2b');

  it('has one row per tier, with the model each one runs on', () => {
    expect(body).toMatch(/^\| 易 \| command-code \| —/m);
    expect(body).toMatch(/^\| 中 \| claude \| sonnet \|/m);
    expect(body).toMatch(/^\| 難 \| claude \| opus \|/m);
  });

  it('admits to the middle tier ONLY on 「危険な領域」「依存」 and closed judgment / design (Issue #3015)', () => {
    const row = body.split('\n').find((line) => line.startsWith('| 中 |')) ?? '';
    expect(row).toContain('「危険な領域」');
    expect(row).toContain('「依存」');
    // #3015 (Sonnet 5.5): a judgment or a design is admitted only when the body
    // closes it — the options listed, or the checks and controls enumerated.
    expect(row).toContain('「閉じた判断」');
    expect(row).toContain('「閉じた設計」');
    expect(row).toContain('だけ');
    for (const ambiguity of ['判断の余地', '原因', '未決事項', '検証', '新規 export']) {
      expect(row, `${ambiguity} must not admit an Issue to the sonnet tier`).not.toContain(ambiguity);
    }
  });

  it('keeps the open-ended work on opus (Issue #3015)', () => {
    const row = body.split('\n').find((line) => line.startsWith('| 難 |')) ?? '';
    for (const openEnded of ['原因', '未決事項', '検証', '新規 export']) {
      expect(row, `${openEnded} must stay in the opus tier`).toContain(openEnded);
    }
  });

  it('says it is a pilot and that a doubt goes to opus', () => {
    expect(body).toContain('パイロット');
    expect(body).toMatch(/迷ったら難（opus）/);
  });
});

describe('/orchestrate: the model never becomes an --instance value', () => {
  it('documents claude-sonnet / claude-opus for --assign only', () => {
    expect(orchestrate).toContain('--assign `<N>=<claude|claude-opus|claude-sonnet|command-code>`');
    expect(orchestrate).toMatch(/`--instance` は常に `claude`/);
  });

  it('never passes claude-sonnet or claude-opus to --instance', () => {
    expect(orchestrate).not.toMatch(/--instance\s+"?claude-(?:sonnet|opus)/);
  });

  it('keeps --claude-only meaning opus', () => {
    expect(orchestrate).toMatch(/--claude-only\*\*: .*Claude（opus）/);
  });

  it('forbids sending /model to a worker', () => {
    expect(orchestrate).toMatch(/ワーカーに `\/model` を送らない/);
  });
});

describe('/orchestrate 3-1: the model is set before the first send, and checked after it', () => {
  const body = section('3-1');

  it('reads three columns from assign.tsv', () => {
    expect(body).toContain('"<issue>\\t<claude|command-code>\\t<opus|sonnet|->"');
    expect(body).toContain('read -r issue AGENT MODEL');
  });

  // #3883: the model is written by launch-worker.mjs, explicitly for both tiers, into the
  // worktree-local file only if git ignores it. The runbook's set_claude_model calls it.
  it('writes the model into the worktree-local settings file, only if git ignores it', () => {
    expect(body).not.toContain('set_claude_model');
    expect(body).toContain('.claude/settings.local.json');
    expect(body).toContain('launch-worker.mjs set-model --worktree <worktree-path> --model <opus|sonnet>');
    expect(launcher).toContain(`'check-ignore', '-q', SETTINGS_FILE`);
    expect(launcher).toContain(`path.join('.claude', 'settings.local.json')`);
    // Both tiers are written; opus is no longer deleted to inherit the global default.
    expect(MODEL_SETTINGS).toEqual({ opus: 'opus[1m]', sonnet: 'sonnet' });
    expect(body).not.toContain('del(.model)');
    expect(launcher).not.toContain('del(.model)');
  });

  it('sets the model BEFORE the send and reads it back AFTER', () => {
    expect(body).toContain('node scripts/orchestrate/launch-worker.mjs send');
    expect(body).toContain('--instance "$AGENT" --model "$MODEL" --contract ".commandmate/tasks/issue-${issue}.yaml"');
    expect(body).not.toMatch(/^\s*commandmatedev send "\$WT"/m);
    const { code, calls, contractAt } = launchCalls('claude-opus-5-5');
    expect(code).toBe(0);
    const set = calls.indexOf('git check-ignore -q .claude/settings.local.json');
    expect(set).toBeGreaterThan(-1);
    expect(calls.indexOf('send')).toBeGreaterThan(set);
    expect(calls.indexOf('capture')).toBeGreaterThan(calls.indexOf('send'));
    // #3883 N1: the send that starts the session carries no contract; the contract goes out after the model was read.
    expect(contractAt).toHaveLength(1);
    expect(contractAt[0]).toBeGreaterThan(calls.indexOf('capture'));
  });

  it('stops a running Claude session before changing its model', () => {
    const { calls } = launchCalls('claude-opus-5-5');
    const kill = calls.indexOf('instances kill');
    expect(kill).toBeGreaterThan(-1);
    expect(kill).toBeLessThan(calls.indexOf('git check-ignore -q .claude/settings.local.json'));
  });

  it('does not go on with a model that does not match after one restart (#3883)', () => {
    const { code, calls, contractAt } = launchCalls('claude-fable-5-1');
    expect(code).toBe(40);
    expect(calls.filter((call) => call === 'send')).toHaveLength(2);
    // #3883 N1 / N2: the session is killed and read back as stopped, and the contract never went to it.
    expect(calls.slice(-2)).toEqual(['instances kill', 'instances --json']);
    expect(contractAt).toEqual([]);
  });

  it('still addresses the session as $AGENT, and records the model as a fifth column', () => {
    expect(body).toContain('--instance "$AGENT" --model "$MODEL"');
    const parsed = parseLaunchArgs(['send', '--run-dir', 'r', '--issue', '1', '--wt', 'w', '--worktree', '/w', '--instance', 'claude', '--contract', 'c']);
    expect(parsed.options).toMatchObject({ duration: '3h' });
    expect(launcher).toContain(`'--instance', o.instance, '--auto-yes', '--duration', o.duration`);
    expect(body).toContain(`printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$issue" "$WT" "$AGENT" "$TASK_ID" "$MODEL"`);
  });

  it('is a shell block that parses (the orchestrator runs it verbatim)', () => {
    const blocks = [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]);
    const dispatch = blocks.find((block) => block.includes('launch-worker.mjs set-model'));
    expect(dispatch, '3-1 has no bash block mentioning launch-worker.mjs set-model').toBeDefined();
    const result = spawnSync('bash', ['-n'], { input: dispatch, encoding: 'utf-8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('says what to do with each of the three verdicts', () => {
    for (const verdict of ['model ok', 'model UNKNOWN', 'model MISMATCH']) {
      expect(body.split(verdict).length - 1, verdict).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('/orchestrate 3-4 / 3-5 / 3-5b: where each tier goes after two failures', () => {
  it('3-4 names all three destinations', () => {
    const row = section('3-4').split('\n').find((line) => line.startsWith('| `20` |')) ?? '';
    expect(row).toContain('Command Code 担当は Claude（sonnet）へ格上げ（3-5）');
    expect(row).toContain('opus へ格上げ（3-5b）');
    expect(row).toContain('Claude（opus）担当は人間へエスカレーション');
  });

  // #3883: 3-5 / 3-5b call the same launch-worker.mjs as 3-1 (opus written, checked, restarted once).
  it('3-5 switches an Antigravity Issue to opus, never to sonnet', () => {
    const body = `${section('3-5')}\n${docSection('switching.md', '3-5 Antigravity から Claude への切り替え')}`;
    expect(body).toContain('AGENT=claude; MODEL=opus');
    expect(body).toContain('--instance claude --model "$MODEL" --contract ".commandmate/tasks/issue-${issue}-claude.yaml"');
    expect(body).toContain('node scripts/orchestrate/launch-worker.mjs send');
    expect(body).not.toMatch(/MODEL=sonnet|--model sonnet/);
  });

  it('3-5b kills the session first, clears the model, and sends a new contract', () => {
    const body = `${section('3-5b')}\n${docSection('switching.md', '3-5b sonnet から opus への格上げ')}`;
    const kill = body.indexOf('commandmatedev instances "$WT" kill claude');
    const clear = body.indexOf('node scripts/orchestrate/launch-worker.mjs send');
    const send = body.indexOf('issue-${issue}-opus.yaml');
    expect(kill).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(kill);
    expect(send).toBeGreaterThan(clear);
    expect(body).toContain('AGENT=claude; MODEL=opus');
    expect(body).toContain('引き継ぎ（前任: Claude sonnet');
    expect(body).toMatch(/起動時に固定/);
  });

  it('the error table agrees with 3-4', () => {
    const row = orchestrate.split('\n').find((line) => line.startsWith('| 検証不合格（exit 20） |')) ?? '';
    expect(row).toContain('3-5b');
  });
});

describe('/orchestrate: the easy tier is Command Code (Issue #4238)', () => {
  it('Phase 0 sends the easy tier to --instance command-code, with no --model', () => {
    const phase0 = orchestrate.slice(orchestrate.indexOf('## Phase 0'), orchestrate.indexOf('## Phase 1'));
    expect(phase0).toContain('**易 → `--instance command-code`**');
    expect(phase0).toContain('Command Code がワーカー起因で 2 回不合格になったら Claude（sonnet）に上げる（3-5）');
    expect(phase0).not.toMatch(/--instance antigravity/);
  });

  it('1-2b names Command Code for the easy tier and points at its document', () => {
    const body = section('1-2b');
    expect(body).toContain('**Command Code に回す（すべて満たせば「易」）**');
    expect(body).not.toMatch(/^\| 易 \| antigravity/m);
    expect(body).toContain('docs/orchestrate/command-code.md');
  });

  it('3-5 raises a Command Code Issue to Claude sonnet, and 3-5b then takes it to opus', () => {
    const body = `${section('3-5')}\n${docSection('switching.md', '3-5 Command Code から Claude（sonnet）への格上げ')}`;
    expect(section('3-5')).toContain('Command Code 担当の Issue が');
    expect(body).toContain('AGENT=claude; MODEL=sonnet');
    expect(body).toContain('commandmatedev instances "$WT" kill command-code');
    expect(body).toContain('--instance claude --model "$MODEL" --contract ".commandmate/tasks/issue-${issue}-claude.yaml"');
    expect(body).toContain('3-5b');
    expect(body).not.toMatch(/MODEL=opus/);
    // Bound to the new task, like every switch (#3118).
    expect(body).toMatch(/wait-verify\.mjs[\s\S]*--task "\$TASK_ID"/);
  });

  it('the error table and 8-3 agree with 3-5', () => {
    const row = orchestrate.split('\n').find((line) => line.startsWith('| 検証不合格（exit 20） |')) ?? '';
    expect(row).toContain('Command Code 担当は Claude（sonnet）へ格上げ（3-5）');
    expect(orchestrate).toContain('- Command Code から Claude（sonnet）への格上げ（3-5）');
  });
});

describe('/orchestrate: after a raise from Command Code, failures go sonnet → opus → a person everywhere (Issue #4238 review)', () => {
  const body34 = section('3-4');

  it('the 3-4 text splits the Claude branch: sonnet goes to 3-5b, only opus stops for a person', () => {
    expect(body34).toContain('**Claude（sonnet）担当は 3-5b の手順で opus に上げる**（3-5 で格上げした sonnet も同じ）');
    expect(body34).toContain('**Claude（opus）担当は** worker を止め、ユーザーに判断を仰ぐ');
    // The old branch stopped every Claude worker, a sonnet raised by 3-5 included.
    expect(body34).not.toContain('**Claude 担当は** worker を止め');
  });

  it('the 3-4 table, the error table, 3-5b and switching.md say the same', () => {
    const tableRow = body34.split('\n').find((line) => line.startsWith('| `20` |')) ?? '';
    const errorRow = orchestrate.split('\n').find((line) => line.startsWith('| 検証不合格（exit 20） |')) ?? '';
    for (const row of [tableRow, errorRow]) {
      expect(row).toContain('Claude（sonnet）担当は opus へ格上げ（3-5b）');
      expect(row).toContain('Claude（opus）担当は人間へエスカレーション');
    }
    expect(section('3-5b')).toContain('Claude（sonnet）担当の Issue が');
    expect(docSection('switching.md', '3-5 Command Code から Claude（sonnet）への格上げ')).toMatch(/ワーカー起因の不合格 2 回で 3-5b の opus への格上げ/);
    expect(docSection('switching.md', '3-5b sonnet から opus への格上げ')).toContain('Claude（opus）担当として 3-4 に従う（ワーカー起因の不合格 2 回で人間へエスカレーション）');
  });

  it('orchestrate.md stays within its 118,000-byte cap', () => {
    expect(Buffer.byteLength(orchestrate, 'utf-8')).toBeLessThanOrEqual(118_000);
  });
});

describe('/orchestrate: the Command Code send and the re-instruction signal are documented (Issue #4238 review)', () => {
  const doc = readFileSync(path.join(REPO_ROOT, 'docs/orchestrate/command-code.md'), 'utf-8');

  it('a session started under ask is stopped before the send, and an alias is checked by its tool', () => {
    expect(doc).toContain('動いているセッションを止めてから契約を送る');
    expect(doc).toContain('alias（例: `cc`）でも同じ確認が効く');
    expect(launcher).toContain("stopped('Command Code reads its permissions when the session starts')");
  });

  it('3-4 re-instructs through wait-verify with the send time; the plain two steps are a Claude-only manual stand-in (re-review)', () => {
    const body = section('3-4');
    expect(body).toContain('SENT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)');
    expect(body).toMatch(/wait-verify\.mjs[\s\S]*--after-reinstruct --signal-since "\$SENT_AT"/);
    expect(body).toContain('Claude 担当だけは、スクリプトを使えないときの手動の代わりに素の 2 段でもよい');
    const manual = readFileSync(path.join(REPO_ROOT, 'docs/orchestrate/antigravity.md'), 'utf-8');
    expect(manual).toContain('SINCE=${SENT_AT:-$TASK_CREATED}');
    expect(manual).toContain('--since "$SINCE"');
    expect(manual).not.toContain('--since "$TASK_CREATED"');
  });

  it('a verification started again without a re-instruction is --reverify, in 3-3 and in exit-codes.md (re-review)', () => {
    expect(section('3-3')).toContain('`--reverify --task "$TASK_ID"`');
    const exitCodes = readFileSync(path.join(REPO_ROOT, 'docs/orchestrate/exit-codes.md'), 'utf-8');
    expect(exitCodes).toContain('`wait-verify.mjs --reverify --task <id>` で検証し直す');
    expect(exitCodes).not.toContain('`wait-verify.mjs --after-reinstruct --task <id>` で検証し直す');
  });

  it('after a re-instruction only a signal written after the send counts', () => {
    expect(doc).toContain('合図は再指示の送信より後に');
    expect(orchestrate).toContain('完了の合図は再指示の送信（`$SENT_AT`）より後のものだけを数える');
    expect(orchestrate).toContain('`--signal-since`');
  });
});

describe('/orchestrate 8-2 / 8-3: the pilot leaves a record', () => {
  it('8-2 records the model that actually ran', () => {
    // Not `section('8-2')`: 8-2 embeds a markdown template whose own `### `
    // headings would end the section after three lines.
    const start = orchestrate.indexOf('\n### 8-2.');
    const end = orchestrate.indexOf('\n### 8-3.');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = orchestrate.slice(start, end);
    expect(body).toContain('| モデル（実測） |');
    expect(body).toMatch(/^\| #\{L\} \| 中 \| claude \| sonnet/m);
  });

  it('8-3 is mandatory after a promotion or a sonnet re-instruction', () => {
    expect(section('8-3')).toContain('sonnet から opus への格上げ（3-5b）');
  });
});

describe('.claude/agents: subagents follow the session model', () => {
  const agents = readdirSync(AGENTS_DIR).filter((name) => name.endsWith('.md')).sort();

  it('finds the agent definitions (anti-vacuity)', () => {
    expect(agents.length).toBeGreaterThanOrEqual(9);
  });

  it.each(agents)('%s declares `model: inherit`', (name) => {
    expect(frontmatterModel(path.join(AGENTS_DIR, name))).toBe('inherit');
  });
});

describe('.claude/commands: a sonnet-pinned command still asks for opus where it matters', () => {
  /** The agents whose work the commands documentation calls "レビュー・TDD系=opus". */
  const OPUS_AGENTS = [
    'tdd-impl-agent',
    'acceptance-test-agent',
    'refactoring-agent',
    'architecture-review-agent',
    'issue-review-agent',
    'investigation-agent',
  ];
  const invocations = readdirSync(COMMANDS_DIR)
    .filter((name) => name.endsWith('.md'))
    .flatMap((name) => {
      const file = path.join(COMMANDS_DIR, name);
      const commandModel = frontmatterModel(file);
      return readFileSync(file, 'utf-8')
        .split('\n')
        .map((line, index) => ({ name, line, lineNumber: index + 1, commandModel }))
        .filter(({ line }) => OPUS_AGENTS.some((agent) => line.startsWith(`Use ${agent}`)));
    });

  it('finds the invocation lines (anti-vacuity)', () => {
    expect(invocations.length).toBeGreaterThanOrEqual(12);
    expect(invocations.some(({ commandModel }) => commandModel === 'sonnet')).toBe(true);
    expect(invocations.some(({ commandModel }) => commandModel === 'opus')).toBe(true);
  });

  it('every such line in a command that is NOT pinned to opus names `(model: opus)` itself', () => {
    const unprotected = invocations
      .filter(({ commandModel }) => commandModel !== 'opus')
      .filter(({ line }) => !/^Use [a-z-]+-agent \(model: opus\)/.test(line))
      .map(({ name, lineNumber }) => `${name}:${lineNumber}`);
    expect(unprotected).toEqual([]);
  });
});
