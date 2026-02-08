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
4. **`detectPrompt()`の外部呼び出し箇所（計9箇所）**: `detectPrompt()`はcliToolIdを引数として受け取らず、以下の全呼び出し箇所がCLIツール種別を考慮していない:
   1. `auto-yes-manager.ts` L290
   2. `status-detector.ts` L87
   3. `prompt-response/route.ts` L75
   4. `current-output/route.ts` L88
   5. `response-poller.ts` L248 **[Claude専用ガード内 - 変更不要]**
   6. `response-poller.ts` L442 **[全CLIツール共通]**
   7. `response-poller.ts` L556 **[全CLIツール共通]**
   8. `claude-poller.ts` L164 **[Claude専用ポーラー]**
   9. `claude-poller.ts` L232 **[Claude専用ポーラー]**

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
   - **確認ポイント**: `auto-yes-resolver.ts`の`resolveAutoAnswer()`は`promptData.options.find(o => o.isDefault)`でデフォルト選択肢を探し、見つからない場合は最初の選択肢を選択する。Codexにデフォルトマーカーがない場合、`isDefault`が常にfalseとなり常に最初の選択肢が選ばれる動作が許容可能か確認すること。
4. **TUIベースの場合の代替アプローチの検討**
   - テキストパターンマッチが機能しない場合、`tmux send-keys`による矢印キー操作が必要
   - この確認結果によって設計方針が大きく変わるため、**設計フェーズの前提条件**として扱う

### TUIベースの場合の影響範囲（代替設計パス）

**前提条件確認でTUIベースと判明した場合**、影響範囲がパターンマッチアプローチとは大きく異なる。事前に代替パスの影響範囲を文書化しておく:

1. **変更が集中するモジュール**:
   - `prompt-response/route.ts`: sendKeysロジックの変更（番号送信 -> 矢印キー+Enterの操作シーケンス）
   - `auto-yes-manager.ts`: sendKeys呼び出しの変更（番号 -> 矢印キー回数への変換）
   - `respond/route.ts` L149-156: sendKeys呼び出しも影響を受ける
   - `getAnswerInput()`: multiple_choiceハンドリングの変更（番号 -> 矢印キー回数への変換）

2. **detectMultipleChoicePromptの役割変化**:
   - TUIベースの場合、tmuxバッファのstripAnsi後にテキストとして選択肢が残るかが鍵
   - ANSIエスケープシーケンスのみで情報が失われる場合、パターンマッチ自体が機能しない
   - その場合はCodex固有の「選択肢表示中」状態を別の方法で検出する必要がある（例: 特定の文字列パターンや行数パターン）

3. **フロントエンドコンポーネントへの影響**:
   - `PromptPanel.tsx`/`MobilePromptSheet.tsx`: multiple_choiceセクションで、ユーザーが番号をクリック -> sendKeysで矢印キー操作に変換する中間レイヤーが必要になる可能性
   - テキストベースの場合は現行UIで対応可能

4. **矢印キー操作の設計参考**: `codex.ts`の`startSession()` L91-96で既にDown arrow + Enterによる TUI操作の実装例がある。この実装パターンを参考にできる。

> **Note**: 前提条件確認（TUI vs テキスト）の結果が影響範囲を大きく左右するため、確認後に影響範囲テーブルを更新すること。

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
     - **案B（推奨）**: パターンのパラメータ化（`detectMultipleChoicePrompt(output, patterns)`） - 非依存性を維持しつつ拡張可能
     - **案C**: CLIツール別のdetectPromptラッパー関数を追加 - 既存関数を変更せず拡張
   - **推奨理由（案B）**: Issue #161で確立された「prompt-detector.tsのCLIツール非依存性」原則を維持できる。`detectPrompt(output, options?)`のようにオプションパラメータでパターン設定を渡す形にすれば後方互換性を保てる（options省略時は既存のClaude用パターンを使用）。呼び出し元は`cli-patterns.ts`から取得したパターンセットを渡すだけで済む。
   - **型定義の例**: `interface DetectPromptOptions { choiceIndicatorPattern?: RegExp; normalOptionPattern?: RegExp; }`

4. **テスト追加**
   - Codex選択肢出力例でのプロンプト検出テスト
   - Auto-Yes動作確認テスト

## 実装タスク

- [ ] **【前提】** Codex CLIの選択肢出力形式を実機確認（tmuxバッファ取得）- テキストベースかTUIベースかを特定し、結果をIssueにコメント。**確認後に影響範囲テーブルを更新すること**
- [ ] `src/lib/cli-patterns.ts`: Codex選択肢パターン定義追加
- [ ] `src/lib/prompt-detector.ts`: `detectMultipleChoicePrompt()`をCodex形式対応。**案B採用時**: `DetectPromptOptions` interfaceを定義し、`detectPrompt(output, options?)`のシグネチャに変更
- [ ] `src/app/api/worktrees/[id]/prompt-response/route.ts`: CLIツール別パターンをoptions引数で渡す修正（L50でcliToolIdを取得済み -> cli-patterns.tsからパターンセットを取得し、L75のdetectPromptにoptions引数として渡す）
- [ ] `src/lib/auto-yes-manager.ts`: `pollAutoYes()`内の`detectPrompt()`にCLIツール別パターンをoptions引数で渡す修正（L262でcliToolIdを引数として受け取っている -> cli-patterns.tsからパターンセットを取得し、L290のdetectPromptにoptions引数として渡す）
- [ ] `src/lib/response-poller.ts`: `detectPrompt()`呼び出し箇所のCLIツール別パターン対応 - **L442, L556のみ変更必要**（L248はClaude専用ガード内のため変更不要）。cliToolIdからcli-patterns.tsのパターンセットを取得しoptions引数で渡す
- [ ] `src/lib/status-detector.ts`: `detectPrompt()`呼び出し（L87）のCLIツール別パターン対応。cliToolIdからcli-patterns.tsのパターンセットを取得しoptions引数で渡す。**Note**: STATUS_CHECK_LINE_COUNT=15の制限により、選択肢数が多い場合（7個以上）に検出に失敗する可能性あり。必要に応じて引き上げを検討
- [ ] `src/app/api/worktrees/[id]/current-output/route.ts`: `detectPrompt()`呼び出し（L88）のCLIツール別パターン対応。cliToolIdからcli-patterns.tsのパターンセットを取得しoptions引数で渡す
- [ ] `src/lib/claude-poller.ts`: `detectPrompt()`シグネチャ変更時の影響確認。案B（パターンパラメータ化）でoptionalパラメータとする場合は後方互換性があり変更不要。Claude専用ポーラーのためCodexセッションでは使用されない
- [ ] `tests/unit/prompt-detector.test.ts`: Codex選択肢検出テスト追加
- [ ] `tests/unit/lib/cli-patterns.test.ts`: Codex選択肢パターンテスト追加
- [ ] 既存テストファイルの更新確認: `detectPrompt`をモックしているテストのシグネチャ対応
  - `tests/unit/lib/auto-yes-manager.test.ts`（L431）
  - `tests/unit/api/prompt-response-verification.test.ts`（L50, L112, L141）
- [ ] `auto-yes-resolver.ts`の`isDefault`フラグ動作確認: Codex選択肢でデフォルトマーカーが検出されるか、されない場合の「最初の選択肢を選択」動作が許容可能か検証
- [ ] 動作検証: UI手動送信、Auto-Yesモードの両方で確認

## 受入条件

- [ ] Codex CLIの複数選択肢にUIから番号を入力して回答を送信できること
- [ ] Auto-YesモードでCodex CLIの選択肢に自動応答されること
  - デフォルト選択が検出できる場合はデフォルトを選択
  - デフォルト選択がない場合は最初の選択肢を選択（現行ロジック維持）
  - Codex固有の選択肢パターンに対してカスタムルールが必要な場合は別途検討
- [ ] Claude CLIの既存の選択肢検出・応答機能に影響がないこと
- [ ] Codex CLI選択肢表示時のサイドバーステータスが正しく'waiting'（黄色）になること
  - **Note**: 選択肢数が多い場合（7個以上）のケースもテストに含めること（status-detector.tsの15行ウィンドウ制限の影響確認）
- [ ] ユニットテストが追加されていること（Codex選択肢検出テスト）
- [ ] 既存テストがすべてパスすること

## 影響範囲

### 変更対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/lib/cli-patterns.ts` | Codex選択肢パターン定義追加 |
| `src/lib/prompt-detector.ts` | `detectMultipleChoicePrompt()`のCodex形式対応。案B採用時: `DetectPromptOptions` interface定義、`detectPrompt(output, options?)`シグネチャ変更 |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | CLIツール別パターンをoptions引数で渡す修正（L50で取得済みのcliToolIdからcli-patterns.tsのパターンセットを取得し、L75のdetectPromptにoptions引数として渡す） |
| `src/lib/auto-yes-manager.ts` | `pollAutoYes()`内の`detectPrompt()`にCLIツール別パターンをoptions引数で渡す修正 |
| `src/lib/response-poller.ts` | `detectPrompt()`呼び出し箇所のCLIツール別パターン対応。**L248はClaude専用ガード（`if (cliToolId === 'claude')`）内のため変更不要。L442とL556が全CLIツール共通パスであり変更必要** |
| `src/lib/status-detector.ts` | `detectPrompt()`呼び出し（L87）のCLIツール別パターン対応。**Note**: STATUS_CHECK_LINE_COUNT=15の制限により、Codexの選択肢が多い場合に検出に失敗する可能性あり。必要に応じて引き上げを検討 |
| `src/app/api/worktrees/[id]/current-output/route.ts` | `detectPrompt()`呼び出し（L88）のCLIツール別パターン対応 |
| `src/lib/claude-poller.ts` | `detectPrompt()`呼び出し（L164, L232）の影響確認。Claude専用ポーラーのためCodexセッションでは使用されない。案B（パターンパラメータ化）でoptionalパラメータとする場合は後方互換性があり変更不要 |
| `tests/unit/prompt-detector.test.ts` | Codex選択肢検出テスト追加 |
| `tests/unit/lib/cli-patterns.test.ts` | Codex選択肢パターンテスト追加 |

**Note**: `detectPrompt()`のシグネチャを変更する場合、**案B（パターンパラメータ化）**を推奨。`detectPrompt(output, options?)`のようにoptionalパラメータとすることで後方互換性を保ち、`claude-poller.ts`等の既存呼び出し箇所は変更不要。段階的に全呼び出し箇所を移行する。

### 既存テストファイルの更新（シグネチャ変更時）

| ファイル | 更新理由 |
|---------|---------|
| `tests/unit/lib/auto-yes-manager.test.ts` | L431で`detectPrompt`をモック - 新シグネチャ対応のモック更新が必要 |
| `tests/unit/api/prompt-response-verification.test.ts` | L50, L112, L141で`detectPrompt`をモック - 同上 |

> **Note**: `tests/integration/api-prompt-handling.test.ts` は `detectPrompt` を直接import/mockしておらず、`respond/route.ts`経由の統合テストである。`detectPrompt`のシグネチャ変更の直接的影響はないため、シグネチャ変更時の更新対象からは除外。ただし、Codex選択肢対応後の動作確認（回帰テスト）として実行すること。

### 関連コンポーネント（動作確認）

- `src/lib/auto-yes-resolver.ts` - 自動応答判定のCodex動作確認（`isDefault`フラグの挙動検証: Codexにデフォルトマーカーがない場合、`isDefault`が常にfalseとなり「最初の選択肢を選択」動作が許容可能か確認）
- `src/lib/cli-tools/codex.ts` - Codex CLIセッション管理（TUI描画方式の確認。startSession() L91-96のDown arrow+Enter操作が設計参考になる）
- `src/lib/claude-poller.ts` - `detectPrompt()`呼び出し（L164, L232）の影響確認。Claude専用ポーラーのためCodexセッションでは使用されない
- `src/app/api/worktrees/[id]/respond/route.ts` - メッセージIDベースのプロンプト応答API。`getAnswerInput()`を使用しており（L82-113）、Codex TUIベース選択肢の場合はsendKeysロジックの変更が必要になる可能性あり。**Note**: respond/route.tsはL12でresponse-poller.tsのstartPollingをimportしている（claude-poller.tsではない）。テスト（api-prompt-handling.test.ts）ではclaude-pollerをモックしているため不整合がある可能性があるが、本Issueのスコープ外。動作確認時に認識しておくこと
- `src/components/worktree/PromptPanel.tsx` - 選択肢UI描画コンポーネント。TUIベースの場合、番号クリック -> 矢印キー操作変換の中間レイヤーが必要になる可能性。テキストベースの場合は現行UIで対応可能
- `src/components/worktree/MobilePromptSheet.tsx` - モバイル版選択肢UI。PromptPanelと同様の影響
- `src/hooks/useAutoYes.ts` - クライアント側Auto-Yesフック。Codex選択肢検出時に`isPromptWaiting=true`がcurrent-output APIから返された場合、クライアント側Auto-Yesがサーバー側ポーリング（auto-yes-manager.ts）と重複応答しないことを確認（`lastServerResponseTimestamp`による重複防止機構の動作検証）

### 関連Issue

- Issue #4: CLIツールサポート（Codex CLI追加）
- Issue #161: Auto-Yes誤検出修正（2パス❯検出方式、prompt-detector.tsのCLIツール非依存性）
- Issue #138: サーバー側Auto-Yesポーリング

---

## レビュー履歴

### イテレーション 1 (2026-02-08)
- S1-001: detectPrompt()の全9箇所の呼び出しを行番号付きで列挙
- S1-002: 前提条件セクションにTUI vs テキスト確認の4項目を追加
- S1-003: prompt-response/route.tsを変更対象テーブルと実装タスクに追加
- S1-004: auto-yes-manager.tsを変更対象テーブルと実装タスクに追加
- S1-005: response-poller.ts（L248/L442/L556区別付き）とclaude-poller.tsを追加
- S1-006: TUIベースの代替設計パスセクションを追加
- S1-007: 受入条件にAuto-Yesの具体的な動作方針を追加
- S1-008: status-detector.tsを変更対象テーブルに追加（STATUS_CHECK_LINE_COUNT注記付き）
- S1-009: current-output/route.tsを変更対象テーブルに追加
- S1-010: 案Bを推奨案として明記、理由と型定義例を提示
- S3-001: detectPromptの計9箇所の呼び出しを正確な行番号と分類付きで詳細化
- S3-002: auto-yes-resolver.tsのisDefaultフラグ動作を前提条件とタスクに追加
- S3-003: codex.tsのstartSession() TUI操作を設計参考として記載
- S3-004: response-poller.tsの3箇所（L248/L442/L556）を区別して記載
- S3-005: 推奨案B（パターンパラメータ化）の型定義例を追加
- S3-006: status-detector.tsのSTATUS_CHECK_LINE_COUNT=15制限の影響を注記
- S3-007: respond/route.tsの確認ポイントを詳細化
- S3-008: テストファイル更新計画テーブルを追加
- S3-009: prompt-response/route.tsのcliToolId取得済み（L50）をL75に渡す記述を具体化
- S3-010: current-output/route.tsのdetectPrompt呼び出しをL88として正確に記載

### イテレーション 2 (2026-02-08)
- S5-001: tests/integration/api-prompt-handling.test.tsをシグネチャ変更の更新対象テーブルから除外（detectPromptを直接import/mockしていないため影響なし。回帰テストとして実行は推奨）
- S5-002: respond/route.tsのstartPolling import元（response-poller.ts vs claude-poller.ts）の不整合を認識事項として追記（本Issueスコープ外）
- S5-003: 実装タスクの記述を案B（パターンパラメータ化）に整合（「cliToolIdを渡す」から「CLIツール別パターンをoptions引数で渡す」に修正）
- S5-004: response-poller.ts L248の注記を「変更不要の可能性」から「変更不要」に統一
- S5-005: useAutoYes.tsの確認内容を具体化（lastServerResponseTimestampによる重複防止機構の動作検証を明記）
