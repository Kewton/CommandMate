/**
 * `/orchestrate` 2-4-1 must carry a *real* CHANGELOG entry as the worked example (Issue #1997).
 *
 * The section used to specify the fragment format with a one-line abstract spec
 * (`- **<type>(<scope>): …** (#<N>): …`). In the 2026-08-22〜23 run 3 of 4 Phase 4
 * workers wrote a fragment that did not start with `- **`, so `grep -cE '^- \*\*'`
 * — the count 6-4 verifies the fold with — would not have counted them. A worked
 * example is what fixed it, and an example that drifts from `CHANGELOG.md` (or is
 * invented outright) teaches the wrong shape, so the example line is pinned here
 * against the real file rather than against a copy.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const ORCHESTRATE_PATH = '.claude/commands/orchestrate.md';

const read = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const orchestrate = read(ORCHESTRATE_PATH);
const changelog = read('CHANGELOG.md');
const moduleReference = read('docs/module-reference.md');
const claudeMd = read('CLAUDE.md');

/** The `### 2-4-1 …` section body, up to the next `###` heading. */
function section241(): string[] {
  const lines = orchestrate.split('\n');
  const start = lines.findIndex((line) => line.startsWith('### 2-4-1.'));
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('### '));
  return end === -1 ? rest : rest.slice(0, end);
}

/** The blockquote the orchestrator transcribes verbatim into every contract, `> ` stripped. */
function transcribedBlock(): string[] {
  return section241()
    .filter((line) => line.startsWith('>'))
    .map((line) => line.replace(/^> ?/, ''));
}

interface Fence {
  info: string;
  body: string[];
}

/** Fenced blocks inside the transcribed block, plus the lines that sit outside them. */
function splitFences(lines: string[]): { fences: Fence[]; prose: string[] } {
  const fences: Fence[] = [];
  const prose: string[] = [];
  let open: Fence | null = null;

  for (const line of lines) {
    const marker = line.match(/^\s*```(.*)$/);
    if (marker) {
      if (open) {
        fences.push(open);
        open = null;
      } else {
        open = { info: marker[1].trim(), body: [] };
      }
      continue;
    }
    if (open) {
      open.body.push(line.replace(/^ {4}/, ''));
    } else {
      prose.push(line);
    }
  }

  expect(open).toBeNull(); // an unterminated fence would swallow the rest of the section
  return { fences, prose };
}

const { fences, prose } = splitFences(transcribedBlock());

describe('/orchestrate 2-4-1 CHANGELOG fragment example', () => {
  it('embeds exactly two worked examples: the CHANGELOG entry and the module-reference note', () => {
    expect(fences).toHaveLength(2);
    expect(fences[0].info).toBe('markdown');
    expect(fences[1].info).toBe('markdown');
  });

  it('opens the CHANGELOG example with the section-name comment 6-4 skips with `sed -n 2,$p`', () => {
    const [first] = fences[0].body;
    expect(first).toMatch(/^<!--\s+###\s+(Added|Changed|Fixed)\s+-->$/);
  });

  it('shows exactly one entry, on exactly one line', () => {
    const entryLines = fences[0].body.slice(1).filter((line) => line.trim() !== '');
    expect(entryLines).toHaveLength(1);
  });

  it('shapes the entry so `grep -cE \'^- \\*\\*\'` counts it and `(#N)` stays outside the summary', () => {
    const [entry] = fences[0].body.slice(1).filter((line) => line.trim() !== '');

    // The exact expression 6-4 uses to verify the fold.
    expect(entry).toMatch(/^- \*\*/);

    const shape = entry.match(/^- \*\*([a-z]+)\(([a-z0-9,\-]+)\): (.+?)\*\* \(#(\d+)\): (.+)$/);
    expect(shape).not.toBeNull();
    const [, , , summary, , body] = shape!;
    expect(summary.length).toBeGreaterThan(0);
    expect(body.length).toBeGreaterThan(0);
    // `（Issue #N）` inside the summary is the deviation this example exists to prevent.
    expect(summary).not.toMatch(/Issue\s*#\d+/);
  });

  it('quotes an entry that really exists in CHANGELOG.md, byte for byte', () => {
    const [entry] = fences[0].body.slice(1).filter((line) => line.trim() !== '');
    expect(changelog.split('\n')).toContain(entry);
  });

  it('names a `<type>` that CLAUDE.md actually defines', () => {
    const [entry] = fences[0].body.slice(1).filter((line) => line.trim() !== '');
    const type = entry.match(/^- \*\*([a-z]+)\(/)![1];
    expect(commitTypes()).toContain(type);
  });
});

/** The commit-type vocabulary from the CLAUDE.md table (`| \`feat\` | 新機能 |`). */
function commitTypes(): string[] {
  const types = [...claudeMd.matchAll(/^\| `([a-z]+)` \| .+ \|$/gm)].map((match) => match[1]);
  expect(types).toContain('feat');
  expect(types).toContain('fix');
  return types;
}

describe('/orchestrate 2-4-1 rationale bullets', () => {
  /** The four one-line reasons, nested under the changelog fragment bullet. */
  const reasons = prose.filter((line) => /^ {4}- /.test(line));

  it('states four reasons, one line each', () => {
    expect(reasons).toHaveLength(4);
    for (const reason of reasons) {
      expect(reason).not.toContain('\n');
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });

  it('reason 1 ties the leading `- **` to the counting grep', () => {
    expect(reasons[0]).toContain('- **');
    expect(reasons[0]).toContain("grep -cE '^- \\*\\*'");
  });

  it('reason 2 keeps `(#N)` out of the summary', () => {
    expect(reasons[1]).toContain('(#<N>)');
    expect(reasons[1]).toContain('（Issue #<N>）');
  });

  it('reason 3 lists only types CLAUDE.md defines', () => {
    const listed = [...reasons[2].matchAll(/`([a-z]+)`/g)].map((match) => match[1]);
    expect(listed.length).toBeGreaterThanOrEqual(8);
    for (const type of listed) {
      expect(commitTypes()).toContain(type);
    }
  });

  it('reason 4 forbids wrapping an entry across lines', () => {
    expect(reasons[3]).toMatch(/1 エントリ＝1 行/);
  });
});

describe('/orchestrate 2-4-1 module-reference fragment', () => {
  it('requires the existence check to be run and its output copied into the fragment', () => {
    const block = transcribedBlock().join('\n');
    expect(block).toContain("grep -n '^| \\`<path>\\`' docs/module-reference.md");
    expect(block).toContain('断片に書き写してから');
  });

  it('demonstrates the check with a row key that really exists', () => {
    const example = fences[1].body.join('\n');
    const rowKey = example.match(/- `([^`]+)` — 実在確認/);
    expect(rowKey).not.toBeNull();
    expect(moduleReference).toContain(`| \`${rowKey![1]}\` |`);
  });
});

describe('/orchestrate 2-4-1 pre-existing instructions', () => {
  const body = section241().join('\n');

  it('still keeps both shared files out of scope.allow', () => {
    expect(body).toContain(
      '**`CHANGELOG.md` と `docs/module-reference.md` を `scope.allow` に入れてはならない。**'
    );
  });

  it('still says the fragments live under dev-reports/ and are written with the implementation', () => {
    expect(body).toContain('`dev-reports/` 配下なので commit には入りません');
    expect(body).toContain('**実装と同じ commit の時点で書くこと。**');
  });
});
