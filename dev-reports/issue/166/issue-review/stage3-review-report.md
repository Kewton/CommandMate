# Issue #166 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-03-14
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目（Stage 3）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 5 |
| Nice to Have | 2 |

影響範囲は主にslash-commands周辺モジュールに限定されており、UIコンポーネントへの影響は軽微。破壊的変更は発生しない見込み。

---

## 影響範囲マップ

| 影響エリア | 影響度 | 対象ファイル |
|-----------|--------|-------------|
| 型定義 | Medium | `src/types/slash-commands.ts` |
| キャッシュ | High | `src/lib/slash-commands.ts` |
| APIルート | Medium | `src/app/api/worktrees/[id]/slash-commands/route.ts`, `src/app/api/slash-commands/route.ts` |
| フィルタリング | High | `src/lib/command-merger.ts` |
| テスト | Medium | `tests/unit/slash-commands.test.ts`, `tests/unit/lib/command-merger.test.ts`, `tests/integration/api-*.test.ts` |
| UIコンポーネント | Low | `src/components/worktree/SlashCommandList.tsx`, `SlashCommandSelector.tsx` |
| パフォーマンス | Low | `src/lib/slash-commands.ts` |
| OS互換性 | Medium | `src/lib/slash-commands.ts` |

---

## Must Fix（必須対応）

### IA-004: filterCommandsByCliTool()のデフォルト挙動と既存.claude/skills/スキルの扱い

**カテゴリ**: フィルタリング
**影響ファイル**: `src/lib/command-merger.ts`, `src/lib/slash-commands.ts`

**問題**:
`filterCommandsByCliTool()`は、`cliTools`がundefinedの場合に`cliToolId === 'claude'`の場合のみ表示する（184-196行目）。既存の`.claude/skills/`から読み込まれたスキルは`cliTools`が未設定のため、Claudeタブでのみ表示される。

Issue #166でCodexスキルに`cliTools: ['codex']`を設定する設計は正しいが、この前提がIssueに明記されていない。実装者が`.claude/skills/`のスキルにも`cliTools`を付与しようとした場合、既存のClaudeスキル表示が壊れるリスクがある。

**根拠**:
```typescript
// src/lib/command-merger.ts:191-195
if (!cmd.cliTools) {
  return cliToolId === 'claude';
}
return cmd.cliTools.includes(cliToolId);
```

**推奨対応**:
Issueに以下の設計前提を明記する:
- 既存の`.claude/skills/`スキルは`cliTools`を設定しない（undefinedのまま）
- undefinedはClaude-onlyとして`filterCommandsByCliTool()`が処理する
- Codexスキルのみに明示的に`cliTools: ['codex']`を設定する

---

## Should Fix（推奨対応）

### IA-001: Codexグローバルスキルキャッシュの設計とclearCache()への影響

**カテゴリ**: キャッシュ
**影響ファイル**: `src/lib/slash-commands.ts`

**問題**:
3つ目のキャッシュ（codexSkillsCache等）を追加する場合、`clearCache()`への追加漏れは一般的なバグパターン。現在の`clearCache()`は`commandsCache`と`skillsCache`の2つをnullに設定している。

**推奨対応**:
実装タスクに「clearCache()にCodexスキルキャッシュのクリアを追加」を明記する。

---

### IA-002: APIレスポンスのsources集計に'codex-skill'の追加が必要

**カテゴリ**: API
**影響ファイル**: `src/app/api/worktrees/[id]/slash-commands/route.ts`

**問題**:
worktree別APIルートの`SlashCommandsResponse.sources`に`codex-skill`のカウントをどう扱うかが不明。既存の`sources.skill`に含めるか、別プロパティにするかの設計判断が必要。

**推奨対応**:
APIレスポンス型の更新方針を明記する。

---

### IA-003: SlashCommandCategory新カテゴリ追加時のCATEGORY_ORDER/CATEGORY_LABELS連動

**カテゴリ**: 型定義
**影響ファイル**: `src/types/slash-commands.ts`, `src/lib/command-merger.ts`

**問題**:
新カテゴリを追加する場合、`CATEGORY_LABELS`、`CATEGORY_ORDER`、テスト(`command-merger.test.ts`)の3箇所を同時に更新する必要がある。追加漏れがあるとUI上でカテゴリラベルが表示されない、またはソート順が不正になる。

**推奨対応**:
3箇所同時更新の必要性を注記として追加する。もしくは既存の`'skill'`カテゴリを共用し、`source`値で区別する設計も検討可能。

---

### IA-006: ホームディレクトリ解決方法の明示

**カテゴリ**: OS互換性
**影響ファイル**: `src/lib/slash-commands.ts`

**問題**:
Node.jsでの`~`の解決方法が明記されていない。既存コード(`db-path-resolver.ts`等)では`os.homedir()`が使われている。

**推奨対応**:
実装タスクに「`os.homedir()`を使用してホームディレクトリを解決する（既存パターンに倣う）」を追記する。

---

### IA-007: グローバル/ローカル重複排除のテスト設計

**カテゴリ**: テスト
**影響ファイル**: `tests/unit/slash-commands.test.ts`

**問題**:
`deduplicateByName()`の呼び出し順序（globalを先に登録し、localで上書き）がローカル優先の鍵だが、テスト計画に明示されていない。

**推奨対応**:
テスト計画のIntegration Test対象に「同名Codexスキルがグローバル・ローカル両方に存在する場合、ローカル版が優先されること」を明記する。

---

## Nice to Have（あれば良い）

### IA-005: グローバルスキル読込時のエラーハンドリング

**カテゴリ**: パフォーマンス
**影響ファイル**: `src/lib/slash-commands.ts`

リモートファイルシステム等での遅延リスクは低いが、既存の`.catch(() => [])`パターンを踏襲すれば十分対応可能。

---

### IA-008: メインAPIルートでのCodexスキル扱い

**カテゴリ**: API
**影響ファイル**: `src/app/api/slash-commands/route.ts`, `src/lib/slash-commands.ts`

`/api/slash-commands`エンドポイントにCodexスキルを含めるかどうかの設計判断を明記しておくと、実装時の混乱を防げる。

---

## 参照ファイル

### 主要変更対象コード
- `src/lib/slash-commands.ts`: 新規Codexスキル読込関数追加、キャッシュ拡張
- `src/types/slash-commands.ts`: SlashCommandSource型拡張（'codex-skill'追加）
- `src/lib/command-merger.ts`: filterCommandsByCliTool()の挙動確認（変更不要の見込み）
- `src/app/api/worktrees/[id]/slash-commands/route.ts`: sourcesカウント拡張

### テスト
- `tests/unit/slash-commands.test.ts`: 新規テスト追加（既存テストへの破壊的変更なし）
- `tests/unit/lib/command-merger.test.ts`: filterCommandsByCliToolのCodexスキルテスト追加
- `tests/integration/api-worktree-slash-commands.test.ts`: Codexスキル統合テスト追加

### UIコンポーネント（変更不要）
- `src/components/worktree/SlashCommandList.tsx`: 型に依存するが、新しいsource/categoryを特別扱いしていないため変更不要
- `src/components/worktree/SlashCommandSelector.tsx`: 同上

### 参考パターン（既存実装）
- `src/lib/db/db-path-resolver.ts`: os.homedir()使用パターン
- `src/lib/slash-commands.ts` loadSkills(): .codex/skills/読込のベースパターン
