/**
 * Shared set-up of the Issue #4226 tests: #4222's world (a migrated file DB under
 * `os.tmpdir()`, one registered root, fake git and gh) with the prompts' deps — the
 * branch listing, a counting `observe`, and a `step` that changes the state right after
 * one await resolved (the injection point of the design's table, P2-2). Not a test file.
 */
import { memSuggest, type BranchListing, type MemSuggestAwaitId, type MemSuggestDeps } from '@/lib/mem-suggest/service';
import { getMemSettings, saveMemSettings } from '@/lib/db/mem-db';
import { memWriteNow, type MemServiceDeps } from '@/lib/mem/service';
import type { WorktreeHeadObservation } from '@/lib/mem/git-observe';
import type { MemBranchRule, MemFeatures, MemWriteResponse } from '@/types/mem';
import type { MemSuggestResponse } from '@/types/mem-suggest';
import { MemWorld } from '../mem/mem-4222-harness';

export const DAY = 24 * 60 * 60 * 1000;
export const BASE = 1_800_000_000_000;

export class SuggestWorld extends MemWorld {
  t = BASE;
  branchListing: BranchListing = { ok: true, stdout: 'feature/x refs/heads/feature/x\nmain refs/heads/main\nfeature/off refs/heads/feature/off' };
  steps: MemSuggestAwaitId[] = [];
  listCalls = 0;
  observeCalls = 0;
  /** Changed right after the await `at` resolved, before what follows it runs. */
  inject: { at: MemSuggestAwaitId; change: () => void } | null = null;
  /** Changed between the 1st and the 2nd `observe` of the next membership (the wait of W5, P2-2). */
  betweenObserves: (() => void) | null = null;

  open(prefix: string): void {
    super.open(prefix);
    this.t = BASE;
    this.clock = () => this.t;
    this.steps = [];
    this.listCalls = 0;
    this.observeCalls = 0;
    this.inject = null;
    this.betweenObserves = null;
    this.branchListing = { ok: true, stdout: 'feature/x refs/heads/feature/x\nmain refs/heads/main\nfeature/off refs/heads/feature/off' };
  }

  /** Rules and features of a root (default: on for every branch, prompts on). */
  setRules(rules: MemBranchRule[], features: Partial<MemFeatures> = {}, repositoryId = this.repo): void {
    const current = getMemSettings(this.db, repositoryId);
    saveMemSettings(this.db, repositoryId, { version: current.version, features: { ...current.features, ...features }, rules });
  }

  on(features: Partial<MemFeatures> = { promptOnEvents: true }, repositoryId = this.repo): void {
    this.setRules([{ match: 'glob', pattern: '**', mode: 'on' }], features, repositoryId);
  }

  suggestDeps(extra: Partial<MemSuggestDeps> = {}): MemSuggestDeps {
    const base = this.deps();
    let observed = 0;
    return {
      ...base,
      observe: async (worktreePath: string): Promise<WorktreeHeadObservation> => {
        this.observeCalls += 1;
        observed += 1;
        const seen = await (base.observe as (p: string) => Promise<WorktreeHeadObservation>)(worktreePath);
        if (observed % 2 === 1 && this.betweenObserves) {
          const change = this.betweenObserves;
          this.betweenObserves = null;
          change();
        }
        return seen;
      },
      listBranches: async () => {
        this.listCalls += 1;
        return this.branchListing;
      },
      step: async (id, run) => {
        this.steps.push(id);
        const value = await run();
        if (this.inject?.at === id) {
          const change = this.inject.change;
          this.inject = null;
          change();
        }
        return value;
      },
      ...extra,
    };
  }

  async writeNow(instanceId = 'claude', worktreeId = 'wt-1', extra: Record<string, unknown> = {}, deps: MemServiceDeps = this.deps()) {
    const outcome = await memWriteNow(this.db, worktreeId, { instanceId, text: 'working on it', ...extra }, deps);
    if (outcome.status >= 300) throw new Error(`now failed: ${JSON.stringify(outcome.body)}`);
    return (outcome.body as MemWriteResponse).item;
  }

  async suggest(full: boolean, instanceId: string | null = 'claude', worktreeId = 'wt-1', extra: Partial<MemSuggestDeps> = {}) {
    return memSuggest(this.db, worktreeId, { full, ...(instanceId === null ? {} : { instanceId }) }, this.suggestDeps(extra));
  }

  async quiet(instanceId: string | null = 'claude', worktreeId = 'wt-1', extra: Partial<MemSuggestDeps> = {}): Promise<MemSuggestResponse> {
    const outcome = await this.suggest(false, instanceId, worktreeId, extra);
    if (outcome.status !== 200) throw new Error(`quiet answered ${outcome.status}: ${JSON.stringify(outcome.body)}`);
    return outcome.body as MemSuggestResponse;
  }

  shown(worktreeId?: string): number {
    return worktreeId === undefined
      ? this.count('SELECT COUNT(*) AS n FROM suggestion_shown')
      : this.count('SELECT COUNT(*) AS n FROM suggestion_shown WHERE worktree_id = ?', worktreeId);
  }

  codes(body: MemSuggestResponse): string[] {
    return body.suggestions.map((suggestion) => suggestion.code);
  }
}
