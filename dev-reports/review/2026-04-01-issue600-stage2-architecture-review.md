# Architecture Review Report: Issue #600 Stage 2 (整合性レビュー)

## Executive Summary

| 項目 | 値 |
|------|---|
| Issue | #600 |
| レビューステージ | Stage 2: 整合性レビュー |
| フォーカス | 設計方針書と既存コード/Issue本文の整合性 |
| レビュアー | Claude Opus |
| ステータス | Conditionally Approved |
| Must Fix | 2件 |
| Should Fix | 6件 |
| Nice to Have | 4件 |

設計方針書はStage 1レビューの指摘事項を適切に反映し、内部整合性は概ね良好。しかし、Issue本文側にStage 1反映前の旧方針が残存しており、実装着手時の混乱を招く矛盾が複数存在する。既存コードとの整合性（ファイルパス、型定義、API構造）は良好。

---

## Detailed Findings

### Must Fix (2件)

#### DR2-001: Issue本文と設計方針書でMessageInputの実装方針が矛盾

- **カテゴリ**: Issue整合性
- **場所**: Issue #600 本文「/worktrees/:id/reply の仕様」 vs 設計方針書セクション3-2

Issue本文には `variant='simplified'` をMessageInputに追加する方式が記載されているが、設計方針書はDR1-001を反映し `SimpleMessageInput + useSendMessage()` 方式に変更済み。Issue本文の「新規コンポーネント方式は機能乖離リスクがあるため避ける」という記載が設計方針書の方針と直接矛盾する。

**改善提案**: Issue本文の該当セクションを設計方針書と一致するように更新する。

#### DR2-012: Phase 1/Phase 2間の依存関係が不明確

- **カテゴリ**: 内部整合性
- **場所**: 設計方針書セクション11 Phase 1/Phase 2

Phase 1の新規ファイルに `review-config.ts`（STALLED_THRESHOLD_MS等）が含まれるが、これを使用する `stalled-detector.ts` はPhase 2配置。Phase間の依存関係が明確に説明されていない。

**改善提案**: Phase依存関係を明示する注記を追加し、各ファイルの初回使用Phaseを明確にする。

---

### Should Fix (6件)

#### DR2-002: SidebarContextのautoCollapsedPaths記載がIssue本文に残存

- **カテゴリ**: Issue整合性
- **場所**: Issue #600 本文「サイドバーの扱い」 vs 設計方針書セクション3-4

Issue本文には `SidebarContext` に `autoCollapsedPaths` を追加する記載が残っているが、設計方針書ではDR1-003対応で `useLayoutConfig()` フックに集約する方針に変更済み。

#### DR2-003: Stalled判定の配置先がIssue本文と矛盾

- **カテゴリ**: Issue整合性
- **場所**: Issue #600 本文「主要変更ファイル」 vs 設計方針書セクション9

Issue本文の主要変更ファイルリストに「worktree-status-helper.ts - Stalled判定追加」と記載されているが、設計方針書ではDR1-010対応で `stalled-detector.ts` を新設する方針に変更済み。

#### DR2-004: Phase 2タスクにMessageInput variant記載が残存

- **カテゴリ**: Issue整合性
- **場所**: Issue #600 本文「実装タスク Phase 2」

Phase 2タスクに「MessageInput に variant='simplified'」の記載が残っている。

#### DR2-005: getNextAction()にexhaustive checkが欠如

- **カテゴリ**: コード整合性
- **場所**: 設計方針書セクション3-3 vs src/lib/detection/status-detector.ts

`SessionStatus` 型が将来拡張された場合、`getNextAction()` がデフォルトで 'Running...' を返してしまう。TypeScript の exhaustive check がないため、新ステータス追加時にコンパイル時に検出できない。

#### DR2-006: deep link pane値とMobileActivePane/LeftPaneTab型の関係が曖昧

- **カテゴリ**: 型整合性
- **場所**: 設計方針書セクション7 vs src/types/ui-state.ts

pane値9種（terminal, history, git, files, notes, logs, agent, timer, info）とMobileActivePane（5値）/LeftPaneTab（3値）は1対1対応ではないが、「MobileActivePane・LeftPaneTab型をpane値9種に対応拡張」という記載が誤解を招く。DeepLinkPane型を別途定義すべき。

#### DR2-010: worktrees APIのrepositories配列について設計方針書で言及なし

- **カテゴリ**: API整合性
- **場所**: 設計方針書セクション5 vs src/app/api/worktrees/route.ts

現在のworktrees APIレスポンスに含まれる `repositories` 配列について、?include=review時の扱いやRepositories画面のデータ取得方法が不明確。

---

### Nice to Have (4件)

#### DR2-007: Review画面ポーリング間隔の表現差異

Issue本文は「5-10秒」、設計方針書は7秒固定。矛盾ではないが統一が望ましい。

#### DR2-008: 新規ファイルリストのPhase配置が混在

Issue本文の新規ファイルリストがPhase横断で列挙されており、Phase別整理が望ましい。

#### DR2-009: Worktree型参照の正確性（問題なし）

設計方針書のWorktree型参照は正確。対応不要。

#### DR2-011: Home画面のStalled集計とinclude=review未使用方針の矛盾

Home画面で「Stalled のカウント」を表示するには `?include=review` が必要だが、Home画面では付与しない方針。Stalledカウントを除外するか、方針を変更する必要がある。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 実装混乱 | Issue本文と設計方針書の矛盾により実装者が旧方針で着手するリスク | Medium | High | P1 |
| 型安全性 | DeepLinkPane型とMobileActivePane/LeftPaneTab型の混同 | Medium | Medium | P2 |
| API設計 | Repositories画面のデータ取得方法未定義 | Low | Medium | P2 |
| パフォーマンス | Home画面Stalled集計方針の不整合 | Low | Low | P3 |

---

## Consistency Check Matrix

| 設計項目 | 設計方針書 | 既存コード | Issue本文 | 整合性 |
|---------|-----------|-----------|----------|--------|
| SessionStatus型 | 'idle' / 'ready' / 'running' / 'waiting' | 一致 | 一致 | OK |
| PromptType型 | 'approval' を使用 | 'yes_no' / 'multiple_choice' / 'approval' / 'choice' / 'input' / 'continue' | 一致 | OK |
| Worktree.status | 'todo' / 'doing' / 'done' / null | 一致 | 一致 | OK |
| MessageInput行数 | 474行 | 474行 | - | OK |
| WorktreeDetailRefactored行数 | 1966行 | 1966行 | - | OK |
| MessageInput方針 | SimpleMessageInput + useSendMessage | - | variant='simplified' | NG (DR2-001) |
| Stalled判定配置 | stalled-detector.ts | - | worktree-status-helper.ts | NG (DR2-003) |
| サイドバー制御 | useLayoutConfig() | - | autoCollapsedPaths | NG (DR2-002) |
| AUTH_EXCLUDED_PATHS | /login, /api/auth/* | 一致 | - | OK |
| getLastServerResponseTimestamp | auto-yes-manager経由 | 一致 | 一致 | OK |
| 既存ファイルパス全件 | 記載のパスすべて実在 | 確認済 | - | OK |
| sidebar-utils.ts エクスポート | sortBranches, groupBranches等 | 一致 | - | OK |

---

## Improvement Recommendations

### 必須改善項目 (Must Fix)

1. Issue #600 本文のStage 1レビュー反映漏れ箇所（DR2-001〜DR2-004）を一括更新する
2. 設計方針書セクション11にPhase間依存関係の注記を追加する

### 推奨改善項目 (Should Fix)

1. DeepLinkPane型をMobileActivePane/LeftPaneTab型とは別に定義する型設計を明記する
2. worktrees APIレスポンス全体構造とRepositories画面のデータ取得方法を明記する
3. getNextAction()にexhaustive checkを追加する設計を明記する

### 検討事項 (Consider)

1. Home画面の集計サマリーからStalledカウントを除外する
2. Issue本文の新規ファイルリストをPhase別に整理する
3. Review画面ポーリング間隔を7秒固定に統一する
