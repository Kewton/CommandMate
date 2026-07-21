# ADR: Harness Pack 共通契約・移植方針

- **Issue**: [#1447](https://github.com/Kewton/CommandMate/issues/1447)（親Epic [#1227](https://github.com/Kewton/CommandMate/issues/1227) / Phase 1B・実行計画 [#1452](https://github.com/Kewton/CommandMate/issues/1452)）
- **ステータス**: Accepted
- **対象 schema_version**: 1（変更しない）
- **成果物**: 本ADR / `Kewton/commandmate-skills` の共通 fixture・schema
- **前提ADR**: [agent-skills-distribution.md](./agent-skills-distribution.md)（#1228, manifest/Catalog/receipt 契約）

本ADRは、実績ハーネス（orchestrate / worktree-setup / worktree-cleanup）を Claude/Codex 共通の公式 Agent Skill
（`cmate-worktree-setup` / `cmate-orchestrate` / `cmate-worktree-cleanup`）へ移植するための **共通契約・責務境界・repository profile・
risk・Phase 1B/Phase 5 境界** を確定する。後続の [#1448](https://github.com/Kewton/CommandMate/issues/1448) / [#1449](https://github.com/Kewton/CommandMate/issues/1449) /
[#1453](https://github.com/Kewton/CommandMate/issues/1453)〜[#1456](https://github.com/Kewton/CommandMate/issues/1456) は、本ADRと `agent-skills-distribution.md` の
公開契約だけを前提に実装する。**本Issueの範囲は契約・matrix・schema・profile・ADRであり、3 Skill package の実装・release は含まない。**

---

## 1. 前提の検証結果（着手時の実物調査）

Issue 記載の前提を、CommandMate 本体・`Kewton/CommandAgent`・`Kewton/commandmate-skills` の実物で確認した。

| Issue 記載の前提 | 実物 | 判定 |
|---|---|---|
| CommandAgent の Skill は `.agents/skills/orchestrate/` 等 | 実体は `.codex/skills/`。ID は `commandagent-orchestrate` / `commandagent-worktree-cleanup` / `commandagent-issue-worker`。`.agents/` は存在しない | **要訂正**（本ADRで訂正済み） |
| CommandAgent に `worktree-setup` Skill がある | 存在しない。worktree 作成は `scripts/codex_orchestrate.py --create-worktrees` と `commandagent-issue-worker` の運用規約が担う | **要訂正** |
| CommandAgent の repository script は約3400行 | `scripts/codex_orchestrate.py` は 523行（18KB）。約3400行は eval 系スクリプト群を含めた数値の誤り | **要訂正** |
| worker Skill は `$codex-issue-worker` | 実在するのは `commandagent-issue-worker` | **要訂正** |
| 既存ID `orchestrate` 等が repository-local Skill と衝突する | 両repository の `.agents/skills` に同名 ID は実在しない。一般 repository では衝突しうる | **一般化して採用** |
| CommandMate 側の worktree 同期は localhost API | `POST /api/repositories/sync`（`src/app/api/repositories/sync/`）。CLI に sync サブコマンドは存在しない | 正しい（sync 経路は §11 で決定） |
| CommandMate 側 cleanup は force remove・branch -D・DB/log 削除を含む | `.claude/commands/worktree-cleanup.md` に `git worktree remove --force` / `git branch -D` 案内 / DB・log 削除が実在 | 正しい |
| schema v1 に Skill alias / dependency / Runtime entrypoint はない | `src/types/skills.ts` の `SkillAgentSupport = native|commandmate_runtime|unsupported|unknown`。alias/dependency field なし | 正しい（§10 で self-contained を維持） |
| public CLI は `commandmate`、開発用は `commandmatedev` | `package.json` の `bin` は `commandmate` のみ。`commandmatedev` は repository 開発用 alias | 正しい |

**結論**: source artifact は **7 件**（CommandMate 3 slash command＋CommandAgent 3 Skill＋`codex_orchestrate.py`）である。
「6 artifact」「worktree-setup Skill が両方に存在」「約3400行」を前提にした設計判断は本ADRで修正する。

---

## 2. スコープ / 非スコープ

**スコープ**: 3 Skill 共通の命名・入力・出力 schema・permission・risk・safety gate・evidence・Agent 互換規約、7 artifact の
behavior matrix、Node/Rust profile と未知 repository の扱い、Phase 1B/Phase 5 の能力境界、legacy 移行方針。

**非スコープ**: 3 Skill package の実装・release（#1448/#1449/#1453-1456）、manifest schema v2・alias installer・dependency resolver、
Phase 4 Runtime protocol・Attention・resume/reconciliation、5 Issue/3並列 UAT・cross-model review・明示承認なしの自動 merge、外部Registry公開。

---

## 3. 責務境界

| 層 | 責務 | 非責務 |
|---|---|---|
| Skill package | 標準手順（SKILL.md）と宣言metadata（commandmate.skill.yaml）、deterministic runner、共通 schema | CommandMate 内部 module への直接依存 |
| CommandMate 本体 | source/checksum検証、worktree解決、plan/apply、receipt/audit、互換性判定 | Skill 固有のWave/verification ロジック |
| public CLI (`commandmate`) | Skill が使う唯一の公開実行面（send/wait/respond/capture/ls、および新設 sync） | 独自の検証経路 |
| `commandmatedev` | repository 開発用 adapter。**公式 Skill の実行経路には使わない** | — |

---

## 4. 7 source artifact behavior matrix

分類記号: ● 共通機能（公式Skillへ採用） / ◆ repository 固有（profile で吸収） / ✗ 廃止（公式Skillへ持ち込まない）

| 機能 | CM orchestrate.md | CM worktree-setup.md | CM worktree-cleanup.md | CA commandagent-orchestrate | CA commandagent-worktree-cleanup | CA commandagent-issue-worker | codex_orchestrate.py | 公式Skill方針 |
|---|---|---|---|---|---|---|---|---|
| default dry-run | ✗ | ✗ | ✗ | ● | — | — | ● | ● 全Skill default dry-run |
| dependency override / cycle 検出 | 部分 | — | — | ● | — | — | ● | ● orchestrate |
| bounded parallelism（最大3） | 部分 | — | — | ● | — | — | ● | ● orchestrate |
| file conflict barrier | 部分 | — | — | ● | — | — | ● | ● orchestrate |
| verification gate（completion≠success） | 部分 | — | — | ● | — | ● | ● | ● orchestrate |
| PR作成/CI/guarded merge | ◆npm前提 | — | — | ●explicit flag | — | — | ●explicit flag | ● 明示承認つき |
| UAT / 修正ループ | ◆ | — | — | ●explicit flag | — | — | ●explicit flag | ● 回数上限つき |
| worktree 作成（base/branch/path） | ◆固定path/npm | ◆固定path/npm | — | — | — | ◆slug path/Cargo | ●--create-worktrees | ● setup（profile吸収） |
| baseline 検証 | — | ◆npm | — | — | — | ◆cargo | — | ● setup（profile吸収） |
| dirty/unmerged 拒否 | — | — | 部分 | — | ● | — | — | ● cleanup |
| direct ancestry 検証 | — | — | — | — | ●merge-base | — | — | ● cleanup |
| squash/rebase merged-equivalence | — | — | — | — | ✗（未実装） | — | — | ● cleanup で**新規設計** |
| guarded ref delete（expected OID） | — | — | ✗branch -D案内 | — | ✗branch -d | — | — | ● cleanup で**新規設計** |
| force remove / branch -D | — | — | ✗ | — | 禁止 | — | — | ✗ 公式Skillは禁止 |
| server/tmux 停止・DB/log 削除 | — | — | ✗ | 禁止 | — | — | — | ✗ 診断表示のみ |
| GitHub Project 更新 | ✗ | ✗ | — | — | — | — | — | ✗ Phase 2以降 |
| CommandMate worktree sync | ◆localhost | ◆localhost | ◆localhost | ●--dispatch | — | — | ●--dispatch | ● 新設 `commandmate sync` 経由（§11） |

CM=CommandMate slash command / CA=CommandAgent Skill。squash/rebase merged-equivalence と guarded ref delete は
**どちらの既存実装にも無く**、`cmate-worktree-cleanup`（#1449）で新規設計する。

---

## 5. 公式ID・命名と legacy 互換

- 公式ID: `cmate-worktree-setup` / `cmate-orchestrate` / `cmate-worktree-cleanup`（`cmate-` prefix は既存3 Skill と整合）。
- legacy 名（`/orchestrate`・`/worktree-setup`・`/worktree-cleanup`・`$commandagent-*`）は source repository 側の
  **thin compatibility wrapper** で当面維持し、公式ID へ委譲する。wrapper は新規機能を持たない。
- **ID統一（決定）**: Phase 5 の `cmate-parallel-issue-development`（#1258-1261）は **`cmate-orchestrate` へ統一** する。
  Phase 5 は同一 Skill の **major version（Runtime 昇格）** として entrypoint/state contract を追加し、別 Skill を作らない。
  `cmate-parallel-issue-development` の名称は廃止し、確定後に Phase 5 子Issue の名称を更新する。

---

## 6. Agent 非依存の入力契約

3 Skill 共通の入力語彙（Claude/Codex で同一）:

| 入力 | 型 | 対象Skill | 備考 |
|---|---|---|---|
| `issues` | 正の整数の配列 | 全 | 複数時は上限（setup/orchestrate=3）を設ける |
| `repository` / `worktree` | server 登録済み worktree ID | 全 | client 構成の絶対 path を信頼しない |
| `base_branch` | symbolic ref | setup/orchestrate | profile default から解決可 |
| `max_parallel` | 1〜3 | orchestrate | 既定は profile 依存 |
| `phase` | plan \| develop \| verify \| pr \| merge \| uat-fix | orchestrate | mutating phase は 1 invocation で1つのみ |
| `profile` | node \| rust \| （override） | 全 | 未指定時は自動検出＋確認 |
| `dependency_override` | 明示依存の宣言 | orchestrate | run 全体で固定、途中で inference へ戻さない |

---

## 7. 最小 schema（Claude/Codex 双方で利用）

versioned な 4 契約を定義する（詳細 JSON Schema は commandmate-skills 側 fixture）。

- **execution-plan**: `schema_version`, `run_id`, `profile`, `issues[]`, `dependencies[]`, `waves[][]`, `max_parallel`, `risk`, `permissions`, `commands[]`。
- **worktree-result**: `issue`, `branch`, `directory`, `base_ref`, `base_sha`, `baseline`（command/status/evidence）, `commandmate_worktree_id?`, `status`(success|partial|failure)。
- **verification-evidence**: `wave`, `checks[]`（name/command/status/summary）, `passed`(bool)。worker completion とは独立。
- **result-report**: `run_id`, `status`(success|partial|blocked|failure), `waves[]`, `prs[]?`, `merges[]?`, `uat[]?`, `next_actions[]`, `evidence_refs[]`。

全 schema は `machine-readable field`（`phase_capabilities`, `runtime.type`）で Phase 1B / Phase 5 の能力差を識別できるようにする。

---

## 8. repository profile

- **動作確認済み profile は Node/CommandMate と Rust/CommandAgent の 2 つのみ**（決定: まず利用可能にすることを優先）。
- Node profile: base=`develop`, branch=`feature/{N}-worktree`, baseline=`npm run lint`→`tsc --noEmit`→`test:unit`（proportional）。
- Rust profile: base=`origin/develop`, branch=`feature/issue-{N}-{slug}`, baseline=`cargo fmt --check`→`cargo test <filter>`→（必要時）`cargo build --release`。
- 検出は `git worktree list --porcelain` と package manifest（package.json / Cargo.toml）を正本とし、文字列 grep だけで判定しない。
- **未知 repository**: `unverified` として扱い、実行前に profile/base/path/baseline を利用者へ確認したうえで利用可能とする。
  profile 追加・確認済み設定のリポジトリ単位保存は将来拡張（Phase 2以降）。
- core に `develop` / `feature/...` / npm / Cargo を hardcode せず、profile から解決する。

---

## 9. Phase 1B / Phase 5 能力境界

| 能力 | Phase 1B native MVP | Phase 5 Runtime 昇格 |
|---|---|---|
| plan/dry-run・Issue品質/依存/file conflict/Wave | ● | ● |
| 最大並列 | 3 | 拡張（5 Issue/3並列） |
| worktree create/reuse 安全調整 | ● | ● |
| send/wait/capture・prompt handoff | ● | ● |
| verification evidence gate | ● | ● |
| **明示承認つき PR作成・CI確認・guarded merge** | ● | ● |
| **回数上限つき UAT 修正ループ** | ● | ● |
| Runtime による phase/event 永続化 | — | ● |
| Attention Inbox・dispatch gate・emergency stop | — | ● |
| crash reconciliation・安全な resume/retry | — | ● |
| unrestricted Auto Yes | — | ●（policy下） |
| cross-model review | — | ● |

Phase 1B は Runtime 監督（Attention/stop/recovery/resume）を持たないが、**明示承認つきの PR作成・CI確認・guarded merge・
回数上限つき UAT 修正ループ**までを範囲とする。high-risk native Skill は CommandMate Runtime の enforcement 対象ではないことを UI/CLI に明示する。

---

## 10. requirements / permission / risk

- 各 Skill は schema v1 に dependency field を追加せず **単独 install 可能・self-contained** とする。
- `requirements.commands`: 全 Skill で `commandmate` / `git`。orchestrate は追加で `gh`、runner runtime（§11 の決定により `node`）。
- `declared_permissions`: setup/orchestrate は `repository: write`・`github_issues: read`、orchestrate は加えて PR/merge のため `github: write`。
- `declared_risk_level`: cleanup/orchestrate=high、setup=medium。**effective risk は宣言値と CommandMate static inspection の高い方**（`agent-skills-distribution.md` §manifest 準拠）。
- GitHub write・PR・merge・credential access は **宣言と実行時確認を分離**する。high-risk Skill は内容を伴う install 時 acknowledgment を要求する（既存 `install-plan.ts` の acknowledgment 経路を利用）。

---

## 11. CommandMate worktree 同期の公式経路（決定）

- **決定**: 公式 CLI に **`commandmate sync` サブコマンドを新設**し、Skill はこれを唯一の同期経路とする（`commandmatedev` は使わない）。
- 理由: 「Skill は public `commandmate` 経路だけを使う」原則との整合。現行の localhost `POST /api/repositories/sync` 直叩きは
  localhost 結合で、認証・可搬性の宣言が曖昧なため公式経路にしない。
- 暫定: `commandmate sync` 実装までは API を利用してよいが、Skill は sync を **optional** に扱い、未提供環境では
  worktree-result に `commandmate_worktree_id` を欠落として返し、失敗にしない。
- `commandmate sync` CLI の追加は本ADRの非スコープ（別Issue化）。本ADRは契約（Skill は CLI 経路を前提）だけを固定する。

---

## 12. runner 実装言語（決定）

- **決定**: `cmate-orchestrate` の deterministic runner は **Node（`.mjs`）** で実装する。
- 理由: CommandMate 環境で保証されるのは **Node >= 22** のみ（`package.json` engines）。任意 target repository へ追加依存なしで
  可搬。Epic の manifest 例（`scripts/orchestrate.mjs`）とも整合。
- 影響: CommandAgent の `codex_orchestrate.py`（523行）planner ロジック（Issue parsing / dependency / file overlap / bounded batch /
  verification gate / report）を Node へ移植する。manifest へ `kind: executable` として完全宣言し、effective risk を high にする。
- Python 標準library 依存・`python3` 宣言は不要（target host の interpreter 不在リスクを回避）。

---

## 13. セキュリティ規約（3 Skill 共通）

- setup: 既存 branch/directory/worktree を暗黙上書き・reset・reuse しない（exact match の reuse も明示指定時のみ）。
- cleanup: force remove・`git branch -D`・無条件 process kill・DB/log 自動削除を禁止。dirty/detached/unmerged/unverifiable は zero-delete。
  guarded ref delete は検証済み branch tip を expected old OID に指定し、race 時は失敗させる。
- orchestrate: default dry-run、bounded parallel、Auto Yes default off、prompt 検出時停止、PR/merge は明示承認＋CI pass 必須。
- client/Agent 入力の絶対 path・`..`・symlink ancestor・worktree root 外 escape を拒否（`path-validator.ts` を #1231 と同様に利用）。
- machine 絶対 path・token・signed URL・raw terminal 全量を artifact/audit へ残さない（redaction）。

---

## 14. 決定事項サマリ（後続Issueが従う）

1. source artifact は **7 件**。behavior matrix（§4）を母集合とする。
2. 公式ID は `cmate-worktree-setup` / `cmate-orchestrate` / `cmate-worktree-cleanup`。legacy は thin wrapper で維持。
3. **ID統一**: Phase 5 は `cmate-orchestrate` の major version 昇格。`cmate-parallel-issue-development` は廃止。
4. **runner 言語**: Node（`.mjs`）。Python は採用しない。
5. **sync 経路**: `commandmate sync` CLI 新設を前提。暫定 API・sync は optional・失敗にしない。
6. profile は Node/Rust のみ verified。未知 repository は実行前確認つき unverified 利用。
7. Phase 1B は **明示承認つき PR/merge・回数上限つき UAT 修正ループ**まで含む。Runtime 監督は Phase 5。
8. 人による受け入れ基準: **現行 `/orchestrate` 相当のハーネスエンジニアリングを公式Skillで完遂できること**。

---

## 15. 後続Issueへの含意

| Issue | 本ADRから受け取る前提 |
|---|---|
| #1448 setup | §6 入力 / §8 profile / §11 sync optional / worktree-result schema（§7） |
| #1449 cleanup | §4 の merged-equivalence・guarded ref delete を新規設計 / §13 zero-delete |
| #1453 orchestrate計画コア | §7 execution-plan / §12 Node runner / dry-run 必須 |
| #1454 dispatch | §6 phase / verification-evidence（§7）/ completion≠success |
| #1455 PR/merge | §9 明示承認＋CI pass / §10 github:write |
| #1456 UAT loop/RC | 回数上限（§9）/ result-report（§7）|
| #1457 auto test | 全 schema・profile matrix・§13 redaction を test 化 |
| #1458 live UAT | §14-8 受け入れ基準 / Phase 1B 境界（§9）|
