# Issue #374 レビューレポート

**レビュー日**: 2026-02-27
**フォーカス**: 通常レビュー
**ステージ**: Stage 1（通常レビュー 1回目）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 4 |
| Nice to Have | 3 |

**総合評価**: Issue #374 は既存の vibeLocalModel 実装パターンを踏襲した堅実な機能追加Issueであり、重大な技術的誤りや整合性の問題は見当たらない。全ての前提条件は仮説検証でConfirmed済みであり、変更対象ファイルの特定も正確。ただし、テスト戦略の欠如、バリデーション範囲の根拠不足、DB更新関数の設計パターン未指定、セッション再起動時の挙動の明確化の4点は実装前に明確化すべき。

---

## Should Fix（推奨対応）

### SF-001: テスト戦略が記載されていない

**カテゴリ**: 完全性
**場所**: Issue本文全体（受け入れ基準セクション）

**問題**:
Issueにテスト計画が記載されていない。各レイヤー（DBマイグレーション、APIバリデーション、CLIコマンド構築、UIコンポーネント）でどのテストを追加・修正するかが不明確。既存の vibeLocalModel 実装でもテストが書かれていることが想定されるが、それと同等のテストカバレッジが求められるかどうかの判断基準がない。

**推奨対応**:
受け入れ基準または別セクションに以下のテスト要件を追加すべき:
- ユニットテスト: バリデーション関数（正の整数、範囲チェック、null許容）、DBマイグレーション（カラム追加・デフォルト値）、CLIコマンド構築（`--context-window`付与・省略）
- インテグレーションテスト: PATCH API（正常値、null、境界値、不正値の各パターン）
- 受け入れ基準に「各レイヤーのユニットテスト・インテグレーションテストがパスする」を追加

---

### SF-002: バリデーション範囲 1024〜131072 の根拠が不明

**カテゴリ**: 明確性
**場所**: 対応方針 > 2. API セクション

**問題**:
Issueでは「正の整数（例: 1024〜131072）」と記載があるが、この範囲が確定値なのか例示なのかが曖昧。vibe-local CLIツール側が受け付けるコンテキストウィンドウサイズの実際の制約（最小値・最大値）が明示されていない。

Ollama自体は理論上モデルに応じて様々な値を受け付ける。例えばGemma2:2Bは2048が推奨だが、Llama 3.1:405Bは128Kまで対応している。下限1024で十分かどうか、上限131072がハードリミットとして適切かどうかの根拠が必要。

**推奨対応**:
以下のいずれかを選択して明記すべき:
- (A) 下限のみ設定（例: 128以上の正の整数）し、上限はvibe-local側に委ねる
- (B) 1024〜131072を確定範囲とする場合、その根拠（代表的モデルの対応範囲等）を記載する
- (C) 下限を小さくする（例: 256以上）ことで、小規模モデルにも対応可能とする

---

### SF-003: DB更新関数の実装パターンが未指定

**カテゴリ**: 技術的妥当性
**場所**: 変更対象（想定） > `src/lib/db.ts`

**問題**:
Issueでは変更対象に db.ts を挙げているが、`updateVibeLocalContextWindow` を専用関数として実装するか、既存の `updateVibeLocalModel` と統合した汎用関数にするかの設計方針が記載されていない。

既存コードでは `updateVibeLocalModel`（`src/lib/db.ts:1004`行目）が単独関数として実装されており、同パターンであれば一貫性は保たれるが、類似カラムが増えるたびに関数が増える課題がある。

**証拠**:
```typescript
// src/lib/db.ts:1004-1014
export function updateVibeLocalModel(
  db: Database.Database,
  id: string,
  model: string | null
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET vibe_local_model = ?
    WHERE id = ?
  `);
```

**推奨対応**:
既存パターンとの一貫性を優先し、`updateVibeLocalContextWindow` を `updateVibeLocalModel` と同様の単独関数として実装する方針を明記すべき。将来的な汎用化（例: `updateWorktreeField` 関数）はリファクタリングIssueとして別途起票することを推奨。

---

### SF-004: セッション再起動時の反映タイミングが受け入れ基準にない

**カテゴリ**: 受け入れ条件
**場所**: 受け入れ基準セクション

**問題**:
コンテキストウィンドウの値を変更した後、既に起動中のvibe-localセッションに対してどう扱うかが不明確。現在の `vibeLocalModel` 実装では、値を変更してもセッション再起動まで反映されない（`startSession` 時にDB読取する設計のため）。

```typescript
// src/lib/cli-tools/vibe-local.ts:86-97
// Read Ollama model preference from DB
// [SEC-001] Re-validate model name at point of use (defense-in-depth)
let vibeLocalCommand = 'vibe-local -y';
try {
  const db = getDbInstance();
  const wt = getWorktreeById(db, worktreeId);
  if (wt?.vibeLocalModel && OLLAMA_MODEL_PATTERN.test(wt.vibeLocalModel)) {
    vibeLocalCommand = `vibe-local -y -m ${wt.vibeLocalModel}`;
  }
} catch {
  // DB read failure is non-fatal; use default model
}
```

この挙動が `--context-window` でも同様であることの明示が必要。

**推奨対応**:
受け入れ基準に「コンテキストウィンドウの変更はセッション再起動後に反映される（vibeLocalModelと同じ挙動）」を追加すべき。また、UI上に「変更はセッション再起動後に反映されます」等のヒント表示が必要かどうかも言及すべき。

---

## Nice to Have（あれば良い）

### NTH-001: UIの入力欄仕様がやや粗い

**カテゴリ**: 完全性
**場所**: 対応方針 > 3. UI セクション

**問題**:
`type="number"` のinput要素に対する `step`、`min`、`max` 属性のHTML仕様レベルでの設定値が記載されていない。また、プレースホルダー「Default」のi18nキー名も未指定。

**推奨対応**:
UI仕様として以下を明記すると実装時の迷いが減る:
- `step="1"`（整数のみ）
- `min` / `max` をバリデーション範囲に合わせて設定
- i18nキー: `vibeLocalContextWindow`, `vibeLocalContextWindowDefault`
- 空欄時のクリア方法（入力値を消去してフォーカスアウトでnullに戻る等）

---

### NTH-002: 関連Issue #368へのリンクがない

**カテゴリ**: 完全性
**場所**: 背景セクション

**問題**:
本Issueの前提となるVibe Local実装はIssue #368で行われているが、Issue本文にその参照がない。開発者が経緯を辿る際に不便。

**推奨対応**:
背景セクションに「Issue #368 で実装されたVibe Local統合を拡張する」旨のリンクを追加すべき。

---

### NTH-003: CLAUDE.mdのモジュール説明更新が変更対象に含まれていない

**カテゴリ**: 整合性
**場所**: 変更対象（想定）セクション

**問題**:
CLAUDE.mdの「主要機能モジュール」セクションにある `vibe-local.ts` の説明は現状「VibeLocalTool、BaseCLITool継承、tmuxセッション管理」のみ。Issue #374完了後にコンテキストウィンドウサポートを追記する必要があるが、Issueの変更対象ファイル一覧にCLAUDE.mdが含まれていない。

**推奨対応**:
変更対象ファイルに `CLAUDE.md` を追加し、`vibe-local.ts` のモジュール説明にコンテキストウィンドウ対応の記述を含める。

---

## 参照ファイル

### コード

| ファイル | 関連箇所 | 説明 |
|---------|---------|------|
| `src/lib/cli-tools/vibe-local.ts` | 88-97行目 | コマンド構築箇所 - `--context-window` の追加先 |
| `src/lib/db-migrations.ts` | 932-948行目 | 既存の `vibe_local_model` マイグレーションパターン（version 19） |
| `src/app/api/worktrees/[id]/route.ts` | 232-251行目 | 既存の `vibeLocalModel` APIバリデーション |
| `src/lib/db.ts` | 1004-1014行目 | 既存の `updateVibeLocalModel` 関数パターン |
| `src/components/worktree/AgentSettingsPane.tsx` | 232-264行目 | 既存の Ollama model selector UI |
| `src/types/models.ts` | 80-81行目 | Worktreeインターフェース |

### ドキュメント・設定

| ファイル | 説明 |
|---------|------|
| `locales/ja/schedule.json` | i18nラベル追加先 |
| `locales/en/schedule.json` | i18nラベル追加先 |
| `CLAUDE.md` | モジュール説明の更新が必要（変更対象に未記載） |
