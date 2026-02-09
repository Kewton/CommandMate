# Issue #201 影響範囲レビューレポート

**レビュー日**: 2026-02-09
**フォーカス**: 影響範囲レビュー（Impact Scope）
**イテレーション**: 1回目（Stage 3）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 3 |

Issue #201の変更範囲は限定的かつ低リスクである。変更は `src/lib/cli-patterns.ts` への定数追加と `src/lib/claude-session.ts` の `startClaudeSession()` ポーリングループ内への条件分岐追加のみであり、破壊的変更は発生しない。`CLAUDE_TRUST_DIALOG_PATTERN` が未マッチの場合は既存動作と完全に同一であるため、後方互換性は維持される。

ただし、Issueの変更ファイル一覧にテストファイル（`cli-patterns.test.ts`）とドキュメント（`CLAUDE.md`）が含まれておらず、プロジェクト慣例との不整合がある。

---

## 影響範囲の全体像

### 変更の波及構造

```
src/lib/cli-patterns.ts  (CLAUDE_TRUST_DIALOG_PATTERN追加)
  |
  +-- src/lib/claude-session.ts  (importして使用)
  |     |
  |     +-- startClaudeSession() ポーリングループ内に条件分岐追加
  |     |
  |     +-- (以下は変更なし、間接影響のみ)
  |     +-- src/lib/cli-tools/claude.ts (ClaudeTool.startSession())
  |     +-- src/app/api/worktrees/[id]/send/route.ts (APIルート)
  |     +-- src/lib/claude-session.ts restartClaudeSession()
  |
  +-- (以下のファイルはcli-patterns.tsをimportするが、CLAUDE_TRUST_DIALOG_PATTERNは使用しない)
  +-- src/lib/auto-yes-manager.ts
  +-- src/lib/status-detector.ts
  +-- src/lib/response-poller.ts
  +-- src/lib/assistant-response-saver.ts
  +-- src/app/api/worktrees/[id]/prompt-response/route.ts
  +-- src/app/api/worktrees/[id]/current-output/route.ts
```

---

## Should Fix（推奨対応）

### SF-1: cli-patterns.test.tsにCLAUDE_TRUST_DIALOG_PATTERNのテストが必要

**カテゴリ**: テスト範囲
**場所**: ## 技術要件 > 変更ファイル

**問題**:
`CLAUDE_TRUST_DIALOG_PATTERN` は `src/lib/cli-patterns.ts` に追加される新規パブリックexportであるが、そのパターンマッチのテストが変更ファイル一覧に含まれていない。既存の `src/lib/__tests__/cli-patterns.test.ts` は全てのパターン定数（`CLAUDE_PROMPT_PATTERN`, `CLAUDE_THINKING_PATTERN` 等）に対してマッチ/非マッチテストを持つ慣例がある。

**証拠**:
- `src/lib/__tests__/cli-patterns.test.ts`: 各パターン定数ごとにdescribeブロックを持つ（L12-96: CLAUDE_PROMPT_PATTERN, L98-129: CLAUDE_THINKING_PATTERN等）
- Issueの変更ファイル一覧: `cli-patterns.ts`, `claude-session.ts`, `claude-session.test.ts` の3ファイルのみ

**推奨対応**:
変更ファイル一覧に `src/lib/__tests__/cli-patterns.test.ts` を追加し、以下のテストケースを含めること:
1. 信頼性ダイアログの全文出力にマッチすること
2. tmux出力にダイアログテキストが含まれるケースでマッチすること
3. 通常のCLI出力（例: "No, exit"単独、一般的なtmux出力）にマッチしないこと

---

### SF-2: CLAUDE.mdの更新が変更ファイル一覧に含まれていない

**カテゴリ**: 影響ファイル / ドキュメント更新
**場所**: ## 技術要件 > 変更ファイル

**問題**:
本プロジェクトでは `CLAUDE.md` の「最近の実装機能」セクションに、実装済みIssueの概要・主要コンポーネント・変更点を記録する慣例がある。直近の全てのIssue（#193, #191, #190, #187, #152等）がこのパターンに従っている。

**証拠**:
- `CLAUDE.md` の「最近の実装機能」セクション: Issue #193 から Issue #96 まで全てのIssueが記録されている
- Issue #201の変更ファイル一覧にはCLAUDE.mdが含まれていない

**推奨対応**:
変更ファイル一覧に `CLAUDE.md` を追加し、以下の内容を「最近の実装機能」セクションに追記すること:
- Issue番号とタイトル
- 問題の概要（信頼性ダイアログでstartClaudeSession()がタイムアウト）
- 修正内容（CLAUDE_TRUST_DIALOG_PATTERN追加、ポーリングループ内ダイアログ検出・自動応答）
- 主要コンポーネント一覧

---

## Nice to Have（あれば良い）

### NTH-1: Auto-Yesポーリングとの相互作用分析

**カテゴリ**: 依存関係
**場所**: Issue本文全体

**問題**:
`auto-yes-manager.ts` の `pollAutoYes()` はセッション開始後にプロンプト検出で自動応答を行う。信頼性ダイアログとの相互作用が問題ないことの分析が記載されていない。

**証拠**:
- `src/app/api/worktrees/[id]/send/route.ts` L98-100: `startSession()` が完了してからメッセージ送信・ポーリング開始
- `auto-yes-manager.ts` のポーリングはセッション初期化完了後に起動されるため、ダイアログ表示時点でAuto-Yesが動作することはない
- 仮にAuto-Yesが有効でダイアログ表示中であっても、`CLAUDE_PROMPT_PATTERN` にマッチしないため誤応答のリスクはない

**推奨対応**:
Issue本文の対応方針に「Auto-Yesポーリングとの相互作用はない（セッション初期化完了後にポーリング開始するため）」の一文を追記すると、影響範囲の網羅性が向上する。

---

### NTH-2: サイズ見積もりのファイル数更新

**カテゴリ**: ドキュメント更新
**場所**: ## 技術要件 > サイズ

**問題**:
SF-1とSF-2を含めると実質5ファイルへの変更となるが、サイズ見積もりは「3ファイル、約30行」のまま。

**推奨対応**:
ファイル数を5ファイルに更新し、行数見積もりを約60-80行に調整する。全体としてはS(小)の範囲内に収まる。

---

### NTH-3: Claude CLI旧バージョンとの後方互換性の明示

**カテゴリ**: 移行考慮
**場所**: Issue本文全体

**問題**:
`CLAUDE_TRUST_DIALOG_PATTERN` が未マッチの場合（Claude CLI v2.x未満、またはダイアログ済みワークスペース）は既存動作と完全に同一であるが、この後方互換性の保証が明示的に記載されていない。

**証拠**:
- `claude-session.ts` L332-354: ポーリングループに条件分岐を追加するのみ。マッチしない場合は次のポーリングへ進み、既存の `CLAUDE_PROMPT_PATTERN` チェックが実行される
- 受け入れ条件に「既存のセッション初期化フロー（ダイアログなし）に回帰がないこと」があり、事実上の後方互換性保証

**推奨対応**:
対応方針に「本変更は後方互換性を維持する。ダイアログが表示されないケースでは既存動作に一切の変更はない」の一文を追記する。

---

## 影響範囲の詳細分析

### 直接変更ファイル

| ファイル | 変更種別 | 変更内容 | リスク |
|---------|---------|---------|-------|
| `src/lib/cli-patterns.ts` | 追加 | `CLAUDE_TRUST_DIALOG_PATTERN` 定数export追加（約3行） | 極低: 新規export追加のみ |
| `src/lib/claude-session.ts` | 修正 | `startClaudeSession()` ポーリングループ内に条件分岐追加（約15行） | 低: 既存制御フローへの分岐追加 |
| `tests/unit/lib/claude-session.test.ts` | 追加 | ダイアログ関連テスト3件追加（約30行） | なし: テスト追加のみ |

### 追加推奨ファイル（SF-1, SF-2）

| ファイル | 変更種別 | 変更内容 |
|---------|---------|---------|
| `src/lib/__tests__/cli-patterns.test.ts` | 追加 | パターンマッチテスト追加（約15行） |
| `CLAUDE.md` | 更新 | 最近の実装機能セクションに概要追記（約15行） |

### 間接影響（変更不要）

| ファイル | 依存関係 | 影響有無 | 理由 |
|---------|---------|---------|------|
| `src/lib/cli-tools/claude.ts` | `startClaudeSession()` ラップ | なし | インターフェース変更なし |
| `src/app/api/worktrees/[id]/send/route.ts` | `cliTool.startSession()` 呼び出し元 | なし（正の影響） | タイムアウトエラー頻度の減少 |
| `src/lib/auto-yes-manager.ts` | `cli-patterns.ts` import | なし | 新規パターンを使用しない |
| `src/lib/status-detector.ts` | `cli-patterns.ts` import | なし | 新規パターンを使用しない |
| `src/lib/response-poller.ts` | `cli-patterns.ts` import | なし | 新規パターンを使用しない |
| `src/lib/assistant-response-saver.ts` | `cli-patterns.ts` import（stripAnsiのみ） | なし | 新規パターンを使用しない |

### 破壊的変更

**なし**。以下の理由による:
1. `CLAUDE_TRUST_DIALOG_PATTERN` は新規追加のexportであり、既存のexportを変更・削除しない
2. `startClaudeSession()` の関数シグネチャ（引数・戻り値型）に変更はない
3. エラーケースの振る舞いも変更なし（タイムアウト時のエラーメッセージは既存のまま）
4. パターン未マッチ時は既存の制御フローと完全に同一

### 依存関係

**新規外部依存**: なし（新規npmパッケージの追加なし）

**内部依存の変更**:
- `cli-patterns.ts` -> `claude-session.ts` 方向に `CLAUDE_TRUST_DIALOG_PATTERN` のimportが追加される
- この依存方向は既存（`CLAUDE_PROMPT_PATTERN`, `stripAnsi`）と同一であり、循環依存は発生しない

### テスト範囲の妥当性

**既存テストによる回帰検出**:
- `tests/unit/lib/claude-session.test.ts`: `startClaudeSession()` のタイムアウト、プロンプト検出、セパレータ除外、安定化待機の全テストケースが回帰を検出可能
- `src/lib/__tests__/cli-patterns.test.ts`: 既存パターン定数のテストが影響なしであることを保証

**新規テストの必要性**:
- Issueに記載のテスト3件（ダイアログ検出、プロンプト検出完了、二重送信防止）は適切
- 追加として、`CLAUDE_TRUST_DIALOG_PATTERN` 自体のパターンテスト（SF-1）を推奨

**回帰リスク**: 低。ポーリングループへの条件分岐追加は、既存条件を変更せずに新規条件を追加するのみ。

---

## 参照ファイル

### コード
- `src/lib/claude-session.ts`: 直接変更対象 -- startClaudeSession()ポーリングループ（L332-354）
- `src/lib/cli-patterns.ts`: 直接変更対象 -- CLAUDE_TRUST_DIALOG_PATTERN追加（L48付近）
- `tests/unit/lib/claude-session.test.ts`: 直接変更対象 -- テスト追加
- `src/lib/__tests__/cli-patterns.test.ts`: 追加推奨 -- パターンテスト（SF-1）
- `src/lib/cli-tools/claude.ts`: 間接影響確認 -- ClaudeTool.startSession()
- `src/app/api/worktrees/[id]/send/route.ts`: 間接影響確認 -- セッション起動フロー
- `src/lib/tmux.ts`: 依存確認 -- sendKeys()関数
- `src/lib/auto-yes-manager.ts`: 間接影響確認 -- ポーリングとの相互作用

### ドキュメント
- `CLAUDE.md`: 追加推奨 -- 最近の実装機能セクション（SF-2）

### 関連Issue
- Issue #187: セッション初回メッセージ送信信頼性改善（直接の前提Issue）
- Issue #152: セッション初回メッセージ送信の信頼性向上（startClaudeSession改善の初版）
- Issue #198: CLI操作の信頼性改善バッチ（親Epic）
