/**
 * Shared set-up of the Issue #4223 tests: #4222's `MemWorld` (a migrated file DB under
 * `os.tmpdir()`, one registered root, worktrees, a fake `gh` / `git`) plus writers for
 * the brief's other sources, and a runner that answers what the CLI would print.
 * Not a test file.
 */
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { clearAllAutoYesStates } from '@/lib/auto-yes-state';
import { createMessage } from '@/lib/db/chat-db';
import { createRelay } from '@/lib/db/relay-db';
import { createVerificationRun } from '@/lib/db/verification-db';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearLastKnownStatuses } from '@/lib/session/status-evidence';
import { clearWaitingEpisodes } from '@/lib/session/waiting-episode-state-store';
import { briefForRoute, type BriefQuery } from '@/lib/brief/service';
import type { BriefBuildDeps } from '@/lib/brief/build';
import { MEM_EXIT_BY_CODE, type MemErrorCode } from '@/types/mem';
import { MemWorld } from '../mem/mem-4222-harness';

export const GHP = `ghp_${'a'.repeat(36)}`;

export function resetBriefMemory(): void {
  clearAllAutoYesStates();
  clearLastKnownStatuses();
  clearWaitingEpisodes();
  clearPolicySuppressions();
}

export interface BriefRun {
  /** What the CLI would end with. */
  exit: number;
  /** What the CLI would print on stdout ('' on a refusal). */
  stdout: string;
  body: Record<string, unknown>;
}

export class BriefWorld extends MemWorld {
  briefDeps(extra: BriefBuildDeps = {}): BriefBuildDeps {
    const deps = this.deps();
    return { target: deps, evaluation: deps.evaluation, ...extra };
  }

  async brief(query: Partial<BriefQuery> & { worktreeId?: string } = {}, extra: BriefBuildDeps = {}): Promise<BriefRun> {
    const { worktreeId = 'wt-1', ...rest } = query;
    const outcome = await briefForRoute(
      this.db,
      worktreeId,
      { instance: 'claude', budget: null, format: null, all: null, ...rest },
      this.briefDeps(extra)
    );
    const body = outcome.body as Record<string, unknown>;
    if (outcome.status !== 200) {
      const code = body.code as MemErrorCode;
      return { exit: MEM_EXIT_BY_CODE[code] ?? 99, stdout: '', body };
    }
    const stdout = body.format === 'text' ? `${String(body.text)}\n` : `${JSON.stringify(body)}\n`;
    return { exit: 0, stdout, body };
  }

  task(input: { id?: string; worktreeId?: string; cliToolId?: string; instanceId?: string | null; title?: string; status?: string; updatedAt?: number; autoYesMode?: string | null }): string {
    const id = input.id ?? randomUUID();
    const at = input.updatedAt ?? Date.now();
    const title = input.title ?? 'a task';
    this.db
      .prepare(
        `INSERT INTO tasks (id, worktree_id, cli_tool_id, instance_id, title, goal, contract_path, contract_json, status,
           last_verification_run_id, created_at, updated_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, 'goal', NULL, ?, ?, NULL, ?, ?, ?, NULL)`
      )
      .run(
        id,
        input.worktreeId ?? 'wt-1',
        input.cliToolId ?? 'claude',
        input.instanceId === undefined ? null : input.instanceId,
        title,
        JSON.stringify({ title, goal: 'goal', autoYes: { mode: input.autoYesMode ?? null, allowPromptTypes: [], denyPatterns: [] } }),
        input.status ?? 'running',
        at,
        at,
        at
      );
    return id;
  }

  verify(instanceId: string | null, worktreeId = 'wt-1'): number {
    return createVerificationRun(this.db, { worktreeId, instanceId, trigger: 'manual' } as Parameters<typeof createVerificationRun>[1]).id;
  }

  relay(from: { worktreeId: string; instanceId: string }, to: { worktreeId: string; instanceId: string }, state?: 'prompt'): string {
    const relay = createRelay(this.db, { from, to, hops: 1, expiresAt: Date.now() + 3_600_000 });
    if (state) this.db.prepare('UPDATE session_relays SET state = ? WHERE id = ?').run(state, relay.id);
    return relay.id;
  }

  message(input: { instanceId: string; cliToolId: string; role: 'user' | 'assistant'; content: string; at: number; requestId?: string }): void {
    createMessage(this.db, {
      worktreeId: 'wt-1',
      role: input.role,
      content: input.content,
      timestamp: new Date(input.at),
      messageType: 'normal',
      cliToolId: input.cliToolId as 'claude',
      instanceId: input.instanceId,
      ...(input.requestId ? { requestId: input.requestId } : {}),
    } as Parameters<typeof createMessage>[1]);
  }

  /** A run record under the registered root, as `run-log.mjs append` writes it. */
  runLog(date: string, issues: string, lines: Array<Record<string, unknown> | string>): string {
    const dir = path.join(this.root, 'workspace', 'orchestration', 'runs', date);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `run-${issues}.jsonl`);
    writeFileSync(file, lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n');
    return file;
  }
}

/** The lines between the fences of a text brief. */
export function itemLines(stdout: string): string[] {
  const lines = stdout.replace(/\n$/, '').split('\n');
  return lines.slice(4, -1);
}

export const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');
