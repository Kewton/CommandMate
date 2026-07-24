import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.join(
  process.cwd(),
  '.claude/skills/orchestrate-monitor/scripts/classify-state.sh',
);
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

function classify(fixture: string): string {
  return execFileSync('bash', [SCRIPT, '--json', path.join(FIXTURES, fixture)], {
    encoding: 'utf8',
  }).trim();
}

describe('classify-state on real capture --json shapes', () => {
  it('NOT_RUNNING when the session is not running', () => {
    expect(classify('not-running.json')).toBe('NOT_RUNNING');
  });

  it('GENERATING on the token-counter anchor (↓ 1.4k tokens)', () => {
    expect(classify('generating-token-anchor.json')).toBe('GENERATING');
  });

  it('GENERATING on a background-agent wait even when isGenerating is false', () => {
    // Faithful to the recipe: the text anchor — not the isGenerating field —
    // is the reliable "still busy" signal.
    expect(classify('generating-bg-agent.json')).toBe('GENERATING');
  });

  it('IDLE on the completion summary (must not match `Brewed for 8m 55s`)', () => {
    // Anchor trap: `[0-9]+m [0-9]+s` would match the summary line and pin a
    // finished session as generating forever; `↓ [0-9]` avoids it. The `↑`
    // token line must not be read as the `↓` anchor either.
    expect(classify('idle-brewed-summary.json')).toBe('IDLE');
  });

  it('PROMPT on a yes/no approval prompt (isPromptWaiting=true)', () => {
    expect(classify('prompt-yes-no.json')).toBe('PROMPT');
  });

  it('PROMPT on AskUserQuestion even when isPromptWaiting=false', () => {
    // `❯ 1. Submit answers` is not flagged as isPromptWaiting by the product,
    // so a text-marker check is required or the blocked question reads as idle.
    expect(classify('prompt-submit-answers.json')).toBe('PROMPT');
  });

  it('RATE_LIMIT on a usage-limit banner', () => {
    expect(classify('rate-limit.json')).toBe('RATE_LIMIT');
  });
});
