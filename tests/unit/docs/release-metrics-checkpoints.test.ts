/**
 * The `report metrics` checkpoints must keep saying what the code actually does.
 *
 * Two claims in these recipes are cheap to get wrong and expensive to be wrong
 * about, so they are asserted against the source constants rather than restated:
 *
 * 1. `--days` is *not* clamped. `computeVibeMetrics()` clamps internally, but
 *    neither caller ever reaches that clamp — the CLI rejects an out-of-range
 *    window with ExitCode.CONFIG_ERROR and the route answers 400. A recipe that
 *    promises clamping makes the release step die on a window nobody bounded.
 * 2. The verdict is the exit code, never the JSON. On failure the redirect file
 *    holds an error line, not a document, so anything that parses first reads
 *    "server is down" as "no data" — and `| grep` erases the exit code outright
 *    (the recorded false-PASS mode these recipes exist to avoid).
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode } from '@/cli/types';
import { GATE_FAIL_BREAKDOWN_LIMIT, MAX_METRICS_DAYS } from '@/lib/metrics/vibe-metrics';

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** Every checkpoint that names the command. */
const ALL_DOCS = [
  '.claude/skills/release/SKILL.md',
  '.claude/commands/progress-report.md',
  '.claude/prompts/progress-report-core.md',
  '.claude/agents/progress-report-agent.md',
  'docs/release-guide.md',
];

/** The subset that spells the invocation out, and so must keep its shell form. */
const INVOCATION_DOCS = [
  '.claude/skills/release/SKILL.md',
  '.claude/commands/progress-report.md',
  '.claude/prompts/progress-report-core.md',
  'docs/release-guide.md',
];

const RELEASE_DOCS = ['.claude/skills/release/SKILL.md', 'docs/release-guide.md'];

const PROGRESS_DOCS = [
  '.claude/commands/progress-report.md',
  '.claude/prompts/progress-report-core.md',
];

/** Markdown emphasis carries no meaning here; strip it so prose matches survive it. */
function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8').replace(/[`*]/g, '');
}

function linesMatching(content: string, pattern: RegExp): string[] {
  return content.split('\n').filter((line) => pattern.test(line));
}

/** The number as a standalone token, so `1` does not match inside `127`. */
function exitCodeToken(code: number): RegExp {
  return new RegExp(`(?:^|[^0-9])${code}(?![0-9])`);
}

describe('report metrics checkpoints', () => {
  it.each(ALL_DOCS)('%s names the command', (doc) => {
    expect(read(doc)).toMatch(/report metrics/);
  });

  it.each(INVOCATION_DOCS)('%s keeps the exit code observable', (doc) => {
    const invocations = linesMatching(read(doc), /report metrics/);
    // Guards against a zero-line "every invocation is fine" pass.
    expect(invocations.length).toBeGreaterThan(0);
    expect(
      invocations.some((line) => /> \/tmp\/vibe-metrics\.json 2>&1; echo \$\?/.test(line))
    ).toBe(true);
  });

  it.each(INVOCATION_DOCS)('%s never pipes the command into grep', (doc) => {
    for (const line of linesMatching(read(doc), /report metrics/)) {
      expect(line).not.toMatch(/\|\s*grep/);
    }
  });

  it.each(INVOCATION_DOCS)('%s states the real window bound', (doc) => {
    expect(read(doc)).toMatch(new RegExp(`1\\.\\.${MAX_METRICS_DAYS}`));
  });

  it.each(INVOCATION_DOCS)('%s documents rejection, not clamping, out of range', (doc) => {
    const content = read(doc);
    expect(content).toMatch(new RegExp(`クランプされ(?:ず|ない)`));
    expect(content).toMatch(new RegExp(`exit ${ExitCode.CONFIG_ERROR}(?![0-9])`));
  });

  it.each(INVOCATION_DOCS)('%s maps a down server to its real exit code', (doc) => {
    const mentions = linesMatching(read(doc), /サーバ未稼働/);
    expect(mentions.length).toBeGreaterThan(0);
    expect(mentions.some((line) => exitCodeToken(ExitCode.DEPENDENCY_ERROR).test(line))).toBe(true);
  });

  it.each(INVOCATION_DOCS)('%s decides on the exit code before the JSON', (doc) => {
    expect(read(doc)).toMatch(/パースしてから判断してはいけ(?:ない|ません)/);
  });

  it.each(RELEASE_DOCS)('%s refuses to block the release on metrics', (doc) => {
    expect(read(doc)).toMatch(/リリースをブロックし(?:ない|ません)/);
  });

  it.each(PROGRESS_DOCS)('%s omits the section instead of failing', (doc) => {
    const content = read(doc);
    expect(content).toMatch(/セクションごと省略/);
    expect(content).toMatch(/レポート(?:の)?生成(?:自体)?は止め(?:ない|ません)/);
  });

  it.each(PROGRESS_DOCS)('%s keeps a null rate out of the zero column', (doc) => {
    expect(read(doc)).toMatch(/0% と書いてはいけない/);
  });

  it('the release recipe states the real gate-breakdown cap', () => {
    expect(read('.claude/skills/release/SKILL.md')).toMatch(
      new RegExp(`最大 ${GATE_FAIL_BREAKDOWN_LIMIT} 件`)
    );
  });

  it('release is deliberately not mirrored into .agents/skills', () => {
    // The mirror policy is per skill (cf. demo-video / video-to-gif, which are
    // mirrored). A copy added here would silently drift from the .claude one.
    expect(fs.existsSync(path.join(REPO_ROOT, '.agents/skills/release'))).toBe(false);
  });
});
