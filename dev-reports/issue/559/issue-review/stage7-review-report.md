# Issue #559 レビューレポート（Stage 7）

**レビュー日**: 2026-03-27
**フォーカス**: 影響範囲レビュー（2回目）
**イテレーション**: 2回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 1 |
| Nice to Have | 2 |

Stage 3（影響範囲レビュー1回目）で指摘した8件（must_fix 2件、should_fix 4件、nice_to_have 2件）は全て適切に反映されている。2回目のレビューでは重大な漏れは発見されず、影響範囲分析の品質は十分に高い状態にある。

---

## 前回指摘事項（Stage 3）の解決状況

| ID | 重要度 | タイトル | 状況 |
|----|--------|---------|------|
| F3-001 | must_fix | special-keys/route.tsの影響分析欠如 | 解決済み - スコープ外として明示的に分析・記載 |
| F3-008 | must_fix | スラッシュコマンド範囲の未定義 | 解決済み - 全コマンド対象+SELECTION_LIST_COMMANDSサブセットを明記 |
| F3-002 | should_fix | スラッシュコマンド判定方法の未定義 | 解決済み - 設計方針セクションで二重管理リスクとpublicメソッド推奨を記載 |
| F3-003 | should_fix | waitForPromptタイムアウト変更の波及 | 解決済み - 2つの方針選択肢を明記、受入条件も修正 |
| F3-004 | should_fix | テストファイル更新範囲の未記載 | 解決済み - 影響範囲テーブルに2つのテストファイルを追加 |
| F3-006 | should_fix | 先頭空白付きコマンドの判定 | 解決済み - trim処理の必要性を設計方針と受入条件に記載 |
| F3-005 | nice_to_have | 他CLIツールへの影響 | 解決済み - フォローアップ候補セクションに記載 |
| F3-007 | nice_to_have | レスポンス遅延の影響 | 解決済み - パフォーマンス考慮事項セクションを新設 |

---

## Should Fix（推奨対応）

### F7-001: cli-patterns.tsの影響範囲記載が曖昧

**カテゴリ**: 影響範囲の精度
**場所**: 影響範囲テーブル

**問題**:
影響範囲テーブルで `src/lib/detection/cli-patterns.ts` の変更内容が「スラッシュコマンド判定パターン（必要に応じて）」と記載されている。実際のcli-patterns.tsにはステータス検出パターン（COPILOT_PROMPT_PATTERN等）のみが定義されており、スラッシュコマンド判定用のパターンは存在しない。スラッシュコマンド判定は `/` で始まるかどうかの単純な文字列判定であり、正規表現パターンの追加は不要。

**証拠**:
- cli-patterns.tsの既存パターン: COPILOT_PROMPT_PATTERN, COPILOT_THINKING_PATTERN, COPILOT_SELECTION_LIST_PATTERN（全てステータス検出用）
- スラッシュコマンド判定: copilot.ts L204-209の `extractSlashCommand()` は `message.trim().startsWith('/')` による単純判定
- 推奨アプローチC（委譲パターン）採用時、cli-patterns.tsへの変更は不要

**推奨対応**:
cli-patterns.tsの行をアプローチ別に具体化するか、テーブルから除外して「変更なし（既存パターンで対応可能）」と記載する。

---

## Nice to Have（あれば良い）

### F7-002: CLAUDE.md更新の具体的スコープ

**カテゴリ**: CLAUDE.md更新範囲
**場所**: 受入条件

**問題**:
受入条件の「CLAUDE.mdのモジュール説明が必要に応じて更新されていること」が具体性に欠ける。

**推奨対応**:
想定される更新対象を例示する（例: copilot.tsエントリにpublicスラッシュコマンド判定メソッド追加を反映）。

---

### F7-003: Copilotプロセス異常終了時のブロッキング

**カテゴリ**: エッジケース
**場所**: パフォーマンス考慮事項

**問題**:
tmuxセッションは存在するがCopilotプロセスがクラッシュ等で停止している場合、waitForPromptが15秒フルにブロックした後にコマンドを送信する動作になる。これは既存のsendMessage経路でも同様の挙動であるため新たなリスクではないが、パフォーマンス考慮事項に含めると網羅的になる。

**推奨対応**:
パフォーマンス考慮事項に「Copilotプロセス異常終了時も15秒ブロッキングが発生する（sendMessage経路と同様）」を補足として追記する。

---

## 影響範囲テーブルの網羅性評価

| 評価項目 | 結果 |
|---------|------|
| 主要変更対象ファイルの網羅 | 適切（terminal/route.ts, copilot.ts） |
| テストファイルの特定 | 適切（terminal-route.test.ts, copilot.test.ts） |
| スコープ外ファイルの明示的除外 | 適切（special-keys/route.ts, send/route.ts, CLI経路） |
| 依存関係への影響分析 | 適切（waitForPrompt波及の2方針が明記） |
| 破壊的変更のリスク管理 | 適切（受入条件で既存経路への影響確認を要求） |
| テスト範囲の妥当性 | 適切（新規+既存更新が明記） |
| パフォーマンス影響 | 適切（15秒ブロッキング、HTTPタイムアウト確認を記載） |

---

## 総合評価

Issue #559の影響範囲分析は、6ステージのレビューと改善を経て十分な品質に達している。前回のmust_fix 2件を含む8件の指摘は全て適切に反映されており、影響範囲テーブル、受入条件、テスト範囲、破壊的変更のリスク管理が網羅的に記載されている。

残りの指摘は should_fix 1件（cli-patterns.tsの記載精度）と nice_to_have 2件であり、いずれもIssueの実装品質に大きな影響を与えるものではない。

---

## 参照ファイル

### コード
- `src/app/api/worktrees/[id]/terminal/route.ts` (L81-82): sendKeys直接呼び出し箇所（主要な変更対象）
- `src/lib/cli-tools/copilot.ts` (L182-209): waitForPrompt/extractSlashCommand（委譲・公開対象）
- `src/lib/detection/cli-patterns.ts`: ステータス検出パターン（変更不要の可能性）
- `tests/unit/terminal-route.test.ts` (L12): isCliToolTypeモック（copilot未含）
- `tests/unit/cli-tools/copilot.test.ts`: CopilotToolテスト

### ドキュメント
- `CLAUDE.md`: モジュール説明更新の可能性
