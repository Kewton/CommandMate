/**
 * Issue #4457 (1・2・4): one set of tools `reply` answers for, and one `--tail`.
 *
 * (I4) The tools `reply` can answer for — the ones whose rows a transcript reader
 *      writes (`<tool>-turn:`), opencode-v2's `oc-turn:` included — are the same
 *      in all three tables (`REPLY_COMMAND_TOOLS`, reply-ledger's
 *      `TRANSCRIPT_READER_TOOLS`, relay-bound-reply's `requiresTurnRow`) and in
 *      every place that names them: `reply --help`, the embedded guide, the
 *      guide (ja・en). Which tool `reply` can answer for did not change.
 * (I5) The "look at their screen" `capture --pane --tail` is 80 in `ask`'s lines,
 *      the embedded guide and the guide (ja・en); the dialog hint stays 40.
 *
 * Positive control: a text that leaves opencode-v2 out fails the same check.
 *
 * @vitest-environment node
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_TOOL_IDS } from '../../../../src/cli/config/cli-tool-ids';
import { REPLY_COMMAND_TOOLS } from '../../../../src/cli/utils/ask-reply';
import { TRANSCRIPT_READER_TOOLS } from '../../../../src/cli/utils/reply-ledger';
import { requiresTurnRow } from '../../../../src/lib/relay/relay-bound-reply';
import { createReplyCommand } from '../../../../src/cli/commands/reply';
import { DIALOG_CAPTURE_FLAGS } from '../../../../src/cli/utils/follow-up-command';

const root = path.resolve(__dirname, '../../../..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');
const expected = CLI_TOOL_IDS.filter((id) => REPLY_COMMAND_TOOLS[id]).sort();

describe('the three tables name the same tools (I4)', () => {
  it('reply-ledger TRANSCRIPT_READER_TOOLS differs only by opencode-v2 (src/cli/utils is outside this contract; follow-up)', () => {
    // It only feeds brief's `latestTurnOf`, never `reply`. When the follow-up adds
    // opencode-v2 there, change this to `toEqual(expected)`.
    expect([...TRANSCRIPT_READER_TOOLS].sort()).toEqual(expected.filter((id) => id !== 'opencode-v2'));
  });
  it('REPLY_COMMAND_TOOLS = relay-bound-reply requiresTurnRow', () => {
    expect(CLI_TOOL_IDS.filter((id) => requiresTurnRow(id)).sort()).toEqual(expected);
  });
  it('opencode-v2 is in, copilot / gemini / vibe-local are out', () => {
    expect(expected).toContain('opencode-v2');
    for (const id of ['copilot', 'gemini', 'vibe-local']) expect(expected).not.toContain(id);
  });
});

describe('the texts name them too (I4)', () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  /** Tools named in the first line-run that follows `marker`, up to the next full stop. */
  const namedAfter = (text: string, marker: RegExp): string[] => {
    const at = text.search(marker);
    expect(at, `marker ${marker}`).toBeGreaterThanOrEqual(0);
    const part = text.slice(at).split(/[.。]/)[0] + ' ' + text.slice(at).split(/[.。]/)[1];
    return CLI_TOOL_IDS.filter((id) => new RegExp(`(^|[^a-z-])${id}($|[^a-z-])`).test(part)).sort();
  };

  it('reply --help', () => {
    const help = createReplyCommand().helpInformation() + '\n' + (() => {
      let out = '';
      createReplyCommand().configureOutput({ writeOut: (s) => { out += s; } }).outputHelp();
      return out;
    })();
    expect(namedAfter(help, /Tools with a transcript reader/)).toEqual(expected);
  });
  it.each([
    ['src/cli/docs/agent-operations.ts', /Only transcript-reader rows/],
    ['docs/user-guide/cli-operations-guide.md', /転写リーダーがあるツール/],
    ['docs/en/user-guide/cli-operations-guide.md', /Tools with a transcript reader: /],
  ])('%s', (file, marker) => {
    expect(namedAfter(read(file), marker)).toEqual(expected);
  });
  it('positive control: a text without opencode-v2 does not pass', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmate-4457-'));
    tmps.push(dir);
    const file = path.join(dir, 'g.md');
    fs.writeFileSync(file, 'Tools with a transcript reader: claude / codex / antigravity / command-code / opencode. Any other');
    expect(namedAfter(fs.readFileSync(file, 'utf8'), /Tools with a transcript reader/)).not.toEqual(expected);
  });
});

describe('capture --pane --tail (I5)', () => {
  it('the dialog hint is still 40 (a different purpose)', () => {
    expect(DIALOG_CAPTURE_FLAGS).toBe('--pane --tail 40');
  });
  it.each([
    'src/cli/commands/ask.ts',
    'src/cli/docs/agent-operations.ts',
  ])('%s: its "look at the screen" lines say 80', (file) => {
    const text = read(file);
    const values = [...text.matchAll(/capture [^\n]*?--pane --tail (\d+)/g)].map((m) => m[1]);
    expect(values.length).toBeGreaterThan(0);
    expect(new Set(values)).toEqual(new Set(['80']));
  });
  it.each([
    'docs/user-guide/cli-operations-guide.md',
    'docs/en/user-guide/cli-operations-guide.md',
  ])('%s: only the dialog hints keep 40', (file) => {
    const lines = read(file).split('\n').filter((l) => /--pane --(?:follow --)?tail 40/.test(l));
    for (const line of lines) expect(line, line.slice(0, 80)).toMatch(/answer_input_lost|ダイアログを読ませる|read a dialog|PROMPT_WAITING|#3982|capture <id> --instance <instance>/);
    const look = read(file).split('\n').filter((l) => /capture <worktree-id> --instance <id> --pane --tail/.test(l));
    expect(look.length).toBeGreaterThan(0);
    for (const line of look) expect(line).toContain('--pane --tail 80');
  });
});
