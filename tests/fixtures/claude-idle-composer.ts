/**
 * The minimal Claude frame that carries §4 D1 completion evidence (Issue #1927).
 *
 * Every row below was read off live 200x1000 captures of Claude Code 2.1.240 —
 * the same session the fixtures under
 * `tests/unit/detection/tools/claude/fixtures/` hold verbatim. This builder is
 * the smallest frame that still contains all four structural elements the
 * detector reads, so a suite that needs "an idle Claude session" can say so in
 * one line instead of pasting a thousand rows:
 *
 *   1. a transcript row,
 *   2. the turn-completion marker `✻ <Verb> for <N>s`, which is Claude's only
 *      positive completion evidence (the composer `❯` is drawn during
 *      generation too, so it is not evidence — that is what #1885 established
 *      for copilot and #1927 measured for Claude),
 *   3. the input box, fenced by the two `────` separators `findClaudeInputBox`
 *      locates it by,
 *   4. the bottom status row, which is what bounds the search for (3).
 *
 * It is NOT a detection fixture and must not be used as one: the fixture sweep
 * takes verbatim captures only. This is a test convenience for suites whose
 * subject is something else (the payload builder, the latch, the merge) and
 * which merely need a frame the detector reads as a finished turn.
 *
 * @param completionMarker - Override the marker row, e.g. to build the negative
 *   case (a frame with no completion evidence) by passing a plain prose line.
 */
export function buildClaudeIdleComposerFrame(completionMarker = '✻ Brewed for 3s'): string {
  return [
    '⏺ some agent output',
    completionMarker,
    '',
    '────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────',
    '  ⏸ manual mode on · ? for shortcuts · ⇥ for agents',
  ].join('\n');
}
