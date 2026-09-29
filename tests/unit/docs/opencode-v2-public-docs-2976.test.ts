/**
 * OpenCode V2 on the public surfaces and in the user guides (Issue #2976).
 *
 * The decision (option A): the public count stays at eight. `CLI_TOOL_IDS` has
 * nine ids, but `opencode` and `opencode-v2` are OpenCode 1.x and V2 and are
 * counted as one agent, written "OpenCode (1.x and V2)" where the versions are
 * spelled out. public-messaging §3c and §11 say so.
 *
 * What goes red here:
 * - a surface that starts counting nine (`nine agents`, `9 種`, ...);
 * - the counting rule dropping out of public-messaging;
 * - an agent list on README / LP / public-messaging losing "OpenCode (1.x and V2)";
 * - the ja / en OpenCode V2 guides disappearing or losing their known-bug section;
 * - the skills guide going back to "a session restart is required" for every agent.
 *
 * The positive and negative controls run the same scanner over files written to
 * a temporary directory, so no repository file is rewritten.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** Every public surface that states or implies the agent count. */
const COUNT_SURFACES = [
  'README.md',
  'docs/ja/README.md',
  'website/index.html',
  'website/llms.txt',
  'docs/design/public-messaging.md',
  'docs/concept.md',
  'docs/en/concept.md',
];

/** A count of nine agents, in either language. */
const NINE_AGENTS = [
  /\bnine\s+(?:coding\s+)?(?:agents?|agent\s+CLIs|CLIs)\b/i,
  /\bany of the nine\b/i,
  /\ball nine\b/i,
  /\b9\s+(?:coding\s+)?(?:agents|agent\s+CLIs|CLIs)\b/i,
  /9\s*種/,
];

/** Lines of `text` that count nine agents, as `<line>: <text>`. */
function findNineAgentCounts(text: string): string[] {
  const hits: string[] = [];
  text.split('\n').forEach((line, index) => {
    if (NINE_AGENTS.some((pattern) => pattern.test(line))) {
      hits.push(`${index + 1}: ${line.trim()}`);
    }
  });
  return hits;
}

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

describe('the public count of agents stays at eight (Issue #2976, option A)', () => {
  let tmp: string | null = null;

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('flags a nine-agent count and passes an eight-agent one (controls)', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-2976-'));
    const bad = path.join(tmp, 'bad.md');
    const good = path.join(tmp, 'good.md');
    fs.writeFileSync(bad, 'Intro.\nAny of the nine agents can take the work.\n9 種すべてが第一級。\n');
    fs.writeFileSync(good, 'Intro.\nAny of the eight agents can take the work.\n8 種すべてが第一級。\n');

    expect(findNineAgentCounts(fs.readFileSync(bad, 'utf8'))).toEqual([
      '2: Any of the nine agents can take the work.',
      '3: 9 種すべてが第一級。',
    ]);
    expect(findNineAgentCounts(fs.readFileSync(good, 'utf8'))).toEqual([]);
  });

  it.each(COUNT_SURFACES)('%s does not count nine agents', (relative) => {
    expect(findNineAgentCounts(read(relative))).toEqual([]);
  });

  it('still has nine CLI tool ids, which is why the rule has to be written down', () => {
    expect(CLI_TOOL_IDS).toContain('opencode');
    expect(CLI_TOOL_IDS).toContain('opencode-v2');
  });

  it('writes the counting rule into public-messaging §3c and §11', () => {
    const doc = read('docs/design/public-messaging.md');
    expect(doc.split('v1 と v2 は 1 種と数える').length - 1).toBeGreaterThanOrEqual(2);
    expect(doc).not.toContain('公開面の「8 種」には数えない');
  });

  it.each([
    ['README.md', 'OpenCode (1.x and V2)'],
    ['docs/ja/README.md', 'OpenCode（1.x と V2）'],
    ['website/index.html', 'OpenCode (1.x and V2)'],
    ['docs/design/public-messaging.md', 'OpenCode (1.x and V2)'],
    ['docs/design/public-messaging.md', 'OpenCode（1.x と V2）'],
  ])('%s names "%s" in its agent list', (relative, phrase) => {
    expect(read(relative)).toContain(phrase);
  });
});

describe('the OpenCode V2 user guides (Issue #2976)', () => {
  const JA = 'docs/user-guide/opencode-v2.md';
  const EN = 'docs/en/user-guide/opencode-v2.md';

  it('exists in both languages and links the other one', () => {
    expect(read(JA)).toContain('(../en/user-guide/opencode-v2.md)');
    expect(read(EN)).toContain('(../../user-guide/opencode-v2.md)');
  });

  it.each([JA, EN])('%s names the executable, the open bug and the v1 differences', (relative) => {
    const body = read(relative);
    expect(body).toContain('opencode2');
    expect(body).toContain('#2991');
    expect(body).toContain('shift+tab');
    expect(body).toContain('Always allow');
  });

  it('is linked from README and from the CLI setup guides', () => {
    expect(read('README.md')).toContain('(./docs/en/user-guide/opencode-v2.md)');
    expect(read('docs/ja/README.md')).toContain('(../user-guide/opencode-v2.md)');
    expect(read('docs/user-guide/cli-setup-guide.md')).toContain('(./opencode-v2.md)');
    expect(read('docs/en/user-guide/cli-setup-guide.md')).toContain('(./opencode-v2.md)');
  });

  it('does not tell every agent it needs a session restart to see a new Skill', () => {
    const ja = read('docs/user-guide/skills.md');
    const en = read('docs/en/user-guide/skills.md');
    expect(en).not.toContain('reads its own discovery root at startup (**a session restart is required**');
    expect(ja).not.toContain('各 Agent が起動時に自分の discovery root を読む（**セッション再起動が必要**');
    expect(en).toMatch(/\| OpenCode V2 \| 2\.0\.18 \|/);
    expect(ja).toMatch(/\| OpenCode V2 \| 2\.0\.18 \|/);
  });

  it('tells schedule users that "Always allow" reaches every worktree of the repository', () => {
    expect(read('docs/user-guide/cmate-schedules-guide.md')).toContain(
      '同じリポジトリのすべての worktree のスケジュールで許可済み',
    );
    expect(read('docs/en/user-guide/cmate-schedules-guide.md')).toContain(
      'allowed in the schedules of every worktree of the',
    );
  });
});
