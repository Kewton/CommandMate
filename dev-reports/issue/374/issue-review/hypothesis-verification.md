# Issue #374 仮説検証レポート

## 検証日時
- 2026-02-27

## 概要

Issue #374 は機能追加Issueであり、バグの原因仮説は含まれない。
ただし、現状コードベースに関する事実の記述があるため、それらを検証した。

## 検証結果サマリー

| # | 主張/前提条件 | 判定 | 根拠 |
|---|-------------|------|------|
| 1 | `vibe-local -y -m {model}` でセッション起動（vibe-local.ts） | Confirmed | src/lib/cli-tools/vibe-local.ts:93 |
| 2 | `vibe_local_model` カラムがDBに存在し永続化される | Confirmed | src/lib/db-migrations.ts:939 |
| 3 | AgentSettingsPaneのUIからモデル変更可能 | Confirmed | src/components/worktree/AgentSettingsPane.tsx:235 |
| 4 | コンテキストウィンドウの指定手段がない | Confirmed | コードベース全体に `--context-window` 該当箇所なし |
| 5 | i18nラベルは `schedule.json` に追加する | Confirmed | locales/ja/schedule.json:37-38 にvibeLocalModel既存ラベルが存在 |
| 6 | 変更対象ファイルがすべて存在する | Confirmed | 全ファイル存在確認済み |

## 詳細検証

### 前提条件 1: `vibe-local -y -m {model}` でセッション起動

**Issue内の記述**: 「`vibe-local -y -m {model}` でセッション起動（`src/lib/cli-tools/vibe-local.ts`）」

**検証結果**:
- `src/lib/cli-tools/vibe-local.ts` の93行目: `vibeLocalCommand = \`vibe-local -y -m ${wt.vibeLocalModel}\`;`
- 88行目: デフォルトコマンドは `'vibe-local -y'` （モデル未設定時）

**判定**: Confirmed ✅

---

### 前提条件 2: `vibe_local_model` カラムがDBに存在

**Issue内の記述**: 「モデル選択はDB（`vibe_local_model` カラム）に永続化」

**検証結果**:
- `src/lib/db-migrations.ts:939`: `ALTER TABLE worktrees ADD COLUMN vibe_local_model TEXT DEFAULT NULL;`
- `src/lib/db.ts:232`: `vibe_local_model: string | null;` (row型定義)
- `src/lib/db.ts:262`: `vibeLocalModel: row.vibe_local_model ?? null,` (マッピング)

**判定**: Confirmed ✅

---

### 前提条件 3: AgentSettingsPaneのUIからモデル変更可能

**Issue内の記述**: 「AgentSettingsPaneのUIから変更可能」

**検証結果**:
- `src/components/worktree/AgentSettingsPane.tsx:235`: `{t('vibeLocalModel')}` ラベル表示
- `src/components/worktree/AgentSettingsPane.tsx:250`: `value={vibeLocalModel ?? ''}` 入力フィールド
- `src/components/worktree/AgentSettingsPane.tsx:163`: PATCH APIで `vibeLocalModel` を更新

**判定**: Confirmed ✅

---

### 前提条件 4: コンテキストウィンドウの指定手段なし

**検証結果**:
- コードベース全体に `--context-window` の記述なし
- `src/lib/cli-tools/vibe-local.ts` にコンテキストウィンドウ関連コードなし

**判定**: Confirmed ✅ (機能未実装であることが確認された)

---

### 前提条件 5: i18nラベルの追加先が schedule.json

**Issue内の記述**: 「`locales/ja/schedule.json`, `locales/en/schedule.json` — i18nラベル追加」

**検証結果**:
- `locales/ja/schedule.json:37-38`: `"vibeLocalModel": "Ollamaモデル"`, `"vibeLocalModelDefault": "デフォルト"` が存在
- `locales/en/schedule.json:37-38`: `"vibeLocalModel": "Ollama Model"`, `"vibeLocalModelDefault": "Default"` が存在
- AgentSettingsPaneは `useTranslations('schedule')` を使用しているため、schedule.jsonが正しい

**判定**: Confirmed ✅

---

### 前提条件 6: 変更対象ファイルがすべて存在する

**検証結果**:
- `src/lib/db-migrations.ts` ✅
- `src/lib/db.ts` ✅
- `src/types/models.ts` ✅
- `src/app/api/worktrees/[id]/route.ts` ✅
- `src/lib/cli-tools/vibe-local.ts` ✅
- `src/components/worktree/AgentSettingsPane.tsx` ✅
- `locales/ja/schedule.json`, `locales/en/schedule.json` ✅

**判定**: Confirmed ✅

---

## Stage 1レビューへの申し送り事項

- 全ての前提条件はConfirmedであり、Issueの現状記述は正確
- Issue内容の機能設計（バリデーション範囲、UIパターン）の整合性確認を重点的に実施すること
- `db.ts` にある `updateVibeLocalModel` 相当の関数と同様のパターンで `updateVibeLocalContextWindow` を実装するか、既存の `updateWorktree` 汎用関数で対応するかの設計判断をレビューすること
- 既存の `selected_agents_validator.ts` の `validateAgentsPair()` パターンを参考に、バリデーション範囲 (1024〜131072) が適切かを確認すること
