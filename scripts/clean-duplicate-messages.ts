/**
 * Clean up duplicate messages in feature-issue-146
 *
 * This script identifies and removes duplicate assistant messages that were created
 * due to the response polling bug (before the fix).
 */

import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(process.cwd(), 'data', 'cm.db');
const db = new Database(dbPath);

interface MessageRow {
  id: string;
  worktree_id: string;
  role: string;
  content: string;
  timestamp: number;
  message_type: string;
  cli_tool_id: string;
}

// Get all messages for feature-issue-146
const messages = db.prepare(`
  SELECT id, worktree_id, role, content, timestamp, message_type, cli_tool_id
  FROM chat_messages
  WHERE worktree_id = 'feature-issue-146'
    AND cli_tool_id = 'claude'
    AND role = 'assistant'
  ORDER BY timestamp ASC
`).all() as MessageRow[];

console.log(`Total messages found: ${messages.length}`);

if (messages.length === 0) {
  console.log('No messages found for feature-issue-146');
  db.close();
  process.exit(0);
}

// Group by content to find duplicates
const contentGroups = new Map<string, MessageRow[]>();

for (const msg of messages) {
  const existing = contentGroups.get(msg.content) || [];
  existing.push(msg);
  contentGroups.set(msg.content, existing);
}

// Find duplicate groups
const duplicateGroups = Array.from(contentGroups.entries())
  .filter(([_, msgs]) => msgs.length > 1)
  .map(([content, msgs]) => ({
    content: content.substring(0, 100) + (content.length > 100 ? '...' : ''),
    count: msgs.length,
    messages: msgs
  }));

console.log(`\nDuplicate groups found: ${duplicateGroups.length}`);

if (duplicateGroups.length === 0) {
  console.log('No duplicates found!');
  db.close();
  process.exit(0);
}

// Display duplicates
for (const group of duplicateGroups) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Content preview: ${group.content}`);
  console.log(`Duplicate count: ${group.count}`);
  console.log('Messages:');

  for (const msg of group.messages) {
    const date = new Date(msg.timestamp);
    console.log(`  - ID: ${msg.id.substring(0, 8)}... | Time: ${date.toISOString()}`);
  }
}

// Ask for confirmation before deletion
console.log(`\n${'='.repeat(80)}`);
console.log('CLEANUP PLAN:');
console.log('For each duplicate group, keep the FIRST message (oldest) and delete the rest.');

let totalToDelete = 0;
for (const group of duplicateGroups) {
  totalToDelete += group.count - 1; // Keep the first, delete the rest
}

console.log(`Total messages to delete: ${totalToDelete}`);
console.log('\nStarting cleanup...');

// Delete duplicates (keep the first/oldest message in each group)
const deleteStmt = db.prepare('DELETE FROM chat_messages WHERE id = ?');

let deletedCount = 0;

db.transaction(() => {
  for (const group of duplicateGroups) {
    // Sort by timestamp to ensure we keep the oldest
    const sorted = group.messages.sort((a, b) => a.timestamp - b.timestamp);

    // Delete all except the first (oldest)
    for (let i = 1; i < sorted.length; i++) {
      deleteStmt.run(sorted[i].id);
      deletedCount++;
      console.log(`Deleted: ${sorted[i].id.substring(0, 8)}... (${new Date(sorted[i].timestamp).toISOString()})`);
    }
  }
})();

console.log(`\n✓ Cleanup complete! Deleted ${deletedCount} duplicate messages.`);

// Verify cleanup
const remainingMessages = db.prepare(`
  SELECT COUNT(*) as count
  FROM chat_messages
  WHERE worktree_id = 'feature-issue-146'
    AND cli_tool_id = 'claude'
    AND role = 'assistant'
`).get() as { count: number };

console.log(`Remaining assistant messages: ${remainingMessages.count}`);

db.close();
