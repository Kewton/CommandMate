export type TmuxControlEvent =
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode?: number | null }
  | { type: 'error'; error: Error };

/**
 * Minimal tmux control mode parser for Phase 2.
 *
 * Current behavior:
 * - Treats `%output ` lines as output events
 * - Treats `%exit` lines as exit events
 * - Emits raw non-control lines as output to avoid dropping data
 *
 * The parser is intentionally conservative: unknown control messages are ignored
 * instead of being misinterpreted as terminal content.
 */
export class TmuxControlParser {
  private remainder = '';

  push(chunk: string): TmuxControlEvent[] {
    if (chunk.length === 0) {
      return [];
    }

    const combined = this.remainder + chunk;
    const lines = combined.split('\n');
    this.remainder = lines.pop() ?? '';

    const events: TmuxControlEvent[] = [];
    for (const line of lines) {
      const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line;
      const parsed = this.parseLine(normalizedLine);
      if (parsed) {
        events.push(parsed);
      }
    }

    return events;
  }

  flush(): TmuxControlEvent[] {
    if (this.remainder.length === 0) {
      return [];
    }

    const parsed = this.parseLine(this.remainder);
    this.remainder = '';
    return parsed ? [parsed] : [];
  }

  private parseLine(line: string): TmuxControlEvent | null {
    if (line.length === 0) {
      return { type: 'output', data: '\n' };
    }

    if (line.startsWith('%output ')) {
      return { type: 'output', data: `${line.slice('%output '.length)}\n` };
    }

    if (line === '%exit' || line.startsWith('%exit ')) {
      return { type: 'exit', exitCode: null };
    }

    if (line.startsWith('%error ')) {
      return { type: 'error', error: new Error(line.slice('%error '.length)) };
    }

    if (line.startsWith('%')) {
      return null;
    }

    return { type: 'output', data: `${line}\n` };
  }
}
