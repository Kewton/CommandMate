/**
 * Strip box-drawing border characters from CLI output.
 * Gemini CLI wraps Action Required prompts in ╭─╮│╰─╯ borders.
 * Removes │ (U+2502) prefix/suffix and border-only lines (╭╮╰╯─).
 *
 * @param str - Input string (typically after stripAnsi())
 * @returns String with box-drawing borders removed
 */
export function stripBoxDrawing(str: string): string {
  return str.split('\n').map(line => {
    // Remove border-only lines (╭──╮, ╰──╯, │ only, ┃ only, ╹▀▀▀, █ scrollbar, etc.)
    // U+2502 │ (light vertical), U+2503 ┃ (heavy vertical - OpenCode TUI)
    // U+2579 ╹ (heavy up), U+2580 ▀ (upper half block - OpenCode separator)
    // U+2588 █ (full block - OpenCode scrollbar)
    if (/^[\u2502\u2503\u256D\u256E\u256F\u2570\u2500\u2579\u2580\u2588\s]+$/.test(line)) return '';
    // Strip leading whitespace + │/┃ + optional space, trailing space + │/┃/█
    // OpenCode TUI adds 2-space padding before ┃ borders (e.g., "  ┃  content")
    // OpenCode scrollbar █ appears at end of content lines
    return line.replace(/^\s*[\u2502\u2503]\s?/, '').replace(/\s*[\u2502\u2503\u2588]$/, '');
  }).join('\n');
}
