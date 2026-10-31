/**
 * Where a prompt's screen may be read as a kind of dialog, and where that
 * reading may be read back (Issue #3881).
 *
 * `prompt-detector-single-entry-2368.test.ts` fixes who may call the generic
 * detector, so every consumer reads one frame one way. #3881 found the same
 * drift one step later: the reading of the frame (question, permission or
 * confirmation page) was lost at the save, and the chat transcript decided it
 * again from the stored strings — differently from the poller, on Claude's
 * 16-column confirm page. So the decision now has a fixed home too:
 *
 * - WRITERS decide the kind from a frame (`readPromptScreen` /
 *   `promptDataForStorage`). Only the module that defines them and the two
 *   writers of a `prompt` row that have the frame in hand: the response
 *   poller's save, the Auto-Yes poller's audit row and a person's answer's
 *   audit row (`/prompt-response`).
 * - READERS take a stored reading back (`readStoredPromptReading`). Only the
 *   module that defines it and the chat transcript.
 * - The reading's version constant is named only where a reading is defined,
 *   built or validated — a second builder would be a second classifier.
 *
 * Widening a list is allowed, but each entry names a test that runs the same
 * live fixture (`tab-row-wrapped-16x1000.txt`) through the new site, and this
 * file checks that test exists and uses it. That is the condition #3881's
 * recurrence plan (G2-6) attaches to widening.
 *
 * A listed file covers the pieces split off it (`<dir>/<base>-*.ts`, Issue
 * #3903, `split-family.ts`): a split may move `auditPromptData` out of the
 * Auto-Yes poller without widening the list. A file outside every family fails
 * as before.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { originsOf } from './split-family';

const REPO_ROOT = process.cwd();
const FIXTURE = 'tab-row-wrapped-16x1000.txt';
const E2E_PROOF = 'tests/unit/lib/polling/prompt-reading-confirm-page-3881.test.ts';

interface Site {
  file: string;
  why: string;
  /** A test that runs {@link FIXTURE} through this site. */
  proof: string;
}

const WRITERS: readonly Site[] = [
  {
    file: 'src/app/api/worktrees/[id]/prompt-response/answer-delivery.ts',
    why: 'A person’s answer (second review N2): the audit row of the PC and phone panels and `commandmate respond` is stored with the reading of the frame the answer was verified against, as the Auto-Yes audit row is.',
    proof: 'tests/unit/api/prompt-response-audit-reading-3881.test.ts',
  },
  {
    file: 'src/lib/polling/prompt-screen-reading.ts',
    why: 'The definition: the one function that reads a frame as question / permission / confirmation, with the predicates the Auto-Yes poller acts on.',
    proof: E2E_PROOF,
  },
  {
    file: 'src/lib/auto-yes-poller.ts',
    why: 'The Auto-Yes audit row (review P2-2): an answer recorded before the response poller saved the prompt creates the row, so it is stored with the reading of the frame the tick answered (its one normalised frame), not the bare promptData.',
    proof: 'tests/unit/lib/polling/prompt-reading-audit-row-3881.test.ts',
  },
  {
    file: 'src/lib/polling/response-checker.ts',
    why: 'The response poller’s save (`savePromptMessage`): the one producer of `prompt` rows that has the frame in hand when it writes the row.',
    proof: E2E_PROOF,
  },
];

const READERS: readonly Site[] = [
  {
    file: 'src/lib/detection/prompt-reading.ts',
    why: 'The definition: validates a stored reading field by field and answers null for anything this version cannot vouch for.',
    proof: E2E_PROOF,
  },
  {
    file: 'src/lib/chat/chat-tool-approvals.ts',
    why: 'The chat transcript’s chips: a stored reading decides kind and phase; only a row without one goes through the compatibility rules.',
    proof: 'tests/unit/components/worktree/ChatTranscript-stored-reading-3881.test.tsx',
  },
];

const VERSION_SITES: readonly string[] = [
  'src/types/prompt-reading.ts',
  'src/lib/detection/prompt-reading.ts',
  'src/lib/polling/prompt-screen-reading.ts',
];

function trackedSources(): string[] {
  return execFileSync('git', ['ls-files', '-z', 'src'], { cwd: REPO_ROOT, encoding: 'utf-8' })
    .split('\0')
    .filter((f) => /\.tsx?$/.test(f));
}

/** The source with its comments taken out, so prose naming a function is not a call. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Does the code call (or define) any of `names`? A method of the same name elsewhere does not count. */
export function callsAny(source: string, names: readonly string[]): boolean {
  const code = codeOf(source);
  return names.some((name) => new RegExp(`(^|[^\\w.])${name}\\s*\\(`, 'm').test(code));
}

/** Does the code name `identifier` at all? */
export function namesIdentifier(source: string, identifier: string): boolean {
  return new RegExp(`(^|[^\\w.])${identifier}\\b`, 'm').test(codeOf(source));
}

/** The files of `sources` (path → code) that match `predicate`, as the listed files they belong to (#3903). */
export function sitesIn(
  sources: ReadonlyMap<string, string>,
  predicate: (source: string) => boolean,
  listed: readonly string[],
): string[] {
  const hits = [...sources].filter(([, code]) => predicate(code)).map(([file]) => file);
  return originsOf(hits, listed);
}

function sitesMatching(predicate: (source: string) => boolean, listed: readonly string[]): string[] {
  const sources = new Map(trackedSources().map((f) => [f, readFileSync(join(REPO_ROOT, f), 'utf-8')] as const));
  return sitesIn(sources, predicate, listed);
}

describe('[#3881] the screen is read as a kind of dialog in a fixed set of places', () => {
  it('writers: exactly the allowlist', () => {
    const listed = WRITERS.map((s) => s.file);
    expect(sitesMatching((s) => callsAny(s, ['readPromptScreen', 'promptDataForStorage']), listed)).toEqual(
      [...listed].sort(),
    );
  });

  it('readers: exactly the allowlist', () => {
    const listed = READERS.map((s) => s.file);
    expect(sitesMatching((s) => callsAny(s, ['readStoredPromptReading']), listed)).toEqual([...listed].sort());
  });

  it('the reading’s version is named only where a reading is defined, built or validated', () => {
    expect(sitesMatching((s) => namesIdentifier(s, 'PROMPT_READING_VERSION'), VERSION_SITES)).toEqual(
      [...VERSION_SITES].sort(),
    );
  });

  it.each([...WRITERS, ...READERS])('$file states a reason and a proof that runs the live fixture', ({ file, why, proof }) => {
    expect(existsSync(join(REPO_ROOT, file)), `${file} is listed but missing`).toBe(true);
    expect(why.length).toBeGreaterThan(60);
    expect(existsSync(join(REPO_ROOT, proof)), `${proof} is missing`).toBe(true);
    expect(readFileSync(join(REPO_ROOT, proof), 'utf-8')).toContain(FIXTURE);
  });
});

describe('[#3881] the scanner is not vacuous', () => {
  it('catches a call', () => {
    expect(callsAny('const r = readPromptScreen(tool, frame, d);\n', ['readPromptScreen'])).toBe(true);
  });

  it('ignores a mention in prose and a method of the same name', () => {
    expect(callsAny('/** readPromptScreen(x) */\nconst r = other.readPromptScreen(x);\n', ['readPromptScreen'])).toBe(false);
  });

  it('names an identifier in code, not in a comment', () => {
    expect(namesIdentifier('import { PROMPT_READING_VERSION } from "x";\n', 'PROMPT_READING_VERSION')).toBe(true);
    expect(namesIdentifier('// PROMPT_READING_VERSION\n', 'PROMPT_READING_VERSION')).toBe(false);
  });

  it('the walk reached the listed files', () => {
    const tracked = trackedSources();
    for (const { file } of [...WRITERS, ...READERS]) expect(tracked).toContain(file);
  });
});

describe('[#3903] a split may move a writer, and only within a listed file', () => {
  const WRITER_FILES = WRITERS.map((s) => s.file);
  const writes = (s: string): boolean => callsAny(s, ['readPromptScreen', 'promptDataForStorage']);
  /** The listed writers as they are before a split. */
  const before = (): Map<string, string> =>
    new Map(WRITER_FILES.map((f) => [f, 'const r = promptDataForStorage(tool, frame, d);\n']));

  it('positive: auditPromptData moved to auto-yes-poller-*.ts counts as the Auto-Yes poller', () => {
    // Before #3903 the list compared paths, so this piece was an unlisted fifth writer.
    const sources = before();
    sources.set('src/lib/auto-yes-poller.ts', "import { auditPromptData } from './auto-yes-poller-audit';\n");
    sources.set(
      'src/lib/auto-yes-poller-audit.ts',
      'export function auditPromptData() { return promptDataForStorage(tool, frame, d); }\n',
    );
    expect(sitesIn(sources, writes, WRITER_FILES)).toEqual([...WRITER_FILES].sort());
  });

  it('negative: a caller outside every listed file still fails, also one only named like a piece', () => {
    const sources = before();
    sources.set('src/lib/other.ts', 'readPromptScreen(tool, frame, d);\n');
    sources.set('src/lib/auto-yes-poller2.ts', 'readPromptScreen(tool, frame, d);\n');
    sources.set('src/lib/polling/auto-yes-poller-audit.ts', 'readPromptScreen(tool, frame, d);\n');
    const got = sitesIn(sources, writes, WRITER_FILES);
    expect(got).not.toEqual([...WRITER_FILES].sort());
    expect(got).toEqual(
      expect.arrayContaining(['src/lib/other.ts', 'src/lib/auto-yes-poller2.ts', 'src/lib/polling/auto-yes-poller-audit.ts']),
    );
  });

  it('negative: a listed writer whose family stopped calling is missing', () => {
    const sources = before();
    sources.set('src/lib/auto-yes-poller.ts', 'export {};\n');
    expect(sitesIn(sources, writes, WRITER_FILES)).not.toContain('src/lib/auto-yes-poller.ts');
  });
});
