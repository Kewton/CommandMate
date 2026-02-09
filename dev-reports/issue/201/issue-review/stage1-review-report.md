# Issue #201 レビューレポート

**レビュー日**: 2026-02-09
**フォーカス**: 通常レビュー（Consistency & Correctness）
**イテレーション**: 1回目（Stage 1）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 4 |
| Nice to Have | 2 |

Issue #201は、Claude CLI v2.xの「Quick safety check」信頼性確認ダイアログへの自動応答機能の追加を提案している。仮説検証レポートにより、根本原因の分析（CLAUDE_PROMPT_PATTERNの行頭マッチによるダイアログ未検出）は正確であることが確認済み。しかし、実装タスクの記述にはポーリングループでのEnter二重送信防止や、sendMessageToClaude()への波及分析が不足している箇所がある。

---

## Must Fix（必須対応）

### MF-1: Enter二重送信防止のガード条件が未記載

**カテゴリ**: 完全性
**場所**: ## 対応方針 > 実装タスク > 2.

**問題**:
Issueの実装タスクで提案されているフロー図では、`CLAUDE_TRUST_DIALOG_PATTERN`にマッチした場合に「Enter送信 -> ポーリング継続」とあるが、Enter送信後にダイアログが消えるまでの間に再度マッチして連続Enter送信される可能性への対処が記載されていない。

**証拠**:
- `src/lib/claude-session.ts` L333-354: ポーリングループはCLAUDE_INIT_POLL_INTERVAL（300ms）間隔で繰り返し実行される
- `sendKeys()`呼び出し後、tmux上のバッファは即座には更新されない。ダイアログのテキスト「Yes, I trust this folder」はEnter送信後もバッファに残存する可能性がある
- 300ms以内にダイアログが消えなければ、次のポーリングで再度パターンがマッチし、Enterが連打される

**推奨対応**:
実装タスクに以下のいずれかのガード条件を明記すること:
1. `trustDialogHandled`フラグを導入し、一度Enter送信したら以降のマッチをスキップ
2. Enter送信後に短い待機時間（例: 1-2秒）を入れてからポーリング再開
3. 最大送信回数を制限（例: 1回のみ）

いずれの方式でも受け入れ条件に「Enter送信が1回のみであること」を追加すべき。

---

## Should Fix（推奨対応）

### SF-1: CLAUDE_PROMPT_PATTERNの記述が実際のコードと異なる

**カテゴリ**: 正確性
**場所**: ## 原因 セクション

**問題**:
Issue本文では`CLAUDE_PROMPT_PATTERN`を「`/^[>❯]/m`」と記載しているが、実際のコードでは`/^[>❯](\s*$|\s+\S)/m`である。

**証拠**:
- Issue本文: `CLAUDE_PROMPT_PATTERN`（`/^[>❯]/m`）
- 実際のコード（`src/lib/cli-patterns.ts:48`）: `export const CLAUDE_PROMPT_PATTERN = /^[>❯](\s*$|\s+\S)/m;`

行頭マッチが核心であるため、根本原因の分析としては正しい。ただし、パターンを正確に記述することで、読者の誤解を防ぐことができる。仮説検証レポートでも同様の指摘がなされている。

**推奨対応**:
原因セクションのパターン記述を実際のコードと一致させる: `CLAUDE_PROMPT_PATTERN`（`/^[>❯](\s*$|\s+\S)/m`）

---

### SF-2: sendMessageToClaude()への影響分析が不足

**カテゴリ**: 完全性
**場所**: ## 原因 セクション / ## 技術要件

**問題**:
Issue本文は`startClaudeSession()`の修正のみを実装タスクとして挙げている。`sendMessageToClaude()`内の`waitForPrompt()`（`src/lib/claude-session.ts` L394-398）も`CLAUDE_PROMPT_PATTERN`のみを使用しているが、この点への影響分析が記載されていない。

**証拠**:
- `src/lib/claude-session.ts` L394-398: `sendMessageToClaude()`はプロンプト未検出時に`waitForPrompt()`を呼び出す
- `waitForPrompt()`（L257-276）もCLAUDE_PROMPT_PATTERNのみで検出する

通常フローでは`startClaudeSession()`で信頼性ダイアログを処理すれば、後続の`sendMessageToClaude()`では正常プロンプトが表示されるはず。しかし以下のケースが考慮されていない:
1. `startClaudeSession()`がタイムアウトした後のリトライシナリオ
2. セッション再利用時にダイアログが再表示されるケース（可能性は低いが）

**推奨対応**:
`sendMessageToClaude()`/`waitForPrompt()`ではダイアログ対応不要であることの理由を、Issue本文の対応方針に一文追記する。

---

### SF-3: 検出パターンの多言語対応への考慮不足

**カテゴリ**: 明確性
**場所**: ## 対応方針 > 実装タスク > 1.

**問題**:
提案されている`CLAUDE_TRUST_DIALOG_PATTERN = /Yes, I trust this folder/m`は英語文字列に固定されている。Claude CLIが将来ローカライズされた場合にマッチしなくなる可能性があるが、この前提条件が記載されていない。

**証拠**:
提案パターン: `/Yes, I trust this folder/m` -- 特定の英語文字列のみマッチ

**推奨対応**:
以下のいずれかを明記する:
1. Claude CLIが現時点で英語UIのみであり、ローカライズ対応は将来の別Issueとする前提
2. より構造的な検出パターン（例: ダイアログのレイアウト構造やキー文字列の組み合わせ）を併用する案を検討候補として記載

---

### SF-4: Enter送信後のタイムアウト処理に対する受け入れ条件不足

**カテゴリ**: 受け入れ条件
**場所**: ## 受入条件

**問題**:
Enter送信後、残りのCLAUDE_INIT_TIMEOUT時間内でプロンプト検出に到達する必要があるが、この状態遷移に対する受け入れ条件がない。

**証拠**:
- `src/lib/claude-session.ts` L328: `CLAUDE_INIT_TIMEOUT = 15000ms`
- ダイアログ検出にN秒消費した場合、残り(15-N)秒でEnter処理 + プロンプト検出まで完了する必要がある
- 現在の受け入れ条件には「自動応答後にClaude CLIが正常にプロンプト状態になること」のみあり、タイムアウトケースの振る舞いが未指定

**推奨対応**:
以下の受け入れ条件を追加:
- 「ダイアログ検出・Enter送信後、CLAUDE_INIT_TIMEOUT内にプロンプトが検出されない場合は、既存と同じタイムアウトエラーが発生すること」
- 必要に応じてCLAUDE_INIT_TIMEOUTの延長可否も検討する（15秒で十分かどうか）

---

## Nice to Have（あれば良い）

### NTH-1: 代替案の検討記録

**カテゴリ**: 完全性
**場所**: ## 対応方針

**問題**:
案Aのみが提案されており、検討した代替案がない。設計判断の根拠を記録しておくことで、将来のメンテナンス時に有用。

**推奨対応**:
以下のような代替案を検討記録として追記:
- 案B: `claude --dangerously-skip-permissions` フラグでの起動（セキュリティリスクが高い）
- 案C: ユーザーに手動対応を促すUI通知（UX低下）
- 案D: Claude CLIの設定ファイル（`~/.claude/settings.json`）での事前許可

---

### NTH-2: ログ出力仕様の詳細化

**カテゴリ**: 完全性
**場所**: ## 受入条件

**問題**:
「自動応答時にコンソールログが出力されること」とあるが、ログレベルや出力内容が未指定。

**推奨対応**:
- ログレベル: `console.log`（info相当）で十分と考えられる（セキュリティイベントではなく正常動作のため）
- 出力内容例: `"Trust dialog detected, sending Enter to confirm (worktreeId: ${worktreeId})"`

---

## 参照ファイル

### コード
- `src/lib/claude-session.ts`: 変更対象 -- startClaudeSession()のポーリングループ（L326-354）
- `src/lib/cli-patterns.ts`: 変更対象 -- CLAUDE_TRUST_DIALOG_PATTERN追加先（L48付近）
- `src/lib/tmux.ts`: 依存 -- sendKeys()関数（L207-225）の動作確認
- `tests/unit/lib/claude-session.test.ts`: 変更対象 -- テスト追加先

### ドキュメント
- `CLAUDE.md`: Issue #152, #187のセッション管理改善履歴の記録先

### 関連Issue
- Issue #187: セッション初回メッセージ送信信頼性改善（直接の前提Issue）
- Issue #198: CLI操作の信頼性改善バッチ（親Epic）
