/**
 * Claude output parsing utilities
 * Shared between webhook handlers and polling logic
 */

/** Parsed metadata extracted from Claude's tmux output */
export interface ParsedClaudeOutput {
  /** Full raw output (used as chat message content) */
  content: string;
  /** Optional human-readable summary line */
  summary?: string;
  /** Filename of the JSONL log referenced in the output */
  logFileName?: string;
  /**
   * Full path of that JSONL log, as the pane printed it (Issue #2121).
   *
   * The same match as {@link logFileName}, which has always kept only the
   * basename. The path is what `lib/hooks/sources/claude/history` needs to read
   * the transcript, and it is a *hint* there rather than a source of truth: it
   * is text the agent printed, so it is accepted only after being checked into
   * `~/.claude/projects`.
   */
  logFilePath?: string;
  /** Request identifier emitted by Claude CLI */
  requestId?: string;
}

const LOG_FILE_REGEX = /📄 Session log: (.+?\/([^\/\s]+\.jsonl))/;
const REQUEST_ID_REGEX = /Request ID: ([^\s\n]+)/;
const SUMMARY_REGEX = /Summary: (.+?)(?:\n─|$)/s;

/**
 * Parse Claude CLI output and extract metadata that the UI relies on.
 *
 * @param output Raw tmux capture string
 */
export function parseClaudeOutput(output: string): ParsedClaudeOutput {
  const result: ParsedClaudeOutput = {
    content: output,
  };

  const logFileMatch = LOG_FILE_REGEX.exec(output);
  if (logFileMatch) {
    result.logFileName = logFileMatch[2];
    result.logFilePath = logFileMatch[1];
  }

  const requestIdMatch = REQUEST_ID_REGEX.exec(output);
  if (requestIdMatch) {
    result.requestId = requestIdMatch[1];
  }

  const summaryMatch = SUMMARY_REGEX.exec(output);
  if (summaryMatch) {
    result.summary = summaryMatch[1].trim();
  }

  return result;
}
