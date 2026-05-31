# 進捗レポート - Issue #743 (Iteration 1)

## 概要

| 項目 | 内容 |
|------|------|
| **Issue** | #743 - fix(terminal): missing AI agent status indicator in PC per-split header (#728 follow-up) |
| **Iteration** | 1 |
| **ブランチ** | `feature/743-worktree` |
| **報告日時** | 2026-05-31 |
| **総合ステータス** | 成功（実装・受入・ドキュメント完了。PR作成待ち） |

### 対応サマリー

PC ターミナルの per-split header に AI エージェントの status indicator（idle/ready/waiting=色付きドット、running/generating=青スピナー）を復活させた。Issue #728（per-split 化）の follow-up であり、#740（per-split Auto-Yes）と同型の「親 derive → 子 propagate」パターンを踏襲。

- 親 `WorktreeDetailRefactored.renderSplitPane` で `deriveCliStatus(worktree?.sessionStatusByCli?.[paneCli])` を算出し、導出済みの `BranchStatus` 文字列のみを `cliStatus` prop として `React.memo` 化済みの子へ渡す（S3-001 memo-safe）。
- 子 `TerminalSplitPaneContent` が `SIDEBAR_STATUS_CONFIG` 準拠の indicator を `headerExtras` 経由で `TerminalSplitPane` のヘッダーに配線。Mobile 正準の inline span（`title` のみ）を再利用。
- 新 prop `cliStatus?` は optional（未指定時 `'idle'` フォールバック）で既存呼び出し元・テストを無改修温存（S3-002）。
- Mobile 経路（`WorktreeDetailRefactored.tsx:1947-1974`）は不変更。コミット 9f2f227f は `renderSplitPane` 内の +11 行のみの additive 変更。

---

## フェーズ別結果

| Phase | フェーズ | ステータス | 結果 / 備考 |
|-------|---------|-----------|-------------|
| 0.5 + 1-4 | Issue レビュー（マルチステージ） | 成功 | 仮説検証12件（Confirmed 4 / Rejected 7 / 注記1）。Must 6 / Should 7 / Nice 3 を全件反映。Codex Stage 5-8 はユーザー方針でスキップ |
| 2 | 設計方針（design-policy） | スキップ | ユーザー方針により Phase 2 スキップ |
| 3 | 設計レビュー（design-review） | スキップ | ユーザー方針により Phase 3 スキップ |
| 4 | 作業計画（work-plan） | 成功 | 6タスクに分解 |
| 5 | TDD 実装 | 成功 | テスト7件追加、RED→GREEN→REFACTOR 完了。全品質ゲート PASS |
| 6 | 受入テスト | 成功 | 受入条件 10/10 PASS、failed 0 |
| 7 | リファクタリング | 変更不要 | additive +11行・#740パターン踏襲のためコードスメルなし |
| 8 | ドキュメント更新 | 成功 | CHANGELOG.md / CLAUDE.md 更新 |
| 9 | UAT（実機受入） | スキップ | PC専用UI修正・ユニット+build+静的解析で網羅検証済みのためユーザー選択でスキップ（#740同様） |

### Phase 0.5 + 1-4: Issue レビュー（成功）

根本原因の診断（H1/H2/H3）は100%正確だった一方、当初の「対応方針」コードサンプルに **6件の参照誤り** が含まれており、Stage 1-4 で正準パターンへ全面修正した。

| # | 誤った前提 | 正準（修正後） |
|---|-----------|---------------|
| H4 | `deriveCliStatus` = `@/lib/sidebar-utils` | `@/types/sidebar` |
| H5 | `SIDEBAR_STATUS_CONFIG` = `@/config/status-config` | `@/config/status-colors`（status-config.ts は存在しない） |
| H6 | `statusConfig.colorClass` | `statusConfig.className` |
| H7 | `cliStatus === 'processing'` でspinner判定 | `'processing'` は無い。`statusConfig.type === 'spinner'` |
| H8 | `useWorktreeStatusByCli` hook 使用 | 存在しない。親 propagate 方式 |
| H9 | `<Spinner/>` component 使用 | 存在しない。inline span |

### Phase 5: TDD 実装（成功）

- **追加テスト**: 7件（状態別描画 it.each 5ケース / 未指定idleフォールバック / per-split独立 A=running spinner・B=idle dot）
- **対象ファイルテスト**: 16/16 passed
- **フルスイート**: 358 files / 6710 passed / 7 skipped / 0 failed
- **RED→GREEN→REFACTOR**: RED で indicator 未描画により7件失敗 → `SIDEBAR_STATUS_CONFIG` import・`cliStatus` prop・`statusIndicator` useMemo 追加で GREEN → 構造的リファクタ不要（headerExtras スロット再利用）

**変更ファイル**:
- `src/components/worktree/TerminalSplitPaneContent.tsx` (+36)
- `src/components/worktree/WorktreeDetailRefactored.tsx` (+11)
- `tests/unit/components/worktree/TerminalSplitPaneContent.test.tsx` (+109)

### Phase 6: 受入テスト（成功 10/10）

全10件の受入条件をコードレビューで PASS と判定。詳細は下記「受入条件の充足状況」を参照。

### Phase 7: リファクタリング（変更不要）

保守的レビューの観点4件すべてで変更不要と判定。useMemo deps の正確性、Mobile 正準 span のミラーリング（重複は意図的）、未使用コードなし、JSDoc/保守コメントの適切性をいずれも確認。

### Phase 8: ドキュメント更新（成功）

- `CHANGELOG.md`: +1行
- `CLAUDE.md`: モジュールリファレンスへ #743 反映（4行変更）

---

## 変更ファイル一覧（2コミット）

### コミット 1: `9f2f227f` — 実装 + テスト
```
fix(terminal): restore AI agent status indicator in PC per-split header
 src/components/worktree/TerminalSplitPaneContent.tsx          |  36 +++++++
 src/components/worktree/WorktreeDetailRefactored.tsx          |  11 +++
 tests/unit/components/worktree/TerminalSplitPaneContent.test.tsx | 109 +++++
 3 files changed, 156 insertions(+)
```

### コミット 2: `6fdacdf3` — ドキュメント
```
docs: update CHANGELOG.md / CLAUDE.md for PC per-split status indicator (#743)
 CHANGELOG.md | 1 +
 CLAUDE.md    | 4 ++--
 2 files changed, 3 insertions(+), 2 deletions(-)
```

---

## 総合品質メトリクス

| 品質ゲート | 結果 |
|-----------|------|
| `npx tsc --noEmit` | PASS（exit 0） |
| `npm run lint` | PASS（No ESLint warnings or errors） |
| `npm run test:unit` | PASS（358 files / 6710 passed / 7 skipped / 0 failed） |
| `npm run build` | PASS（Compiled successfully） |
| 受入条件 | 10/10 PASS（failed 0） |
| 回帰テスト追加 | 3系統（状態別描画 / 未指定フォールバック / per-split独立） |

> 注: ユニット出力中の console.error は他スイート（SidebarContext/WorktreesCacheProvider）の意図的な負経路ログであり失敗ではない。build の ERROR 行は #743 と無関係な既存の Next.js dynamic-route 静的解析ログ。

---

## 受入条件の充足状況（10/10 PASS）

| # | 受入条件 | 判定 |
|---|---------|------|
| 1 | PC版で各 split header に status indicator が表示される（headerExtras 経由の配線） | PASS |
| 2 | 状態→色/形マッピングが実 SIDEBAR_STATUS_CONFIG 準拠（idle→グレーdot / ready→緑dot / waiting→黄dot / running・generating→青スピナー）。'processing' 不使用 | PASS |
| 3 | スプリットA=running→青スピナー / B=idle→グレーdot が独立表示（per-split data-testid） | PASS |
| 4 | worktree切替・CLI切替後も対応する status が反映される | PASS |
| 5 | ポーリング更新で indicator 自動更新、かつ status 不変周期では split 再renderされない（memo-safe / S3-001） | PASS |
| 6 | 新 prop cliStatus は optional、未指定時 'idle' フォールバック（既存呼び出し元/テスト無改修 / S3-002） | PASS |
| 7 | a11y 属性は Mobile 正準に合わせ title のみ（aria-label 二重読み上げ回避 / S3-006） | PASS |
| 8 | モバイル版の status indicator 挙動は変更なし（L1947-1974 不変更） | PASS |
| 9 | lint / tsc / test:unit / build 全PASS | PASS |
| 10 | 回帰テスト追加（状態別描画 / 未指定フォールバック / per-split独立 の3系統） | PASS |

---

## ブロッカー

**なし。**

全フェーズが成功（または妥当な理由でスキップ）し、全品質ゲートと全受入条件をクリアしている。

---

## 次のアクション

1. **PR作成** — `/create-pr` で `feature/743-worktree` → `develop` 向けの PR を作成
   - PRタイトル例: `fix(terminal): restore AI agent status indicator in PC per-split header (#743)`
   - ラベル: `bug`（#728 follow-up の修正）
   - 本文に受入条件 10/10 PASS・品質ゲート全PASS・Mobile非影響（additive +11行）を明記
2. **レビュー依頼** — 1名以上の承認を取得
3. **CI/CD 確認** — 全チェックパスを確認の上マージ

---

## 備考

- 設計方針（Phase 2）・設計レビュー（Phase 3）・UAT（Phase 9）・Codex 委任（Issue review Stage 5-8）はいずれもユーザー方針／選択により意図的にスキップ。本修正は #740 と同型の additive な PC専用UI修正であり、ユニット・build・静的解析で網羅検証済み。
- リファクタリングは「変更不要」判定のため独立コミットなし（実装は 9f2f227f に内包）。

**Issue #743 の実装・受入・ドキュメント更新が完了しました。PR作成フェーズへ進めます。**
