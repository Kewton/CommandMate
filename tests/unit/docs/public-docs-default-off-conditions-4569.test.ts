/**
 * Issue #4569: a feature that is off by default (or needs an approval) is never
 * shown on a public page without the condition that turns it on.
 *
 * Invariant: when a public document (README en / ja, concept en / ja,
 * how-it-works en / ja) names a feature or command listed in
 * docs/design/public-messaging.md §4 "既定で無効・承認の要る機能", the condition
 * that enables it (a mode, a setting, an approval) is written in the SAME
 * table row, the SAME list item or the SAME paragraph. A neighbouring row,
 * a sibling list item or the next paragraph does not count.
 *
 * This test only looks at the "mouths" registered in DEFAULT_OFF_FEATURES.
 * The registry must hold exactly the IDs of that §4 table, with the same
 * treatment ("条件を書く" = required here, "求めない" = exempt here); the
 * first describe block fails when the two drift apart. When a new default-off
 * feature reaches a public page, add a row to §4 first, then here.
 *
 * How a document is cut into units:
 * - every table row (a line starting with `|`) is its own unit, header rows too
 * - every list item (`- `, `* `, `+ `, `1. `) is its own unit, together with
 *   the non-blank lines that continue it (until the next item, a blank line,
 *   a table row, a fence or a heading)
 * - a paragraph is a run of other non-blank lines
 * - a fenced code block is joined to the paragraph or list item right before
 *   it (only blank lines between): a command example counts as part of the
 *   prose that introduces it, so the condition belongs in that prose or in
 *   the block itself. A block after a table row or a heading stands alone
 * - headings are not judged: a heading names a section, its body carries the
 *   condition
 * - EXCLUDED_SECTIONS are skipped: the Antigravity notice in the READMEs is
 *   itself the statement of the condition (and is pinned by
 *   antigravity-usage-notice-4438.test.ts), so its list of refused uses is not
 *   a mouth
 * A document in which no mouth appears passes.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const MESSAGING_DOC = 'docs/design/public-messaging.md';
const REGISTRY_HEADING = '### 既定で無効・承認の要る機能';

export interface DefaultOffFeature {
  /** The ID of the row in public-messaging.md §4 (F1 …). */
  id: string;
  /** Name used in failure messages. */
  name: string;
  /** false when §4 says the public pages need not state a condition ("求めない"). */
  required: boolean;
  /** Every pattern must match the unit for the mouth to be present. */
  mouth: RegExp[];
  /** Every pattern must match the same unit. */
  condition: RegExp[];
  /** A sentence that is a mouth without the condition (positive control). */
  sample: string;
  /** Text that, appended to `sample`, states the condition. */
  fix: string;
}

const MEM_CONDITION = [/\bmode\b|モード/i, /`on`/, /既定|default/i, /`off`/];

/** The registry. Same IDs and treatment as public-messaging.md §4. */
export const DEFAULT_OFF_FEATURES: DefaultOffFeature[] = [
  {
    id: 'F1',
    name: 'mem writes (mode `on` only; the default is `off`)',
    required: true,
    mouth: [/commandmate mem\b|\bmem (?:now|add)\b|`mem`/],
    condition: MEM_CONDITION,
    sample: 'Keep the state with `commandmate mem now "x"`.',
    fix: ' Writes only on a branch whose mem mode is `on` (the default is `off`).',
  },
  {
    id: 'F2',
    name: 'commandmate brief (prints nothing while the mode is `off`)',
    required: true,
    mouth: [/commandmate brief\b|`brief`/],
    condition: [/\bmode\b|モード/i, /`off`|exit 50/],
    sample: 'After a restart, `commandmate brief` hands it back.',
    fix: ' It prints nothing while the mem mode is `off` (exit 50).',
  },
  {
    id: 'F3',
    name: 'automatic brief injection (mode derived/on AND injectOnStart)',
    required: true,
    mouth: [/brief/i, /注入|自動|inject|automatic/i],
    condition: [/injectOnStart/],
    sample: 'A brief is put in front of a send automatically.',
    fix: ' Only when `injectOnStart` is turned on.',
  },
  {
    id: 'F4',
    name: 'decisions applied on the screen (written only in mode `on`)',
    required: true,
    mouth: [/決定|decision|promote/i, /画面|screen/i],
    condition: [/\bmode\b|モード/i, /`on`/],
    sample: 'Decisions an agent records wait for you on the screen.',
    fix: ' They are recorded only on a branch whose mem mode is `on`.',
  },
  {
    id: 'F5',
    name: 'Auto Yes (off by default; a person turns it on)',
    required: true,
    mouth: [/auto[- ]?yes/i],
    condition: [/opt-in|既定で無効|off by default|オプショナル|optional|ask me before|私に確認|有効にする前/i],
    sample: 'Auto Yes answers the prompts for you.',
    fix: ' It is opt-in.',
  },
  {
    id: 'F6',
    name: 'commandmate remote public tunnel (needs approval)',
    required: true,
    mouth: [/commandmate remote|--provider cloudflare|Cloudflare Quick Tunnel/i],
    condition: [/承認|出す前に確認|asking before|asks? before|approv|--yes/i],
    sample: 'Run `commandmate remote` to pair your phone.',
    fix: ' A public tunnel starts only after you approve it.',
  },
  {
    id: 'F7',
    name: 'remote --auth remote-only (the local listener goes without auth)',
    required: true,
    mouth: [/remote-only/],
    condition: [/認証なし|トークンなし|トークンを求め|without (?:a )?token|without auth|unauthenticated|asks? for the token|token/i],
    sample: 'Use `--auth remote-only` for the phone.',
    fix: ' The local listener then goes without a token.',
  },
  {
    id: 'F8',
    name: 'push notifications (off until commandmate init sets them up)',
    required: true,
    mouth: [/プッシュ通知|push 通知|push notification|web push|通知/i, /届|arriv|waiting|入力待ち|待って|tells you|shows up/i],
    condition: [/commandmate init|有効にしたとき|when web push is (?:enabled|on)|VAPID/i],
    sample: 'A waiting agent reaches you as a push notification.',
    fix: ' Push works once `commandmate init` has set it up.',
  },
  {
    id: 'F9',
    name: 'roles (not a default-off feature; exempt)',
    required: false,
    mouth: [/commandmate roles|--role/],
    condition: [],
    sample: 'Start it with `commandmate roles`.',
    fix: '',
  },
  {
    id: 'F10',
    name: 'Antigravity driven by an agent or automation (refused without CM_ANTIGRAVITY_USAGE)',
    required: true,
    mouth: [
      /Antigravity|\bagy\b/i,
      /レビュー|ワーカー|自動|送る|送り|\b(?:review(?:s|ed)?|REJECT|APPROVE|workers?|send|ask|automat\w*|Schedules?)\b/i,
    ],
    condition: [/CM_ANTIGRAVITY_USAGE|個人向け|consumer|拒否|断ら|断る|refus|入れません|keeps Antigravity out/i],
    sample: 'Antigravity reviews the work.',
    fix: ' Agents can send to it only when `CM_ANTIGRAVITY_USAGE` is `api-key` or `enterprise`.',
  },
  {
    id: 'F11',
    name: 'Schedules (run only what CMATE.md says; exempt)',
    required: false,
    mouth: [/Schedules?|スケジュール/],
    condition: [],
    sample: 'Schedules start the work.',
    fix: '',
  },
  {
    id: 'F12',
    name: 'confirmed CLI (skill install, update; exempt)',
    required: false,
    mouth: [/skill install|commandmate update/],
    condition: [],
    sample: 'Run `commandmate update`.',
    fix: '',
  },
];

export const PUBLIC_DOCS = [
  'README.md',
  'docs/ja/README.md',
  'docs/concept.md',
  'docs/en/concept.md',
  'docs/user-guide/how-it-works.md',
  'docs/en/user-guide/how-it-works.md',
];

/** Headings whose sections are not judged (see the header). */
export const EXCLUDED_SECTIONS = ['## Before you use Antigravity (agy)', '## Antigravity（agy）を使う前に'];

interface Unit {
  kind: 'row' | 'item' | 'paragraph' | 'code';
  text: string;
  /** 1-based line number where the unit starts. */
  line: number;
  /** Index (0-based) of the unit's last line. */
  end: number;
}

const FENCE = /^\s*```/;
const ROW = /^\s*\|/;
const ITEM = /^\s*(?:[-*+]|\d+\.)\s/;
const HEADING = /^#{1,6}\s/;

function headingLevel(line: string): number | null {
  const m = /^(#{1,6})\s/.exec(line);
  return m ? m[1].length : null;
}

/** Blank out the lines of EXCLUDED_SECTIONS (fence-aware), keeping line numbers. */
function dropExcluded(lines: string[]): string[] {
  const out = [...lines];
  let fenced = false;
  let skipLevel: number | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE.test(line)) fenced = !fenced;
    const level = fenced ? null : headingLevel(line);
    if (level !== null && skipLevel !== null && level <= skipLevel) skipLevel = null;
    if (level !== null && EXCLUDED_SECTIONS.includes(line.trim())) skipLevel = level;
    if (skipLevel !== null) out[i] = '';
  }
  return out;
}

function splitUnits(lines: string[]): Unit[] {
  const units: Unit[] = [];
  let i = 0;
  const startsBlock = (l: string): boolean =>
    l.trim() === '' || ROW.test(l) || FENCE.test(l) || HEADING.test(l) || ITEM.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    if (FENCE.test(line)) {
      let j = i + 1;
      while (j < lines.length && !FENCE.test(lines[j])) j += 1;
      const end = Math.min(j, lines.length - 1);
      const block = lines.slice(i, end + 1).join('\n');
      const prev = units[units.length - 1];
      const gapBlank = prev !== undefined && lines.slice(prev.end + 1, i).every((l) => l.trim() === '');
      if (prev && gapBlank && (prev.kind === 'paragraph' || prev.kind === 'item')) {
        prev.text = `${prev.text}\n${block}`;
        prev.end = end;
      } else {
        units.push({ kind: 'code', text: block, line: i + 1, end });
      }
      i = end + 1;
      continue;
    }
    if (HEADING.test(line)) {
      i += 1;
      continue;
    }
    if (ROW.test(line)) {
      units.push({ kind: 'row', text: line, line: i + 1, end: i });
      i += 1;
      continue;
    }
    const kind = ITEM.test(line) ? 'item' : 'paragraph';
    let j = i;
    while (j + 1 < lines.length && !startsBlock(lines[j + 1])) j += 1;
    units.push({ kind, text: lines.slice(i, j + 1).join('\n'), line: i + 1, end: j });
    i = j + 1;
  }
  return units;
}

export interface MissingCondition {
  id: string;
  mouth: string;
  line: number;
  excerpt: string;
}

/** Returns every unit where a required, registered mouth appears without its condition in the same unit. */
export function findMissingConditions(
  markdown: string,
  features: DefaultOffFeature[] = DEFAULT_OFF_FEATURES,
): MissingCondition[] {
  const lines = dropExcluded(markdown.split(/\r?\n/));
  const missing: MissingCondition[] = [];
  for (const unit of splitUnits(lines)) {
    for (const f of features) {
      if (!f.required) continue;
      if (!f.mouth.every((re) => re.test(unit.text))) continue;
      if (f.condition.every((re) => re.test(unit.text))) continue;
      missing.push({ id: f.id, mouth: f.name, line: unit.line, excerpt: unit.text.split('\n')[0].slice(0, 120) });
    }
  }
  return missing;
}

/** The rows of the §4 registry table: ID → required ("条件を書く") or exempt ("求めない"). */
export function readCanonicalRegistry(markdown: string): Map<string, boolean> {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(REGISTRY_HEADING));
  const rows = new Map<string, boolean>();
  if (start < 0) return rows;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(line)) break;
    if (!ROW.test(line)) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (!/^F\d+$/.test(cells[0] ?? '')) continue;
    const treatment = cells[3] ?? '';
    rows.set(cells[0], treatment.startsWith('条件を書く'));
  }
  return rows;
}

describe('the registry matches public-messaging.md §4', () => {
  it('has the same IDs and the same treatment as the §4 table', () => {
    const canonical = readCanonicalRegistry(fs.readFileSync(path.join(REPO_ROOT, MESSAGING_DOC), 'utf8'));
    expect(canonical.size, `${MESSAGING_DOC} must have the "${REGISTRY_HEADING}" table`).toBeGreaterThan(0);
    const here = new Map(DEFAULT_OFF_FEATURES.map((f) => [f.id, f.required]));
    expect(Object.fromEntries(here)).toEqual(Object.fromEntries(canonical));
  });

  it('reads a drifted table as different (tmp control)', () => {
    const md = `${REGISTRY_HEADING}\n\n| ID | 機能 | 既定 | 公開面の扱い | 根拠 |\n|---|---|---|---|---|\n| F1 | mem | off | 求めない | x |\n`;
    expect(readCanonicalRegistry(md).get('F1')).toBe(false);
    expect(DEFAULT_OFF_FEATURES.find((f) => f.id === 'F1')?.required).toBe(true);
  });
});

describe('findMissingConditions (controls)', () => {
  it('passes a document that never names a registered mouth', () => {
    expect(findMissingConditions('# Title\n\nNothing about notes here.\n')).toEqual([]);
  });

  it('passes a table row that names mem now with the mode condition', () => {
    const md = '| `commandmate mem now "x"` | Record it. Writes only on a branch whose mem mode is `on` (default `off`) |\n';
    expect(findMissingConditions(md)).toEqual([]);
  });

  it('fails a table row that names mem now without the mode condition', () => {
    const md = '| `commandmate mem now "x"` | Record what a session is doing now |\n';
    const found = findMissingConditions(md);
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe('F1');
  });

  it('fails a mem row that drops "the default is `off`"', () => {
    const md = '| `commandmate mem now "x"` | Writes only on a branch whose mem mode is `on` |\n';
    expect(findMissingConditions(md).map((m) => m.id)).toEqual(['F1']);
  });

  // Inverted by reinstruction 2 (#4569): the condition on the next row used
  // to count, which let one row hide the other's missing condition.
  it('does not accept the condition on the line right after the unit', () => {
    const md = '| `commandmate mem add --kind note --text x` | A typed item |\n| (mem mode `on` only, default `off`) | |\n';
    expect(findMissingConditions(md).map((m) => m.line)).toEqual([1]);
  });

  it('fails a list item whose sibling item carries the condition', () => {
    const md = '- `commandmate mem now "x"` records the state\n- **mode**: mem mode `on` only; the default is `off`\n';
    expect(findMissingConditions(md).map((m) => [m.id, m.line])).toEqual([['F1', 1]]);
  });

  it('keeps the continuation lines of a list item in that item', () => {
    const md = '- `commandmate mem now "x"` records the state\n  (mem mode `on` only; the default is `off`)\n- next\n';
    expect(findMissingConditions(md)).toEqual([]);
  });

  it('fails a paragraph whose next paragraph carries the condition', () => {
    const md = 'Keep the state with `commandmate mem now "x"`.\n\nWrites only in mem mode `on` (the default is `off`).\n';
    expect(findMissingConditions(md).map((m) => m.line)).toEqual([1]);
  });

  it('fails a paragraph about automatic brief without injectOnStart, and passes it with', () => {
    const bad = 'The brief is put in front of a send automatically when you turn it on.\n';
    const good = 'The brief is put in front of a send automatically only when `injectOnStart` is on.\n';
    expect(findMissingConditions(bad).map((m) => m.id)).toEqual(['F3']);
    expect(findMissingConditions(good)).toEqual([]);
  });

  it('joins a code block to the prose before it', () => {
    const bad = 'Keep the state in mem.\n\n```bash\ncommandmate mem now "x"\n```\n\n- unrelated\n';
    const good = 'Keep the state in mem (mode `on` only; the default is `off`).\n\n```bash\ncommandmate mem now "x"\n```\n';
    expect(findMissingConditions(bad).map((m) => m.id)).toEqual(['F1']);
    expect(findMissingConditions(good)).toEqual([]);
  });

  it('skips the excluded Antigravity notice section, and only that section', () => {
    const md = '## Before you use Antigravity (agy)\n\n- turn on Auto-Yes for agy\n\n## Next\n\n- turn on Auto-Yes\n';
    expect(findMissingConditions(md).map((m) => [m.id, m.line])).toEqual([['F5', 7]]);
  });

  it('ignores exempt rows of the registry', () => {
    expect(findMissingConditions('Run `commandmate update` and `commandmate roles list`.\n')).toEqual([]);
  });
});

describe('every required row of the registry catches its own mouth (generated controls)', () => {
  const required = DEFAULT_OFF_FEATURES.filter((f) => f.required);
  const shapes: [string, (s: string) => string][] = [
    ['table row', (s) => `| cmd | ${s} |\n`],
    ['list item', (s) => `- ${s}\n`],
    ['paragraph', (s) => `${s}\n`],
  ];

  it.each(required.flatMap((f) => shapes.map(([shape, wrap]) => [f.id, shape, f, wrap] as const)))(
    '%s as a %s: red without the condition, green with it',
    (id, _shape, f, wrap) => {
      expect(findMissingConditions(wrap(f.sample), [f]).map((m) => m.id)).toEqual([id]);
      expect(findMissingConditions(wrap(`${f.sample}${f.fix}`), [f])).toEqual([]);
    },
  );
});

describe('findMissingConditions on a file (tmpdir controls)', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reads a document from disk the same way: red without, green with the condition', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'default-off-4569-'));
    const file = path.join(dir, 'README.md');
    fs.writeFileSync(file, '| `commandmate mem add --kind waiting` | A typed item |\n');
    expect(findMissingConditions(fs.readFileSync(file, 'utf8'))).toHaveLength(1);
    fs.writeFileSync(file, '| `commandmate mem add --kind waiting` | A typed item; mem mode `on` branches only (default `off`) |\n');
    expect(findMissingConditions(fs.readFileSync(file, 'utf8'))).toEqual([]);
  });
});

describe('public docs state the enabling condition of default-off features (#4569)', () => {
  it.each(PUBLIC_DOCS)('%s', (rel) => {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    expect(findMissingConditions(text)).toEqual([]);
  });
});
