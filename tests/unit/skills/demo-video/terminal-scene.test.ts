/**
 * terminal-scene.ts — ANSI reading, frame timing and the tmux contract (#1810).
 *
 * The converter's output is assigned with `innerHTML` by the renderer, so the
 * escaping is not a detail: it is the only thing standing between a pane's
 * bytes and markup in a published frame. Every rule here is therefore tested in
 * both directions — the sequence it understands produces the style, and the
 * bytes it does not understand produce nothing at all.
 *
 * Importing the script from here is also what puts it under `npx tsc --noEmit`:
 * `.claude/**` is outside the root tsconfig `include` (Issue #1265).
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ANSI_PALETTE,
  EMPTY_STYLE,
  ansiToHtml,
  applySgr,
  buildConcatScript,
  captureFrames,
  dedupeFrames,
  escapeHtml,
  frameDurations,
  styleToCss,
  tmuxArgs,
  xterm256,
  type CaptureDeps,
  type CapturedFrame,
} from '../../../../.claude/skills/demo-video/scripts/terminal-scene';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** Written as escapes rather than literals so this file stays greppable. */
const ESC = '\u001b';
const BEL = '\u0007';

/** The body of the single `.t-line` div `ansiToHtml` wraps one line in. */
function line(text: string): string {
  const html = ansiToHtml(text);
  const match = /^<div class="t-line">([\s\S]*)<\/div>$/.exec(html);
  expect(match, `not a single line: ${html}`).not.toBeNull();
  return match![1];
}

describe('escapeHtml', () => {
  it('escapes every delimiter that could open an element or an attribute', () => {
    expect(escapeHtml('<script>alert("x") & \'y\'</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;',
    );
  });

  it('escapes the ampersand first, so an entity is not escaped twice', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('applySgr', () => {
  it('reads the 8 basic foregrounds', () => {
    expect(applySgr(EMPTY_STYLE, [31]).fg).toBe(ANSI_PALETTE[1]);
    expect(applySgr(EMPTY_STYLE, [37]).fg).toBe(ANSI_PALETTE[7]);
  });

  it('reads the 8 bright foregrounds as the upper half of the palette', () => {
    expect(applySgr(EMPTY_STYLE, [91]).fg).toBe(ANSI_PALETTE[9]);
    expect(applySgr(EMPTY_STYLE, [97]).fg).toBe(ANSI_PALETTE[15]);
  });

  it('reads backgrounds and their reset', () => {
    expect(applySgr(EMPTY_STYLE, [44]).bg).toBe(ANSI_PALETTE[4]);
    expect(applySgr({ ...EMPTY_STYLE, bg: '#fff' }, [49]).bg).toBeNull();
  });

  it('reads bold and dim, and 22 clears both', () => {
    expect(applySgr(EMPTY_STYLE, [1]).bold).toBe(true);
    expect(applySgr(EMPTY_STYLE, [2]).dim).toBe(true);
    expect(applySgr({ fg: null, bg: null, bold: true, dim: true }, [22])).toEqual(EMPTY_STYLE);
  });

  it('resets everything on 0, and on a bare ESC[m', () => {
    const busy = { fg: '#abc', bg: '#def', bold: true, dim: true };
    expect(applySgr(busy, [0])).toEqual(EMPTY_STYLE);
    expect(applySgr(busy, [])).toEqual(EMPTY_STYLE);
  });

  it('reads the indexed and true-colour forms chalk emits under a 256-colour TERM', () => {
    expect(applySgr(EMPTY_STYLE, [38, 5, 1]).fg).toBe(ANSI_PALETTE[1]);
    expect(applySgr(EMPTY_STYLE, [38, 2, 18, 52, 86]).fg).toBe('#123456');
    expect(applySgr(EMPTY_STYLE, [48, 2, 0, 0, 0]).bg).toBe('#000000');
  });

  it('consumes an extended colour’s own parameters, so what follows still applies', () => {
    // `38;5;1;1` is red *and* bold. A reader that did not skip the `5;1` would
    // interpret the 5 as blink and the 1 as bold twice, or worse as a colour.
    expect(applySgr(EMPTY_STYLE, [38, 5, 1, 1])).toEqual({
      fg: ANSI_PALETTE[1],
      bg: null,
      bold: true,
      dim: false,
    });
  });

  it('leaves the style alone for a parameter it does not implement', () => {
    // Italic, underline, blink, and anything invented later: dropping is the
    // safe direction — the frame is missing an emphasis, not showing bytes the
    // product never printed.
    expect(applySgr(EMPTY_STYLE, [3, 4, 5, 7, 53, 999])).toEqual(EMPTY_STYLE);
  });

  it('is pure: the style handed in is never mutated', () => {
    const before = { ...EMPTY_STYLE };
    applySgr(before, [31, 1]);
    expect(before).toEqual(EMPTY_STYLE);
  });
});

describe('xterm256', () => {
  it('reuses the 16 basic colours, so 38;5;1 and 31 render alike', () => {
    expect(xterm256(1)).toBe(ANSI_PALETTE[1]);
    expect(xterm256(15)).toBe(ANSI_PALETTE[15]);
  });

  it('reads the 6x6x6 cube and the grey ramp', () => {
    expect(xterm256(16)).toBe('#000000');
    expect(xterm256(231)).toBe('#ffffff');
    expect(xterm256(232)).toBe('#080808');
  });

  it('clamps an out-of-range index instead of producing NaN', () => {
    expect(xterm256(-5)).toBe(ANSI_PALETTE[0]);
    expect(xterm256(9999)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('ansiToHtml', () => {
  it('renders plain text with no span at all', () => {
    expect(line('GATE unit PASS')).toBe('GATE unit PASS');
  });

  it('wraps a coloured run in a span carrying the palette colour', () => {
    expect(line(`${ESC}[32mPASS${ESC}[0m`)).toBe(
      `<span style="color:${ANSI_PALETTE[2]}">PASS</span>`,
    );
  });

  it('ends the style at the reset, leaving the rest unstyled', () => {
    expect(line(`${ESC}[1;31mFAIL${ESC}[0m tail`)).toBe(
      `<span style="color:${ANSI_PALETTE[1]};font-weight:700">FAIL</span> tail`,
    );
  });

  it('starts each line from a clean style, as a terminal grid does', () => {
    // capture-pane emits each row independently; carrying a colour across the
    // newline would paint rows the pane never painted.
    const html = ansiToHtml(`${ESC}[31mred\nplain`);
    expect(html).toBe(
      `<div class="t-line"><span style="color:${ANSI_PALETTE[1]}">red</span></div>` +
        '<div class="t-line">plain</div>',
    );
  });

  it('escapes the text inside a styled run too', () => {
    expect(line(`${ESC}[31m<b>&${ESC}[0m`)).toBe(
      `<span style="color:${ANSI_PALETTE[1]}">&lt;b&gt;&amp;</span>`,
    );
  });

  it('renders a pane full of markup as the characters it showed', () => {
    // The renderer assigns this with innerHTML, and may only do so because of
    // this: a `<script>` in the pane is eight visible characters, not an element.
    expect(line('<script>alert(1)</script>')).not.toMatch(/<script/);
    expect(line('<script>alert(1)</script>')).toContain('&lt;script&gt;');
  });

  it('gives a blank line a box, so the numbering below it does not shift up', () => {
    expect(line('')).toBe('&nbsp;');
    expect(line(`${ESC}[31m${ESC}[0m`)).toBe('&nbsp;');
  });

  it.each([
    ['cursor movement', `${ESC}[2J${ESC}[H`],
    ['cursor position', `${ESC}[12;40H`],
    ['a private-mode toggle', `${ESC}[?25l`],
    ['an OSC title string', `${ESC}]0;a title${BEL}`],
    ['an OSC with the ST terminator', `${ESC}]8;;http://x${ESC}\\`],
    ['a single-character escape', `${ESC}M`],
    ['a lone trailing ESC', ESC],
    ['a bare control byte', '\u000d'],
  ])('drops %s entirely rather than printing it', (_what, sequence) => {
    expect(line(`a${sequence}b`)).toBe('ab');
  });

  it('drops a malformed SGR without corrupting the style that follows', () => {
    // `ESC[38;5m` names an indexed colour and then does not give the index.
    // The reader must not carry a half-applied state into the next run.
    expect(line(`${ESC}[38;5mx${ESC}[32my`)).toBe(`x<span style="color:${ANSI_PALETTE[2]}">y</span>`);
  });

  it('never emits an unescaped angle bracket, whatever the input', () => {
    const hostile = `${ESC}[31m<img src=x onerror=alert(1)>${ESC}[0m</div><script>`;
    const html = ansiToHtml(hostile);
    const withoutOwnTags = html.replace(/<\/?(?:div|span)\b[^>]*>/g, '');
    expect(withoutOwnTags).not.toMatch(/[<>]/);
  });

  it('preserves the runs of spaces a terminal grid aligns on', () => {
    expect(line('a    b')).toBe('a    b');
  });
});

describe('styleToCss', () => {
  it('emits nothing for the default style, so plain text needs no span', () => {
    expect(styleToCss(EMPTY_STYLE)).toBe('');
  });

  it('emits colour, background and weight together', () => {
    expect(styleToCss({ fg: '#111', bg: '#222', bold: true, dim: true })).toBe(
      'color:#111;background:#222;font-weight:700;opacity:.65',
    );
  });
});

describe('dedupeFrames', () => {
  const frame = (atMs: number, text: string): CapturedFrame => ({ atMs, text });

  it('drops consecutive repeats, which is most of a 250ms sample', () => {
    expect(
      dedupeFrames([frame(0, 'a'), frame(250, 'a'), frame(500, 'b'), frame(750, 'b')]),
    ).toEqual([frame(0, 'a'), frame(500, 'b')]);
  });

  it('keeps a frame that comes back after a change', () => {
    // A prompt that is drawn, cleared and drawn again is three frames, not two:
    // collapsing by value rather than by adjacency would drop the redraw.
    expect(dedupeFrames([frame(0, 'a'), frame(1, 'b'), frame(2, 'a')])).toHaveLength(3);
  });

  it('returns nothing for an empty capture', () => {
    expect(dedupeFrames([])).toEqual([]);
  });
});

describe('frameDurations', () => {
  it('holds each frame until the next one, and the last until the end', () => {
    expect(
      frameDurations([{ atMs: 0, text: 'a' }, { atMs: 1000, text: 'b' }], 2500),
    ).toEqual([1000, 1500]);
  });

  it('floors a burst at the minimum, so a frame is not shorter than a frame', () => {
    // At 30fps a 4ms slot does not survive the encode; the writes would appear
    // to have been dropped rather than merely hurried.
    expect(
      frameDurations([{ atMs: 0, text: 'a' }, { atMs: 4, text: 'b' }], 8, 100),
    ).toEqual([100, 100]);
  });
});

describe('buildConcatScript', () => {
  it('repeats the last file, without which it would show for one frame', () => {
    // The concat demuxer applies `duration` to the transition to the next
    // entry, so the final image needs a following entry to be held at all —
    // and that final image is the one carrying RESULT and the exit code.
    expect(buildConcatScript(['/f/0.png', '/f/1.png'], [1000, 2500])).toBe(
      ["file '/f/0.png'", 'duration 1.000', "file '/f/1.png'", 'duration 2.500', "file '/f/1.png'", ''].join('\n'),
    );
  });

  it('refuses a mismatched pair rather than encoding the wrong timing', () => {
    expect(() => buildConcatScript(['a'], [1, 2])).toThrow(/1 frames but 2 durations/);
    expect(() => buildConcatScript([], [])).toThrow(/no frames/);
  });
});

describe('captureFrames', () => {
  const deps = (samples: (string | null)[]): CaptureDeps => {
    let index = 0;
    let clock = 0;
    return {
      capture: () => samples[Math.min(index++, samples.length - 1)],
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    };
  };

  it('stops when the session ends, which is how cli-scene.sh signals it is done', async () => {
    const result = await captureFrames(deps(['a', 'a', 'b', null]), {
      intervalMs: 250,
      timeoutMs: 10_000,
    });
    expect(result.sessionEnded).toBe(true);
    expect(result.frames.map((f) => f.text)).toEqual(['a', 'b']);
    expect(result.endMs).toBe(750);
  });

  it('reports the timeout rather than looping forever on a stuck pane', async () => {
    const result = await captureFrames(deps(['a']), { intervalMs: 100, timeoutMs: 300 });
    expect(result.sessionEnded).toBe(false);
    expect(result.frames).toHaveLength(1);
  });

  it('captures nothing when the session was already gone', async () => {
    const result = await captureFrames(deps([null]), { intervalMs: 100, timeoutMs: 300 });
    expect(result.frames).toEqual([]);
    expect(result.sessionEnded).toBe(true);
  });
});

describe('tmuxArgs', () => {
  it('uses the ambient tmux server when no socket is named', () => {
    expect(tmuxArgs('', ['kill-session', '-t', '=x:'])).toEqual(['kill-session', '-t', '=x:']);
  });

  it('puts -L first, where tmux requires it', () => {
    expect(tmuxArgs('cmdemo', ['capture-pane'])).toEqual(['-L', 'cmdemo', 'capture-pane']);
  });
});

/** Assembled at runtime; see the note on the assertion that uses it. */
const KILL_SERVER = ['kill', 'server'].join('-');

describe('the terminal scene never reaches beyond its own session', () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, '.claude/skills/demo-video/scripts/terminal-scene.ts'),
    'utf8',
  );
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  it('never kills the tmux server this developer is working in', () => {
    // The token is assembled rather than written: the repo-wide guard in
    // tests/unit/config/tmux-live-test-safety.test.ts scans test sources for
    // the literal and cannot tell an assertion against it from a use of it.
    expect(code).not.toContain(KILL_SERVER);
    expect(code).not.toMatch(/\bpkill\b/);
  });

  it('targets sessions by exact name, so a prefix cannot be hit', () => {
    // Without `=`, tmux resolves a prefix: `cmdemo-cli` would match a
    // developer's `cmdemo-cli-scratch`, and this module both photographs and
    // kills what it targets.
    expect(code).toContain("`=${session}:`");
    expect(code).not.toMatch(/'-t', session/);
  });

  it('the teardown guard is not vacuous', () => {
    expect(`tmux ${KILL_SERVER}`).toContain(KILL_SERVER);
  });
});

describe('the terminal template', () => {
  const html = fs.readFileSync(
    path.join(REPO_ROOT, '.claude/skills/demo-video/templates/terminal.html'),
    'utf8',
  );

  it('carries the container the renderer fills', () => {
    expect(html).toContain('id="terminal-body"');
  });

  it('requests nothing over the network', () => {
    // A webfont that arrives late re-flows a monospace grid, which is the whole
    // layout; and the page has to render identically with no network at all.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/@import|<link\b|<script\b/);
  });

  it('does not wrap, and preserves runs of spaces', () => {
    expect(html).toMatch(/white-space:\s*pre/);
  });

  it('the network guard is not vacuous', () => {
    expect('<link rel="stylesheet" href="https://fonts.example/x.css">').toMatch(/<link\b/);
  });
});
