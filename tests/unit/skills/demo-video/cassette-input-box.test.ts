/**
 * Every `@input` frame must paint an empty composer (Issue #3080, cf. #2464).
 *
 * CommandMate's send confirmation treats "the `❯` line between the separators
 * still holds text after Enter" as unsent. A cassette that echoes `{{INPUT}}`
 * into the composer therefore fails `send` with "typed but unsent". A real CLI
 * scrolls the question up and leaves the composer empty.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const FIXTURES = path.resolve(__dirname, '../../../../.claude/skills/demo-video/fixtures');
const SEPARATOR = /^─{20,}$/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** Text left in the `❯` line that sits between two separator lines, or null if no such box. */
export function composerText(payload: string): string | null {
  const lines = payload
    .replace(/\\e/g, '\x1b')
    .split('\\n')
    .map((l) => l.replace(ANSI, '').trimEnd());
  for (let i = 1; i < lines.length - 1; i++) {
    if (SEPARATOR.test(lines[i - 1]) && lines[i].startsWith('❯') && SEPARATOR.test(lines[i + 1])) {
      return lines[i].slice(1).trim();
    }
  }
  return null;
}

function inputFrames(file: string): string[] {
  return fs
    .readFileSync(path.join(FIXTURES, file), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('@input\t'))
    .map((l) => l.slice('@input\t'.length));
}

describe('composerText', () => {
  const sep = '─'.repeat(40);
  it('positive control: flags a composer that still holds the input', () => {
    expect(composerText(`q\\n${sep}\\n❯ {{INPUT}}\\n${sep}\\n`)).toBe('{{INPUT}}');
  });
  it('negative control: passes an empty composer', () => {
    expect(composerText(`q\\n${sep}\\n❯ \\n${sep}\\n`)).toBe('');
  });
});

describe('cassette @input frames leave the composer empty', () => {
  const casts = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.cast'));
  for (const cast of casts) {
    const frames = inputFrames(cast);
    if (frames.length === 0) continue;
    it(cast, () => {
      for (const frame of frames) {
        const text = composerText(frame);
        if (text !== null) expect(text).toBe('');
      }
    });
  }
});
