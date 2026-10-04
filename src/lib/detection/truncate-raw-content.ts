/**
 * Maximum number of lines to retain in rawContent.
 * Tail lines are preserved (instruction text typically appears just before the prompt).
 * @see truncateRawContent
 */
export const RAW_CONTENT_MAX_LINES = 200;

/**
 * Maximum number of characters to retain in rawContent.
 * Tail characters are preserved.
 * @see truncateRawContent
 */
export const RAW_CONTENT_MAX_CHARS = 5000;

/**
 * Truncate raw content to fit within size limits.
 * Preserves the tail (end) of the content since instruction text
 * typically appears just before the prompt at the end of output.
 *
 * Security: No regular expressions used -- no ReDoS risk. [SF-S4-002]
 * String.split('\n') and String.slice() are literal string operations only.
 *
 * @param content - The content to truncate
 * @returns Truncated content (last RAW_CONTENT_MAX_LINES lines, max RAW_CONTENT_MAX_CHARS characters)
 */
export function truncateRawContent(content: string): string {
  const lines = content.split('\n');
  const truncatedLines = lines.length > RAW_CONTENT_MAX_LINES
    ? lines.slice(-RAW_CONTENT_MAX_LINES)
    : lines;
  let result = truncatedLines.join('\n');
  if (result.length > RAW_CONTENT_MAX_CHARS) {
    result = result.slice(-RAW_CONTENT_MAX_CHARS);
  }
  return result;
}
