/**
 * Issue #4438 (stage A, docs): the Antigravity (agy) usage notice.
 *
 * Section 6 of the Google Antigravity Additional Terms of Service and the
 * official FAQ restrict using Antigravity through third-party software on
 * consumer plans. What is pinned here is only what a surface must not get
 * wrong, not the wording:
 *
 * 1. Both READMEs (EN and JA) carry the notice with both primary-source links,
 *    and neither claims the question is "being confirmed with Google".
 * 2. The agent-health docs no longer recommend running agy from a Schedule:
 *    no Schedule row of `CMATE.example.md` names antigravity, and every line
 *    of the guide's Schedule section that names Antigravity is a caution.
 * 3. The CLI Operations Guide (JA and EN) puts the caution in the Auto-Yes,
 *    relay and unattended-run sections.
 *
 * The checkers are run against fixtures in a temp dir first, so a checker
 * that could never fail does not pass silently (positive / negative control).
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_PERMISSIONS } from '@/config/schedule-config';

const REPO_ROOT = path.resolve(__dirname, '../../..');

const TERMS_URL = 'https://antigravity.google/terms';
const FAQ_URL = 'https://antigravity.google/docs/faq';

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

/** The body of the `##`/`###` section whose heading line starts with `heading`. */
function section(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start < 0) return '';
  const level = heading.match(/^#+/)?.[0].length ?? 2;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = l.match(/^(#+) /);
    return m !== null && m[1].length <= level;
  });
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

/** Rows of the `## Schedules` table of a CMATE.md: name, tool and permission. */
function scheduleRows(text: string): Array<{ name: string; tool: string; permission: string }> {
  return section(text, '## Schedules')
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|\s*(Name|-)/.test(l))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
    .map((cells) => ({ name: cells[0], tool: cells[3], permission: cells[5] }));
}

/** Lines naming Antigravity / agy that are not a caution (a recommendation). */
const CAUTION = /勧めない|使わない|動かさない|規約|#4436|#4438|do not|terms/i;
function recommendingAntigravityLines(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => /antigravity|\bagy\b/i.test(l))
    .filter((l) => !CAUTION.test(l));
}

/**
 * The declaration is read from the server's environment at startup only, so a
 * notice says to restart the server and that the CLI's environment has no effect.
 */
const SERVER_ENV_ONLY =
  /(サーバーの環境変数[\s\S]*commandmate start --daemon[\s\S]*CLI を打つ側の環境に設定しても効[かき])|(server's environment variable[\s\S]*commandmate start --daemon[\s\S]*CLI has no effect)/;

/** A notice is present when it links both primary sources. */
function hasNoticeLinks(text: string): boolean {
  return text.includes(TERMS_URL) && text.includes(FAQ_URL);
}

describe('[#4438] checkers (controls on temp fixtures)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-notice-4438-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function fixture(name: string, body: string): string {
    const file = path.join(tmpDir, name);
    fs.writeFileSync(file, body);
    return fs.readFileSync(file, 'utf8');
  }

  it('flags the old antigravity Schedule row and recommendation (positive control)', () => {
    const cmate = fixture(
      'CMATE.md',
      [
        '## Schedules',
        '',
        '| Name | Cron | Message | CLI Tool | Enabled | Permission |',
        '|------|------|---------|----------|---------|------------|',
        '| agent-health-daily | 0 7 * * * | run | antigravity | true | --dangerously-skip-permissions |',
        '',
      ].join('\n'),
    );
    expect(scheduleRows(cmate).map((r) => r.tool)).toEqual(['antigravity']);
    const guide = fixture('guide.md', '- 毎日 07:00 に Antigravity（`agy -p`）で手順を実行する\n');
    expect(recommendingAntigravityLines(guide)).toHaveLength(1);
    expect(hasNoticeLinks(fixture('readme.md', '# README\n'))).toBe(false);
  });

  it('passes a claude row, a caution line and a linked notice (negative control)', () => {
    const cmate = fixture(
      'CMATE.md',
      [
        '## Schedules',
        '',
        '| Name | Cron | Message | CLI Tool | Enabled | Permission |',
        '|------|------|---------|----------|---------|------------|',
        '| agent-health-daily | 0 7 * * * | run | claude | true | bypassPermissions |',
        '',
      ].join('\n'),
    );
    expect(scheduleRows(cmate)).toEqual([
      { name: 'agent-health-daily', tool: 'claude', permission: 'bypassPermissions' },
    ]);
    const guide = fixture('guide.md', '- Antigravity の Schedule は勧めない（規約 6 条）\n');
    expect(recommendingAntigravityLines(guide)).toEqual([]);
    expect(hasNoticeLinks(fixture('readme.md', `[t](${TERMS_URL}) [f](${FAQ_URL})\n`))).toBe(true);
  });
});

describe('[#4438] README: the Antigravity usage notice (EN and JA)', () => {
  it('EN README has the notice with both links and no "being confirmed" claim', () => {
    const notice = section(read('README.md'), '## Before you use Antigravity');
    expect(notice).not.toBe('');
    expect(hasNoticeLinks(notice)).toBe(true);
    expect(notice).toMatch(/no explicit confirmation from Google/);
    expect(notice).not.toMatch(/being confirmed/i);
    expect(notice).toMatch(/CM_ANTIGRAVITY_USAGE/);
    expect(notice).toMatch(SERVER_ENV_ONLY);
  });

  it('JA README has the notice with both links and no 「確認中」 claim', () => {
    const notice = section(read('docs/ja/README.md'), '## Antigravity（agy）を使う前に');
    expect(notice).not.toBe('');
    expect(hasNoticeLinks(notice)).toBe(true);
    expect(notice).toMatch(/Google による明示の確認は無い/);
    expect(notice).not.toMatch(/確認中/);
    expect(notice).toMatch(/CM_ANTIGRAVITY_USAGE/);
    expect(notice).toMatch(SERVER_ENV_ONLY);
  });
});

describe('[#4438] agent-health: no Antigravity Schedule is recommended', () => {
  it('CMATE.example.md has no antigravity row; the daily row runs on claude with a claude permission', () => {
    const rows = scheduleRows(read('docs/agent-health/CMATE.example.md'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.tool === 'antigravity')).toEqual([]);
    const daily = rows.find((r) => r.name === 'agent-health-daily');
    expect(daily?.tool).toBe('claude');
    expect(CLAUDE_PERMISSIONS as readonly string[]).toContain(daily?.permission);
  });

  it('the Schedule section of agent-health.md names Antigravity only as a caution', () => {
    const schedule = section(read('docs/user-guide/agent-health.md'), '## 毎日の自動実行（Schedule）');
    expect(schedule).not.toBe('');
    expect(recommendingAntigravityLines(schedule)).toEqual([]);
    expect(schedule).toContain('#4436');
    expect(hasNoticeLinks(schedule)).toBe(true);
  });
});

describe('[#4438] CLI Operations Guide: cautions in the Auto-Yes, relay and unattended sections', () => {
  const cases = [
    {
      file: 'docs/user-guide/cli-operations-guide.md',
      headings: [
        '## commandmate relays',
        '## commandmate auto-yes',
        '### 無人実行の Auto-Yes ポリシーは allow-listed を使う',
      ],
    },
    {
      file: 'docs/en/user-guide/cli-operations-guide.md',
      headings: [
        '## commandmate relays',
        '## commandmate auto-yes',
        '### Use an allow-listed Auto-Yes Policy for Unattended Runs',
      ],
    },
  ];
  for (const { file, headings } of cases) {
    for (const heading of headings) {
      it(`${file}: "${heading}" carries the caution`, () => {
        const body = section(read(file), heading);
        expect(body).not.toBe('');
        expect(body).toMatch(/Antigravity/);
        expect(body).toContain(TERMS_URL);
        expect(body).toContain('CM_ANTIGRAVITY_USAGE');
        expect(body).toMatch(SERVER_ENV_ONLY);
      });
    }
  }
});

describe('[#4438] agent-health: the watcher follows the daily runner (I10)', () => {
  it('watch-prompt.md reports claude as the runner and names Antigravity only as a caution', () => {
    const watch = read('docs/agent-health/watch-prompt.md');
    expect(recommendingAntigravityLines(watch)).toEqual([]);
    expect(watch).toContain('runner=claude');
    expect(watch).not.toMatch(/runner=antigravity|agent-health:antigravity:/);
  });

  it('every file under docs/agent-health names antigravity only as a caution', () => {
    const dir = path.join(REPO_ROOT, 'docs/agent-health');
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.md'))) {
      expect({ name, lines: recommendingAntigravityLines(read(`docs/agent-health/${name}`)) }).toEqual({ name, lines: [] });
    }
  });
});

describe('[#4438-4] CLI Operations Guide: every exit-33 row names auto-yes', () => {
  /** The `| 33 |` rows of a guide's tables. */
  function rows33(text: string): string[] {
    return text.split('\n').filter((l) => l.startsWith('| 33 |'));
  }
  const files = [
    'docs/user-guide/cli-operations-guide.md',
    'docs/en/user-guide/cli-operations-guide.md',
  ];

  for (const file of files) {
    it(`${file}: all three 33 rows mention auto-yes`, () => {
      const rows = rows33(read(file));
      expect(rows).toHaveLength(3);
      for (const row of rows) expect(row).toContain('auto-yes');
    });

    it(`${file}: the auto-yes section says it exits 33 when refused`, () => {
      const heading = '## commandmate auto-yes';
      const body = section(read(file), heading);
      expect(body).toMatch(/33/);
      expect(body).toContain('TOOL_POLICY_DENIED');
    });
  }

  it('negative control: a 33 row that names only send/ask/respond/relay is caught', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4438-4-'));
    try {
      const p = path.join(dir, 'guide.md');
      fs.writeFileSync(p, '| 33 | TOOL POLICY DENIED | `send` / `ask` / `respond` and relay |\n');
      const rows = rows33(fs.readFileSync(p, 'utf8'));
      expect(rows.every((r) => r.includes('auto-yes'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
