/**
 * A tool's ask capability is true only with its controls in place (Issue #4344,
 * design `docs/design/ask-attribution-4344.md` §0.1).
 *
 * `ASK_ATTRIBUTION_TOOLS` is what `GET /api/asks/capabilities` publishes and the
 * send route stamps envelopes by. Turning a tool on is a claim that its
 * transcript reader binds the enveloped input to the completed turn and holds
 * M1〜M6 — so each `true` row needs the adapter's control file
 * (`tests/unit/hooks/sources/<tool>-ask-attribution-4344.test.ts`), and that file
 * has to name every M case.
 *
 * H5 (§0.1 版の判定): each `true` tool has a minimum version, and its control
 * fixtures (`tests/fixtures/<tool>-ask-attribution-4344/`) are records of that
 * version or later carrying the records the tool's adapter completes a turn by —
 * checked per tool, never by one tool's record shape alone (PR2 prereview F6):
 *  - claude: every assistant record carries `stop_reason`;
 *  - codex: the version is `session_meta.payload.cli_version`, and a file holds an
 *    enveloped `UserMessage` with its own `thread_id`, an `AgentMessage` and a
 *    `task_complete` of the same `turn_id`, and the user `response_item` with the
 *    same whole text (Q3: the envelope and the expanded paste are both kept).
 */
import { describe, it, expect } from 'vitest';
import { ASK_ENVELOPE_PATTERN } from '@/lib/ask/envelope';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ASK_ATTRIBUTION_MIN_VERSIONS, ASK_ATTRIBUTION_TOOLS, versionAtLeast } from '@/lib/ask/ask-correlation';

const M_CASES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'] as const;

/** M4 (command bodies) is the send side's, pinned in the route's and the envelope's controls. */
const M4_CONTROLS = ['tests/unit/app/api/worktrees/send-ask-4344.test.ts', 'tests/unit/lib/ask/envelope-4344.test.ts'];

const enabled = Object.entries(ASK_ATTRIBUTION_TOOLS).filter(([, on]) => on).map(([tool]) => tool);

interface CodexLine {
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    cli_version?: string;
    thread_id?: string;
    turn_id?: string;
    content?: { text?: string }[];
    item?: { type?: string; id?: string; content?: { text?: string }[] };
  };
}

/**
 * What a codex control fixture lacks (F6, T19): an empty list when it carries
 * the version and every record the codex adapter completes an ask by. The
 * `endMarker` is the last line of the text that was sent (the README names it):
 * a cut text is a missing record, not a pass.
 */
function codexControlGaps(lines: readonly string[], minimum: string, endMarker: string): string[] {
  const records = lines.filter((line) => line.trim()).map((line) => JSON.parse(line) as CodexLine);
  const gaps: string[] = [];
  const version = records.find((r) => r.type === 'session_meta')?.payload?.cli_version;
  if (!version || versionAtLeast(version, minimum) !== true) gaps.push(`version ${String(version)}`);
  const text = (content?: { text?: string }[]) => (content ?? []).map((c) => c.text ?? '').join('');
  const prompts = records.filter((r) => r.type === 'event_msg' && r.payload?.type === 'item_completed'
    && r.payload.item?.type === 'UserMessage' && ASK_ENVELOPE_PATTERN.test(text(r.payload.item.content).split('\n')[0]));
  if (prompts.length === 0) gaps.push('an enveloped UserMessage');
  for (const prompt of prompts) {
    const turnId = prompt.payload?.turn_id;
    const body = text(prompt.payload?.item?.content);
    if (!prompt.payload?.thread_id) gaps.push('thread_id on the UserMessage');
    if (!prompt.payload?.item?.id) gaps.push('item.id on the UserMessage');
    if (!turnId) { gaps.push('turn_id on the UserMessage'); continue; }
    if (!body.endsWith(endMarker)) gaps.push('the whole text (end marker) in the UserMessage');
    const sameTurn = records.filter((r) => r.payload?.turn_id === turnId);
    if (!sameTurn.some((r) => r.payload?.type === 'task_started')) gaps.push('task_started of the turn');
    if (!sameTurn.some((r) => r.payload?.item?.type === 'AgentMessage' && r.payload.thread_id)) gaps.push('AgentMessage of the turn');
    if (!sameTurn.some((r) => r.type === 'event_msg' && r.payload?.type === 'task_complete')) gaps.push('task_complete of the turn');
    const copies = records.filter((r) => r.type === 'response_item' && r.payload?.role === 'user' && text(r.payload.content) === body);
    if (copies.length === 0) gaps.push('the user response_item with the same whole text');
  }
  return gaps;
}

/** Per-tool control fixture check (H5). Answers what the file lacks. */
function controlGaps(tool: string, dir: string, name: string, minimum: string): string[] {
  const lines = readFileSync(join(dir, name), 'utf8').split('\n').filter((l) => l.trim());
  if (tool === 'codex') return codexControlGaps(lines, minimum, CODEX_END_MARKER);
  const gaps: string[] = [];
  let assistants = 0;
  for (const line of lines) {
    const record = JSON.parse(line) as { type: string; version?: string; message?: { stop_reason?: string } };
    if (record.type === 'user' || record.type === 'assistant') {
      if (!(record.version && versionAtLeast(record.version, minimum))) gaps.push(`${name}: version ${record.version}`);
    }
    if (record.type === 'assistant') {
      assistants += 1;
      if (!record.message?.stop_reason) gaps.push(`${name}: stop_reason`);
    }
  }
  if (tool === 'claude' && assistants === 0) gaps.push(`${name}: no assistant record`);
  return gaps;
}

/** The last line of the text sent in the codex Q3 record (its README). */
const CODEX_END_MARKER = 'END-OF-PROBE-4344-Q3';

describe('ask capability controls (Issue #4344)', () => {
  // The title is PR1's; the decision of PR2 (the contract) turns codex on, so the
  // list now holds both.
  it('claude is the first tool on (PR1), and only it', () => {
    expect(enabled).toEqual(['claude', 'codex']);
  });

  it.each(enabled)('%s has its adapter control file naming M1, M2, M3, M5 and M6', (tool) => {
    const file = join(process.cwd(), 'tests/unit/hooks/sources', `${tool}-ask-attribution-4344.test.ts`);
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, 'utf8');
    for (const name of M_CASES.filter((m) => m !== 'M4')) {
      // A case is named when a test title starts with it: it('M1 …') / ['M3 …', …].
      expect(text, `${tool}: ${name}`).toMatch(new RegExp(`['"\`]${name} `));
    }
  });

  it('M4 is pinned on the send side', () => {
    for (const path of M4_CONTROLS) {
      expect(readFileSync(join(process.cwd(), path), 'utf8')).toMatch(/M4/);
    }
  });

  it.each(enabled)('%s has a minimum version, and its control fixtures are at least that version with stop_reason on every assistant record (H5)', (tool) => {
    const minimum = (ASK_ATTRIBUTION_MIN_VERSIONS as Record<string, string | undefined>)[tool];
    expect(minimum, `${tool}: minimum version`).toBeDefined();
    const dir = join(process.cwd(), 'tests/fixtures', `${tool}-ask-attribution-4344`);
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      expect(controlGaps(tool, dir, name, minimum!), `${tool}: ${name}`).toEqual([]);
    }
  });
});

describe('the codex control check finds what a fixture lacks (F6, T19)', () => {
  const minimum = ASK_ATTRIBUTION_MIN_VERSIONS.codex ?? '';
  const fixture = readFileSync(join(process.cwd(), 'tests/fixtures/codex-ask-attribution-4344/q3-enveloped-paste-01672.jsonl'), 'utf8')
    .split('\n').filter((l) => l.trim());
  const edit = (pick: (r: CodexLine & Record<string, unknown>) => boolean, change: (r: CodexLine & Record<string, unknown>) => CodexLine | null) =>
    fixture.flatMap((line) => {
      const record = JSON.parse(line) as CodexLine & Record<string, unknown>;
      if (!pick(record)) return [line];
      const changed = change(record);
      return changed ? [JSON.stringify(changed)] : [];
    });
  const isPrompt = (r: CodexLine) => r.payload?.item?.type === 'UserMessage';

  it('codex has a minimum version (H5)', () => {
    expect(minimum).toBe('0.167.2');
  });

  it('the real Q3 record has no gap', () => {
    expect(codexControlGaps(fixture, minimum, CODEX_END_MARKER)).toEqual([]);
  });

  it.each([
    ['no task_complete', () => edit((r) => r.payload?.type === 'task_complete', () => null), 'task_complete of the turn'],
    ['no thread_id on the UserMessage', () => edit(isPrompt, (r) => { delete r.payload!.thread_id; return r; }), 'thread_id on the UserMessage'],
    ['no envelope', () => edit(isPrompt, (r) => { r.payload!.item!.content![0].text = r.payload!.item!.content![0].text!.split('\n').slice(1).join('\n'); return r; }), 'an enveloped UserMessage'],
    ['the end of the text cut', () => edit(isPrompt, (r) => { r.payload!.item!.content![0].text = r.payload!.item!.content![0].text!.split('\n').slice(0, -1).join('\n'); return r; }), 'the whole text (end marker) in the UserMessage'],
    ['no AgentMessage', () => edit((r) => r.payload?.item?.type === 'AgentMessage', () => null), 'AgentMessage of the turn'],
    ['an older version', () => edit((r) => r.type === 'session_meta', (r) => { r.payload!.cli_version = '0.166.0'; return r; }), 'version 0.166.0'],
  ])('%s is a gap', (_label, make, gap) => {
    expect(codexControlGaps(make(), minimum, CODEX_END_MARKER)).toContain(gap);
  });
});
