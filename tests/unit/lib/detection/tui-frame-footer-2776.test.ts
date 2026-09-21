/**
 * フッタ判定が文中の引用に当たらない (Issue 2776)
 *
 * `normalizeTuiFrameForDetection` は Claude のフッタ行を見つけると、その行より下
 * （その下に新しい対話があれば上）を捨てる。2774 では会話本文が引用した 1 行が
 * フッタと判定され、1002 行中 963 行が捨てられた。
 *
 * 採った条件は「フッタは行頭に在る」（前に空白と SGR しか無い）の 1 つだけ。
 * 採取ごとの表と、位置・捨てる量の上限を採らなかった理由は
 * `docs/design/tui-frame-footer-scan-2776.md`、採取の出どころは
 * `tests/fixtures/tui-frame-footer-2776/README.md`。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { stripAnsi } from '@/lib/detection/ansi';
import {
  isClaudeFooter,
  normalizeTuiFrameForDetection,
} from '@/lib/detection/tui-detection-frame';

const ROOT = process.cwd();
const CAPTURES = 'tests/fixtures/tui-frame-footer-2776';
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');
const capture = (name: string): string => read(`${CAPTURES}/${name}`);
const nonBlankRows = (frame: string): string[] => frame.split('\n').filter(row => row.trim() !== '');

/** The rule before Issue 2776, restated as the control: no row anchor. */
const PRE_2776_FOOTER = [
  /Esc\s+to\s+cancel\s*[·•]\s*Tab\s+to\s+amend/i,
  /Enter\s+to\s+select\b.*\bnavigate\b/i,
];
const isPre2776Footer = (row: string): boolean => PRE_2776_FOOTER.some(p => p.test(row));

/** 1-based numbers of the rows `isFooter` accepts. */
function footerRows(frame: string, isFooter: (row: string) => boolean = isClaudeFooter): number[] {
  return stripAnsi(frame)
    .split('\n')
    .flatMap((row, i) => (isFooter(row) ? [i + 1] : []));
}

describe('本物のフッタは従来どおり採用される（採取 1・2・3, claude 2.1.278）', () => {
  it.each([
    ['claude-2.1.278-bash-approval.txt', 25],
    ['claude-2.1.278-edit-approval.txt', 58],
    ['claude-2.1.278-askuserquestion-picker.txt', 30],
    // 同じフレームの上に引用が 4 行あるが、当たるのは本物の 1 行だけ（採取 5）
    ['claude-2.1.278-picker-below-quoted-footers.txt', 92],
    ['claude-2.1.278-approval-below-quoted-footers.txt', 102],
    // フッタの下（ペイン最下部）に task panel がある（採取 3, Issue 2811）
    ['claude-2.1.278-bash-approval-task-panel.txt', 24],
    ['claude-2.1.278-askuserquestion-task-panel.txt', 32],
  ])('%s: L%i だけがフッタで、正規化はその行で終わる', (name, footerLine) => {
    const frame = stripAnsi(capture(name));
    expect(footerRows(frame)).toEqual([footerLine]);

    const normalized = normalizeTuiFrameForDetection(frame).split('\n');
    expect(normalized.at(-1)).toBe(frame.split('\n')[footerLine - 1]);
  });

  it('生のキャプチャ（行頭に SGR が付く）でも同じ行がフッタになる', () => {
    for (const [name, footerLine] of [
      ['claude-2.1.278-bash-approval.txt', 25],
      ['claude-2.1.278-askuserquestion-picker.txt', 30],
      ['claude-2.1.278-bash-approval-task-panel.txt', 24],
      ['claude-2.1.278-askuserquestion-task-panel.txt', 32],
    ] as const) {
      const row = capture(name).split('\n')[footerLine - 1];
      const prefix = row.slice(0, row.search(/Esc to cancel|Enter to select/));
      expect(prefix).toMatch(/\x1b\[[0-9;]*m/);
      expect(isClaudeFooter(row)).toBe(true);
    }
  });

  it.each([
    ['claude-2.1.278-bash-approval-task-panel.txt', 24],
    ['claude-2.1.278-askuserquestion-task-panel.txt', 32],
  ])('%s: フッタ L%i の下に描かれた task panel は捨てる（2.1.278, Issue 2811）', (name, footerLine) => {
    const frame = stripAnsi(capture(name));
    const rows = frame.split('\n');
    // task panel はフッタの直下ではなくペインの最下部に描かれ、フッタとの間は空行
    expect(rows.length).toBe(1001);
    expect(rows.slice(footerLine).filter(row => row.trim() !== '')).toEqual([
      '  3 tasks (0 done, 1 in progress, 2 open)',
      '  ◼ a.ts を読む',
      '  ◻ README.md を読む',
      '  ◻ probe.txt を作る',
    ]);
    expect(rows.findIndex(row => row.includes('3 tasks (0 done, 1 in progress, 2 open)')) + 1).toBe(997);

    const normalized = normalizeTuiFrameForDetection(frame);
    expect(normalized).not.toContain('3 tasks (0 done, 1 in progress, 2 open)');
    expect(normalized).not.toContain('◻ probe.txt を作る');
    expect(normalized.split('\n').at(-1)).toBe(rows[footerLine - 1]);
  });

  it('旧版の実キャプチャ（2.1.240 / 2.1.223）でも task panel を捨てる', () => {
    // 2776 では 2.1.278 の task panel を出せず、この 2 本で代えていた（Issue 2811 で上の実測に置き換え）。
    const bash = stripAnsi(read('tests/unit/lib/detection/fixtures/claude-live-1708/bash-approval-taskpanel.txt'));
    expect(footerRows(bash)).toEqual([108]);
    const bashOut = normalizeTuiFrameForDetection(bash);
    expect(bash).toContain('7 tasks (0 done, 1 in progress, 6 open)');
    expect(bashOut).not.toContain('7 tasks (0 done, 1 in progress, 6 open)');
    expect(bashOut.split('\n').at(-1)).toContain('Esc to cancel · Tab to amend · ctrl+e to explain');

    const picker = stripAnsi(read('tests/fixtures/canary/askuserquestion-task-panel.raw.txt'));
    expect(footerRows(picker)).toEqual([38]);
    expect(picker).toContain('3 tasks (0 done, 3 open)');
    expect(normalizeTuiFrameForDetection(picker)).not.toContain('3 tasks (0 done, 3 open)');
  });
});

describe('引用された行はフッタとして採用されない（採取 5・2774）', () => {
  const FIXTURE_2774 = 'tests/fixtures/codex-quoted-footer-2774/idle-after-quoted-picker-footer.txt';

  it('2774 の fixture: 引用行 L22 はフッタではない（旧ルールでは L22 がフッタだった）', () => {
    const frame = read(FIXTURE_2774);
    expect(footerRows(frame, isPre2776Footer)).toEqual([22]);
    expect(footerRows(frame)).toEqual([]);
  });

  it('2774 の fixture: `›` のアンカーに頼らなくても 1 行も捨てない', () => {
    // composer の `›` を CLAUDE_LOWER_INTERACTIVE_ANCHOR が拾わない文字に替える。
    // 2774 の修正だけなら、これで引用行から下が全部捨てられる。
    const withoutAnchor = read(FIXTURE_2774).replace(/›/g, '»');
    expect(withoutAnchor).not.toContain('›');
    expect(nonBlankRows(normalizeTuiFrameForDetection(withoutAnchor))).toEqual(
      nonBlankRows(withoutAnchor),
    );
  });

  it('2774 の fixture: 引用行そのものも残る', () => {
    expect(normalizeTuiFrameForDetection(read(FIXTURE_2774))).toContain(
      '「フッタ: Enter to select | Arrow keys to navigate',
    );
  });

  it.each([
    ['claude-2.1.278-idle-quoted-footers.txt', [58, 61, 65, 67]],
    ['codex-0.155.1-idle-quoted-footers.txt', [42, 43]],
    ['command-code-1.58.0-idle-quoted-footers.txt', [20, 21]],
  ])('%s: 引用行（旧ルールでは %j）はフッタではなく、1 行も捨てない', (name, quotedLines) => {
    const frame = stripAnsi(capture(name));
    expect(footerRows(frame, isPre2776Footer)).toEqual(quotedLines);
    expect(footerRows(frame)).toEqual([]);
    expect(nonBlankRows(normalizeTuiFrameForDetection(frame))).toEqual(nonBlankRows(frame));
  });
});

// ---------------------------------------------------------------------------
// 他ツールのフレームでフッタと判定される行（tests/fixtures 全体を走査して再導出）
// ---------------------------------------------------------------------------

type OtherTool = 'codex' | 'command-code' | 'antigravity';

const SWEEP_ROOTS = ['tests/fixtures', 'tests/unit/lib/detection/fixtures'];

function toolOf(rel: string): OtherTool | null {
  const p = rel.toLowerCase();
  if (/command-?code/.test(p)) return 'command-code';
  if (/antigravity|(?:^|[/_-])agy(?:[/_.-]|$)/.test(p)) return 'antigravity';
  if (/codex/.test(p)) return 'codex';
  return null;
}

function listFiles(rel: string): string[] {
  return readdirSync(path.join(ROOT, rel), { withFileTypes: true }).flatMap(entry => {
    const child = `${rel}/${entry.name}`;
    return entry.isDirectory() ? listFiles(child) : [child];
  });
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(stringsIn);
  return [];
}

function parsedOrRaw(text: string): string[] {
  try {
    return stringsIn(JSON.parse(text));
  } catch {
    return [text];
  }
}

/** Every frame a fixture file carries: the file itself, JSON string leaves, or TS exports. */
async function framesOf(rel: string): Promise<string[]> {
  const text = (): string => read(rel);
  if (/\.(?:txt|capture|log)$/.test(rel)) return [text()];
  if (rel.endsWith('.json')) return parsedOrRaw(text());
  if (rel.endsWith('.jsonl')) return text().split('\n').filter(Boolean).flatMap(parsedOrRaw);
  if (rel.endsWith('.ts')) {
    const mod: Record<string, unknown> = await import(path.join(ROOT, rel));
    return Object.values(mod).flatMap(v =>
      typeof v === 'function' && v.length === 0 ? stringsIn((v as () => unknown)()) : stringsIn(v),
    );
  }
  return [];
}

interface Hit {
  file: string;
  line: number;
  row: string;
  nonBlankBelow: number;
}

async function sweep(isFooter: (row: string) => boolean) {
  const files: Record<OtherTool, number> = { codex: 0, 'command-code': 0, antigravity: 0 };
  const hits: Record<OtherTool, Hit[]> = { codex: [], 'command-code': [], antigravity: [] };
  for (const file of SWEEP_ROOTS.flatMap(listFiles).sort()) {
    const tool = toolOf(file);
    if (tool === null || file.endsWith('README.md')) continue;
    const frames = await framesOf(file);
    if (frames.length === 0) continue;
    files[tool] += 1;
    for (const frame of frames) {
      const rows = stripAnsi(frame).split('\n');
      rows.forEach((row, i) => {
        if (!isFooter(row)) return;
        const nonBlankBelow = rows.slice(i + 1).filter(r => r.trim() !== '').length;
        hits[tool].push({ file, line: i + 1, row: row.trim(), nonBlankBelow });
      });
    }
  }
  return { files, hits };
}

/** Command Code's own AskUserQuestion footer — the same words as Claude's, by design. */
const COMMAND_CODE_PICKER_FOOTER = /^Enter to select \| Arrow keys to navigate \|/;

describe('他ツール（codex / command-code / antigravity）のフレームで誤認される行が 0 件', () => {
  it('codex と antigravity のフレームではフッタと判定される行が 0 件', async () => {
    const { files, hits } = await sweep(isClaudeFooter);
    // 走査が空振りしていないこと（2026-09-21 時点の件数を下限にする）
    expect(files.codex).toBeGreaterThanOrEqual(57);
    expect(files.antigravity).toBeGreaterThanOrEqual(38);
    expect(hits.codex).toEqual([]);
    expect(hits.antigravity).toEqual([]);
  });

  it('command-code で当たるのは自身の AskUserQuestion フッタだけで、その下に捨てる行は無い', async () => {
    const { files, hits } = await sweep(isClaudeFooter);
    expect(files['command-code']).toBeGreaterThanOrEqual(115);
    expect(hits['command-code'].length).toBeGreaterThan(0);
    for (const hit of hits['command-code']) {
      expect(hit.file).toMatch(/\/command-code-askuserquestion-\d+\//);
      expect(hit.row).toMatch(COMMAND_CODE_PICKER_FOOTER);
      expect(hit.nonBlankBelow).toBe(0);
    }
  });

  it('対照: 旧ルールで同じ走査をすると引用行が見つかる（この走査は引用を見落とさない）', async () => {
    const { hits } = await sweep(isPre2776Footer);
    const quoted = [...hits.codex, ...hits['command-code'], ...hits.antigravity]
      .filter(hit => !COMMAND_CODE_PICKER_FOOTER.test(hit.row))
      .map(hit => `${hit.file}:${hit.line}`);
    expect(quoted).toEqual(
      expect.arrayContaining([
        'tests/fixtures/codex-quoted-footer-2774/idle-after-quoted-picker-footer.txt:22',
        `${CAPTURES}/codex-0.155.1-idle-quoted-footers.txt:42`,
        `${CAPTURES}/codex-0.155.1-idle-quoted-footers.txt:43`,
        `${CAPTURES}/command-code-1.58.0-idle-quoted-footers.txt:20`,
        `${CAPTURES}/command-code-1.58.0-idle-quoted-footers.txt:21`,
      ]),
    );
  });
});
