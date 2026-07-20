/** Aggregates all migration definitions into a single ordered array. */

import type { Migration } from './runner';
import { v01_v05_migrations } from './v01-v05-initial-schema';
import { v06_v10_migrations } from './v06-v10-schema-updates';
import { v11_v15_migrations } from './v11-v15-feature-additions';
import { v16_v20_migrations } from './v16-v20-refactoring';
import { v21_v23_migrations } from './v21-v23';
import { v24_migrations } from './v24-daily-summaries';
import { v25_migrations } from './v25-report-templates';
import { v26_migrations } from './v26-repository-display-name';
import { v27_migrations } from './v27-app-settings';
import { v28_migrations } from './v28-assistant-conversations';
import { v29_migrations } from './v29-assistant-non-interactive';
import { v30_migrations } from './v30-assistant-context-snapshot';
import { v31_migrations } from './v31-repository-visible';
import { v32_migrations } from './v32-add-messages-role-composite-index';
import { v33_migrations } from './v33-agent-instances';
import { v34_migrations } from './v34-repository-todos';
import { v35_migrations } from './v35-timer-instance-id';
import { v36_migrations } from './v36-worktree-branch';
import { v37_migrations } from './v37-worktree-todos';
import { v38_migrations } from './v38-worktree-todo-status';
import { v39_migrations } from './v39-worktree-todo-detail';
import { v40_migrations } from './v40-timer-error';
import { v41_migrations } from './v41-push-subscriptions';
import { v42_migrations } from './v42-push-subscription-locale';
import { v43_migrations } from './v43-remove-cm-root-dir-ghost-repository';
import { v44_migrations } from './v44-skill-operations';
import { v45_migrations } from './v45-skill-installations';

/**
 * Complete ordered list of all migrations.
 * Used internally by the barrel file (db-migrations.ts); NOT exported from the barrel (DR2-004).
 */
export const migrations: Migration[] = [
  ...v01_v05_migrations,
  ...v06_v10_migrations,
  ...v11_v15_migrations,
  ...v16_v20_migrations,
  ...v21_v23_migrations,
  ...v24_migrations,
  ...v25_migrations,
  ...v26_migrations,
  ...v27_migrations,
  ...v28_migrations,
  ...v29_migrations,
  ...v30_migrations,
  ...v31_migrations,
  ...v32_migrations,
  ...v33_migrations,
  ...v34_migrations,
  ...v35_migrations,
  ...v36_migrations,
  ...v37_migrations,
  ...v38_migrations,
  ...v39_migrations,
  ...v40_migrations,
  ...v41_migrations,
  ...v42_migrations,
  ...v43_migrations,
  ...v44_migrations,
  ...v45_migrations,
];
