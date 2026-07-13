/** Migration v40: Add error column to timer_messages (Issue #1107).
 *
 * Timer (Issue #534) records a one-shot delayed send. On failure it only flips
 * `status` to 'failed' and logs the real reason server-side, so the UI can show
 * nothing but a red "Failed" label. Mirroring the Schedule side's
 * `execution_logs.result` (Issue #481), we add a nullable `error` column so the
 * failure reason is persisted, returned by the API, and shown in the detail modal.
 *
 * Backward compatibility: the column is nullable with no backfill — existing
 * rows keep `error = NULL`, which the UI treats as "no reason recorded".
 */

import type { Migration } from './runner';

export const v40_migrations: Migration[] = [
  {
    version: 40,
    name: 'add-error-to-timer-messages',
    up: (db) => {
      db.exec(`
        ALTER TABLE timer_messages ADD COLUMN error TEXT;
      `);

      console.log('Added error column to timer_messages table');
    },
    down: () => {
      // SQLite cannot drop a column without a table rebuild; no-op rollback
      // (mirrors the v35 instance_id migration).
      console.log('No rollback for error column (SQLite limitation)');
    },
  },
];
