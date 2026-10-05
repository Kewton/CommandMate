/**
 * Issue #3293 — "has this pane had a turn yet?", for codex and vibe-local.
 *
 * The one predicate the response poller and the pre-send flush both ask before
 * they save the rows past the cursor (`isStartupScreenWithoutUserEcho`). The two
 * suites next to this one pin what each path does with the answer; this one
 * pins the answer itself, frame by frame.
 *
 * Every frame but one is a capture of the real tool — see
 * `tests/fixtures/startup-screen-3293/README.md` for versions and provenance.
 * A hand-written frame would agree with the reader by construction. The
 * exception is the pane after a reply longer than itself, which no provider
 * the isolated probe can reach will produce: it is built from two captures
 * (`codex-0.160.0-long-reply-pane.ts`), and the measured frame of the same
 * layout stands next to it in every case.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { isStartupScreenWithoutUserEcho } from '@/lib/polling/startup-screen';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import { buildCodexLongReplyPane } from '../../../fixtures/startup-screen-3293/codex-0.160.0-long-reply-pane';

const FIXTURES = join(process.cwd(), 'tests/fixtures');
const frame = (rel: string): string[] => readFileSync(join(FIXTURES, rel), 'utf8').split('\n');

const CODEX_BOOT = frame('startup-screen-3293/codex-0.160.0-boot-idle.txt');
const CODEX_BOOT_TYPED = frame('startup-screen-3293/codex-0.160.0-boot-typed.txt');
const CODEX_TRUST_DIALOG = frame('startup-screen-3293/codex-0.160.0-dialog-trust.txt');
const CODEX_TURN_INTERRUPTED = frame('startup-screen-3293/codex-0.160.0-first-turn-interrupted.txt');
const CODEX_TURN_REPLY = frame('startup-screen-3293/codex-0.160.0-first-turn-reply.txt');
const CODEX_OVERFLOW = frame('startup-screen-3293/codex-0.160.0-overflow-interrupted.txt');
const CODEX_LONG_REPLY = buildCodexLongReplyPane().split('\n');
const CODEX_0153_BOOT = frame('codex-live-2310/idle-composer.txt');
const CODEX_0157_BOOT = frame('codex-dialogs-0157/idle.txt');
const CODEX_SESSION_TAIL_1671 = frame('../unit/lib/detection/fixtures/codex-live-1671/reported-session-tail.txt');
const CODEX_0153_RUNNING = frame('codex-live-2310/turn-running.txt');
const CODEX_0155_TURN = frame('codex-idle-composer-0155/idle-after-turn.txt');
const VIBE_BOOT = frame('startup-screen-3293/vibe-local-1.3.3-boot-idle.txt');
const VIBE_TURN_DONE = frame('startup-screen-3293/vibe-local-1.3.3-first-turn-done.txt');

describe('[#3293] fixture premises', () => {
  it('the codex frames are raw: the SGR attributes are what separate the composer from an echo', () => {
    for (const lines of [CODEX_BOOT, CODEX_BOOT_TYPED, CODEX_TURN_INTERRUPTED, CODEX_TURN_REPLY]) {
      expect(lines.join('\n')).toContain('\x1b[1m›');
    }
  });

  it('the codex 0.160.0 startup screen carries the banner and the composer', () => {
    const text = CODEX_BOOT.map(stripAnsi).join('\n');
    expect(text).toContain('OpenAI Codex (v0.160.0)');
    expect(text).toContain('› Ask Codex to do anything');
  });

  it.each([
    ['measured: a 1100-line message, interrupted', CODEX_OVERFLOW],
    ['built from the first-turn-reply capture: a reply of 1200 added rows', CODEX_LONG_REPLY],
  ])('a codex 0.160.0 transcript longer than the pane has lost its banner and its echo (%s)', (_name, lines) => {
    const rows = lines.map(stripAnsi);
    // The alternate screen keeps no scrollback: 1000 rows and the trailing
    // newline, however long the transcript is.
    expect(lines).toHaveLength(1001);
    expect(rows[0].trim()).not.toBe('');
    expect(rows.some(row => row.includes('OpenAI Codex'))).toBe(false);
    // The composer is the only `›` row left, where it always is.
    expect(rows.flatMap((row, i) => (row.startsWith('›') ? [i] : []))).toEqual([996]);
    expect(rows[996]).toBe('› Ask Codex to do anything');
    // The transcript ends on row 993, two blank rows above the composer.
    expect(rows[993].trim()).not.toBe('');
    expect(rows.slice(994, 996).map(row => row.trim())).toEqual(['', '']);
  });

  it('the built pane keeps the chrome rows of its source capture byte for byte', () => {
    expect(CODEX_LONG_REPLY.slice(996)).toEqual(CODEX_TURN_REPLY.slice(996));
  });

  it('the vibe-local 1.3.3 startup screen carries the banner and an empty prompt row', () => {
    const rows = VIBE_BOOT.map(stripAnsi);
    expect(rows.join('\n')).toContain('v1.3.3');
    expect(rows.filter(row => /^ctx:\d+%/.test(row))).toEqual(['ctx:4% ❯']);
  });
});

describe('[#3293] codex', () => {
  it('the 0.160.0 startup screen has had no turn', () => {
    expect(isStartupScreenWithoutUserEcho('codex', CODEX_BOOT)).toBe(true);
  });

  it('a message typed into the composer and not sent is not an echo', () => {
    // The composer row reads `› Say hello in one short sentence.` here, the same
    // text shape as an echo. It is told apart by its bold glyph (#2310).
    expect(CODEX_BOOT_TYPED.map(stripAnsi)).toContain('› Say hello in one short sentence.');
    expect(isStartupScreenWithoutUserEcho('codex', CODEX_BOOT_TYPED)).toBe(true);
  });

  it('the 0.153 startup screen (inline layout, boxed banner) has had no turn', () => {
    expect(isStartupScreenWithoutUserEcho('codex', CODEX_0153_BOOT)).toBe(true);
  });

  it('the 0.157.1 startup screen (boxed banner, composer pinned to the bottom) has had no turn', () => {
    expect(isStartupScreenWithoutUserEcho('codex', CODEX_0157_BOOT)).toBe(true);
  });

  it.each([
    ['0.160.0, a reply under the echo', CODEX_TURN_REPLY],
    ['0.160.0, an interrupted turn under the echo', CODEX_TURN_INTERRUPTED],
    ['0.155.1, two finished turns', CODEX_0155_TURN],
    ['0.153, a turn still running', CODEX_0153_RUNNING],
  ])('a pane with an echoed message is past its startup screen (%s)', (_name, lines) => {
    expect(isStartupScreenWithoutUserEcho('codex', lines)).toBe(false);
  });

  it.each([
    ['0.160.0, measured: a message longer than the pane, interrupted', CODEX_OVERFLOW],
    ['0.160.0, built: a reply longer than the pane', CODEX_LONG_REPLY],
    ['a cropped capture: the last 60 rows of a long inline session (#1671)', CODEX_SESSION_TAIL_1671],
  ])('a pane whose echo has left it off the top is NOT a startup screen (%s)', (_name, lines) => {
    // Composer on the pane and no echo above it — the two things a startup
    // screen has — and it is a finished turn. On 0.160.0 this is every turn
    // longer than the pane: the alternate screen keeps no scrollback, and the
    // clipped-capture guard (#1670) is keyed on the 10,000-row window, which a
    // 1000-row capture never reaches. What the frame does not have is the banner.
    expect(isStartupScreenWithoutUserEcho('codex', lines)).toBe(false);
  });

  it('対照: the banner row is what decides — the startup screen without it is not read as one', () => {
    const withoutBannerRow = CODEX_BOOT.map(row => (stripAnsi(row).includes('>_ OpenAI Codex') ? '' : row));
    expect(withoutBannerRow).not.toEqual(CODEX_BOOT);
    expect(isStartupScreenWithoutUserEcho('codex', withoutBannerRow)).toBe(false);
  });

  it('a dialog is not a startup screen: the composer is not drawn', () => {
    expect(isStartupScreenWithoutUserEcho('codex', CODEX_TRUST_DIALOG)).toBe(false);
  });

  it('a pane the composer cannot be located on keeps the reading it had', () => {
    // No composer, no echo: nothing here says "idle and waiting for the first
    // message", so the answer is not "startup screen".
    expect(isStartupScreenWithoutUserEcho('codex', ['Codex response content'])).toBe(false);
    expect(isStartupScreenWithoutUserEcho('codex', [])).toBe(false);
  });
});

describe('[#3293] vibe-local', () => {
  it('the 1.3.3 startup screen has had no turn', () => {
    expect(isStartupScreenWithoutUserEcho('vibe-local', VIBE_BOOT)).toBe(true);
  });

  it('a pane with an echoed message is past its startup screen', () => {
    expect(isStartupScreenWithoutUserEcho('vibe-local', VIBE_TURN_DONE)).toBe(false);
  });

  it('a prompt row holding text counts as an echo, wherever it is', () => {
    // While a reply is being printed the newest prompt row IS the echo — there
    // is no new input box under it yet — so text on the bottom prompt row cannot
    // be read as "not sent yet".
    const replyBeingPrinted = VIBE_TURN_DONE.slice(
      0,
      VIBE_TURN_DONE.findIndex(row => stripAnsi(row).startsWith('assistant: ')) + 1
    );
    expect(replyBeingPrinted.map(stripAnsi).filter(row => /^ctx:\d+%/.test(row))).toHaveLength(1);
    expect(isStartupScreenWithoutUserEcho('vibe-local', replyBeingPrinted)).toBe(false);
  });

  it('a pane with no prompt row keeps the reading it had', () => {
    expect(isStartupScreenWithoutUserEcho('vibe-local', ['The answer is 42.'])).toBe(false);
    expect(isStartupScreenWithoutUserEcho('vibe-local', [])).toBe(false);
  });
});

describe('[#3293] the other tools are not asked', () => {
  it.each(['claude', 'copilot', 'command-code', 'gemini', 'opencode', 'opencode-v2', 'antigravity'] as const)(
    '%s answers false on a codex startup screen and on a vibe-local one',
    cliToolId => {
      expect(isStartupScreenWithoutUserEcho(cliToolId, CODEX_BOOT)).toBe(false);
      expect(isStartupScreenWithoutUserEcho(cliToolId, VIBE_BOOT)).toBe(false);
    }
  );
});
