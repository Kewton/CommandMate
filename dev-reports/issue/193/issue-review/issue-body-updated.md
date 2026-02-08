> **Note**: このIssueは 2026-02-08 にレビュー結果を反映して更新されました。
> 詳細: dev-reports/issue/193/issue-review/

## 概要

Codex CLIからの複数選択肢メッセージ（1~4の選択肢）に対し、CommandMateのUIから回答を送信できない。Auto-Yesモードでもタスクが進まない。

## 再現手順

1. CommandMateでCodex CLIセッションを開始
2. コーディングタスクを実行中、Codex CLIが複数選択肢を表示（例: 1~4の番号付き選択肢）
3. UIの入力欄に選択肢番号（例: `1`）を入力して送信ボタンを押す
4. エラーメッセージが表示され、回答が送信されない
5. Auto-Yesモードを有効にしても、選択肢で停止したまま進まない

## 期待する動作

- UIから選択肢番号を入力して送信すると、Codex CLIに回答が反映されタスクが継続する
- Auto-Yesモードが有効な場合、Codex CLIの選択肢にも自動応答してタスクが進む

## 実際の動作

- UIから送信しようとすると「プロンプトがアクティブでない」旨のエラーが表示される
- Auto-Yesモードでも選択肢を検出できず、タスクが停止したままになる

## スクリーンショット

1から4までの選択肢から該当のモノを選択して送信することを求められているが、commandmateから操作出来ない。

![Screenshot_20260208-092742.png](https://github.com/user-attachments/assets/d0088572-0759-4a6c-aa93-11c60f845150)

## 根本原因の仮説

`prompt-detector.ts`の`detectMultipleChoicePrompt()`がClaude CLI固有の`❯`（U+276F）マーカーのみに対応しており、Codex CLIの選択肢形式を検出できない。

### 処理フロー

```
Codex CLI: 選択肢を表示（Codex固有の形式）
  ↓
prompt-detector.ts: detectMultipleChoicePrompt()
  ├─ Pass 1: ❯ (U+276F) を検索 → マッチなし（Codex形式が異なる）
  └─ return { isPrompt: false }
  ↓
prompt-response/route.ts: 「プロンプトがアクティブでない」と判定
  ↓
UI: エラーメッセージ表示 / Auto-Yes: 検出スキップ
```

### 具体的な問題箇所

1. **`src/lib/prompt-detector.ts`**: `detectMultipleChoicePrompt()`内の2パス❯検出方式（Issue #161）がClaude CLI専用の`❯`(U+276F)マーカーに依存
2. **`src/lib/cli-patterns.ts`**: Codex固有の選択肢パターンが未定義
3. **`src/app/api/worktrees/[id]/prompt-response/route.ts`**: `detectPrompt()`がCodex形式を認識できず、送信を拒否
4. **`detectPrompt()`の全呼び出し箇所**: `detectPrompt()`はcliToolIdを引数として受け取らず、全11箇所の呼び出しがCLIツール種別を考慮していない。Codexセッション時にも呼び出されるため、シグネチャ変更時は全箇所の修正が必要

## 対策案

### 前提条件: Codex CLI選択肢の出力形式確認（実装前に必須）

**重要**: Codex CLIはTUI（ターミナルユーザーインターフェース）ベースのインタラクティブツールであり、`codex.ts`の`startSession()`ではDown arrow keyとEnterを送信してモデル選択ダイアログを操作している（L91-96）。これはCodex CLIが**TUI描画による選択肢UI**を使用していることを示唆する。

実装前に以下を確認し、結果をこのIssueにコメントとして記録する:

1. **tmuxバッファのcapture-pane出力に選択肢テキストが含まれるか**
   - `tmux capture-pane -p` でCodex CLIの選択肢表示時のバッファを取得
   - `stripAnsi()`後のテキストに番号付きリストが残るか確認
2. **選択肢はテキストベース（番号入力）かTUIベース（矢印キー選択）か**
   - テキストベース: 番号を入力してEnterで選択 -> パターンマッチアプローチが有効
   - TUIベース: ハイライト/カーソルで選択してEnterで確定 -> 矢印キー操作（`send-keys`）が必要
3. **Codex CLIがデフォルト選択をどう表示するか**
   - `❯`のようなマーカーがあるか
   - ハイライト表示のみか
   - デフォルト選択の概念自体がないか
4. **TUIベースの場合の代替アプローチの検討**
   - テキストパターンマッチが機能しない場合、`tmux send-keys`による矢印キー操作が必要
   - この確認結果によって設計方針が大きく変わるため、**設計フェーズの前提条件**として扱う

### Codex選択肢パターン対応

1. **Codex選択肢形式の確認**
   - Codex CLIの実際の選択肢出力形式をtmuxバッファから取得・確認
   - 選択肢マーカー、行フォーマット、デフォルト選択表示方法を特定

2. **`src/lib/cli-patterns.ts`にCodex選択肢パターンを追加**
   - Codex固有の選択肢マーカーパターンを定義
   - 例: `CODEX_CHOICE_INDICATOR_PATTERN`

3. **`src/lib/prompt-detector.ts`のCodex形式対応**
   - `detectMultipleChoicePrompt()`をCodex形式にも対応させる
   - 以下の設計方針候補から選択する（実機確認後に決定）:
     - **案A**: `detectPrompt(output, cliToolId?)`でCLIツール別パターン分岐 - prompt-detector.tsのCLIツール非依存性を破る
     - **案B**: パターンのパラメータ化（`detectMultipleChoicePrompt(output, patterns)`） - 非依存性を維持しつつ拡張可能
     - **案C**: CLIツール別のdetectPromptラッパー関数を追加 - 既存関数を変更せず拡張
   - **Note**: Issue #161で確立された「prompt-detector.tsのCLIツール非依存性」との整合性を考慮すること

4. **テスト追加**
   - Codex選択肢出力例でのプロンプト検出テスト
   - Auto-Yes動作確認テスト

## 実装タスク

- [ ] **【前提】** Codex CLIの選択肢出力形式を実機確認（tmuxバッファ取得）- テキストベースかTUIベースかを特定し、結果をIssueにコメント
- [ ] `src/lib/cli-patterns.ts`: Codex選択肢パターン定義追加
- [ ] `src/lib/prompt-detector.ts`: `detectMultipleChoicePrompt()`をCodex形式対応
- [ ] `src/app/api/worktrees/[id]/prompt-response/route.ts`: `detectPrompt()`にcliToolIdを渡す修正（L50でcliToolIdを取得済みだがL75のdetectPromptに未渡し）
- [ ] `src/lib/auto-yes-manager.ts`: `pollAutoYes()`内の`detectPrompt()`にcliToolIdを渡す修正（L262でcliToolIdを引数として受け取っているがL290のdetectPromptに未渡し）
- [ ] `src/lib/response-poller.ts`: `detectPrompt()`呼び出し箇所（L248, L442, L556）のcliToolId対応
- [ ] `src/lib/status-detector.ts`: `detectPrompt()`呼び出し（L87）のcliToolId対応
- [ ] `src/app/api/worktrees/[id]/current-output/route.ts`: `detectPrompt()`呼び出し（L88）のcliToolId対応
- [ ] `tests/unit/prompt-detector.test.ts`: Codex選択肢検出テスト追加
- [ ] `tests/unit/lib/cli-patterns.test.ts`: Codex選択肢パターンテスト追加
- [ ] 動作検証: UI手動送信、Auto-Yesモードの両方で確認

## 受入条件

- [ ] Codex CLIの複数選択肢にUIから番号を入力して回答を送信できること
- [ ] Auto-YesモードでCodex CLIの選択肢に自動応答されること
  - デフォルト選択が検出できる場合はデフォルトを選択
  - デフォルト選択がない場合は最初の選択肢を選択（現行ロジック維持）
  - Codex固有の選択肢パターンに対してカスタムルールが必要な場合は別途検討
- [ ] Claude CLIの既存の選択肢検出・応答機能に影響がないこと
- [ ] Codex CLI選択肢表示時のサイドバーステータスが正しく'waiting'（黄色）になること
- [ ] ユニットテストが追加されていること（Codex選択肢検出テスト）
- [ ] 既存テストがすべてパスすること

## 影響範囲

### 変更対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/lib/cli-patterns.ts` | Codex選択肢パターン定義追加 |
| `src/lib/prompt-detector.ts` | `detectMultipleChoicePrompt()`のCodex形式対応 |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | `detectPrompt()`にcliToolIdを渡す修正（L50で取得済みのcliToolIdをL75に渡す） |
| `src/lib/auto-yes-manager.ts` | `pollAutoYes()`内の`detectPrompt()`にcliToolIdを渡す修正 |
| `src/lib/response-poller.ts` | `detectPrompt()`呼び出し箇所（L248, L442, L556）のcliToolId対応 |
| `src/lib/status-detector.ts` | `detectPrompt()`呼び出し（L87）のcliToolId対応 |
| `src/app/api/worktrees/[id]/current-output/route.ts` | `detectPrompt()`呼び出し（L88）のcliToolId対応 |
| `tests/unit/prompt-detector.test.ts` | Codex選択肢検出テスト追加 |
| `tests/unit/lib/cli-patterns.test.ts` | Codex選択肢パターンテスト追加 |

**Note**: `detectPrompt()`のシグネチャを変更する場合（`cliToolId?: CLIToolType`パラメータ追加）、後方互換性を保つためデフォルト値`'claude'`を設定し、段階的に全呼び出し箇所を移行する。

### 関連コンポーネント（動作確認）

- `src/lib/auto-yes-resolver.ts` - 自動応答判定のCodex動作確認（デフォルト選択方針の検証）
- `src/lib/cli-tools/codex.ts` - Codex CLIセッション管理（TUI描画方式の確認）
- `src/lib/claude-poller.ts` - `detectPrompt()`呼び出し（L164, L232）のCodex影響確認

### 関連Issue

- Issue #4: CLIツールサポート（Codex CLI追加）
- Issue #161: Auto-Yes誤検出修正（2パス❯検出方式、prompt-detector.tsのCLIツール非依存性）
- Issue #138: サーバー側Auto-Yesポーリング
