# Architecture Review: Issue #237 - Stage 3 影響分析レビュー

**Issue**: #237 - 未使用コードの削除・リファクタリング
**Focus**: 影響範囲 (Impact Scope)
**Stage**: 3/4 (影響分析レビュー)
**Date**: 2026-02-11
**Status**: **APPROVED** (5/5)

---

## Executive Summary

Issue #237 の設計方針書に対する影響分析レビューを実施した。ソースコード、テスト、ドキュメント、ビルド設定に対して網羅的な参照検索を行い、設計方針書の影響範囲記載が正確かつ完全であることを確認した。

Stage 1（設計原則レビュー: conditionally_approved, 4/5）および Stage 2（整合性レビュー: approved, 5/5）で指摘された全項目は設計方針書に反映済み。Stage 3 では Must Fix 0件、Should Fix 0件、Consider 3件（全て informational）の結果となり、実装着手に問題なしと判断する。

---

## 1. 影響範囲の網羅性

### 1-1. ソースコード参照（src/配下）

| 削除対象 | 参照元（src/） | 設計書記載 | 検証結果 |
|---------|--------------|----------|---------|
| `claude-poller.ts` | `session-cleanup.ts` L11 | 記載あり (3-1, 4-1) | **一致** |
| `claude-poller.ts` | `cli-tools/manager.ts` L11 | 記載あり (3-1, 4-2) | **一致** |
| `terminal-websocket.ts` | (なし) | 記載あり (3-2: 完全未使用) | **一致** |
| `WorktreeDetail.tsx` | `worktree/index.ts` L12-13 | 記載あり (3-3, 4-3) | **一致** |
| `simple-terminal/page.tsx` | Next.js App Router (自動ルート) | 記載あり (3-4) | **一致** |
| `simple-terminal/page.tsx` | `WorktreeDetail.tsx` L652, L678 | 記載あり (3-4: MF-001対応済) | **一致** |
| `SimpleTerminal.tsx` | `simple-terminal/page.tsx` L9 | 記載あり (3-5) | **一致** |

**動的import/require検索結果**: 削除対象5ファイルに対する `require()` 呼び出し、`next/dynamic` 呼び出し、文字列ベースの参照は検出されなかった。

**結論**: ソースコード参照は完全に網羅されている。

### 1-2. テスト参照（tests/配下）

| テストファイル | vi.mock | import | テストケース削除 | 設計書記載 |
|--------------|---------|--------|---------------|----------|
| `tests/unit/session-cleanup.test.ts` | L15-17 | L26 | 1件 (L58-66) | **一致** |
| `tests/unit/cli-tools/manager-stop-pollers.test.ts` | L14-17 | (dynamic) | 3件 (L43-71) | **一致** |
| `tests/integration/api-kill-session-cli-tool.test.ts` | L19-22 | - | 0件 | **一致** |
| `tests/integration/api-prompt-handling.test.ts` | L53-57 | - | 1件 (L239-268) | **一致** |
| `tests/integration/api-respond-cli-tool.test.ts` | L18-21 | - | 0件 | **一致** |
| `tests/integration/api-send-cli-tool.test.ts` | L49-51 | - | 0件 | **一致** |

**注記**: `api-prompt-handling.test.ts` L239-268 の削除対象テストケースは `claude-poller.startPolling` の呼び出しを検証しているが、実際の `respond/route.ts` (L11, L178) は `response-poller.startPolling` を使用している。このテストは既にソースコードとの乖離があり、削除は正しい判断である。

**結論**: テスト参照は完全に網羅されている。

### 1-3. ドキュメント参照

| ドキュメント | 参照内容 | 設計書記載 |
|------------|---------|----------|
| `docs/architecture.md` L569 | `response-poller / claude-pollerを停止` | 記載あり (4-4) |
| `docs/internal/PROMPT_HANDLING_IMPLEMENTATION_PLAN.md` L456, L589, L1137 | claude-poller.ts への参照 | SF-002で除外明記済み |
| `docs/internal/PROMPT_HANDLING_IMPLEMENTATION_PLAN.md` L870, L872, L875, L1149 | WorktreeDetail.tsx への参照 | CS-005参照 (SF-002方針でカバー) |

**結論**: ドキュメント参照は網羅されている。内部ドキュメントの除外判断（SF-002）は適切。

### 1-4. ビルド設定・構成ファイル

| 設定ファイル | 影響 | 理由 |
|------------|------|------|
| `tsconfig.json` | なし | glob パターン (`**/*.ts`, `**/*.tsx`) でファイルを検出。個別ファイル指定なし |
| `next.config.js` | なし | 削除対象への明示的参照なし |
| `vitest.config.*` | なし | 削除対象への明示的参照なし |
| `package.json` | なし | 削除対象への明示的参照なし |

**結論**: ビルド設定への影響はない。

### 1-5. README / CLAUDE.md

| ファイル | 検索結果 |
|---------|---------|
| `README.md` | 削除対象への参照なし |
| `CLAUDE.md` | 削除対象への参照なし |

---

## 2. 削除順序の妥当性

### 2-1. フェーズ間依存関係の検証

```
Phase 1 (テスト修正)
  vi.mock('@/lib/claude-poller') 削除 --> Phase 3 の claude-poller.ts 削除に先行必須
  テストケース削除 --> claude-poller の動作検証不要化

Phase 2 (参照除去)
  session-cleanup.ts の import/呼び出し削除 --> Phase 3 の claude-poller.ts 削除に先行必須
  manager.ts の import/条件分岐削除 --> Phase 3 の claude-poller.ts 削除に先行必須
  index.ts の export 削除 --> Phase 3 の WorktreeDetail.tsx 削除に先行必須

Phase 3 (ファイル削除)
  claude-poller.ts 削除 --> 参照なし（Phase 1, 2 で除去済み）
  terminal-websocket.ts 削除 --> 参照なし（元から未使用）
  WorktreeDetail.tsx 削除 --> export 除去済み（Phase 2）、simple-terminal リンクは同時削除
  simple-terminal/page.tsx 削除 --> 参照は WorktreeDetail.tsx のみ（同時削除）
  SimpleTerminal.tsx 削除 --> 参照は simple-terminal/page.tsx のみ（同時削除）

Phase 4 (ドキュメント)
  architecture.md 更新 --> ビルド/テスト非依存
```

**順序評価**: 全てのフェーズ間依存関係が正しく前方方向のみ。逆方向の依存はない。

### 2-2. 循環依存の検証

削除対象5ファイルおよび修正対象3ファイル間の依存関係を検証:

- `session-cleanup.ts` -> `claude-poller.ts` (一方向、削除で解消)
- `manager.ts` -> `claude-poller.ts` (一方向、削除で解消)
- `index.ts` -> `WorktreeDetail.tsx` (一方向、export削除で解消)
- `simple-terminal/page.tsx` -> `SimpleTerminal.tsx` (一方向、同時削除)
- `WorktreeDetail.tsx` -> `simple-terminal/page.tsx` (URL文字列参照、同時削除)

**循環依存**: 検出されず。全て一方向の依存関係。

### 2-3. Phase 2 内の修正順序

Phase 2 の3ファイル（`session-cleanup.ts`, `manager.ts`, `index.ts`）に相互依存はない。

- `session-cleanup.ts` は `manager.ts` を参照しない
- `manager.ts` は `session-cleanup.ts` を参照しない
- `index.ts` は上記2ファイルを参照しない

Phase 2 内の修正は任意の順序で実行可能。

---

## 3. テスト影響

### 3-1. 削除対象テストケース（計5件）

| テストファイル | テストケース | 検証内容 | 削除理由 |
|--------------|------------|---------|---------|
| `session-cleanup.test.ts` | `should stop claude-poller` | stopClaudePolling の呼び出し | 対象コード削除 |
| `manager-stop-pollers.test.ts` | `should stop claude-poller only for claude tool` | claude tool 時の stopClaudePolling | 対象コード削除 |
| `manager-stop-pollers.test.ts` | `should NOT stop claude-poller for codex tool` | codex 時に呼ばれないこと | 対象コード削除 |
| `manager-stop-pollers.test.ts` | `should NOT stop claude-poller for gemini tool` | gemini 時に呼ばれないこと | 対象コード削除 |
| `api-prompt-handling.test.ts` | `should resume polling after responding` | startPolling 呼び出し | ソースコード乖離（下記参照） |

### 3-2. テストカバレッジ喪失の評価

**削除されるカバレッジ**:
- `claude-poller.ts` の `stopPolling` が `session-cleanup.ts` から呼ばれること -- 対象コード自体が削除されるため不要
- `claude-poller.ts` の `stopPolling` が `manager.ts` から条件分岐で呼ばれること -- 対象コード自体が削除されるため不要
- `claude-poller.ts` の `startPolling` が prompt 応答後に呼ばれること -- **実際の route.ts では response-poller.startPolling を使用しており、このテストは既に陳腐化していた**

**残存テストでの検証**:
- `session-cleanup.ts`: response-poller の stopPolling 呼び出し、kill session フロー、auto-yes-poller 停止は引き続きテスト済み
- `manager.ts`: response-poller の stopPolling 呼び出し (`should stop response-poller for any CLI tool`) は残存
- API ルート: core の prompt handling フロー（respond, broadcast, sendKeys）は引き続きテスト済み

**結論**: テストカバレッジの喪失は許容範囲。削除されるテストケースは全て、削除されるコードの動作を検証するものか、既に陳腐化していたものである。

---

## 4. ドキュメント影響

### 4-1. 更新対象（設計方針書に記載済み）

| ドキュメント | 更新内容 | Phase |
|------------|---------|-------|
| `docs/architecture.md` L569 | `response-poller / claude-pollerを停止` -> `response-pollerを停止` | Phase 4 |

### 4-2. 更新不要の確認

| ドキュメント | 確認結果 |
|------------|---------|
| `README.md` | 削除対象への参照なし。更新不要 |
| `CLAUDE.md` | 削除対象への参照なし。更新不要 |
| `docs/user-guide/*.md` | 削除対象への参照なし。更新不要 |
| `docs/features/*.md` | 削除対象への参照なし。更新不要 |
| `docs/implementation-history.md` | 削除対象への参照なし。更新不要 |

### 4-3. スコープ外ドキュメント（SF-002 方針）

| ドキュメント | 残存参照 | 方針 |
|------------|---------|------|
| `docs/internal/PROMPT_HANDLING_IMPLEMENTATION_PLAN.md` | claude-poller: L456, L589, L1137 / WorktreeDetail: L870, L872, L875, L1149 | 別途 Issue 対応 |
| `dev-reports/design/` 配下の過去設計方針書 (~20ファイル) | 各 Issue の設計時点での claude-poller 参照 | 対応不要（履歴的設計記録） |

---

## 5. 後方互換性

### 5-1. 外部インターフェース影響

| インターフェース | 影響 |
|----------------|------|
| HTTP API エンドポイント | 影響なし。削除対象は内部モジュールのみ |
| WebSocket プロトコル | 影響なし |
| CLI コマンド | 影響なし |
| データベーススキーマ | 影響なし |
| npm パッケージ exports | 影響なし |

### 5-2. URL ルート影響

| ルート | 影響 | リスク |
|-------|------|-------|
| `/worktrees/[id]/simple-terminal` | 削除される | **低**: xterm.js ベースの Terminal (`/worktrees/[id]/terminal`) で完全代替済み。WorktreeDetail.tsx（このルートへのリンクを持つ唯一のコンポーネント）も同時削除される |

### 5-3. 内部リファクタリング評価

本 Issue は全て内部モジュールの削除であり、破壊的変更はない。

- `claude-poller.ts` のエクスポート関数（`startPolling`, `stopPolling`, `stopAllPolling`, `getActivePollers`）は外部から呼ばれていない（`session-cleanup.ts` と `manager.ts` の参照は内部参照）
- `terminal-websocket.ts` は完全なデッドコード
- `WorktreeDetail.tsx` は `WorktreeDetailRefactored.tsx` に完全置換済み
- `SimpleTerminal.tsx` と `simple-terminal/page.tsx` は xterm.js Terminal に完全代替済み

---

## 6. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | テスト修正時のモジュール解決エラー | Low | Low | P3 (Phase 1の段階的検証で対応) |
| 技術的リスク | 見落とされた参照による TypeScript コンパイルエラー | Low | Low | P3 (Phase 2後の `tsc --noEmit` で検出) |
| 運用リスク | simple-terminal ルートへのブックマーク/外部リンク切れ | Low | Low | P3 (Next.js は 404 を返す。外部リンクは想定されない) |
| セキュリティリスク | なし | - | - | - |

---

## 7. 改善提案

### 必須改善項目 (Must Fix): 0件

Stage 3 の影響分析では、設計方針書の記載内容に漏れや誤りは検出されなかった。

### 推奨改善項目 (Should Fix): 0件

### 検討事項 (Consider): 3件

| ID | カテゴリ | 内容 | 推奨対応 |
|----|---------|------|---------|
| CS-005 | 影響範囲 | `PROMPT_HANDLING_IMPLEMENTATION_PLAN.md` に WorktreeDetail.tsx 参照も残存（L870等） | SF-002 方針でカバー。別途 Issue で内部ドキュメント更新時にまとめて対応 |
| CS-006 | テスト影響 | `api-prompt-handling.test.ts` L239-268 の削除対象テストは既にソースコードと乖離 | 削除は正しい。response-poller.startPolling の検証が他テストに存在するか実装時に確認 |
| CS-007 | 影響範囲 | 過去 Issue 設計方針書（~20ファイル）に claude-poller 参照が残存 | 対応不要。履歴的設計記録は更新しない |

---

## 8. Stage 1-3 総合評価

| Stage | レビュー名 | ステータス | スコア | Must Fix | Should Fix | Consider |
|-------|-----------|----------|--------|----------|------------|----------|
| 1 | 設計原則レビュー | conditionally_approved | 4/5 | 1 (MF-001) | 2 (SF-001, SF-002) | 2 |
| 2 | 整合性レビュー | approved | 5/5 | 0 | 0 | 2 |
| 3 | 影響分析レビュー | approved | 5/5 | 0 | 0 | 3 |

**Stage 1 指摘事項の反映状況**:
- MF-001 (simple-terminal 参照元追記): 設計方針書セクション3-4に反映済み。本 Stage で実コード (L652, L678) との一致を確認
- SF-001 (manager.ts Future コメント削除): 設計方針書セクション4-2に反映済み。本 Stage で L179 コメント内容を確認
- SF-002 (内部ドキュメントスコープ外明記): 設計方針書セクション1に反映済み。本 Stage で追加の WorktreeDetail.tsx 参照も同方針でカバーされることを確認

---

## 9. 結論

設計方針書の影響範囲記載は**完全かつ正確**である。以下の点を確認した:

1. **ソースコード参照**: 全7箇所を正確に特定。動的import、require、文字列参照の見落としなし
2. **テスト参照**: 全6ファイルの修正内容を正確に特定。mock/import/テストケースの修正箇所に漏れなし
3. **ドキュメント参照**: `architecture.md` L569 の更新を正確に特定。内部ドキュメントの除外判断（SF-002）は適切
4. **ビルド設定**: tsconfig.json、next.config.js 等への影響なし（glob パターンベースのため）
5. **削除順序**: Phase 1-4 の依存関係は全て前方方向のみ。循環依存なし
6. **テストカバレッジ**: 削除されるカバレッジは全て削除対象コードに関するもの。許容範囲
7. **後方互換性**: 外部インターフェースへの影響なし。内部リファクタリングとして閉じている

**実装着手を承認する。**

---

*Generated by architecture-review-agent (Stage 3: Impact Analysis)*
*Reviewer model: claude-opus-4-6*
*Date: 2026-02-11*
