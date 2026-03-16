# Architecture Review Report: Issue #506 - Stage 2 (Consistency Review)

## Executive Summary

Issue #506 (Sidebar Branch Sync Button) の設計方針書について、整合性の観点からレビューを実施した。設計方針書の品質は高く、Stage 1レビュー指摘の反映も適切に行われているが、既存コードベースとの整合性において修正が必要な点が確認された。

**Status**: CONDITIONALLY APPROVED (条件付き承認)
**Score**: 4/5
**Risk Level**: LOW

---

## Review Focus

- 設計方針書に記載された内容と既存コードベースの整合性
- 設計書内の各セクション間の整合性
- Issue #506の記載内容と設計方針書の整合性
- 既存のコーディングパターン・アーキテクチャとの整合性

---

## Detailed Findings

### Must Fix (2 items)

#### CONS-001: i18n名前空間 'sidebar' が存在しない

| 項目 | 内容 |
|------|------|
| 重要度 | High |
| 設計書セクション | セクション3 技術選定 / セクション4 設計パターン |

**問題**: 設計書では`useTranslations('sidebar')`を使用しているが、既存のi18n構成に`sidebar`名前空間は存在しない。

**既存コードの状況**:
- `src/i18n.ts`で読み込まれる名前空間: common, worktree, autoYes, error, prompt, auth, schedule (7つ)
- `locales/en/sidebar.json`および`locales/ja/sidebar.json`は存在しない
- Sidebar.tsx内では現在`useTranslations`は一切使用されていない

**影響**: 実装時にランタイムエラーが発生する。

**推奨対応**:
- 方法A: `locales/en/sidebar.json`と`locales/ja/sidebar.json`を新規作成し、`src/i18n.ts`のimportとmessagesマッピングに`sidebar`を追加する
- 方法B: 既存の`common`名前空間にsync関連キーを追加する（追加ファイル不要）
- いずれの方法でも、設計書のコード例を選択した方法に合わせて更新すること

---

#### CONS-002: インラインコンポーネントのmemoパターン記述の不正確さ

| 項目 | 内容 |
|------|------|
| 重要度 | Medium |
| 設計書セクション | セクション4 設計パターン - 既存パターンとの整合性テーブル |

**問題**: 設計書の整合性テーブルに「memo化: Sidebar全体がmemo -> SyncButton内部もmemo」と記載されているが、既存のインラインコンポーネント(GroupHeader, ViewModeToggle, ChevronIcon, GroupIcon, FlatListIcon)はいずれも`memo()`でラップされていない。

**既存コードの状況**:
- `Sidebar`コンポーネント自体は`memo(function Sidebar(){})`でラップされている
- 内部のインラインコンポーネントは全て通常の`function`宣言
- SyncButtonのみmemoを適用するのは技術的に妥当だが、「既存パターンの踏襲」ではなく「新パターンの導入」である

**推奨対応**: 整合性テーブルの記載を修正し、SyncButtonのmemo化が既存パターンの踏襲ではなく、useToast state分離のための技術的判断であることを正確に記述する。

---

### Should Fix (3 items)

#### CONS-003: repositoryApi.sync()の呼び出し元の誤記

| 項目 | 内容 |
|------|------|
| 重要度 | Medium |
| 設計書セクション | セクション4 既存パターンとの整合性テーブル |

**問題**: 「API呼び出し: WorktreeList: repositoryApi.sync()」と記載されているが、WorktreeList.tsxでは`repositoryApi.sync()`は呼ばれていない。

**実際の呼び出し元**:
- `WorktreeList.tsx`: `repositoryApi.getExcluded()`, `.restore()`, `.delete()`を使用
- `RepositoryManager.tsx`: `repositoryApi.sync()`を使用

**推奨対応**: テーブルの記載を「RepositoryManager: repositoryApi.sync()」に修正する。

---

#### CONS-004: refreshWorktrees()のエラーハンドリング特性の未記載

| 項目 | 内容 |
|------|------|
| 重要度 | Low |
| 設計書セクション | セクション4 / セクション2 |

**問題**: 設計書のtry-catch内で`await refreshWorktrees()`を呼んでいるが、`WorktreeSelectionContext.refreshWorktrees()`は内部でエラーをdispatchで処理しthrowしないため、SyncButtonのcatchブロックでは捕捉されない。

**推奨対応**: 設計書に「refreshWorktrees()はエラーをContext内部で処理するため、SyncButton側のcatch対象はrepositoryApi.sync()のみ」と注釈を追加する。

---

#### CONS-005: SyncResponseインターフェース名の不正確さ

| 項目 | 内容 |
|------|------|
| 重要度 | Low |
| 設計書セクション | セクション5 データモデル設計 |

**問題**: 設計書で`SyncResponse`インターフェースとして定義しているが、`api-client.ts`ではインライン型リテラルで戻り値型が定義されており、`SyncResponse`という名前付き型は存在しない。

**推奨対応**: 設計書に「api-client.tsのインライン型リテラルに対応する説明用の型定義」であることを注記する。

---

### Consider (2 items)

#### CONS-006: サイドバー全体のi18n化との一貫性

設計書で既に「スコープ外」と明記済み(Stage 1 F-005対応)。現在のSidebar.tsxにはハードコードされた英語文字列('Branches', 'Search branches...'等)が存在し、SyncButtonのみi18n化すると同一ファイル内で混在する。将来Issueとして計画することを推奨。

#### CONS-007: AppShellのtransformとstacking context

AppShell.tsxのtranslate-x-0/-translate-x-fullの使用がstacking contextに実際に影響するかはブラウザ実装依存。設計書の段階的アプローチ(F-007対応で追記済み)が適切な判断。

---

## Consistency Matrix

| 整合性カテゴリ | 評価 | 備考 |
|--------------|------|------|
| 設計書 vs 既存コードベース | Partially Consistent | i18n名前空間の未定義(CONS-001)、memoパターン記載の不正確さ(CONS-002)、API呼び出し元の誤記(CONS-003) |
| 設計書内セクション間 | Consistent | セクション間の論理的整合性は取れている |
| 設計書 vs Issue #506 | Consistent | 要件に対して適切にスコープされている |
| 設計書 vs アーキテクチャ | Mostly Consistent | 既存レイヤー構成に準拠、新規抽象化なし |

---

## Risk Assessment

| Risk Category | Level | Details |
|---------------|-------|---------|
| Technical | Low | i18n名前空間追加はルーチン作業。memoパターンの差異は設計書記載の問題であり実装品質への影響は小さい |
| Security | Low | 既存認証・CSRF保護の継承のみ。新規セキュリティリスクなし |
| Operational | Low | 既存APIの再利用のみ。運用への影響なし |

---

## Approval Status

**CONDITIONALLY APPROVED** - 以下の条件を満たした上で実装に進むことを推奨:

1. **CONS-001** (Must Fix): i18n名前空間の追加方針を決定し、設計書を更新する
2. **CONS-002** (Must Fix): 整合性テーブルのmemoパターン記載を正確に修正する

Should Fix項目(CONS-003~005)は実装フェーズでの修正でも可。

---

*Reviewed by: architecture-review-agent*
*Review date: 2026-03-16*
*Design document: dev-reports/design/issue-506-sidebar-sync-button-design-policy.md*
