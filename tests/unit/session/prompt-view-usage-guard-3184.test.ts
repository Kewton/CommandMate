/**
 * Nothing in the UI, the Auto-Yes hooks or the CLI decides how a prompt is
 * shown from its raw `type` (Issue #3184, design §4.2).
 *
 * `derivePromptView` is the one decision. What may still appear in
 * `src/components`, `src/hooks` and `src/cli` is a TYPE NARROWING to the closed
 * `PromptData` union (#1725) — a send body that needs `options` typed — or the
 * CLI writing the `unclassified` wire value (an object's `type:` property, which
 * is skipped). Each remaining line must carry a reason
 * comment naming #3184 within the few lines above it; a new line that reads the
 * sentinel to choose what to draw fails here.
 *
 * @vitest-environment node
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const SCANNED = ['src/components', 'src/hooks', 'src/cli'];

/** The ways a reader can look at the sentinel or its predicate directly. */
const DIRECT = /isAnswerablePromptData\(|UNCLASSIFIED_PROMPT_TYPE|UNCLASSIFIED_PROMPT_VIEW_TYPE|type\s*[!=]==\s*'unclassified'|'unclassified'\s*[!=]==\s*[\w.]*type\b/;

/** How far above a hit its reason comment may sit. */
const REASON_WINDOW = 8;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

function findUnexplained(files: { rel: string; text: string }[]): string[] {
  const hits: string[] = [];
  for (const { rel, text } of files) {
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
      if (trimmed.startsWith('import ') || /^[\w\s,]*\}?\s*from\s/.test(trimmed) || /^\w+,$/.test(trimmed)) return;
      // WRITING the wire value (`wait`'s synthesized exit-10 `type`) decides
      // nothing about a payload; only reads are judged.
      if (/^type:\s*UNCLASSIFIED_PROMPT_TYPE,?$/.test(trimmed)) return;
      if (!DIRECT.test(line)) return;
      const window = lines.slice(Math.max(0, index - REASON_WINDOW), index + 1).join('\n');
      if (!window.includes('#3184')) hits.push(`${rel}:${index + 1}: ${trimmed}`);
    });
  }
  return hits;
}

function repoFiles(): { rel: string; text: string }[] {
  return SCANNED.flatMap((dir) => sourceFiles(path.join(ROOT, dir))).map((full) => ({
    rel: path.relative(ROOT, full).split(path.sep).join('/'),
    text: readFileSync(full, 'utf8'),
  }));
}

describe('prompt display is decided by derivePromptView alone (#3184)', () => {
  it('every direct look at the sentinel in UI / hooks / CLI carries a #3184 reason', () => {
    expect(findUnexplained(repoFiles())).toEqual([]);
  });

  it('positive control: an unexplained look is reported, an explained one is not', () => {
    expect(
      findUnexplained([
        {
          rel: 'src/components/New.tsx',
          text: "const x = 1;\nif (promptData.type === 'unclassified') draw();",
        },
        {
          rel: 'src/components/Old.tsx',
          text: '// #3184: type narrowing only\nconst p = isAnswerablePromptData(d) ? d : null;',
        },
      ]),
    ).toEqual(["src/components/New.tsx:2: if (promptData.type === 'unclassified') draw();"]);
  });
});
