/**
 * Clean existing Claude messages in the database
 * Removes shell setup commands from already saved messages
 */

import Database from 'better-sqlite3';
import path from 'path';
import { getEnvByKey } from '../src/lib/env';

// Database path (Issue #76: Environment variable fallback support)
const DB_PATH = getEnvByKey('CM_DB_PATH') || path.join(process.cwd(), 'data', 'db.sqlite');

/**
 * Clean up Claude response by removing shell setup commands
 */
function cleanClaudeResponse(response: string): string {
  const lines = response.split('\n');
  const cleanedLines: string[] = [];

  const skipPatterns = [
    /CLAUDE_HOOKS_/,  // Any CLAUDE_HOOKS reference
    /\/bin\/claude/,  // Claude binary path (any variant)
    /^claude\s*$/,  // Just "claude" on a line
    /@.*\s+%/,  // Shell prompt (any user@host followed by %)
    /feature-issue-\d+/,  // Worktree indicator
    /worktreeId/,  // Curl command JSON parts
    /localhost/,  // Localhost references
    /192\.168\./,  // IP address parts
    /:3000/,  // Port references
    /done'/,  // Any line containing done' (from claude-done')
    /api\/hooks/,  // API hooks
    /curl.*POST/,  // Curl commands
    /Content-Type/,  // HTTP headers
    /export\s+/,  // Export commands
    /^\s*$/,  // Empty lines
  ];

  // Filter out all setup command lines
  for (const line of lines) {
    const shouldSkip = skipPatterns.some(pattern => pattern.test(line));
    if (!shouldSkip && line.trim()) {
      cleanedLines.push(line);
    }
  }

  // If no content remains, return empty string
  const result = cleanedLines.join('\n').trim();
  return result || '[No content]';
}

async function main() {
  console.log('Opening database:', DB_PATH);
  const db = new Database(DB_PATH);

  try {
    // Get all Claude assistant messages
    const messages = db.prepare(`
      SELECT id, content, cli_tool_id
      FROM chat_messages
      WHERE role = 'assistant' AND cli_tool_id = 'claude'
    `).all() as Array<{ id: string; content: string; cli_tool_id: string }>;

    console.log(`Found ${messages.length} Claude messages`);

    let cleanedCount = 0;

    // Clean each message
    for (const message of messages) {
      const cleaned = cleanClaudeResponse(message.content);

      if (cleaned !== message.content) {
        // Update the message
        db.prepare(`
          UPDATE chat_messages
          SET content = ?
          WHERE id = ?
        `).run(cleaned, message.id);

        cleanedCount++;
        console.log(`Cleaned message ${message.id}`);
      }
    }

    console.log(`\n✓ Cleaned ${cleanedCount} messages`);
    console.log(`✓ ${messages.length - cleanedCount} messages were already clean`);

  } finally {
    db.close();
  }
}

main().catch(console.error);
