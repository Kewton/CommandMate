# Issue #747 マルチステージレビュー結果

## レビュー対象
- Issue番号: #747
- タイトル: feat(layout): move sidebar toggle (hamburger) from DesktopHeader to top of ActivityBar (PC)
- レビュー日時: 2026-06-01
- レビュー範囲: **1st Iteration（Stage 1-4）のみ**。2nd Iteration（Stage 5-8 / Codex委任）はユーザー方針によりスキップ。

## 仮説検証結果
Issue記載の対象ファイル・API・意図は概ね正確で実装可能。ただし以下の乖離を検出:
- 行番号参照が軽微にずれている（致命的でない）。
- `onMenuClick` は DesktopHeader で既に `{onMenuClick !== undefined && (...)}` ガード済み（「optional化」は実現済み）。
- **テスト前提が不正確**: `ActivityBar.test.tsx`・DesktopHeaderテストは存在せず「更新」ではなく新規作成。
- ActivityBar の `handleKeyDown`（ACTIVITIES.length / buttonRefs index ベース）と tablist ARIA整合への配慮が必要。

## 1st Iteration

### 通常レビュー（Stage 1）
- 指摘: must-fix 2 / should-fix 4 / consider 3 / good 4
- **M1 (must-fix)**: sidebar toggle を `role="tablist"` の外側に配置（buttonRefs/role="tab" に含めない）。Arrow ナビ index 干渉・ARIA整合を保護。
- **M2 (must-fix)**: テスト参照を「新規作成」に修正（既存ファイルなし）。
- should-fix: 行番号は目安と注記 / onMenuClick は既に optional-guard 済み → タスクを dead-code 削除に再定義 / SVG path `M9 12h15` はそのままCOPY / 削除手順の具体化。

### 指摘反映（Stage 2）
- 9件（must-fix 2 / should-fix 4 / consider 3）をIssue本文に反映。`gh issue edit 747` で更新済み。

### 影響範囲レビュー（Stage 3）
- 指摘: must-fix 0 / should-fix 3 / consider 4 / good 3
- 確認: ActivityBar / DesktopHeader はそれぞれ単一呼び出し元（PC版のみ）。`onMenuClick` consumer は2箇所のみ → prop削除安全。モバイルは別経路で波及なし。
- ⚠️ **I1 はハルシネーション**: `tests/e2e/activity-bar.spec.ts` が存在し e2e が壊れる、との指摘 → メインエージェント検証で**当該ファイル・tablist参照e2eは存在しないことを確認**。却下。

### 指摘反映（Stage 4）
- 有効な4件（SidebarContext再render注記 / separator aria-hidden / w-12カラムレイアウト確認 / focus order）を反映。
- **I1（e2eハルシネーション）を却下**。e2e更新の記述はIssueに追加しない。

## 最終結果
- 総指摘事項: 通常6（must/should）+ 影響範囲3（should）= 反映ベース
- 却下: 1件（I1 e2eハルシネーション、メイン検証で棄却）
- Issue更新回数: 2回（Stage2, Stage4）

## 結論
Issue #747 は**構造的に正確で実装可能**な品質に到達。must-fix（tablist外配置・テスト新規作成）と should-fix（dead-code削除方針・行番号注記）を反映済み。
影響範囲は PC版に限定され blast radius は小さい（単一呼び出し元、モバイル波及なし）。
次ステップ: 設計フェーズ（Phase 2/3）はユーザー方針によりスキップ → Phase 4 作業計画へ。
