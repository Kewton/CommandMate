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
 *     only way to raise sonnet to opus is a new session (3-5b).
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
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const ORCHESTRATE_PATH = '.claude/commands/orchestrate.md';
const COMMANDS_DIR = path.join(REPO_ROOT, '.claude/commands');
const AGENTS_DIR = path.join(REPO_ROOT, '.claude/agents');

const orchestrate = readFileSync(path.join(REPO_ROOT, ORCHESTRATE_PATH), 'utf-8');

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
    expect(body).toMatch(/^\| 易 \| antigravity \| —/m);
    expect(body).toMatch(/^\| 中 \| claude \| sonnet \|/m);
    expect(body).toMatch(/^\| 難 \| claude \| opus \|/m);
  });

  it('admits to the middle tier ONLY on 「危険な領域」 and 「依存」', () => {
    const row = body.split('\n').find((line) => line.startsWith('| 中 |')) ?? '';
    expect(row).toContain('「危険な領域」');
    expect(row).toContain('「依存」');
    expect(row).toContain('だけ');
    for (const ambiguity of ['判断の余地', '設計', '原因', '未決事項', '検証', '新規 export']) {
      expect(row, `${ambiguity} must not admit an Issue to the sonnet tier`).not.toContain(ambiguity);
    }
  });

  it('says it is a pilot and that a doubt goes to opus', () => {
    expect(body).toContain('パイロット');
    expect(body).toMatch(/迷ったら難（opus）/);
  });
});

describe('/orchestrate: the model never becomes an --instance value', () => {
  it('documents claude-sonnet / claude-opus for --assign only', () => {
    expect(orchestrate).toContain('--assign `<N>=<claude|claude-opus|claude-sonnet|antigravity>`');
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
    expect(body).toContain('"<issue>\\t<claude|antigravity>\\t<opus|sonnet|->"');
    expect(body).toContain('read -r issue AGENT MODEL');
  });

  it('writes the model into the worktree-local settings file, only if git ignores it', () => {
    expect(body).toContain('set_claude_model()');
    expect(body).toContain('.claude/settings.local.json');
    expect(body).toContain('check-ignore -q .claude/settings.local.json');
    expect(body).toContain(`jq '.model = "sonnet"'`);
    expect(body).toContain(`jq 'del(.model)'`);
  });

  it('sets the model BEFORE the send and reads it back AFTER', () => {
    const set = body.indexOf('set_claude_model "$WT_PATH" "$MODEL"');
    const send = body.indexOf('commandmatedev send "$WT"');
    const check = body.indexOf(`jq -r '.model // ""'`);
    expect(set).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(set);
    expect(check).toBeGreaterThan(send);
  });

  it('stops a running Claude session before changing its model', () => {
    const kill = body.indexOf('commandmatedev instances "$WT" kill claude');
    expect(kill).toBeGreaterThan(-1);
    expect(kill).toBeLessThan(body.indexOf('set_claude_model "$WT_PATH" "$MODEL"'));
  });

  it('still addresses the session as $AGENT, and records the model as a fifth column', () => {
    expect(body).toContain('--instance "$AGENT" --auto-yes --duration 3h');
    expect(body).toContain(`printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$issue" "$WT" "$AGENT" "$TASK_ID" "$MODEL"`);
  });

  it('is a shell block that parses (the orchestrator runs it verbatim)', () => {
    const blocks = [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]);
    const dispatch = blocks.find((block) => block.includes('set_claude_model()'));
    expect(dispatch, '3-1 has no bash block defining set_claude_model()').toBeDefined();
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
    expect(row).toContain('Claude（opus）へ切替（3-5）');
    expect(row).toContain('opus へ格上げ（3-5b）');
    expect(row).toContain('Claude（opus）担当は人間へエスカレーション');
  });

  it('3-5 switches an Antigravity Issue to opus, never to sonnet', () => {
    expect(section('3-5')).toContain('set_claude_model "$WT_PATH" opus');
  });

  it('3-5b kills the session first, clears the model, and sends a new contract', () => {
    const body = section('3-5b');
    const kill = body.indexOf('commandmatedev instances "$WT" kill claude');
    const clear = body.indexOf('set_claude_model "$WT_PATH" opus');
    const send = body.indexOf('issue-${issue}-opus.yaml');
    expect(kill).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(kill);
    expect(send).toBeGreaterThan(clear);
    expect(body).toContain('引き継ぎ（前任: Claude sonnet');
    expect(body).toMatch(/起動時に固定/);
  });

  it('the error table agrees with 3-4', () => {
    const row = orchestrate.split('\n').find((line) => line.startsWith('| 検証不合格（exit 20） |')) ?? '';
    expect(row).toContain('3-5b');
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
