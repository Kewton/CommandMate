# Issue #565 通常レビューレポート（Stage 1）

**レビュー日**: 2026-03-28
**フォーカス**: 通常レビュー（1回目）
**イテレーション**: 1

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 5 |
| Nice to Have | 3 |
| **合計** | **9** |

Issue #565は、Copilot CLI（TUI/alternate screen）で発生する4つの事象（レスポンス未保存、スクロール不可、prompt重複、長文送信不可）について、根本原因の分析と暫定対策の記録、および本対応の方針を記述しています。事象と根本原因の分析は概ね正確であり、仮説検証の結果とも整合しています。主な改善点は、受け入れ条件の欠如と、実装方針の具体性不足です。

---

## Must Fix（必須対応）

### F1-002: 受け入れ条件が明示されていない

**カテゴリ**: 受入条件
**場所**: 本対応で必要なこと

**問題**:
「本対応で必要なこと」セクションに必須/推奨の対応項目はあるが、具体的な受け入れ条件（Acceptance Criteria）が定義されていません。「Copilot用TuiAccumulator対応」「TUI向けプロンプト重複防止」等は方針レベルの記述であり、何をもって完了とするか（何が達成されれば事象が解消されたと判定できるか）が不明確です。

**推奨対応**:
各必須/推奨対応項目について検証可能な受け入れ条件を追加してください。例:
1. Copilotの応答内容がMessage Historyに正しく保存されること（ステータスバー文字列ではなく本文が保存される）
2. 同一promptの重複保存が発生しないこと（同一内容のpromptが連続保存されない）
3. 78文字超のメッセージが正常に送信されること
4. 暫定対策の副作用（isFullScreenTuiによる重複悪化）が解消されていること

---

## Should Fix（推奨対応）

### F1-001: 24行制限は固定値ではなく画面サイズ依存

**カテゴリ**: 正確性
**場所**: 事象2 / 根本原因 > alternate screenモード

**問題**:
Issueの複数箇所で「約24行しか取得できない」と記載されていますが、これはtmuxペインのサイズ（行数）に依存する値であり、固定的な制限ではありません。仮説検証でもPartially Confirmedとなっています。

**推奨対応**:
「現在画面の約24行」を「tmuxペインの表示行数（デフォルト端末サイズでは約24行）」に修正し、alternate screenモードではスクロールバックバッファが無効化される旨を補足してください。

---

### F1-003: content hashベース重複防止の具体的な設計が未記載

**カテゴリ**: 実装方針
**場所**: 本対応で必要なこと > 必須 > 2

**問題**:
「content hashベース等」と記載されていますが、どのレイヤーで重複チェックを行うのか、既存のlineCountベースとどう共存させるかが記載されていません。response-poller.ts内には3箇所のlineCountベース重複チェック（L642, L650, L749）があり、isFullScreenTui時に全てスキップされています。

**根拠**:
- `response-poller.ts:642` - lineCount === lastCapturedLine チェック
- `response-poller.ts:650` - lineCount <= lastCapturedLine チェック
- `response-poller.ts:749` - race condition防止チェック

**推奨対応**:
重複防止の実装方針を具体化してください。例: promptメッセージ保存前にDB上の直近メッセージとcontentハッシュを比較、messageType='prompt'に限定するか全メッセージ対象か明記。

---

### F1-004: cleanCopilotResponseがplaceholder実装のままである点がIssueに未記載

**カテゴリ**: 整合性
**場所**: 本対応で必要なこと > 必須 > 1

**問題**:
`src/lib/response-cleaner.ts:159-176`の`cleanCopilotResponse`は、COPILOT_SKIP_PATTERNS（PastedTextPatternのみ）しかフィルタしておらず、実質的にplaceholder実装です。Issueの「本対応で必要なこと」ではTuiAccumulatorのCopilot対応に言及していますが、cleanCopilotResponseの拡充については直接触れていません。

**根拠**:
```
// src/lib/detection/cli-patterns.ts:285-287
export const COPILOT_SKIP_PATTERNS: readonly RegExp[] = [
  PASTED_TEXT_PATTERN,
] as const;
```

**推奨対応**:
必須対応1のスコープにcleanCopilotResponseの本実装を明示的に含めてください。

---

### F1-005: 200ms遅延の妥当性検証方針が不明確

**カテゴリ**: 実装方針
**場所**: 本対応で必要なこと > 必須 > 3

**問題**:
「現在の200ms遅延が十分か検証、または別アプローチ」とありますが、何をもって十分とするかの基準がありません。send/route.ts（L262）とterminal/route.ts（L88）の両方で同一のハードコード値200msが使用されています。

**推奨対応**:
検証基準を明記してください。また、200ms値を定数化してconfig化する方針の検討を推奨します。

---

### F1-007: TuiAccumulatorのCopilot拡張方針が不明確

**カテゴリ**: 整合性
**場所**: 本対応で必要なこと > 必須 > 1

**問題**:
`tui-accumulator.ts`は現在OpenCode完全専用の実装です（normalizeOpenCodeLine、OPENCODE_SKIP_PATTERNS、OPENCODE_RESPONSE_COMPLETE）。Copilot対応に必要な(1) normalize関数、(2) スキップパターン、(3) 完了検出パターンの3点について、新規関数を作るのか既存関数を拡張するのかの方針が不明です。

**推奨対応**:
実装アプローチを明記してください。既存のcli-tools/のStrategy パターンとの整合性を考慮すると、extractCopilotContentLines関数の新設、またはcli-tools層への統合が妥当です。

---

## Nice to Have（あれば良い）

### F1-006: 暫定対策の「未コミット」記述と実際の状態の不一致

**カテゴリ**: 整合性
**場所**: 暫定対策

**問題**:
「本Issue内で実施済み / 未コミット」と記載されていますが、git logにはコミット`7c68640e`が存在し既にコミット済みです。

**推奨対応**:
暫定対策セクションの記述をコミット済みの状態に更新してください。

---

### F1-008: ラベルが未設定

**カテゴリ**: その他
**場所**: Issueメタデータ

**問題**:
Issue #565にラベルが設定されていません。CLAUDE.mdのPRルールでは種類に応じたラベル付与が規定されています。

**推奨対応**:
`bug`ラベルの付与を推奨します。

---

### F1-009: 事象間の依存関係が明記されていない

**カテゴリ**: その他
**場所**: 事象 / 根本原因

**問題**:
4つの事象が独立に記載されていますが、事象1と事象3は根本原因が関連しており（isFullScreenTuiの適用が両方に影響）、事象3は暫定対策の副作用として発生しています。この因果関係がIssue本文では分散して記述されています。

**推奨対応**:
事象間の因果関係を明記してください。例: 「事象3は暫定対策（isFullScreenTui適用）の副作用」「事象1/2はalternate screen共通問題」

---

## 参照ファイル

### コード
| ファイル | 関連 |
|---------|------|
| `src/lib/polling/response-poller.ts` | isFullScreenTui定義、重複検出スキップ、プロンプト後ポーリング継続 |
| `src/lib/tui-accumulator.ts` | OpenCode専用TUI蓄積ロジック、Copilot対応が必要 |
| `src/lib/detection/cli-patterns.ts` | COPILOT_SKIP_PATTERNSがplaceholder状態 |
| `src/lib/response-cleaner.ts` | cleanCopilotResponseがplaceholder実装 |
| `src/app/api/worktrees/[id]/send/route.ts` | Copilot用200ms遅延分離送信 |
| `src/app/api/worktrees/[id]/terminal/route.ts` | Copilot用200ms遅延分離送信 |

### ドキュメント
| ファイル | 関連 |
|---------|------|
| `CLAUDE.md` | モジュールリファレンスとの整合性確認 |
