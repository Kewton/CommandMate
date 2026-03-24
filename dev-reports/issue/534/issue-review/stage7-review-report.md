# Issue #534 レビューレポート - Stage 7

**レビュー日**: 2026-03-24
**フォーカス**: 影響範囲レビュー
**イテレーション**: 2回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 1 |
| Nice to Have | 1 |

## 前回レビュー（Stage 3）指摘の反映確認

Stage 3で指摘した全7件（Must Fix 2件、Should Fix 3件、Nice to Have 2件）は全て正しくIssue本文に反映されていることを確認した。

| ID | 分類 | 指摘内容 | ステータス |
|----|------|---------|-----------|
| MF-1 | 影響ファイル | server.tsの初期化・シャットダウン統合 | 反映済み |
| MF-2 | 影響ファイル | resource-cleanup.tsの孤立エントリ検出 | 反映済み |
| SF-1 | テスト範囲 | テスト対象の具体的なファイル・シナリオ | 反映済み |
| SF-2 | 依存関係 | メッセージ送信方式の明確化 | 反映済み |
| SF-3 | ドキュメント | CLAUDE.md・module-reference.mdの更新 | 反映済み |
| NTH-1 | 破壊的変更 | SubTab型拡張の型安全性 | 反映済み |
| NTH-2 | 移行考慮 | DBマイグレーションv23のロールバック | 反映済み |

## Stage 5-6（通常レビュー2回目）で追加された内容の影響分析

Stage 5で指摘されStage 6で反映された5件の変更について、影響範囲への波及を確認した。

| ID | 変更内容 | 新たな影響ファイル |
|----|---------|------------------|
| S5-MF-1 | 時間上限値を8h45m/31500000msに統一 | なし（timer-constants.ts内部） |
| S5-SF-1 | タイマー発火時エラーハンドリング追加 | なし（timer-manager.ts内部） |
| S5-SF-2 | UIタブ表記をi18nラベルに合わせて修正 | なし（既にlocales/*.jsonが影響範囲に含まれている） |
| S5-NTH-1 | カウントダウン表示の実装方針追記 | なし（TimerPane.tsx内部） |
| S5-NTH-2 | DELETE APIのクエリパラメータ方式明記 | なし（追加ルートファイル不要） |

Stage 5-6の変更は全て既存の影響範囲内に収まっており、新たな影響ファイルの追加は不要。

---

## Must Fix（必須対応）

### MF-1: テスト対象ファイルのパスが実際のファイル構造と一致しない

**カテゴリ**: テスト範囲
**場所**: ## テスト対象ファイル、## 実装タスク > ユニットテスト

**問題**:
Issueに記載されているテストファイルパスが、実際のリポジトリのファイル構造と一致しない。

- Issue記載: `tests/unit/lib/session-cleanup.test.ts`
- 実際のパス: `tests/unit/session-cleanup.test.ts`（Issue #69, #526用）および `tests/unit/session-cleanup-issue404.test.ts`（Issue #404, #525用）
- Issue記載: `tests/unit/lib/resource-cleanup.test.ts`
- 実際のパス: `tests/unit/resource-cleanup.test.ts`

**証拠**:
- `tests/unit/session-cleanup.test.ts` -- cleanupWorktreeSessions, killWorktreeSession, syncWorktreesAndCleanupのテスト
- `tests/unit/session-cleanup-issue404.test.ts` -- 呼び出し順序テスト（L35-63）、pollersStopped配列テスト（L73-87）
- `tests/unit/resource-cleanup.test.ts` -- cleanupOrphanedMapEntries()のテスト

**推奨対応**:
テスト対象ファイルのパスを実際の配置に合わせて修正。特にsession-cleanup関連は2つのテストファイルが存在することを明記する。

---

## Should Fix（推奨対応）

### SF-1: session-cleanup-issue404.test.tsへの影響が未記載

**カテゴリ**: 影響ファイル
**場所**: ## テスト対象ファイル

**問題**:
`tests/unit/session-cleanup-issue404.test.ts` がテスト対象ファイルに含まれていない。このファイルはcleanupWorktreeSessionsの呼び出し順序を厳密にテストしており、timer-managerのステップ追加で以下の変更が必要になる。

**証拠**:
- L21-24: `vi.mock('@/lib/schedule-manager')` -- timer-manager用のvi.mockも追加が必要
- L35-63: callOrder配列で `stopAutoYesPollingByWorktree -> deleteAutoYesStateByWorktree -> stopScheduleForWorktree` の順序を検証 -- stopTimersForWorktreeの位置を追加する必要がある
- L73-87: `pollersStopped` 配列に `schedule-manager` が含まれることをテスト -- `timer-manager` エントリの追加テストが必要

**推奨対応**:
テスト対象ファイルに `tests/unit/session-cleanup-issue404.test.ts（既存追加）` を追加し、変更内容として「timer-manager用のvi.mock追加、呼び出し順序テストへのstopTimersForWorktree追加、pollersStopped配列テストへのtimer-managerエントリ追加」を明記する。

---

## Nice to Have（あれば良い）

### NTH-1: timer-managerからのメッセージ送信に使う関数の明確化

**カテゴリ**: 依存関係
**場所**: ## 実装タスク > timer-manager.ts

**問題**:
Issue本文では「session-key-sender.tsまたはtmux.ts経由で直接呼び出す」と記載されているが、session-key-sender.tsのエクスポート関数はClaude CLI固有のロジック（CLAUDE_PROMPT_PATTERN、pasted text検知）を含んでおり、マルチエージェント対応のタイマー送信には不向きな可能性がある。

**証拠**:
- `session-key-sender.ts` L19-22: CLAUDE_PROMPT_PATTERNやdetectAndResendIfPastedTextなどClaude固有のimport
- timer-managerが必要とするのはcli_tool_idに基づくtmuxセッションへのsendKeys + Enterのみ
- job-executor.tsはclaude-executor.ts経由でexecFileを使用しており（非インタラクティブ実行）、tmux sendKeysとは異なるアプローチ

**推奨対応**:
「tmux.tsのsendKeys()を直接使用する」に一本化するか、session-key-sender.tsを使う場合はどの関数を利用するかを具体的に記載しておくと、実装時の設計判断がスムーズになる。

---

## 全体評価

### 影響範囲の網羅性

Stage 3の1回目影響範囲レビューで指摘した重大な漏れ（server.ts、resource-cleanup.ts）は全てIssue本文に反映されている。Stage 5-6で追加された通常レビューの修正内容（時間上限値の統一、エラーハンドリング方針、i18nラベル整合性）は全て既存の影響範囲内に収まっており、新たな影響ファイルの追加は不要。

今回の指摘はテストファイルのパス正確性と、session-cleanup関連テストが2ファイルに分かれている点の考慮漏れに集中している。これらは実装の正確性に直接影響するため、MF-1はMust Fixとして対応を推奨する。

### 影響範囲の最終集計

| 区分 | ファイル数 |
|------|-----------|
| 新規ファイル（本体） | 5 |
| 変更ファイル（本体） | 8 |
| 新規テストファイル | 3 |
| 変更テストファイル | 3（session-cleanup.test.ts, session-cleanup-issue404.test.ts, resource-cleanup.test.ts） |
| ドキュメント更新 | 2 |
| i18n更新 | 2 |

### リスク評価

**全体リスク**: Medium
- 破壊的変更なし
- 主な技術リスクはtimer-manager.tsのglobalThisパターン + setTimeout管理 + DB復元の複合性（既にStage 3で分析済み）
- 既存テストへの影響は3ファイルに限定されており、変更パターンは既存のmock追加/配列チェック追加と同質

---

## 参照ファイル

### テスト
- `tests/unit/session-cleanup-issue404.test.ts`: 呼び出し順序テスト・pollersStopped配列テスト（timer-manager追加で直接影響）
- `tests/unit/session-cleanup.test.ts`: cleanupWorktreeSessionsのテスト（vi.mock追加が必要）
- `tests/unit/resource-cleanup.test.ts`: cleanupOrphanedMapEntries()のテスト（vi.mock追加・CleanupMapResult型対応が必要）

### コード
- `src/lib/session-key-sender.ts`: timer-managerのメッセージ送信候補（Claude固有ロジックを含む点に注意）
- `src/lib/tmux/tmux.ts`: sendKeys()がtimer-managerの送信に最もシンプルな依存パス
