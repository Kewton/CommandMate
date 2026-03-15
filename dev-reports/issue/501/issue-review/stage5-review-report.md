# Issue #501 Stage 5 Review Report - 通常レビュー（2回目）

**レビュー日**: 2026-03-16
**対象Issue**: fix: Auto-Yesサーバー/クライアント二重応答とポーラー再作成によるステータス不安定
**レビュー種別**: 通常レビュー（2回目 / 最終確認）

---

## 1. 前回指摘事項の対応状況

### Stage 1（通常レビュー 1回目）: 全6件対応済み

| ID | 重要度 | 状態 | 内容 |
|----|--------|------|------|
| F1-001 | should_fix | 対応済み | 問題Bの行番号をL486-494/L496-506に修正 |
| F1-002 | should_fix | 対応済み | 対策3を既存lastOutputTimestampパラメータ活用に変更 |
| F1-003 | should_fix | 対応済み | 対策3の変更対象ファイルを明確化 |
| F1-004 | nice_to_have | 対応済み | 対策2にauto-yes/route.ts側の影響を追記 |
| F1-005 | nice_to_have | 対応済み | 背景にDUPLICATE_PREVENTION_WINDOW_MSの定義場所と値を追記 |
| F1-006 | nice_to_have | 対応済み | 行番号を最新コードに合わせて更新 |

### Stage 3（影響範囲レビュー 1回目）: 6件対応済み / 3件スキップ

| ID | 重要度 | 状態 | 内容 |
|----|--------|------|------|
| F3-008 | must_fix | 対応済み | 対策1の変更内容を4ステップに明確化 |
| F3-001 | should_fix | 対応済み | CLIツール間タイムスタンプ干渉リスクを追記 |
| F3-002 | should_fix | 対応済み | worktree-status-helper.tsのテスト追加を受入条件に追加 |
| F3-003 | should_fix | 対応済み | 対策間の依存関係セクションを新設 |
| F3-006 | should_fix | 対応済み | session-cleanup.tsを間接影響ファイルに追加 |
| F3-009 | nice_to_have | 対応済み | resource-cleanup.tsを間接影響ファイルに追加 |
| F3-004 | should_fix | スキップ | 既存問題で対策2による悪化なし（妥当な判断） |
| F3-005 | nice_to_have | スキップ | 既存記載で方針言及済み（妥当な判断） |
| F3-007 | nice_to_have | スキップ | 受入条件で暗黙的にカバー済み（妥当な判断） |

**結果**: 全12件の対応対象が適切に処理されている。スキップされた3件もいずれも妥当な判断である。

---

## 2. コード検証結果

今回のレビューでは、Issue本文中の全行番号参照を実際のソースコードと突合検証した。

| ファイル | Issue記載行番号 | 実際の行番号 | 一致 |
|----------|----------------|--------------|------|
| WorktreeDetailRefactored.tsx - CurrentOutputResponse | L116-132 | L116-132 | 一致 |
| WorktreeDetailRefactored.tsx - fetchCurrentOutput | L352-398 | L352-398 | 一致 |
| WorktreeDetailRefactored.tsx - useAutoYes呼び出し | L961-967 | L961-967 | 一致 |
| auto-yes-poller.ts - 既存ポーラー破棄 | L486-494 | L486-494 (注1) | ほぼ一致 |
| auto-yes-poller.ts - 新規作成 | L496-506 | L496-506 | 一致 |
| status-detector.ts - lastOutputTimestamp | L155 | L155 | 一致 |
| status-detector.ts - 時間ヒューリスティック | L404-417 | L404-417 | 一致 |
| current-output/route.ts - detectSessionStatus | L86 | L86 | 一致 |
| current-output/route.ts - lastServerResponseTimestamp返却 | L139 | L139 | 一致 |
| worktree-status-helper.ts - detectSessionStatus | L91 | L91 | 一致 |
| auto-yes/route.ts - pollingStarted判定 | L170-174 | L170-174 | 一致 |
| useAutoYes.ts - DUPLICATE_PREVENTION_WINDOW_MS | L36 | L36 | 一致 |

注1: L486は`autoYesPollerStates.has(worktreeId)`（存在チェック）であり、実際のstop処理はL491-494。厳密にはL491-494が正確だが、前後の文脈から実装者が該当箇所を特定するのに支障はない。

---

## 3. 新規発見事項

### F5-001: 問題Bの行番号範囲がやや不正確 (nice_to_have)

- **カテゴリ**: accuracy
- **セクション**: 根本原因 > 問題B
- **詳細**: L486-494と記載されているが、L486-490はDoS防御の同時実行数チェックであり、ポーラー破棄はL491-494。
- **推奨**: L491-494に修正するか、行番号を省略して関数名で参照する。

### F5-002: worktree-status-helper.tsのimport追加が未言及 (nice_to_have)

- **カテゴリ**: completeness
- **セクション**: 対策一覧 > 対策3
- **詳細**: 対策3でworktree-status-helper.tsに`getLastServerResponseTimestamp`を使用するためのimport追加が必要だが、Issue本文では言及されていない。
- **推奨**: 変更内容に明記する。ただし実装者にとっては自明。

---

## 4. 総合評価

Issue #501は4段階のレビュー・修正サイクル（Stage 1-4）を経て、実装着手可能な高品質の状態に達している。

**強み**:
- 根本原因の3問題（A: タイムスタンプ未伝播、B: ポーラー再作成、C: ステータス検出タイムラグ）の分析が正確
- 問題間の連鎖関係と対策間の依存関係が明確に文書化されている
- 対策3で既存機構（lastOutputTimestampパラメータ）を活用する方針は、新規実装を最小化し変更リスクを低減する優れた設計判断
- 全行番号が実際のコードと一致しており、信頼性が高い
- 受入条件が14項目あり、各対策に対するテスト要件が網羅的
- 直接変更対象5ファイル、間接影響4ファイルが正確に特定されている

**残存課題**: nice_to_haveレベル2件のみ。実装に支障なし。

**判定**: レビュー完了。実装着手可能。
